# GitHubLinesCoded

A small Cloudflare Worker API that, given a GitHub username, returns coding
statistics as JSON — total lines of code (additions/deletions across the user's
own public repos), merged PRs, closed issues, and how those numbers have changed
**since last week** and **since last month**.

Built to power a personal page widget like:

> **Leander** — 500 lines more since last week 🚀

## How it works

```
GET /?username=foo
   │
   ├─ KV read "stats:foo"
   │     ├─ fresh (< ~24h)? → return cached JSON  (0 GitHub calls)
   │     └─ stale/missing?  → fetch from GitHub ↓
   │
   ├─ GraphQL: profile + merged PRs + closed issues + commits   (1 cheap call)
   ├─ REST stats/contributors per own public repo (202-retry)   (N gated calls)
   ├─ Roll snapshots: current → weekAgo (~7d) / monthAgo (~30d)
   ├─ KV write "stats:foo"
   └─ return JSON (+ permissive CORS for browser fetch)
```

State is **on-request only** — a user's KV entry is created lazily on first
lookup and refreshed when stale. Scales from 1 to 100 users with no
pre-registration; each username is just its own KV key.

### Response shape

```json
{
  "username": "leander",
  "lines":        { "total": 12000, "vsWeek": 500, "vsMonth": 1000 },
  "mergedPRs":    777,
  "closedIssues": 109,
  "publicRepos":  139,
  "followers":    14821,
  "lastUpdated":  "2026-05-31T12:00:00Z",
  "stale":        false
}
```

## Setup

1. **GitHub token** — create a classic Personal Access Token (`public_repo`
   scope is enough). This lifts the API limit to 5,000 req/hr. Store it in the
   account-level **Secrets Store** (so it can be reused across Workers), then
   bind it in `wrangler.toml` (`store_id` + `secret_name = "GITHUB_TOKEN"`):
   ```sh
   npx wrangler secrets-store store create my-secrets --remote
   npx wrangler secrets-store secret create <store-id> --name GITHUB_TOKEN --scopes workers --remote
   ```
   The Worker reads it asynchronously via `await env.GITHUB_TOKEN.get()`.
2. **KV namespace** — create it and add the binding to `wrangler.toml`:
   ```sh
   npx wrangler kv namespace create STATS
   ```
3. **Deploy from GitHub** — connect this repo in the Cloudflare dashboard
   (Workers & Pages → Create → Connect to Git). Every push to `main`
   auto-deploys.

## Local development

```sh
npm install
npm run dev      # wrangler dev
```

## Notes & limitations

- **Lines of code** is the expensive, approximate stat. GitHub has no API for
  "all lines a user ever wrote"; this counts additions/deletions across the
  user's **own public repos** via the per-repo stats endpoint (which returns
  `202` and computes asynchronously, hence the retry loop).
- Merged PRs, closed issues, commits, followers are fast and exact.

## License

MIT
