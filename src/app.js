'use strict';

const express = require('express');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { TwitterApiError } = require('./twitterClient');

/**
 * Server-side error log with an ISO 8601 timestamp prefix, so log lines stay
 * traceable even without an external log pipeline adding timestamps.
 */
function logError(...args) {
  console.error(`[${new Date().toISOString()}]`, ...args);
}

/** X usernames: 1-15 characters, letters / digits / underscore only. */
const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

function isValidUsername(username) {
  return typeof username === 'string' && USERNAME_PATTERN.test(username);
}

/** Constant-time comparison for the optional shared-secret API key. */
function apiKeyMatches(provided, expected) {
  if (typeof provided !== 'string' || provided === '' || typeof expected !== 'string') {
    return false;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Parse "exclude" / "include" style flags from env strings or query params. */
function parseFlag(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const v = String(value).toLowerCase();
  if (v === 'exclude' || v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'include' || v === 'false' || v === '0' || v === 'no') return false;
  return defaultValue;
}

/**
 * Build the Express app.
 *
 * @param {object} options
 * @param {object} options.client - TwitterClient instance
 * @param {string} options.username - default username (without "@")
 * @param {boolean} [options.excludeRetweets=true] - default handling of retweets
 * @param {boolean} [options.excludeReplies=true] - default handling of replies
 * @param {number} [options.cacheTtlMs=60000] - in-memory response cache TTL
 * @param {string} [options.apiKey] - optional shared secret; when set,
 *   /latest-tweet requires it in the `x-api-key` header (401 otherwise).
 *   Leave unset for local / trusted-network use. (/health stays open.)
 */
function createApp({
  client,
  username,
  excludeRetweets = true,
  excludeReplies = true,
  cacheTtlMs = 60_000,
  apiKey = null,
} = {}) {
  const requiredApiKey = typeof apiKey === 'string' && apiKey !== '' ? apiKey : null;
  if (!client) throw new Error('createApp requires a TwitterClient instance.');
  if (!username) throw new Error('createApp requires a default username.');
  if (!isValidUsername(String(username).replace(/^@/, ''))) {
    throw new Error(
      `createApp received an invalid default username: "${username}" (1-15 chars: letters, digits, underscore).`
    );
  }

  const app = express();
  app.disable('x-powered-by');

  // Simple in-memory cache: key -> { expiresAt, payload }
  // Protects the X API quota (user timeline reads are rate limited per user/app).
  const cache = new Map();

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Optional shared-secret gate for the (paid) upstream-backed endpoint.
  if (requiredApiKey) {
    app.use('/latest-tweet', (req, res, next) => {
      if (!apiKeyMatches(req.get('x-api-key'), requiredApiKey)) {
        return res.status(401).json({
          error: 'unauthorized',
          message: 'A valid API key is required (send it in the x-api-key header).',
        });
      }
      return next();
    });
  }

  app.get('/latest-tweet', async (req, res) => {
    // Per-request identifier, included in server-side error logs so a single
    // failing request can be traced across log lines.
    const requestId = randomUUID();
    // The query parser can deliver non-string values here (an array for
    // "?username=a&username=b", an object for "?username[x]=y"). Validate
    // the TYPE before touching the value: calling .replace() on such a
    // value throws, and an exception at this point (outside the try block,
    // in an async Express 4 handler) would leave the request unanswered.
    const queryUsername = req.query.username;
    if (
      queryUsername !== undefined &&
      queryUsername !== null &&
      queryUsername !== '' &&
      typeof queryUsername !== 'string'
    ) {
      return res.status(400).json({
        error: 'invalid_username',
        message:
          'Invalid username. Pass exactly one username as a string (1-15 characters: letters, digits and underscores only).',
      });
    }
    const targetUsername = (
      typeof queryUsername === 'string' && queryUsername !== '' ? queryUsername : String(username)
    ).replace(/^@/, '');
    if (!isValidUsername(targetUsername)) {
      return res.status(400).json({
        error: 'invalid_username',
        message:
          'Invalid username. X usernames are 1-15 characters: letters, digits and underscores only.',
      });
    }
    const exRetweets = parseFlag(req.query.exclude_retweets, excludeRetweets);
    const exReplies = parseFlag(req.query.exclude_replies, excludeReplies);

    const cacheKey = `${targetUsername}|rt:${exRetweets}|rp:${exReplies}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json({ ...cached.payload, cached: true });
    }

    try {
      // The username lookup and the timeline fetch share ONE overall
      // deadline (TWITTER_DEADLINE_MS): a single deadlineAt is taken here
      // and threaded through both calls, so the deadline bounds the whole
      // handling of this request, not each upstream call separately.
      const deadlineAt =
        typeof client.operationDeadlineAt === 'function' ? client.operationDeadlineAt() : undefined;
      const user = await client.getUserByUsername(targetUsername, { deadlineAt });
      const tweet = await client.getLatestTweet(user.id, {
        excludeRetweets: exRetweets,
        excludeReplies: exReplies,
        deadlineAt,
      });

      if (!tweet) {
        return res.status(404).json({
          error: 'no_tweets_found',
          message: `No tweets found for @${targetUsername} with the current filters.`,
        });
      }

      const payload = {
        id: tweet.id,
        text: tweet.text,
        created_at: tweet.created_at,
        url: `https://twitter.com/${user.username}/status/${tweet.id}`,
        author: { id: user.id, username: user.username, name: user.name },
        cached: false,
      };

      if (cacheTtlMs > 0) {
        cache.set(cacheKey, { expiresAt: Date.now() + cacheTtlMs, payload });
      }
      return res.json(payload);
    } catch (err) {
      if (err instanceof TwitterApiError) {
        // Rate limited by X -> tell our caller to back off, don't leak internals.
        if (err.status === 429) {
          if (err.retryAfterMs !== null && err.retryAfterMs !== undefined) {
            res.set('Retry-After', String(Math.max(1, Math.ceil(err.retryAfterMs / 1000))));
          }
          return res.status(503).json({
            error: 'rate_limited',
            message: 'The X API rate limit was reached. Please retry shortly.',
          });
        }
        if (err.status === 401 || err.status === 403) {
          return res.status(502).json({
            error: 'upstream_auth_error',
            message:
              'The X API rejected the configured Bearer Token (unauthorized or insufficient access level).',
          });
        }
        if (err.status === 404) {
          return res.status(404).json({
            error: 'user_not_found',
            message: `User "@${targetUsername}" was not found on X.`,
          });
        }
        // Any other upstream failure: the detailed message (which can contain
        // upstream response text) goes to the server log only; the client
        // receives a generalized message.
        logError(
          `X API error in /latest-tweet (requestId=${requestId}, username=${targetUsername}, status=${err.status}, code=${err.code || 'none'}): ${err.message}`
        );
        return res.status(502).json({
          error: 'upstream_error',
          message: 'The X API request failed. Please retry later.',
        });
      }
      // Unexpected error
      logError(`Unexpected error in /latest-tweet (requestId=${requestId}, username=${targetUsername}):`, err);
      return res.status(500).json({
        error: 'internal_error',
        message: 'An unexpected error occurred.',
      });
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'Unknown route.' });
  });

  return app;
}

module.exports = { createApp, parseFlag, isValidUsername, apiKeyMatches };
