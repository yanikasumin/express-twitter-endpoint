# express-twitter-endpoint

A single-endpoint Express.js service that returns the **latest tweet of a given
X (Twitter) user** — text, timestamp and link — as JSON, using the
**X API v2**.

Default target user: **Elon Musk (`@elonmusk`)** (configurable).

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

**The `username` is a screen name, not a numeric user ID.** It is resolved
through `GET /2/users/by/username/:username`; a single leading `@` is
accepted and stripped. Numeric IDs are only used internally, as the input
of the timeline request, after the resolution.

**How the "latest" tweet is selected (exactly what the implementation
does):** one timeline request with `max_results=5`, with the retweet/reply
exclusions applied by the X API itself. From the returned entries, entries
with a malformed shape (missing string `id`/`text`/`created_at`) are skipped and the
first remaining entry is returned. There is **no pagination** and no
fetching of the user's full timeline: if all (up to) 5 returned entries
are filtered out or malformed, the answer is `404 no_tweets_found` even
though older tweets may exist.

### `GET /health`

```json
{ "status": "ok" }
```

**Error responses**

| HTTP | `error`              | When                                                                 |
| ---- | -------------------- | -------------------------------------------------------------------- |
| 400  | `invalid_username`   | The `username` parameter is not a valid X username (1-15 chars: letters, digits, underscores) — including non-string values such as a repeated parameter (`?username=a&username=b`) |
| 401  | `unauthorized`       | `APP_API_KEY` is set on the server and the request's `x-api-key` header is missing or wrong (only when the key gate is enabled) |
| 404  | `user_not_found`     | The username does not exist on X                                     |
| 404  | `no_tweets_found`    | The user exists but has no tweets matching the current filters       |
| 502  | `upstream_auth_error`| The Bearer Token was rejected (401/403 from X: invalid token or the app's access level does not cover these endpoints) |
| 502  | `upstream_error`     | Any other X API failure (details are written to the server log only)  |
| 503  | `rate_limited`       | X API rate limit reached even after retries — wait and retry (a `Retry-After` header is included when X provided one) |
| 500  | `internal_error`     | Unexpected server error                                              |

Error body shape: `{ "error": "<code>", "message": "<human-readable detail>" }`

---

## Setup

**Requirements:** Node.js **>= 20.6.0**. The start scripts use Node's built-in
`--env-file` flag, which was only added in **Node 20.6.0** — on Node 20.0–20.5
`npm start` fails with "bad option: --env-file". The built-in test runner is
used for the tests — no extra tooling needed.

> ⚠️ **Plan requirement — paid X API access is required.** The endpoints used
> by this service are not available for free. As of November 2026 the X API
> is billed **pay-per-use** (there are no subscription tiers for new
> developers): you prepay credits in the X Developer Console, and each read
> is charged per resource returned — US$0.010 per user lookup and US$0.005
> per post read for the endpoints used here. (The former Basic subscription
> tier — US$100/month when it was introduced in 2023 — was retired in 2026,
> so there is no "Basic plan" to buy anymore.) See "Getting an X API Bearer
> Token" below before you start, and check the official pricing page for
> the current rates — X API pricing changes over time.

```bash
npm install
cp .env.example .env   # then edit .env and set your Bearer Token
npm start
```

The server listens on `http://localhost:3000` by default.

**Development mode** (auto-restart on file changes):

```bash
npm run dev
```

**Tests** (fully offline — the X API is mocked, no token needed):

```bash
npm test
```

---

## Configuration (`.env`)

| Variable             | Default    | Description                                                                 |
| -------------------- | ---------- | --------------------------------------------------------------------------- |
| `TWITTER_BEARER_TOKEN` | *(required)* | Bearer Token of your X Developer App                                      |
| `TWITTER_USERNAME`   | `elonmusk` | Default user whose latest tweet is returned — a screen name (a leading `@` is accepted and stripped; not a numeric user ID) |
| `EXCLUDE_RETWEETS`   | `exclude`  | `exclude` or `include` — default handling of retweets                        |
| `EXCLUDE_REPLIES`    | `exclude`  | `exclude` or `include` — default handling of replies                         |
| `CACHE_TTL_SECONDS`  | `60`       | In-memory cache TTL for responses (rate-limit protection)                    |
| `TWITTER_TIMEOUT_MS` | `10000`    | Per-request timeout for X API calls (ms; covers reading the response body)   |
| `TWITTER_MAX_RETRIES`| `3`        | Retries on HTTP 429 with exponential backoff (honours `Retry-After` up to the configured cap) |
| `TWITTER_RETRY_BUDGET_MS` | `90000` | Cap on the TOTAL time spent waiting between 429 retries of one call; retrying stops early once the next wait would exceed it |
| `TWITTER_DEADLINE_MS` | `60000`   | Overall deadline for handling one `/latest-tweet` request: the username lookup and the timeline fetch share a single deadline, and every attempt plus every retry wait of both calls must fit inside it; an attempt is cut off at the deadline (`0` disables it, not recommended) |
| `APP_API_KEY`        | *(unset)*  | Optional shared secret. When set, `/latest-tweet` requires this value in the `x-api-key` header (401 otherwise). Unset = no authentication (local / trusted networks only) |
| `PORT`               | `3000`     | Listening port                                                               |

> ⚠️ Never commit your real `.env` to version control. `.env` is already listed
> in `.gitignore`.

---

## Getting an X API Bearer Token

1. Sign up / sign in at the **X Developer Portal**: https://developer.x.com
2. Create a **Project** and an **App** inside it.
3. Open the App's **"Keys and tokens"** page and copy the **Bearer Token**.
4. Paste it into `.env` as `TWITTER_BEARER_TOKEN=...`.

**Access level / permissions required**

- The endpoints used are read-only:
  - `GET /2/users/by/username/:username` (username → user ID resolution)
  - `GET /2/users/:id/tweets` (user timeline)
- App-only authentication (Bearer Token) is sufficient; **no user login /
  OAuth flow is needed**, and no write permissions are used.
- These endpoints require **paid X API access**. As of November 2026 there
  is no free tier for new developers and no subscription tier to choose:
  billing is pay-per-use against a prepaid credit balance, and calls made
  without credit are rejected (this service maps authorization failures to
  `502 upstream_auth_error`). Under the former subscription model, this
  access level corresponded to the Basic tier or higher. Only **public**
  accounts can be read this way. Plan terms, prices and rate limits change
  over time — check the X Developer Portal (docs.x.com) for the current
  pricing and limits before deploying.

## Rate limits

The X API rate-limits timeline reads (per app / per user, on a rolling
15-minute window; exact numbers depend on the endpoint). To stay well within the
limits, this service:

- caches successful responses in memory for `CACHE_TTL_SECONDS` (default 60s),
  keyed by username + filter settings,
- caches the username → ID resolution for the lifetime of the process,
- retries an upstream `429` up to `TWITTER_MAX_RETRIES` times (default 3) with
  exponential backoff, honouring the API's `Retry-After` header when present,
  up to the configured per-wait cap;
  each single wait is capped at 30 s by default, and the total waiting time per call is
  additionally capped by `TWITTER_RETRY_BUDGET_MS` (default 90 s), so a long
  `Retry-After` cannot keep a request hanging indefinitely,
- if the limit persists, maps the `429` to a clean `503 rate_limited` response
  (propagating `Retry-After` to the caller when available) instead of
  hammering the API,
- times out any single X API request after `TWITTER_TIMEOUT_MS` (default 10s),
- and bounds the whole handling of one incoming request by a single overall
  deadline, `TWITTER_DEADLINE_MS` (default 60s), shared by the username
  lookup and the timeline fetch and covering every attempt and every retry
  wait of both calls: an in-flight attempt is cut off at the deadline and a
  retry wait that would cross it is not taken, so a single incoming request
  can never occupy the server for longer than that.

---

## Running it publicly (access control & cost)

Out of the box this service has **no caller authentication**, and every
uncached `/latest-tweet` request spends real money on the X API (pay-per-use:
a user lookup plus post reads). Do not expose it to the public internet
as-is. For a public deployment, combine:

- **Caller authentication** — set `APP_API_KEY` to a long random string;
  `/latest-tweet` then requires that value in the `x-api-key` header and
  answers `401 unauthorized` otherwise. (`/health` stays open for load
  balancers.) This is a basic shared-secret gate, not a user system — put a
  real gateway / reverse proxy in front for anything stronger.
- **Rate limiting** — enforce per-caller request limits at your reverse
  proxy or gateway (e.g. nginx `limit_req`). The built-in response cache
  already collapses identical sequential requests within
  `CACHE_TTL_SECONDS`, but it does not merge simultaneous in-flight
  requests for the same user (each still costs its own upstream calls),
  and it is not a rate limiter.
- **Spending caps on the X side** — billing is pay-per-use against prepaid
  credit in the X Developer Console. Keep only the credit you are willing
  to spend there and review usage regularly. The prepaid balance works as
  a hard cap only while nothing tops it up automatically: if an
  auto-recharge (automatic top-up) option is enabled for the account in
  the console, turn it off — with auto-recharge on, spending continues
  past the initial balance and the balance by itself caps nothing. In
  addition, set a **Spending limit** in the Developer Console: it caps
  spend per billing cycle independently of the prepaid balance, so it
  still bounds the damage if credit remains (or is topped up) when a
  deployment misbehaves. Treat the two as separate caps and set both.

---

## Project structure

```
express-twitter-endpoint/
├── package.json
├── .env.example          # template — copy to .env
├── README.md
├── src/
│   ├── server.js         # entry point (env -> client -> app -> listen)
│   ├── app.js            # Express app: /latest-tweet, /health, cache, error mapping
│   └── twitterClient.js  # minimal X API v2 client (injectable fetch for testing)
└── test/
    ├── app.test.js         # integration tests (mocked X API, real HTTP)
    ├── twitterClient.test.js # unit tests for the API client
    ├── hardening.test.js   # retry/timeout/validation/error-hygiene tests
    ├── review2.test.js     # retry-cap defaults, log format, README plan-requirement guard
    ├── review3.test.js     # username contract, response classification, body-read timeout, retry budget
    ├── review4.test.js     # username type validation, 200-shape validation, overall deadline, API key gate
    ├── review5.test.js     # shared deadline across both stages, required-field guarantees, billing-cap wording
    └── review6.test.js     # no attempt after the deadline, README error-classification / Retry-After / Spending-limit wording, lockfile engines
```

## Notes

- Tweet data comes from the official X API v2 — no scraping is involved.
- Response classification is status-first: any non-2xx answer from X is an
  error carrying that status. A `200` is not trusted by status alone: the
  X API can answer `200` with an `errors` array and no `data` (e.g. for a
  suspended account), and this service also validates the success shape —
  the body must be a JSON object, a user lookup must return a user object
  with string `id`, `username` and `name`, a timeline's `data` (when
  present) must be an array, and a tweet entry is only used when it
  carries string `id`, `text` and `created_at` — so every field of the
  documented success response is always present. The consequences differ
  by level, though: a malformed user object, or a timeline whose `data`
  is present but not an array, is an upstream error (`502 upstream_error`,
  detail in the server log), never "user not found" or "no tweets"; a
  malformed individual tweet entry is simply skipped, and if no valid
  entry remains the answer is `404 no_tweets_found` even though the
  upstream returned entries. A
  `200` with both `data` and `errors` is a partial success and the `data`
  is used. One honest limitation: a shape-valid but semantically empty
  success response is indistinguishable from a genuinely empty timeline —
  for timelines, a `200` with no `data` field at all is exactly the API's
  empty-result shape and yields `404 no_tweets_found`.
- Timeouts are not retried (only `429` is). The per-request timeout covers
  reading the response body as well; a body that stalls past the timeout
  is reported as a timeout, not as an empty result.
- Server-side error logs go to stderr with an ISO 8601 timestamp and a
  per-request ID (`requestId=...`), and each upstream 429 retry is logged
  as a warning with its attempt number and wait time, so a failing request
  can be followed in plain `console` output or any log pipeline.
- If the target user posts rarely, the "latest" tweet may be old; that is the
  API's data, not a caching artifact (the `cached` flag and `CACHE_TTL_SECONDS`
  make the cache window explicit).
