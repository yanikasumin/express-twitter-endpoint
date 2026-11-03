'use strict';

/**
 * Minimal X (Twitter) API v2 client.
 *
 * - Resolves a username to a user id (GET /2/users/by/username/:username)
 * - Fetches the most recent tweet of a user (GET /2/users/:id/tweets)
 *
 * Reliability behaviour:
 * - Every request has a timeout (AbortController) that covers the whole
 *   attempt, including reading the response body; a timed-out request is
 *   surfaced as a TwitterApiError with `code === 'ETIMEDOUT'` and is NOT
 *   retried (only HTTP 429 is retried; these are idempotent GETs, so a
 *   retry could never create a duplicate anyway).
 * - HTTP error statuses are classified by the status code first: a non-2xx
 *   response always throws a TwitterApiError carrying that status, whatever
 *   its body looks like. A 2xx response whose body carries an `errors`
 *   array but no `data` (the X API does this e.g. for suspended accounts)
 *   is also an error (`code === 'EUPSTREAMERRORS'`), never an empty result.
 * - HTTP 429 (rate limited) responses are retried with exponential backoff.
 *   A `Retry-After` header from the API takes precedence over the computed
 *   backoff; each single wait is capped by `retryMaxDelayMs`, the number of
 *   retries is capped by `maxRetries`, and the TOTAL time spent waiting
 *   between retries is capped by `retryBudgetMs`.
 * - Independently of the per-attempt timeout and the retry-wait budget, one
 *   whole call (all attempts + all waits) is bounded by an overall deadline
 *   (`deadlineMs`, default 60 s): an attempt's timeout is shrunk to the
 *   time remaining, a retry wait that would cross the deadline is not
 *   taken, and an attempt cut off by the deadline is reported with
 *   `code === 'EDEADLINE'`. The two-stage endpoint operation (username
 *   resolution + timeline fetch) shares ONE deadline across both stages
 *   when the caller threads a single `operationDeadlineAt()` value
 *   through both calls (the Express app does), so the deadline bounds
 *   the whole operation, not each stage separately.
 * - A 2xx response is not trusted by status alone: its body must be a JSON
 *   object, a user lookup must yield a user object with a string `id`, and
 *   a timeline payload's `data` (when present) must be an array. Anything
 *   else is an upstream anomaly (`code === 'EBADRESPONSE'`), never an
 *   empty result or a "not found". (A timeline 2xx WITHOUT `data` is the
 *   API's genuine empty-result shape and still resolves to `null`.)
 *
 * The `fetch` implementation is injectable so tests can run fully offline
 * against mocked responses.
 */

const API_BASE = 'https://api.twitter.com/2';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;
// Total wait budget across all 429 retries of one call. The default equals
// the worst case the other defaults already allowed (3 retries x 30 s cap),
// so default behaviour is unchanged; the budget bites when maxRetries /
// retryMaxDelayMs are configured larger.
const DEFAULT_RETRY_BUDGET_MS = 90_000;
// Overall deadline for one whole operation (every attempt plus every
// wait of BOTH sequential lookups — username resolution and timeline
// fetch — which share a single deadline). 60 s is well above a normal
// operation (~2 x 10 s worst-case attempts) but far below the unbounded
// worst case the other knobs alone would allow (per stage: 4 attempts
// x 10 s + 90 s of waits = 130 s).
const DEFAULT_DEADLINE_MS = 60_000;

/** X usernames (screen names): 1-15 characters, letters / digits / underscore. */
const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

/**
 * Normalize a username argument to its canonical screen-name form.
 *
 * A username here is a screen name (e.g. "elonmusk") — NOT a numeric user
 * id. (Numeric ids are what `getLatestTweet(userId)` takes; they come from
 * resolving a username first.) A single leading "@" is accepted and
 * stripped, matching how users normally write handles. Anything that is
 * not a valid X username after that normalization is rejected with a
 * TwitterApiError (`code === 'EINVALIDUSERNAME'`) before any HTTP call.
 */
function normalizeUsername(username) {
  if (typeof username !== 'string') {
    throw new TwitterApiError('Username must be a string (a screen name such as "elonmusk", not a numeric user id).', {
      code: 'EINVALIDUSERNAME',
    });
  }
  const normalized = username.trim().replace(/^@/, '');
  if (!USERNAME_PATTERN.test(normalized)) {
    throw new TwitterApiError(
      `Invalid username "${username}". X usernames are 1-15 characters: letters, digits and underscores only (a leading "@" is allowed and stripped).`,
      { code: 'EINVALIDUSERNAME' }
    );
  }
  return normalized;
}

/** Parse a Retry-After header value (delta-seconds or HTTP-date) into ms. */
function parseRetryAfter(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return Math.max(0, t - now);
  return null;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TwitterApiError extends Error {
  constructor(message, { status = null, body = null, retryAfterMs = null, code = null } = {}) {
    super(message);
    this.name = 'TwitterApiError';
    this.status = status;           // HTTP status returned by the X API (if any)
    this.body = body;               // Parsed response body (if any)
    this.retryAfterMs = retryAfterMs; // Server-requested wait before retrying (if provided)
    this.code = code;               // Internal code, e.g. 'ETIMEDOUT' (if any)
  }
}

class TwitterClient {
  /**
   * @param {object} options
   * @param {string} options.bearerToken - X API v2 Bearer Token (required)
   * @param {Function} [options.fetchImpl] - fetch implementation (defaults to global fetch)
   * @param {string} [options.apiBase] - API base URL (overridable for testing)
   * @param {number} [options.timeoutMs=10000] - per-request timeout
   * @param {number} [options.maxRetries=3] - max retries on HTTP 429 (0 disables retrying)
   * @param {number} [options.retryBaseDelayMs=1000] - base delay for exponential backoff
   * @param {number} [options.retryMaxDelayMs=30000] - cap applied to any single wait
   * @param {number} [options.retryBudgetMs=90000] - cap on the TOTAL time spent waiting between 429 retries of one call
   * @param {number} [options.deadlineMs=60000] - overall deadline for one whole call (all attempts + waits); 0 / null / Infinity disables it
   * @param {Function} [options.sleepImpl] - sleep implementation (injectable for tests)
   */
  constructor({
    bearerToken,
    fetchImpl,
    apiBase,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    retryMaxDelayMs = DEFAULT_RETRY_MAX_DELAY_MS,
    retryBudgetMs = DEFAULT_RETRY_BUDGET_MS,
    deadlineMs = DEFAULT_DEADLINE_MS,
    sleepImpl,
  } = {}) {
    if (!bearerToken) {
      throw new Error('TWITTER_BEARER_TOKEN is required but was not provided.');
    }
    this.bearerToken = bearerToken;
    this.fetch = fetchImpl || globalThis.fetch;
    if (typeof this.fetch !== 'function') {
      throw new Error('No fetch implementation available (Node.js >= 18 required).');
    }
    this.apiBase = apiBase || API_BASE;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.maxRetries =
      Number.isFinite(maxRetries) && maxRetries >= 0 ? Math.floor(maxRetries) : DEFAULT_MAX_RETRIES;
    this.retryBaseDelayMs =
      Number.isFinite(retryBaseDelayMs) && retryBaseDelayMs >= 0
        ? retryBaseDelayMs
        : DEFAULT_RETRY_BASE_DELAY_MS;
    this.retryMaxDelayMs =
      Number.isFinite(retryMaxDelayMs) && retryMaxDelayMs >= 0
        ? retryMaxDelayMs
        : DEFAULT_RETRY_MAX_DELAY_MS;
    this.retryBudgetMs =
      Number.isFinite(retryBudgetMs) && retryBudgetMs >= 0 ? retryBudgetMs : DEFAULT_RETRY_BUDGET_MS;
    // deadlineMs: a finite positive number enables the deadline; an
    // explicitly non-positive or non-finite value disables it (null).
    this.deadlineMs =
      deadlineMs === null || deadlineMs === 0 || deadlineMs === Infinity
        ? null
        : Number.isFinite(deadlineMs) && deadlineMs > 0
          ? deadlineMs
          : DEFAULT_DEADLINE_MS;
    this.sleep = typeof sleepImpl === 'function' ? sleepImpl : defaultSleep;
    this._userIdCache = new Map(); // username (lowercase) -> user object
  }

  /** Read the Retry-After header from a fetch-style response, if present. */
  _retryAfterMs(res) {
    try {
      const headers = res && res.headers;
      if (!headers) return null;
      const value =
        typeof headers.get === 'function'
          ? headers.get('retry-after')
          : headers['retry-after'] !== undefined
            ? headers['retry-after']
            : headers['Retry-After'];
      return parseRetryAfter(value);
    } catch {
      return null;
    }
  }

  /**
   * Perform a single HTTP attempt (with timeout). Throws TwitterApiError
   * on failure. `timeoutMs` may be shrunk by the caller (`_get`) to the
   * time remaining until the overall deadline; `deadlineBound` marks that
   * case so an abort is classified as EDEADLINE, not ETIMEDOUT.
   */
  async _getOnce(path, { timeoutMs = this.timeoutMs, deadlineBound = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    let body = null;
    try {
      res = await this.fetch(`${this.apiBase}${path}`, {
        headers: { Authorization: `Bearer ${this.bearerToken}` },
        signal: controller.signal,
      });
      try {
        body = await res.json();
      } catch (parseErr) {
        if (controller.signal.aborted) {
          // The timeout fired while the body was still being received.
          // That is a timeout, not a "non-JSON body": rethrow so the outer
          // catch classifies it as ETIMEDOUT instead of silently treating
          // the response as empty.
          throw parseErr;
        }
        // Non-JSON body; leave body null.
      }
    } catch (err) {
      if (controller.signal.aborted || (err && err.name === 'AbortError')) {
        if (deadlineBound) {
          throw new TwitterApiError(
            `X API call exceeded its overall deadline of ${this.deadlineMs} ms.`,
            { code: 'EDEADLINE' }
          );
        }
        throw new TwitterApiError(`X API request timed out after ${timeoutMs} ms.`, {
          code: 'ETIMEDOUT',
        });
      }
      // Network failure. Deliberately generic: never include request headers
      // (which contain the Bearer token) in the error.
      throw new TwitterApiError(`Network error while calling the X API: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const detail =
        (body && body.detail) ||
        (body && body.title) ||
        (body && Array.isArray(body.errors) && body.errors[0] && body.errors[0].message) ||
        res.statusText;
      throw new TwitterApiError(`X API request failed (${res.status}): ${detail}`, {
        status: res.status,
        body,
        retryAfterMs: res.status === 429 ? this._retryAfterMs(res) : null,
      });
    }

    // A 2xx status alone does not make the body trustworthy: the X API
    // always answers with a JSON object, so a non-JSON body (parsed as
    // null above), a JSON array or a JSON scalar on a 2xx is an upstream
    // anomaly — never an empty result or a "not found".
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new TwitterApiError(
        `X API returned an unexpected response shape (HTTP ${res.status}): expected a JSON object.`,
        { status: res.status, body, code: 'EBADRESPONSE' }
      );
    }

    // The X API can answer 2xx with an `errors` array and no `data` at all
    // (documented e.g. for suspended accounts on user lookup). That is an
    // upstream error condition, not an empty result: surface it as such
    // instead of letting callers mistake it for "not found" / "no tweets".
    // (A 2xx body with BOTH `data` and `errors` is a partial success and
    // is returned as-is.)
    if (
      body &&
      Array.isArray(body.errors) &&
      body.errors.length > 0 &&
      (body.data === undefined || body.data === null)
    ) {
      const first = body.errors[0] || {};
      const detail = first.detail || first.message || first.title || 'unknown upstream error';
      throw new TwitterApiError(`X API returned errors without data (HTTP ${res.status}): ${detail}`, {
        status: res.status,
        body,
        code: 'EUPSTREAMERRORS',
      });
    }
    return body;
  }

  /**
   * GET a path, retrying HTTP 429 responses with backoff.
   * The server's Retry-After (when provided) wins over the computed backoff;
   * either way the wait is capped at retryMaxDelayMs.
   *
   * The retry count is strictly bounded: at most `maxRetries` retries
   * (default 3, configurable via the constructor / TWITTER_MAX_RETRIES),
   * i.e. at most `maxRetries + 1` HTTP attempts in total. Independently,
   * the total time spent WAITING between retries is bounded by
   * `retryBudgetMs` (default 90 s, TWITTER_RETRY_BUDGET_MS): if the next
   * wait would exceed the remaining budget, retrying stops and the last
   * 429 TwitterApiError is thrown (app.js maps it to a 503 response).
   * This loop can never retry indefinitely.
   *
   * On top of that, the whole call is bounded by `deadlineMs` (default
   * 60 s, TWITTER_DEADLINE_MS): each attempt's timeout is shrunk to the
   * time remaining until the deadline, a retry wait that would cross
   * the deadline is not taken (the last 429 is thrown instead), and once
   * the deadline has passed no further attempt is started at all
   * (EDEADLINE is thrown immediately). Whichever
   * of retryBudgetMs / deadlineMs binds first wins.
   *
   * `options.deadlineAt` lets a caller share ONE absolute deadline across
   * several sequential calls (the app threads a single
   * `operationDeadlineAt()` value through both stages of a request, so
   * the deadline covers the whole two-stage operation). When the
   * property is absent, a fresh deadline is computed from `deadlineMs`;
   * when it is null, the deadline is disabled for this call.
   */
  async _get(path, { deadlineAt: sharedDeadlineAt } = {}) {
    const deadlineAt =
      sharedDeadlineAt !== undefined
        ? sharedDeadlineAt
        : this.deadlineMs
          ? Date.now() + this.deadlineMs
          : null;
    let waitedMs = 0;
    for (let attempt = 0; ; attempt += 1) {
      let attemptTimeoutMs = this.timeoutMs;
      let deadlineBound = false;
      if (deadlineAt !== null) {
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) {
          // The deadline has already passed (e.g. an earlier stage of a
          // shared-deadline operation consumed the whole budget): do not
          // start another attempt at all — not even a 1 ms one.
          throw new TwitterApiError(
            'X API call not started: the overall deadline has already passed.',
            { code: 'EDEADLINE' }
          );
        }
        if (remainingMs < attemptTimeoutMs) {
          attemptTimeoutMs = remainingMs;
          deadlineBound = true;
        }
      }
      try {
        return await this._getOnce(path, { timeoutMs: attemptTimeoutMs, deadlineBound });
      } catch (err) {
        const retryable = err instanceof TwitterApiError && err.status === 429;
        if (!retryable || attempt >= this.maxRetries) {
          throw err;
        }
        const backoff = Math.min(this.retryBaseDelayMs * 2 ** attempt, this.retryMaxDelayMs);
        const waitMs = err.retryAfterMs !== null && err.retryAfterMs !== undefined
          ? Math.min(err.retryAfterMs, this.retryMaxDelayMs)
          : backoff;
        if (waitedMs + waitMs > this.retryBudgetMs) {
          console.warn(
            `[${new Date().toISOString()}] X API 429 for ${path}; retry budget exhausted ` +
              `(waited ${waitedMs} ms of ${this.retryBudgetMs} ms budget, next wait would be ${waitMs} ms); giving up`
          );
          throw err;
        }
        if (deadlineAt !== null && Date.now() + waitMs > deadlineAt) {
          console.warn(
            `[${new Date().toISOString()}] X API 429 for ${path}; overall deadline of ` +
              `${this.deadlineMs} ms would be exceeded by the next wait of ${waitMs} ms; giving up`
          );
          throw err;
        }
        console.warn(
          `[${new Date().toISOString()}] X API 429 for ${path}; retry ` +
            `${attempt + 1}/${this.maxRetries} in ${waitMs} ms`
        );
        waitedMs += waitMs;
        await this.sleep(waitMs);
      }
    }
  }

  /**
   * Resolve a username to its user object { id, name, username }.
   *
   * @param {string} username - the user's screen name (e.g. "elonmusk").
   *   This is the by-username lookup: the argument is a screen name, NOT a
   *   numeric user id (ids are the input of `getLatestTweet`). A single
   *   leading "@" is accepted and stripped; anything that is not a valid
   *   X username is rejected before any HTTP call (see normalizeUsername).
   * Results are cached in memory for the lifetime of the client.
   *
   * The returned user object is shape-guaranteed: `id`, `username` and
   * `name` are all strings (`id` and `username` non-empty). A 200 payload
   * that cannot provide them is an upstream anomaly (EBADRESPONSE), so
   * callers can build the documented response (permalink, author block)
   * without ever embedding an `undefined` field.
   *
   * @param {object} [options]
   * @param {number|null} [options.deadlineAt] - shared absolute deadline
   *   (ms epoch) for this call; see `_get`.
   */
  async getUserByUsername(username, { deadlineAt } = {}) {
    const normalized = normalizeUsername(username);
    const key = normalized.toLowerCase();
    if (this._userIdCache.has(key)) {
      return this._userIdCache.get(key);
    }
    const data = await this._get(
      `/users/by/username/${encodeURIComponent(normalized)}?user.fields=name,username`,
      { deadlineAt }
    );
    // A genuine "user not found" arrives as an HTTP 404 status and is
    // thrown by _getOnce before this point. A 200 whose payload does not
    // contain a usable user object is an upstream anomaly, NOT a
    // "not found": classify it as EBADRESPONSE (app.js maps it to 502).
    const user = data ? data.data : undefined;
    if (user === undefined || user === null) {
      throw new TwitterApiError(
        `X API returned no user object for "@${normalized}" (HTTP 200 without a "data" object).`,
        { status: 200, body: data, code: 'EBADRESPONSE' }
      );
    }
    if (
      typeof user !== 'object' ||
      Array.isArray(user) ||
      typeof user.id !== 'string' ||
      user.id === '' ||
      typeof user.username !== 'string' ||
      user.username === '' ||
      typeof user.name !== 'string'
    ) {
      throw new TwitterApiError(
        `X API returned a malformed user object for "@${normalized}" (missing string "id", "username" or "name").`,
        { status: 200, body: data, code: 'EBADRESPONSE' }
      );
    }
    this._userIdCache.set(key, user);
    return user;
  }

  /**
   * Fetch the latest tweet of a user.
   *
   * Entries with a malformed shape (missing string `id` / `text` /
   * `created_at`) are skipped; if no well-formed entry remains, the
   * result is `null`. A returned tweet therefore always carries the
   * fields the endpoint's documented response is built from.
   *
   * @param {string} userId
   * @param {object} [options]
   * @param {boolean} [options.excludeRetweets=true]
   * @param {boolean} [options.excludeReplies=true]
   * @param {number|null} [options.deadlineAt] - shared absolute deadline
   *   (ms epoch) for this call; see `_get`.
   * @returns {Promise<object|null>} the tweet object, or null if the user has no (matching) tweets
   */
  async getLatestTweet(userId, { excludeRetweets = true, excludeReplies = true, deadlineAt } = {}) {
    const excludes = [];
    if (excludeRetweets) excludes.push('retweets');
    if (excludeReplies) excludes.push('replies');

    const params = new URLSearchParams({
      max_results: '5',
      'tweet.fields': 'created_at,author_id',
    });
    if (excludes.length > 0) {
      params.set('exclude', excludes.join(','));
    }

    const data = await this._get(`/users/${encodeURIComponent(userId)}/tweets?${params.toString()}`, {
      deadlineAt,
    });
    if (!data || data.data === undefined || data.data === null) {
      // The X API omits `data` entirely when a timeline is empty
      // (only `meta.result_count: 0` is returned) — a genuine empty result.
      return null;
    }
    if (!Array.isArray(data.data)) {
      // `data` is present but not an array: an upstream anomaly, not an
      // empty timeline.
      throw new TwitterApiError(
        'X API returned a malformed timeline payload ("data" is not an array).',
        { status: 200, body: data, code: 'EBADRESPONSE' }
      );
    }
    const valid = data.data.filter(
      (t) =>
        t &&
        typeof t.id === 'string' &&
        t.id !== '' &&
        typeof t.text === 'string' &&
        typeof t.created_at === 'string' &&
        t.created_at !== ''
    );
    return valid.length > 0 ? valid[0] : null;
  }

  /**
   * The absolute deadline (ms epoch) for one whole operation, computed
   * from `deadlineMs` — or null when the deadline is disabled.
   *
   * A caller performing the two-stage operation (username resolution +
   * timeline fetch) for a single incoming request takes ONE value from
   * here and passes it as `deadlineAt` to both `getUserByUsername` and
   * `getLatestTweet`. The overall deadline then bounds the combined
   * operation instead of restarting at each stage.
   *
   * @returns {number|null}
   */
  operationDeadlineAt() {
    return this.deadlineMs ? Date.now() + this.deadlineMs : null;
  }
}

module.exports = { TwitterClient, TwitterApiError, API_BASE, parseRetryAfter, normalizeUsername };
