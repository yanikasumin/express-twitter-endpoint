'use strict';

/**
 * Entry point.
 *
 * Environment variables are loaded from ".env" via Node's built-in
 * `--env-file` flag (see the "start" / "dev" scripts in package.json),
 * so no dotenv dependency is needed on Node.js >= 20.6.0 (the version
 * that introduced `--env-file`).
 */

const { TwitterClient } = require('./twitterClient');
const { createApp, parseFlag } = require('./app');

const bearerToken = process.env.TWITTER_BEARER_TOKEN;
if (!bearerToken) {
  console.error(
    'ERROR: TWITTER_BEARER_TOKEN is not set. Copy .env.example to .env and fill in your X API Bearer Token.'
  );
  process.exit(1);
}

const username = (process.env.TWITTER_USERNAME || 'elonmusk').replace(/^@/, '');
const cacheTtlSeconds = Number(process.env.CACHE_TTL_SECONDS || '60');
const port = Number(process.env.PORT || '3000');

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(n) ? n : fallback;
}

const client = new TwitterClient({
  bearerToken,
  timeoutMs: envNumber('TWITTER_TIMEOUT_MS', 10_000),
  maxRetries: envNumber('TWITTER_MAX_RETRIES', 3),
  retryBudgetMs: envNumber('TWITTER_RETRY_BUDGET_MS', 90_000),
  deadlineMs: envNumber('TWITTER_DEADLINE_MS', 60_000),
});

const app = createApp({
  client,
  username,
  excludeRetweets: parseFlag(process.env.EXCLUDE_RETWEETS, true),
  excludeReplies: parseFlag(process.env.EXCLUDE_REPLIES, true),
  cacheTtlMs: Number.isFinite(cacheTtlSeconds) ? cacheTtlSeconds * 1000 : 60_000,
  // Optional shared secret for /latest-tweet (x-api-key header). Unset =
  // no authentication, suitable for local / trusted-network use only.
  apiKey: process.env.APP_API_KEY || null,
});

app.listen(port, () => {
  console.log(`express-twitter-endpoint listening on http://localhost:${port}`);
  console.log(`  GET /latest-tweet           -> latest tweet of @${username}`);
  console.log(`  GET /latest-tweet?username= -> any other public user`);
});
