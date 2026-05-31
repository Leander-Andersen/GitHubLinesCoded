// GET /?username=<github-login>
// Returns coding stats for the user as JSON, with line-count diffs vs last week
// and last month. Results are cached per user in KV.
//
// GitHub's per-repo stats/contributors endpoint is slow and often returns 202
// ("still computing") for a while, so we never block a request on it. Instead we
// serve cached data immediately and refresh from GitHub in the background
// (stale-while-revalidate); line counts land on a later load once GitHub has
// finished computing them.

import {
  fetchGitHubStats,
  fetchLineCount,
  UserNotFoundError,
  type RepoRef,
} from "./github";
import {
  appendSnapshot,
  isFresh,
  latest,
  lineDiffs,
  readHistory,
  type Snapshot,
} from "./snapshots";

export interface Env {
  STATS: KVNamespace;
  // Account-level secret from Secrets Store; resolved asynchronously via .get().
  GITHUB_TOKEN: SecretsStoreSecret;
  CACHE_TTL_HOURS?: string;
  MAX_REPOS?: string;
  INCLUDE_FORKS?: string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// GitHub usernames: 1-39 chars, alphanumeric or single hyphens.
const USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

// Foreground line fetch: one quick attempt, no waiting (used on first lookup so
// the user isn't blocked). Background fetch is patient.
const FAST_LINES = { maxAttempts: 1, delayMs: 0 };
const PATIENT_LINES = { maxAttempts: 4, delayMs: 2000 };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405);
    }

    const url = new URL(request.url);
    const username = url.searchParams.get("username")?.trim();
    if (!username) {
      return json({ error: "Missing required query parameter: username" }, 400);
    }
    if (!USERNAME_RE.test(username)) {
      return json({ error: "Invalid GitHub username" }, 400);
    }
    if (!env.GITHUB_TOKEN) {
      return json({ error: "Server not configured: missing GITHUB_TOKEN binding" }, 500);
    }

    let token: string;
    try {
      token = await env.GITHUB_TOKEN.get();
    } catch {
      return json({ error: "Server not configured: could not read GITHUB_TOKEN" }, 500);
    }

    const opts: RefreshOpts = {
      maxRepos: numEnv(env.MAX_REPOS, 15),
      includeForks: env.INCLUDE_FORKS === "true",
    };
    const ttlHours = numEnv(env.CACHE_TTL_HOURS, 24);
    const force = url.searchParams.has("refresh");
    const now = Date.now();

    try {
      const history = await readHistory(env.STATS, username);
      const cached = latest(history);

      // Forced refresh: synchronous, patient fetch — accurate but slow (debug).
      if (force) {
        const { snapshot, updated, name } = await refreshUser(
          env, username, token, history, opts, PATIENT_LINES,
        );
        return json(buildResponse(username, snapshot, updated, false, name));
      }

      // Fresh cache: serve instantly, touch nothing.
      if (cached && isFresh(cached, ttlHours, now)) {
        return json(buildResponse(username, cached, history, false));
      }

      // Stale cache: serve stale immediately, refresh in the background.
      if (cached) {
        ctx.waitUntil(
          refreshUser(env, username, token, history, opts, PATIENT_LINES).catch(
            (err) => console.error("background refresh failed:", err),
          ),
        );
        return json(buildResponse(username, cached, history, true));
      }

      // First-ever lookup: fast synchronous fetch (lines may be 0 this round),
      // then background-fill the slow line counts for next time.
      const stats = await fetchGitHubStats(username, token, opts.includeForks);
      const lines = await fetchLineCount(
        stats.login, stats.repos, token, opts.maxRepos,
        FAST_LINES.maxAttempts, FAST_LINES.delayMs,
      );
      const snapshot = toSnapshot(now, lines, stats);
      const updated = await appendSnapshot(env.STATS, username, snapshot, history);

      if (lines === 0) {
        // GitHub was still computing; backfill real line counts in the background.
        ctx.waitUntil(
          backfillLines(env, username, token, stats.repos, opts).catch((err) =>
            console.error("line backfill failed:", err),
          ),
        );
      }
      return json(buildResponse(stats.login, snapshot, updated, false, stats.name));
    } catch (err) {
      if (err instanceof UserNotFoundError) {
        return json({ error: err.message }, 404);
      }
      console.error("stats lookup failed:", err);

      // On a transient GitHub failure, fall back to stale cache if we have one.
      const history = await readHistory(env.STATS, username);
      const cached = latest(history);
      if (cached) {
        return json(buildResponse(username, cached, history, true));
      }
      return json({ error: "Failed to fetch GitHub stats" }, 502);
    }
  },
} satisfies ExportedHandler<Env>;

interface RefreshOpts {
  maxRepos: number;
  includeForks: boolean;
}

interface LineRetry {
  maxAttempts: number;
  delayMs: number;
}

/** Full refresh: profile via GraphQL + line counts, appended to KV history. */
async function refreshUser(
  env: Env,
  username: string,
  token: string,
  history: Snapshot[],
  opts: RefreshOpts,
  lines: LineRetry,
): Promise<{ snapshot: Snapshot; updated: Snapshot[]; name: string | null }> {
  const stats = await fetchGitHubStats(username, token, opts.includeForks);
  const lineCount = await fetchLineCount(
    stats.login, stats.repos, token, opts.maxRepos, lines.maxAttempts, lines.delayMs,
  );
  const snapshot = toSnapshot(Date.now(), lineCount, stats);
  const updated = await appendSnapshot(env.STATS, username, snapshot, history);
  return { snapshot, updated, name: stats.name };
}

/**
 * Patiently fetch line counts and patch them onto the latest stored snapshot.
 * Used after a first lookup where GitHub returned 202 for every repo.
 */
async function backfillLines(
  env: Env,
  username: string,
  token: string,
  repos: RepoRef[],
  opts: RefreshOpts,
): Promise<void> {
  const lines = await fetchLineCount(
    username, repos, token, opts.maxRepos, PATIENT_LINES.maxAttempts, PATIENT_LINES.delayMs,
  );
  if (lines === 0) return; // still not ready; leave for the next refresh

  const history = await readHistory(env.STATS, username);
  const current = latest(history);
  if (!current) return;
  current.lines = lines;
  await appendSnapshot(env.STATS, username, current, history.slice(0, -1));
}

function toSnapshot(ts: number, lines: number, stats: {
  mergedPRs: number; closedIssues: number; publicRepos: number; followers: number;
}): Snapshot {
  return {
    ts,
    lines,
    mergedPRs: stats.mergedPRs,
    closedIssues: stats.closedIssues,
    publicRepos: stats.publicRepos,
    followers: stats.followers,
  };
}

function buildResponse(
  username: string,
  snapshot: Snapshot,
  history: Snapshot[],
  stale: boolean,
  name?: string | null,
) {
  const diffs = lineDiffs(history);
  return {
    username,
    name: name ?? null,
    lines: {
      total: snapshot.lines,
      vsWeek: diffs.vsWeek,
      vsMonth: diffs.vsMonth,
    },
    mergedPRs: snapshot.mergedPRs,
    closedIssues: snapshot.closedIssues,
    publicRepos: snapshot.publicRepos,
    followers: snapshot.followers,
    lastUpdated: new Date(snapshot.ts).toISOString(),
    stale,
  };
}

function numEnv(value: string | undefined, fallback: number): number {
  const n = value !== undefined ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      ...CORS_HEADERS,
    },
  });
}
