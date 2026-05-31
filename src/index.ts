// GET /?username=<github-login>
// Returns coding stats for the user as JSON, with line-count diffs vs last week
// and last month. Results are cached per user in KV; GitHub is only hit when the
// cached snapshot is stale (or missing), keeping us well under rate limits.

import {
  fetchGitHubStats,
  fetchLineCount,
  UserNotFoundError,
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405);
    }

    const username = new URL(request.url).searchParams.get("username")?.trim();
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

    const ttlHours = numEnv(env.CACHE_TTL_HOURS, 24);
    const maxRepos = numEnv(env.MAX_REPOS, 15);
    const includeForks = env.INCLUDE_FORKS === "true";
    const now = Date.now();

    try {
      const history = await readHistory(env.STATS, username);
      const cached = latest(history);

      // Serve cached snapshot without touching GitHub when still fresh.
      if (cached && isFresh(cached, ttlHours, now)) {
        return json(buildResponse(username, cached, history, false));
      }

      // Stale or first-ever lookup: refresh from GitHub.
      const stats = await fetchGitHubStats(username, token, includeForks);
      const lines = await fetchLineCount(stats.login, stats.repos, token, maxRepos);

      const snapshot: Snapshot = {
        ts: now,
        lines,
        mergedPRs: stats.mergedPRs,
        closedIssues: stats.closedIssues,
        publicRepos: stats.publicRepos,
        followers: stats.followers,
      };

      const updated = await appendSnapshot(env.STATS, username, snapshot, history);
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
