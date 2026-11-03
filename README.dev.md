# express-twitter-endpoint — developer notes

A single-endpoint Express.js service that returns the **latest tweet of a
given X (Twitter) user** — text, timestamp and link — as JSON.

**Data source (no-key version):** the public syndication feed behind X's
embed widgets, `https://syndication.twitter.com/srv/timeline-profile/screen-name/<name>`.
No X API key, developer account or login is used anywhere. An earlier
revision of this repository used the official X API v2 with a Bearer
Token; see the git history for it.

Default target user: **Elon Musk (`@elonmusk`)** (configurable).

---

## Architecture

The code is layered so each part can be reused or replaced on its own:

| File | Role |
|---|---|
| `src/twitterClient.js` | Data layer. Fetches the feed page, extracts the embedded `__NEXT_DATA__` JSON, normalises legacy-format tweets, applies the filters and the retry/deadline policy. No Express dependency. |
| `src/app.js` | HTTP layer. `createLatestTweetHandler` (one route handler) and `createApp` (handler + /health + optional key gate + JSON 404). No port binding, no env access. |
| `src/index.js` | Library entry (`package.json` `main`). Re-exports both layers. Importing it has no side effects. |
| `src/server.js` | Standalone entry. Reads `.env`, builds the client and app, listens. This is the only file that touches the environment or a port. |

Embedding levels (also shown in README.md): client only → handler on a
host router → `createApp` mounted as a sub-application → standalone
server.

---

## Endpoint

### `GET /latest-tweet`

Returns the user's most recent tweet.

**Response example (`200 OK`)**

```json
{
  "id": "1853000000000000000",
  "text": "Full text of the latest tweet ...",
  "created_at": "2026-11-03T01:23:45.000Z",
  "url": "https://twitter.com/elonmusk/status/1853000000000000000",
  "author": {
    "id": "44196397",
    "username": "elonmusk",
    "name": "Elon Musk"
  },
  "cached": false
}
```

| Field        | Description                                            |
| ------------ | ------------------------------------------------------ |
| `id`         | Tweet ID                                               |
| `text`       | Full tweet text                                        |
| `created_at` | Creation timestamp (ISO 8601, UTC)                     |
| `url`        | Permalink to the tweet                                 |
| `author`     | Resolved author (`id`, `username`, `name`)             |
| `cached`     | `true` if served from the in-memory cache (see below)  |

**Optional query parameters**

| Parameter          | Values              | Description                                   |
| ------------------ | ------------------- | --------------------------------------------- |
| `username`         | e.g. `nasa`         | Override the target user for this request (validated: 1-15 chars, letters/digits/underscore — invalid values get `400`) |
| `exclude_retweets` | `exclude`/`include` | Override retweet handling for this request    |
| `exclude_replies`  | `exclude`/`include` | Override reply handling for this request      |

```bash
curl "http://localhost:3000/latest-tweet?username=nasa&exclude_replies=include"
```

**The `username` is a screen name, not a numeric user ID.** A single
leading `@` is accepted and stripped. The numeric author `id` in the
response comes from the feed payload itself; no separate user-lookup
call exists in this version.

**How the "latest" tweet is selected (exactly what the implementation
does):** among the tweets embedded in the feed page, drop retweets
(payload carries `retweeted_status`, or the text starts with `RT @`)
when retweets are excluded, and drop replies (payload carries
`in_reply_to_status_id_str`) when replies are excluded; then take the
maximum by `created_at`. Feed order is never trusted (a pinned tweet
is listed first but is usually old). The feed only embeds a bounded
window of recent posts, so selection is limited to that window.

### `GET /health`

Returns `{ "status": "ok" }`. Process liveness only — it says nothing
about upstream reachability.

**Errors**

| Status | `error`           | When |
| ------ | ----------------- | ---- |
| 400    | `invalid_username`| Username missing-shaped, over-long, or not a string |
| 401    | `unauthorized`    | `APP_API_KEY` set and the `x-api-key` header does not match |
| 404    | `user_not_found`  | The feed shows no such user (no profile header, empty timeline). Protected accounts keep their header and surface as `no_tweets_found`; suspended accounts were not measured |
| 404    | `no_tweets_found` | The user exists but no returned post matches the filters |
| 404    | `not_found`       | Unknown route (createApp only) |
| 502    | `upstream_error`  | Feed unreachable, malformed, or answered an error status |
| 503    | `rate_limited`    | Feed rate limit persisted through the retries (`Retry-After` header attached when the wait is known) |
| 500    | `internal_error`  | Anything unexpected |

Upstream error details are written to the server log (with a
per-request id) and never included in responses.

---

## The feed payload, as observed (2026-11-03)

- `GET /srv/timeline-profile/screen-name/<name>` answers `200` with an
  HTML page containing `<script id="__NEXT_DATA__" type="application/json">`.
- Tweets live at `props.pageProps.timeline.entries[]`, each
  `{ type: "tweet", content: { tweet: {…} } }` in legacy format:
  `id_str`, `full_text` (fallback `text`), `created_at`
  (`"Mon Nov 02 22:30:01 +0000 2026"`), `user { id_str, screen_name, name }`,
  optional `retweeted_status`, optional `in_reply_to_status_id_str`.
- `props.pageProps.headerProps.screenName` names the profile. For an
  unknown account the page still answers 200 but has **no**
  `headerProps` and **zero** entries — that absence is the
  user_not_found signal. A protected account (measured 2026-11-03)
  keeps its `headerProps` with the screen name and has zero entries,
  so it resolves as an existing user with no visible posts
  (`no_tweets_found`). Suspended accounts were not measured.
- Entry count varies (20–100 observed). The legacy JSON endpoint
  (`cdn.syndication.twimg.com/timeline/profile`) is dead (200, empty
  body) and is not used.
- Rate limiting: `429` with a plain-text body, headers
  `x-rate-limit-limit: 30`, `x-rate-limit-remaining`,
  `x-rate-limit-reset` (epoch seconds; a 15-minute window was
  observed). No `Retry-After` header was present, so the client reads
  the reset header first-class and also supports `Retry-After`.

## Reliability behaviour

- **Cache**: successful payloads are cached per
  `username|retweets|replies` key (username lower-cased — X screen
  names are case-insensitive) for `CACHE_TTL_SECONDS` (default 60 s).
  Each handler instance owns its cache, bounded at 500 entries with
  oldest-first eviction.
- **Retries**: HTTP 429 and transport failures are retried up to
  `UPSTREAM_MAX_RETRIES` (default 3). The wait before a 429 retry is
  the upstream suggestion (`Retry-After`, else the reset time, else
  exponential backoff). A suggested wait longer than the per-wait cap
  of **30 s** is NOT shortened and retried early — the operation
  fails fast as 503 + `Retry-After` carrying the full suggested wait.
  Total waiting is capped by `UPSTREAM_RETRY_BUDGET_MS` (default 90 s).
- **Deadline**: one deadline (`REQUEST_DEADLINE_MS`, default 60 s)
  bounds the whole operation: attempts are aborted at the deadline
  (AbortController, timeout shrunk to the remaining time), a wait that
  would cross it is not taken, and no attempt starts after it. One
  attempt = fetch + full body read under the same timer, so a body
  that stalls after the headers is aborted too, and a body-read
  failure is classified `upstream_timeout` / `upstream_network`
  (→ 502), never leaked as a bare exception.
- **Structure validation**: the payload must have a `props.pageProps`
  object with a `timeline.entries` array. Missing pieces, entries
  that carry no tweet objects, entries whose posts all fail to
  normalise, posts that are all by someone other than the profile
  owner, a header object without a screen name, or posts on a page
  with no profile header at all are `upstream_malformed` (→ 502).
  Only the measured signature (no header object, empty entries
  array) is `user_not_found`; a profile header with a well-formed
  empty timeline is `no_tweets_found`. Selection only ever picks the
  profile owner's own posts. A page whose `__NEXT_DATA__` JSON does
  not parse is also `upstream_malformed`: at this layer a truncated
  download and a changed page structure are indistinguishable, and
  both surface as 502 either way.
- **Host responsibilities**: this component deliberately does NOT
  coalesce concurrent requests for the same user, negative-cache
  404/503 answers, or rate-limit per caller. When exposing it
  publicly, the host (or its reverse proxy) owns those: request
  coalescing / queuing per screen name, short negative caching
  (e.g. 404 for a minute, 503 for the `Retry-After` duration), and
  per-caller (IP / API key) rate limits. A custom `fetchImpl` must
  honour the `AbortSignal` it receives, like standard fetch — the
  timeout and deadline control relies on it.
- **Validation**: usernames are type-checked before use (array/object
  query values are a 400, not a crash); the optional API key is
  compared in constant time.

## Configuration

Standalone mode is configured by `.env` (see `.env.example`):
`TWITTER_USERNAME`, `EXCLUDE_RETWEETS`, `EXCLUDE_REPLIES`,
`CACHE_TTL_SECONDS`, `UPSTREAM_TIMEOUT_MS`, `UPSTREAM_MAX_RETRIES`,
`UPSTREAM_RETRY_BUDGET_MS`, `REQUEST_DEADLINE_MS`, `APP_API_KEY`,
`PORT`, `HOST` (standalone bind interface, default `127.0.0.1`).
In library use the same knobs are constructor / factory
options; nothing is read from the environment.

## Tests

`npm test` (Node's built-in runner) runs fully offline:

| File | Covers |
|---|---|
| `test/twitterClient.test.js` | Client basics: URL/UA, normalisation, newest-by-timestamp selection |
| `test/app.test.js` | HTTP behaviour with a stub client: payload shape, cache, overrides, error mapping |
| `test/hardening.test.js` | Input hardening: non-string usernames, flag parsing, key gate, per-flag cache keys |
| `test/embed.test.js` | The embedding surface: library exports, handler on a host router, sub-app mounting, client customisation (baseUrl / userAgent / wrapped fetch), per-instance caches |
| `test/review2.test.js` | 429 retry semantics: Retry-After, reset header, 30 s fail-fast, budget |
| `test/review3.test.js` | Parsing edges: missing/malformed `__NEXT_DATA__`, not-found signature, unusable entries |
| `test/review4.test.js` | Retweet/reply filtering, incl. text-only RTs and self-replies |
| `test/review5.test.js` | Deadline semantics: no attempt after the deadline, waits that would cross it refused |
| `test/review6.test.js` | Documentation guards: README/.env.example/server.js/package.json consistency |
| `test/helpers.js` | Feed fixtures in the observed payload shape (not a test file) |
