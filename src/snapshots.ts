// Per-user snapshot history in KV. Each refresh appends a snapshot; week/month
// diffs are computed by comparing the latest snapshot against the one nearest to
// 7 / 30 days ago. State is created lazily on first lookup, so the store scales
// from 1 to many users with no pre-registration — each username is its own key.

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
// Keep a little more than a month of history so monthAgo always has a reference.
const HISTORY_RETENTION_MS = 40 * DAY_MS;

export interface Snapshot {
  ts: number; // epoch ms
  lines: number;
  mergedPRs: number;
  closedIssues: number;
  publicRepos: number;
  followers: number;
}

interface Stored {
  /** Ascending by ts; the last element is the current snapshot. */
  history: Snapshot[];
}

function kvKey(username: string): string {
  return `stats:${username.toLowerCase()}`;
}

export async function readHistory(
  kv: KVNamespace,
  username: string,
): Promise<Snapshot[]> {
  const stored = await kv.get<Stored>(kvKey(username), "json");
  return stored?.history ?? [];
}

/** Append a snapshot, prune old entries, and persist. Returns the new history. */
export async function appendSnapshot(
  kv: KVNamespace,
  username: string,
  snapshot: Snapshot,
  existing: Snapshot[],
): Promise<Snapshot[]> {
  const cutoff = snapshot.ts - HISTORY_RETENTION_MS;
  // Keep everything within the retention window, plus the single newest entry
  // that falls just outside it (so month-ago comparisons stay anchored).
  const withinWindow = existing.filter((s) => s.ts >= cutoff);
  const olderThanWindow = existing.filter((s) => s.ts < cutoff);
  const anchor = olderThanWindow.length
    ? [olderThanWindow[olderThanWindow.length - 1]]
    : [];

  const history = [...anchor, ...withinWindow, snapshot].sort((a, b) => a.ts - b.ts);
  await kv.put(kvKey(username), JSON.stringify({ history } satisfies Stored));
  return history;
}

/** The most recent snapshot, or null if the user has never been looked up. */
export function latest(history: Snapshot[]): Snapshot | null {
  return history.length ? history[history.length - 1] : null;
}

export function isFresh(snapshot: Snapshot, ttlHours: number, now: number): boolean {
  return now - snapshot.ts < ttlHours * 60 * 60 * 1000;
}

/**
 * Find the snapshot closest to `ageMs` before the current one, preferring the
 * most recent snapshot at or before that target. Falls back to the oldest
 * available snapshot, or null when only the current snapshot exists.
 */
function reference(history: Snapshot[], ageMs: number): Snapshot | null {
  if (history.length < 2) return null;
  const current = history[history.length - 1];
  const target = current.ts - ageMs;
  const past = history.slice(0, -1);

  const atOrBefore = past.filter((s) => s.ts <= target);
  if (atOrBefore.length) return atOrBefore[atOrBefore.length - 1];
  return past[0]; // history doesn't reach back that far yet
}

export interface Diffs {
  vsWeek: number;
  vsMonth: number;
}

/** Line-count diffs of the current snapshot vs ~1 week and ~1 month ago. */
export function lineDiffs(history: Snapshot[]): Diffs {
  const current = latest(history);
  if (!current) return { vsWeek: 0, vsMonth: 0 };
  const week = reference(history, WEEK_MS);
  const month = reference(history, MONTH_MS);
  return {
    vsWeek: week ? current.lines - week.lines : 0,
    vsMonth: month ? current.lines - month.lines : 0,
  };
}
