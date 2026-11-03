'use strict';

/**
 * Entry point.
 *
 * Environment variables are loaded from ".env" via Node's built-in
 * `--env-file` flag (see the "start" / "dev" scripts in package.json),
 * so no dotenv dependency is needed on Node.js >= 20.6.0 (the version
 * that introduced `--env-file`).
 *
 * This is the no-API-key version: there is no X credential to
 * configure. The data source is the public syndication feed (see
 * src/twitterClient.js and the README's "Limitations" section).
 */

const { TwitterClient, createApp, parseFlag } = require('./index');

const username = (process.env.TWITTER_USERNAME || 'elonmusk').replace(/^@/, '');
const cacheTtlSeconds = Number(process.env.CACHE_TTL_SECONDS || '60');
const port = Number(process.env.PORT || '3000');
// Bind to loopback by default: the standalone server is meant for
// local / trusted-network use. Set HOST=0.0.0.0 to expose it — and
// set APP_API_KEY when you do.
const host = process.env.HOST || '127.0.0.1';

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(n) ? n : fallback;
}

const client = new TwitterClient({
  timeoutMs: envNumber('UPSTREAM_TIMEOUT_MS', 10_000),
  maxRetries: envNumber('UPSTREAM_MAX_RETRIES', 3),
  retryBudgetMs: envNumber('UPSTREAM_RETRY_BUDGET_MS', 90_000),
  deadlineMs: envNumber('REQUEST_DEADLINE_MS', 60_000),
});

const app = createApp({
  client,
  username,
  excludeRetweets: parseFlag(process.env.EXCLUDE_RETWEETS, true),
  excludeReplies: parseFlag(process.env.EXCLUDE_REPLIES, true),
  cacheTtlMs: Number.isFinite(cacheTtlSeconds) ? cacheTtlSeconds * 1000 : 60_000,
  // Optional shared secret for /latest-tweet (x-api-key header). Unset =
  // no authentication, suitable for local / trusted-network use only.
  apiKey: process.env.APP_API_KEY || undefined,
});

app.listen(port, host, () => {
  console.log(`express-twitter-endpoint (no-key syndication version) listening on http://${host}:${port}`);
  console.log(`  GET /latest-tweet           -> latest tweet of @${username}`);
  console.log(`  GET /latest-tweet?username= -> any other public user`);
});
