// GitHub API access: a single cheap GraphQL call for profile + merged PRs +
// closed issues + commits, plus the expensive per-repo REST "stats/contributors"
// endpoint for line additions/deletions (which returns 202 while GitHub computes
// the numbers, so we retry).

const GRAPHQL_URL = "https://api.github.com/graphql";
const REST_BASE = "https://api.github.com";
const UA = "github-lines-api";

export interface RepoRef {
  owner: string;
  name: string;
}

export interface GitHubStats {
  login: string;
  name: string | null;
  followers: number;
  publicRepos: number;
  mergedPRs: number;
  closedIssues: number;
  commits: number;
  /** Repos owned by the user, newest-pushed first (used for line counting). */
  repos: RepoRef[];
}

/** Thrown when the username does not exist on GitHub. */
export class UserNotFoundError extends Error {}

interface GraphQLResponse {
  data?: {
    user: {
      login: string;
      name: string | null;
      followers: { totalCount: number };
      repositories: {
        totalCount: number;
        nodes: Array<{
          name: string;
          isFork: boolean;
          owner: { login: string };
          pushedAt: string | null;
        }>;
      };
      pullRequests: { totalCount: number };
      issues: { totalCount: number };
      contributionsCollection: { totalCommitContributions: number };
    } | null;
  };
  errors?: Array<{ type?: string; message: string }>;
}

/**
 * Fetch profile, merged-PR count, closed-issue count, commit count, and the
 * user's owned repositories in one GraphQL request.
 */
export async function fetchGitHubStats(
  username: string,
  token: string,
  includeForks = false,
): Promise<GitHubStats> {
  const query = `
    query($login: String!) {
      user(login: $login) {
        login
        name
        followers { totalCount }
        repositories(
          first: 100
          ownerAffiliations: [OWNER]
          orderBy: { field: PUSHED_AT, direction: DESC }
        ) {
          totalCount
          nodes { name isFork owner { login } pushedAt }
        }
        pullRequests(states: MERGED) { totalCount }
        issues(states: CLOSED) { totalCount }
        contributionsCollection { totalCommitContributions }
      }
    }`;

  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "User-Agent": UA,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables: { login: username } }),
  });

  if (!res.ok) {
    throw new Error(`GitHub GraphQL error: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as GraphQLResponse;

  // A missing user comes back as data.user === null with a NOT_FOUND error.
  const notFound = body.errors?.some((e) => e.type === "NOT_FOUND");
  if (notFound || !body.data?.user) {
    if (notFound || body.data?.user === null) {
      throw new UserNotFoundError(`GitHub user "${username}" not found`);
    }
    throw new Error(`GitHub GraphQL error: ${JSON.stringify(body.errors)}`);
  }

  const u = body.data.user;
  return {
    login: u.login,
    name: u.name,
    followers: u.followers.totalCount,
    publicRepos: u.repositories.totalCount,
    mergedPRs: u.pullRequests.totalCount,
    closedIssues: u.issues.totalCount,
    commits: u.contributionsCollection.totalCommitContributions,
    repos: u.repositories.nodes
      .filter((r) => includeForks || !r.isFork)
      .map((r) => ({ owner: r.owner.login, name: r.name })),
  };
}

interface ContributorStats {
  author: { login: string } | null;
  weeks: Array<{ a: number; d: number }>; // additions / deletions
}

/**
 * Total additions+deletions attributable to `username` across the given repos.
 *
 * The REST stats endpoint returns 202 while GitHub computes the data; we retry a
 * couple of times per repo. Repos still computing after the retries contribute 0
 * for now and will be picked up on the next refresh. Subrequests are bounded by
 * `maxRepos` to stay within the Workers per-request subrequest limit.
 */
export async function fetchLineCount(
  username: string,
  repos: RepoRef[],
  token: string,
  maxRepos: number,
  maxAttempts = 3,
  delayMs = 1500,
): Promise<number> {
  let total = 0;

  for (const repo of repos.slice(0, maxRepos)) {
    const stats = await fetchContributorStats(repo, token, maxAttempts, delayMs);
    if (!stats) continue;
    const mine = stats.find(
      (c) => c.author?.login.toLowerCase() === username.toLowerCase(),
    );
    if (!mine) continue;
    for (const w of mine.weeks) total += w.a + w.d;
  }

  return total;
}

async function fetchContributorStats(
  repo: RepoRef,
  token: string,
  maxAttempts: number,
  delayMs: number,
): Promise<ContributorStats[] | null> {
  const url = `${REST_BASE}/repos/${repo.owner}/${repo.name}/stats/contributors`;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(url, {
      headers: {
        Authorization: `bearer ${token}`,
        "User-Agent": UA,
        Accept: "application/vnd.github+json",
      },
    });

    if (res.status === 202) {
      // GitHub is computing the stats; wait and retry (skip wait on last try).
      if (attempt < maxAttempts - 1 && delayMs > 0) await sleep(delayMs);
      continue;
    }
    if (res.status === 204) return []; // empty repo
    if (!res.ok) return null; // skip repos we can't read

    return (await res.json()) as ContributorStats[];
  }

  return null; // still computing after retries; counts as 0 this refresh
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
