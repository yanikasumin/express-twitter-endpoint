'use strict';

/**
 * HTTP layer — deliberately thin and embeddable.
 *
 * Three levels of reuse, from loosest to tightest coupling:
 *
 *  1. `createApp(options)` — a complete Express application with
 *     /health, /latest-tweet and a JSON 404 fallback. Either listen on
 *     it directly (that is all src/server.js does) or mount it inside
 *     a larger application: `host.use('/x', createApp({ ... }))`.
 *
 *  2. `createLatestTweetHandler(options)` — just the /latest-tweet
 *     route handler, for hosts that already have an Express app and
 *     want the endpoint on their own router, under their own path,
 *     behind their own middleware: `host.get('/posts/latest', handler)`.
 *     Authentication, logging policy and 404 handling stay the host's.
 *
 *  3. The data client itself (`require('./twitterClient')`) — no HTTP
 *     at all; see src/index.js for the full library surface.
 *
 * Nothing in this module listens on a port or reads the environment:
 * every knob is an explicit option, so embedding hosts keep control.
 */

const express = require('express');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { TwitterApiError } = require('./twitterClient');

/**
 * Default server-side error log with an ISO 8601 timestamp prefix, so
 * log lines stay traceable even without an external log pipeline.
 * Hosts can inject their own via the `logger` option.
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

function validateHandlerOptions({ client, username }) {
  if (!client || typeof client.getLatestPost !== 'function') {
    throw new Error('createApp/createLatestTweetHandler requires a client with getLatestPost().');
  }
  if (!username) throw new Error('createApp/createLatestTweetHandler requires a default username.');
  if (!isValidUsername(String(username).replace(/^@/, ''))) {
    throw new Error(
      `Invalid default username: "${username}" (1-15 chars: letters, digits, underscore).`
    );
  }
}

/**
 * Build the /latest-tweet route handler.
 *
 * @param {object} options
 * @param {object} options.client - client with getLatestPost() (e.g. TwitterClient)
 * @param {string} options.username - default username (without "@")
 * @param {boolean} [options.excludeRetweets=true] - default handling of retweets
 * @param {boolean} [options.excludeReplies=true] - default handling of replies
 * @param {number} [options.cacheTtlMs=60000] - in-memory response cache TTL;
 *   0 disables the cache. The cache lives in this handler instance, so
 *   separate mounts never share entries.
 * @param {Function} [options.logger] - error logger (defaults to a
 *   timestamped console.error); upstream error details go here only,
 *   never into HTTP responses.
 * @returns {(req: object, res: object) => Promise<void>} Express handler
 */
function createLatestTweetHandler({
  client,
  username,
  excludeRetweets = true,
  excludeReplies = true,
  cacheTtlMs = 60_000,
  logger = logError,
} = {}) {
  validateHandlerOptions({ client, username });
  const defaultUsername = String(username).replace(/^@/, '');

  // Simple in-memory cache: key -> { expiresAt, payload }
  // Protects the upstream feed, which enforces a strict per-IP rate limit.
  // Bounded (oldest entry evicted) so a long-lived handler cannot grow
  // it without limit; keys use the lower-cased username because X
  // screen names are case-insensitive.
  const cache = new Map();
  const MAX_CACHE_ENTRIES = 500;

  return async function latestTweetHandler(req, res) {
    // Per-request identifier, included in server-side error logs so a
    // single failing request can be traced across log lines.
    const requestId = randomUUID();
    // The query parser can deliver non-string values here (an array for
    // "?username=a&username=b", an object for "?username[x]=y"). Validate
    // the TYPE before touching the value: calling .replace() on such a
    // value throws, and an exception at this point (outside the try
    // block, in an async Express 4 handler) would leave the request
    // unanswered.
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
      typeof queryUsername === 'string' && queryUsername !== '' ? queryUsername : defaultUsername
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

    const cacheKey = `${targetUsername.toLowerCase()}|rt:${exRetweets}|rp:${exReplies}`;
    if (cacheTtlMs > 0) {
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return res.json({ ...cached.payload, cached: true });
      }
    }

    try {
      // One upstream operation per request, bounded by ONE overall
      // deadline (REQUEST_DEADLINE_MS in the standalone server): a
      // single deadlineAt is taken here and threaded into the client
      // call, so the deadline bounds the whole handling of this
      // request, including any retries.
      const deadlineAt =
        typeof client.operationDeadlineAt === 'function' ? client.operationDeadlineAt() : undefined;
      const { user, tweet } = await client.getLatestPost(targetUsername, {
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
        if (cache.size > MAX_CACHE_ENTRIES) {
          cache.delete(cache.keys().next().value);
        }
      }
      return res.json(payload);
    } catch (err) {
      if (err instanceof TwitterApiError) {
        // Rate limited upstream -> tell our caller to back off.
        if (err.status === 429) {
          if (err.retryAfterMs !== null && err.retryAfterMs !== undefined) {
            res.set('Retry-After', String(Math.max(1, Math.ceil(err.retryAfterMs / 1000))));
          }
          return res.status(503).json({
            error: 'rate_limited',
            message: 'The upstream feed rate limit was reached. Please retry shortly.',
          });
        }
        if (err.status === 404) {
          return res.status(404).json({
            error: 'user_not_found',
            message: `User "@${targetUsername}" was not found on X.`,
          });
        }
        // Any other upstream failure: the detailed message (which can
        // contain upstream response text) goes to the server log only;
        // the client receives a generalized message.
        logger(
          `Upstream error in /latest-tweet (requestId=${requestId}, username=${targetUsername}, status=${err.status}, code=${err.code || 'none'}): ${err.message}`
        );
        return res.status(502).json({
          error: 'upstream_error',
          message: 'The upstream feed request failed. Please retry later.',
        });
      }
      // Unexpected error
      logger(`Unexpected error in /latest-tweet (requestId=${requestId}, username=${targetUsername}):`, err);
      return res.status(500).json({
        error: 'internal_error',
        message: 'An unexpected error occurred.',
      });
    }
  };
}

/**
 * Build the complete Express application.
 *
 * Accepts every option of createLatestTweetHandler, plus:
 * @param {string} [options.apiKey] - optional shared secret; when set,
 *   /latest-tweet requires it in the `x-api-key` header (401 otherwise).
 *   Leave unset for local / trusted-network use. (/health stays open.)
 *   Hosts that mount the handler directly do their own authentication.
 */
function createApp(options = {}) {
  const { apiKey } = options;
  const requiredApiKey = typeof apiKey === 'string' && apiKey !== '' ? apiKey : null;
  const handler = createLatestTweetHandler(options);

  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Optional shared-secret gate for the upstream-backed endpoint.
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

  app.get('/latest-tweet', handler);

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'Unknown route.' });
  });

  return app;
}

module.exports = {
  createApp,
  createLatestTweetHandler,
  parseFlag,
  isValidUsername,
  apiKeyMatches,
};
