# Express Twitter Endpoint

## Overview

A single-endpoint Express.js service that returns the latest tweet of a given X (Twitter) user as JSON, using the official X API v2. The target user defaults to `@elonmusk` and can be changed via configuration or per request. It returns the tweet text, timestamp, permalink, and author information. No scraping is involved; only the official API is used.

Note: paid X API access is required. Billing is pay-per-use — each read is charged per resource returned — and X API pricing changes over time, so check the X Developer Portal for the current rates. A Bearer Token from an X Developer App is needed.

## Features

- `GET /latest-tweet`: returns the user's most recent tweet. `GET /health`: returns `{ "status": "ok" }` — a liveness check of the server process only; it does not verify X API reachability, Bearer Token validity, or credit balance.
- Per-request overrides: the `username` query parameter (validated) selects a different user. The `username` is a screen name, not a numeric user ID; a single leading `@` is accepted and stripped. `exclude_retweets` / `exclude_replies` override the retweet/reply handling.
- Rate-limit protection: successful responses are cached in memory (default 60 seconds), and username → ID resolutions are cached for the lifetime of the process.
- Retries and deadlines: HTTP 429 responses are retried with exponential backoff; the client honours `Retry-After` up to the configured cap — each wait is limited to up to the configured per-wait cap (default 30 s). A `Retry-After` longer than the cap is therefore not waited out in full, so this does not guarantee avoiding rate limits. The total waiting time per upstream call is capped by `TWITTER_RETRY_BUDGET_MS` (default 90,000 ms), and an overall request deadline (`TWITTER_DEADLINE_MS`, default 60,000 ms — normally the binding limit) applies: the username lookup and the timeline fetch share a single deadline, and no attempt is started after the deadline has passed.
- Optional access gate: when `APP_API_KEY` is set, `/latest-tweet` requires that value in the `x-api-key` header (`/health` stays open).
- Response shape validation: even an HTTP 200 body is validated; only responses carrying the required fields (author `id` / `username` / `name`; tweet `id` / `text` / `created_at`) are treated as success. A malformed user object, or a timeline whose `data` is present but not an array, is an upstream error (502); a malformed individual tweet entry is simply skipped, and if no valid entry remains the answer is `404 no_tweets_found`.
- Error mapping: 400 for invalid input, 401 for the API key gate, 404 for a missing user or no matching tweets, 502 for upstream authentication and other API failures, 503 when the rate limit persists after retries.

## Usage

Requirements: Node.js 20.6.0 or newer (the start scripts use Node's built-in `--env-file` flag).

```bash
npm install
cp .env.example .env   # set your X API Bearer Token in .env
npm start              # listens on http://localhost:3000
```

```bash
curl "http://localhost:3000/latest-tweet"
curl "http://localhost:3000/latest-tweet?username=nasa&exclude_replies=include"
```

Main configuration (`.env`):

| Variable | Default | Description |
|---|---|---|
| `TWITTER_BEARER_TOKEN` | (required) | Bearer Token of your X Developer App |
| `TWITTER_USERNAME` | `elonmusk` | Default target user (screen name) |
| `EXCLUDE_RETWEETS` / `EXCLUDE_REPLIES` | `exclude` | Default handling of retweets / replies |
| `CACHE_TTL_SECONDS` | `60` | Response cache TTL in seconds |
| `TWITTER_TIMEOUT_MS` | `10000` | Timeout per X API call |
| `TWITTER_MAX_RETRIES` | `3` | Retries on HTTP 429 |
| `TWITTER_RETRY_BUDGET_MS` | `90000` | Cap on the total waiting time between 429 retries of one call (the overall deadline usually binds first) |
| `TWITTER_DEADLINE_MS` | `60000` | Overall deadline for handling one request |
| `APP_API_KEY` | (unset) | When set, requires the `x-api-key` header |
| `PORT` | `3000` | Listening port |

Development mode (auto-restart on file changes): `npm run dev`.

## Tech stack

- Node.js (>= 20.6.0), Express 4, CommonJS
- Uses two read-only X API v2 endpoints (username → ID resolution, user timeline) with app-only Bearer Token authentication; no user login and no write permissions.
- Tests run on Node's built-in test runner (`node --test`); no extra test tooling is needed.
- Layout: `src/server.js` (entry point), `src/app.js` (Express app, cache, error mapping), `src/twitterClient.js` (X API client).

## Tests

```bash
npm test
```

- The suite has 80 tests across 8 files under `test/`. The X API is mocked, so the tests run fully offline and need no token.
- Coverage includes endpoint integration tests (real HTTP against a mocked X API), unit tests for the API client, and hardening tests for retries, timeouts, input validation, the overall deadline, the API key gate, and response shape validation.

## Verified scope & limitations

- **No acceptance test against the real X API has been performed.** All tests run against mocks; the service has not been verified with a real Bearer Token against the production API. Verify it with your own token before deploying.
- There is one unresolved field-name question: the code sends `tweet.fields`, while the current official X API reference documents `post.fields` for this endpoint. Which form the live API accepts has not been confirmed.
- Long posts: the code does not fetch the long-form text field (`note_tweet`), so the full text of long posts is not guaranteed to be returned.
- Billing caps: billing is pay-per-use against prepaid Developer Console credit. If auto-recharge is enabled, the prepaid balance is not a spending cap, because it is topped up automatically. Set a Spending limit in the Developer Console as a separate cap, independent of the balance.
- "Latest tweet" selection: one timeline request with `max_results=5`, returning the first well-formed entry. There is no pagination: if all returned entries are filtered out or malformed, the answer is `404 no_tweets_found` even though older tweets may exist.
- Simultaneous in-flight requests for the same user are not merged by the cache (only sequential requests are). The service has no caller rate limiting of its own; for public deployment, combine a reverse proxy rate limit with `APP_API_KEY`.
- X API pricing and terms change over time; check the X Developer Portal for the current conditions.

---

## Development

This project was developed with AI assistance and went through multiple rounds of code review and revision. Detailed development notes are kept in `README.dev.md`.
