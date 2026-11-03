# Express Twitter Endpoint

## Overview

A single-endpoint Express.js service that returns the latest tweet of a given X (Twitter) user as JSON. The target user defaults to `@elonmusk` and can be changed via configuration or per request. It returns the tweet text, timestamp, permalink, and author information.

**No X API key, developer account or login is required.** Instead of the official X API, the data source is the public syndication feed that powers X's embed widgets (`https://syndication.twitter.com/srv/timeline-profile/screen-name/<name>`). The feed page embeds the profile's recent tweets as JSON, and this service extracts the newest matching post. Nothing is charged per read; there is no X-side billing at all.

This is a backend component: it is built to be embedded into a larger system or customised, not only run standalone — see "Embedding and customisation" below. (Earlier revisions of this repository used the official X API v2 with a Bearer Token; that implementation remains in the git history.)

## Features

- `GET /latest-tweet`: returns the user's most recent tweet. `GET /health`: returns `{ "status": "ok" }` — a liveness check of the server process only; it does not verify upstream reachability.
- Per-request overrides: the `username` query parameter (validated) selects a different user. The `username` is a screen name, not a numeric user ID; a single leading `@` is accepted and stripped. `exclude_retweets` / `exclude_replies` override the retweet/reply handling.
- "Latest" means the newest by timestamp among the posts the feed returns — feed order is not trusted, so a pinned older post never wins over a newer one.
- Rate-limit protection: successful responses are cached in memory (default 60 seconds).
- Retries and deadlines: HTTP 429 responses are retried; the wait honours `Retry-After` and the feed's `x-rate-limit-reset` header. A suggested wait longer than 30 seconds is NOT shortened and retried early: the request fails fast and the caller receives a 503 with a `Retry-After` header carrying the full suggested wait. The total waiting time per request is capped by `UPSTREAM_RETRY_BUDGET_MS` (default 90,000 ms), and an overall request deadline (`REQUEST_DEADLINE_MS`, default 60,000 ms) applies: no attempt is started after the deadline has passed, and the deadline also bounds reading the response body.
- Optional access gate: when `APP_API_KEY` is set, `/latest-tweet` requires that value in the `x-api-key` header (`/health` stays open). This key is your own gate for this service; it is unrelated to X.
- Response shape validation: the 200 page's payload is schema-checked (a `props.pageProps` object holding a `timeline.entries` array), and selection only counts posts written by the profile's own author. A page whose structure deviates — including entries that are all unusable or all by other authors — is an upstream error (502), never an empty result and never a "user not found". The one exception is the feed's measured not-found signature (well-formed page, no profile header, empty timeline), which is a 404.

## Usage (standalone)

Requirements: Node.js 20.6.0 or newer (the start scripts use Node's built-in `--env-file` flag).

```bash
npm install
cp .env.example .env   # no secrets in it — adjust the defaults if you like
npm start              # listens on http://localhost:3000
```

```bash
curl "http://localhost:3000/latest-tweet"
curl "http://localhost:3000/latest-tweet?username=nasa&exclude_replies=include"
```

Response:

```json
{
  "id": "1853000000000000000",
  "text": "Full text of the latest tweet ...",
  "created_at": "2026-11-03T01:23:45.000Z",
  "url": "https://twitter.com/elonmusk/status/1853000000000000000",
  "author": { "id": "44196397", "username": "elonmusk", "name": "Elon Musk" },
  "cached": false
}
```

Error mapping: 400 for invalid input, 401 for the API key gate, 404 `user_not_found` for a user the feed does not show, 404 `no_tweets_found` when the user exists but no returned post matches the filters, 502 for upstream failures, 503 when the rate limit persists after retries.

Main configuration (`.env`, standalone mode only):

| Variable | Default | Description |
|---|---|---|
| `TWITTER_USERNAME` | `elonmusk` | Default target user (screen name) |
| `EXCLUDE_RETWEETS` / `EXCLUDE_REPLIES` | `exclude` | Default handling of retweets / replies |
| `CACHE_TTL_SECONDS` | `60` | In-memory response cache TTL |
| `UPSTREAM_TIMEOUT_MS` | `10000` | Per-attempt timeout for feed calls |
| `UPSTREAM_MAX_RETRIES` | `3` | Retries after a 429 or a transport failure |
| `UPSTREAM_RETRY_BUDGET_MS` | `90000` | Cap on the total retry waiting time per request |
| `REQUEST_DEADLINE_MS` | `60000` | Overall deadline per /latest-tweet request |
| `APP_API_KEY` | (unset) | Optional shared secret for /latest-tweet |
| `PORT` | `3000` | Listen port |
| `HOST` | `127.0.0.1` | Bind interface (standalone). Set `0.0.0.0` to expose the server — and set `APP_API_KEY` when you do |

## Embedding and customisation

The package's main entry (`src/index.js`) is a library; importing it never listens on a port, reads the environment, or exits the process. Three levels of reuse:

```js
const {
  TwitterClient,
  createLatestTweetHandler,
  createApp,
} = require('express-twitter-endpoint');

// 1. Client only (no HTTP): fetch the latest post inside your own system.
const client = new TwitterClient();
const { user, tweet } = await client.getLatestPost('nasa', {
  excludeRetweets: true,
  excludeReplies: true,
});

// 2. A single route inside your own Express app, on your own path,
//    behind your own middleware. Auth and 404 handling stay yours.
app.get('/posts/latest', createLatestTweetHandler({ client, username: 'nasa' }));

// 3. The complete sub-application (health check + endpoint + JSON 404),
//    mounted under a prefix of a larger host.
host.use('/x', createApp({ client, username: 'nasa', apiKey: <redacted> }));
```

Customisation points:

- **Client**: `baseUrl` (point at a mirror or a local stub of the feed), `userAgent`, `fetchImpl` (wrap fetch to add a proxy, logging or a different transport), `timeoutMs`, `maxRetries`, `retryBudgetMs`, `deadlineMs`.
- **Handler / app**: default `username`, `excludeRetweets`, `excludeReplies`, `cacheTtlMs` (0 disables the cache; each handler instance keeps its own cache), `apiKey` gate, and an injectable `logger` — upstream error details are written to the log only, never returned to callers.
- **Data handling**: `parseNextData` and `extractTimeline` are exported, so a host can reuse the feed parsing with its own selection logic.

## Limitations

Read these before depending on the service:

- The syndication feed is **not a documented API**. Its page structure can change or break without notice; the parser treats unexpected structure as an upstream error rather than guessing.
- **Public accounts' posts only.** A protected account's page carries its profile header with an empty timeline, so it is reported as `no_tweets_found` — indistinguishable from a public account with no visible posts. A nonexistent account (no header, empty timeline) is reported as `user_not_found`.
- The feed returns a bounded window of recent posts (a few dozen). Selection happens inside that window: if every recent post is filtered out (e.g. all are replies), the answer is `no_tweets_found` even if older matching posts exist.
- The feed enforces its own **per-IP rate limit** (observed 2026-11-03: `x-rate-limit-limit: 30` per 15-minute window). On shared egress IPs this budget is shared with every other user of the address. The cache and retries mitigate this but cannot remove it; for high-volume or guaranteed access, use the official X API instead.
- A retweet is detected via the payload's `retweeted_status` (with an `RT @` text-prefix fallback) and a reply via `in_reply_to_status_id_str`; self-replies (thread continuations) count as replies. An ordinary post whose text merely starts with `RT @` is also treated as a retweet by the fallback — the filters are best-effort, not a contract.

## Tests

```bash
npm test
```

The suite runs fully offline against recorded-shape feed fixtures (parsing, filtering, retry/deadline semantics, the HTTP layer, and the embedding surface).
