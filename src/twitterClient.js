'use strict';

/**
 * Syndication client — the no-API-key data source for this service.
 *
 * Instead of the official X API v2 (which requires a paid developer
 * contract and a Bearer token), this client reads the public profile
 * timeline feed that powers X's official embed widgets:
 *
 *   GET https://syndication.twitter.com/srv/timeline-profile/screen-name/:name
 *
 * That URL returns an HTML page whose embedded `__NEXT_DATA__` JSON
 * contains the profile's recent tweets in the legacy Twitter format.
 * No account, token or API key is involved.
 *
 * Consequences of using an unofficial feed (see README "Limitations"):
 *  - The page structure is not a documented API and can change or break
 *    without notice. Parsing is defensive and schema-checked: a page
 *    whose structure deviates from the measured shape is an upstream
 *    error (502), never a guessed result and never a "user not found".
 *    The ONE exception is the measured not-found signature — a
 *    well-formed page with no profile header and an empty entries
 *    array — which is what the feed returns for unknown accounts;
 *    those are reported user_not_found. A protected account
 *    (measured 2026-11-03) keeps its profile header with an empty
 *    timeline, so it resolves as a user with no visible posts.
 *  - The feed enforces its own per-IP rate limit (response headers
 *    observed 2026-11-03: `x-rate-limit-limit: 30` per 15-minute
 *    window). Retries honour `Retry-After` / `x-rate-limit-reset`,
 *    but a suggested wait longer than MAX_WAIT_MS is NOT shortened
 *    and retried early: the operation fails with a 429 error carrying
 *    the full suggested wait (the app maps it to 503 + Retry-After).
 *  - Only public accounts are visible.
 *
 * Reliability: one attempt = fetch + full body read, both inside the
 * same AbortController timeout (shrunk to the time left before the
 * operation deadline). A stalled body therefore cannot outlive the
 * deadline, and a body-read failure is classified as an upstream
 * error, never leaked to the HTTP layer as a bare exception.
 */

const DEFAULT_BASE_URL = 'https://syndication.twitter.com';

/** Sent so the feed serves the same page a browser widget would get. */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Cap on a single wait between retries, in milliseconds — and the
 * fail-fast threshold for 429 handling: when the upstream-suggested
 * wait exceeds this cap, the client does not wait a shortened time
 * and retry early (the rate limit would still be in force); it
 * surfaces the 429 at once with the full suggested wait attached.
 * This is a deliberate design decision, documented in the README.
 */
const MAX_WAIT_MS = 30_000;

/** X usernames: 1-15 characters, letters / digits / underscore only. */
const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

class TwitterApiError extends Error {
  constructor(message, { status = null, body = null, retryAfterMs = null, code = null } = {}) {
    super(message);
    this.name = 'TwitterApiError';
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
    this.code = code;
  }
}

/** Strip a single leading "@" and validate the result as an X username. */
function normalizeUsername(username) {
  if (typeof username !== 'string') return null;
  const name = username.replace(/^@/, '');
  return USERNAME_PATTERN.test(name) ? name : null;
}

/**
 * Parse a `Retry-After` header value (delta-seconds or HTTP-date) into
 * milliseconds from `now`. Returns null when absent or unparseable.
 */
function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - now);
  return null;
}

/**
 * Milliseconds until the rate-limit window resets, from the
 * `x-rate-limit-reset` header (epoch seconds). Null when absent.
 */
function rateLimitResetMs(headers, now = Date.now()) {
  if (!headers || typeof headers.get !== 'function') return null;
  const raw = headers.get('x-rate-limit-reset');
  if (raw === null || raw === undefined || raw === '') return null;
  const epochSeconds = Number(raw);
  if (!Number.isFinite(epochSeconds)) return null;
  return Math.max(0, Math.round(epochSeconds * 1000 - now));
}

/**
 * Extract and JSON-parse the `__NEXT_DATA__` block of a feed page.
 * The script tag is matched by its id attribute in any attribute
 * order (with possible extra attributes), so harmless markup changes
 * do not break the extraction.
 */
function parseNextData(html) {
  if (typeof html !== 'string') return null;
  // The id attribute must be a real attribute (preceded by
  // whitespace inside the tag): a plain \bid would also match the
  // "id" tail of data-id="__NEXT_DATA__" on some other element.
  const match = html.match(/<script[^>]*?\sid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/**
 * Normalise one legacy-format tweet object from the feed into the
 * internal shape used by the selection logic. Returns null for
 * entries that do not carry a usable tweet.
 */
function normalizeTweet(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id_str === 'string' && raw.id_str !== '' ? raw.id_str : null;
  const text =
    typeof raw.full_text === 'string' ? raw.full_text : typeof raw.text === 'string' ? raw.text : null;
  const createdMs = typeof raw.created_at === 'string' ? Date.parse(raw.created_at) : NaN;
  if (!id || text === null || !Number.isFinite(createdMs)) return null;
  const user = raw.user && typeof raw.user === 'object' ? raw.user : {};
  return {
    id,
    text,
    created_at: new Date(createdMs).toISOString(),
    createdMs,
    isRetweet:
      Boolean(raw.retweeted_status) || (typeof text === 'string' && text.startsWith('RT @')),
    isReply:
      raw.in_reply_to_status_id_str !== null &&
      raw.in_reply_to_status_id_str !== undefined &&
      raw.in_reply_to_status_id_str !== '',
    user: {
      id: typeof user.id_str === 'string' ? user.id_str : null,
      username: typeof user.screen_name === 'string' ? user.screen_name : null,
      name: typeof user.name === 'string' ? user.name : null,
    },
  };
}

/**
 * Pull the profile screen name and the normalised tweets out of a
 * parsed `__NEXT_DATA__` payload, WITH schema validation.
 *
 * Returns { screenName, headerState, tweets, malformed, entryCount,
 * rawTweetCount }:
 *  - `malformed` is true when the payload's shape deviates from the
 *    measured feed structure (no props.pageProps object, no timeline
 *    object, entries not an array, or entries that carry no tweet
 *    objects at all). Callers must treat that as an upstream error,
 *    NOT as "user not found".
 *  - `headerState` is 'valid' when a profile header with a non-empty
 *    screenName is present, 'absent' when there is no header object
 *    at all, and 'invalid' when a header object exists but carries
 *    no usable screenName. The measured pages have exactly two
 *    header shapes: 'valid' (any resolvable account, including
 *    protected ones) and 'absent' (unknown accounts, combined with
 *    an empty entries array). 'invalid' is unmeasured and treated
 *    as malformed by the caller.
 *  - The measured not-found signature is malformed=false,
 *    headerState='absent', entryCount=0 and tweets=[].
 */
function extractTimeline(data) {
  const bad = {
    screenName: null,
    headerState: 'absent',
    tweets: [],
    malformed: true,
    entryCount: 0,
    rawTweetCount: 0,
  };
  if (!data || typeof data !== 'object' || !data.props || typeof data.props !== 'object') return bad;
  const pageProps = data.props.pageProps;
  if (!pageProps || typeof pageProps !== 'object') return bad;
  if (!pageProps.timeline || typeof pageProps.timeline !== 'object') return bad;
  const entries = pageProps.timeline.entries;
  if (!Array.isArray(entries)) return bad;

  // Distinguish "property absent" (the measured not-found shape)
  // from "property present but not a usable object" (malformed):
  // headerProps: null or "corrupt" is invalid, not absent.
  const hasHeaderProp = Object.prototype.hasOwnProperty.call(pageProps, 'headerProps');
  const headerProps =
    hasHeaderProp && pageProps.headerProps && typeof pageProps.headerProps === 'object'
      ? pageProps.headerProps
      : null;
  const screenName =
    headerProps && typeof headerProps.screenName === 'string' && headerProps.screenName !== ''
      ? headerProps.screenName
      : null;
  const headerState = headerProps
    ? screenName
      ? 'valid'
      : 'invalid'
    : hasHeaderProp
      ? 'invalid'
      : 'absent';

  const tweets = [];
  let rawTweetCount = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    // Entries declare their kind; anything explicitly not a tweet is
    // not a post (cursors etc.). A missing type is tolerated.
    if (typeof entry.type === 'string' && entry.type !== 'tweet') continue;
    const raw = entry.content && typeof entry.content === 'object' ? entry.content.tweet : null;
    if (!raw || typeof raw !== 'object') continue;
    rawTweetCount += 1;
    const tweet = normalizeTweet(raw);
    if (tweet) tweets.push(tweet);
  }
  return {
    screenName,
    headerState,
    tweets,
    malformed: entries.length > 0 && rawTweetCount === 0,
    entryCount: entries.length,
    rawTweetCount,
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkOption(name, value, { min, integer = false }) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    (integer && !Number.isInteger(value))
  ) {
    throw new TypeError(
      `TwitterClient option "${name}" must be a ${integer ? 'integer ' : ''}number >= ${min}; got ${value}.`
    );
  }
}

class TwitterClient {
  /**
   * @param {object} [options]
   * @param {number} [options.timeoutMs=10000] - per-attempt timeout,
   *   covering the fetch AND the full body read
   * @param {number} [options.maxRetries=3] - retries after a failed attempt
   * @param {number} [options.retryBudgetMs=90000] - cap on the TOTAL time
   *   spent waiting between retries of one operation
   * @param {number} [options.deadlineMs=60000] - overall deadline for one
   *   getLatestPost operation; attempts and waits must fit inside it
   * @param {Function} [options.fetchImpl] - fetch implementation:
   *   inject a wrapped fetch to add proxies, logging, or a different
   *   transport without touching this client. Contract: like standard
   *   fetch, it must honour the AbortSignal it is given — the
   *   timeout/deadline control relies on that; a transport that
   *   ignores the signal cannot be stopped by this client.
   * @param {string} [options.baseUrl] - feed base URL: point the client
   *   at a mirror or a local stub of the feed
   * @param {string} [options.userAgent] - User-Agent sent to the feed
   * @param {Function} [options.sleepImpl] - sleep implementation (tests)
   * @param {Function} [options.nowFn] - clock (tests)
   */
  constructor({
    timeoutMs = 10_000,
    maxRetries = 3,
    retryBudgetMs = 90_000,
    deadlineMs = 60_000,
    fetchImpl = globalThis.fetch,
    baseUrl = DEFAULT_BASE_URL,
    userAgent = USER_AGENT,
    sleepImpl = defaultSleep,
    nowFn = Date.now,
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('TwitterClient requires a fetch implementation (global fetch on Node >= 18).');
    }
    checkOption('timeoutMs', timeoutMs, { min: 1 });
    checkOption('maxRetries', maxRetries, { min: 0, integer: true });
    checkOption('retryBudgetMs', retryBudgetMs, { min: 0 });
    checkOption('deadlineMs', deadlineMs, { min: 1 });
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.retryBudgetMs = retryBudgetMs;
    this.deadlineMs = deadlineMs;
    this.fetchImpl = fetchImpl;
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.userAgent = userAgent;
    this.sleepImpl = sleepImpl;
    this.nowFn = nowFn;
  }

  /** Absolute timestamp (ms) by which one whole operation must finish. */
  operationDeadlineAt() {
    return this.nowFn() + this.deadlineMs;
  }

  /**
   * One upstream attempt: fetch the timeline page AND read its whole
   * body under one AbortController timeout. Resolves { status, headers,
   * bodyText }. Throws TwitterApiError with code 'deadline_exceeded'
   * when the deadline has passed, 'upstream_timeout' when the attempt
   * was aborted by its own timeout, and 'upstream_network' for other
   * transport failures (including a body that fails mid-read).
   */
  async attemptFetch(url, deadlineAt) {
    const remainingMs = deadlineAt - this.nowFn();
    if (remainingMs <= 0) {
      throw new TwitterApiError('The upstream request deadline was exceeded.', {
        status: null,
        code: 'deadline_exceeded',
      });
    }
    const controller = new AbortController();
    const attemptTimeoutMs = Math.max(1, Math.min(this.timeoutMs, remainingMs));
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: controller.signal,
      });
      // Read the body for EVERY status while the timer is still armed:
      // a 200 needs the content anyway, and error bodies must be
      // consumed so the connection can be reused. A body that stalls
      // is aborted by the same timer and classified below.
      const bodyText = await response.text();
      return { status: response.status, headers: response.headers, bodyText };
    } catch (err) {
      if (err && err.name === 'AbortError') {
        if (this.nowFn() >= deadlineAt) {
          throw new TwitterApiError('The upstream request deadline was exceeded.', {
            status: null,
            code: 'deadline_exceeded',
          });
        }
        throw new TwitterApiError('The upstream feed request timed out.', {
          status: null,
          code: 'upstream_timeout',
        });
      }
      throw new TwitterApiError('The upstream feed request failed (network error).', {
        status: null,
        code: 'upstream_network',
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch the profile timeline page for `username`. Returns the page
   * HTML on HTTP 200. Retry policy:
   *  - HTTP 429: wait the upstream-suggested time (Retry-After, else
   *    the rate-limit reset, else exponential backoff) and retry —
   *    but ONLY when that wait fits MAX_WAIT_MS, the remaining retry
   *    budget and the deadline. A suggested wait beyond MAX_WAIT_MS
   *    fails fast: TwitterApiError status 429 with retryAfterMs set
   *    to the full suggested wait.
   *  - Transport failures (incl. timeouts): retried with short
   *    exponential backoff under the same budget/deadline rules.
   *  - HTTP 404: TwitterApiError status 404 (user_not_found).
   *  - Any other status: TwitterApiError carrying that status.
   */
  async fetchTimelineHtml(username, deadlineAt) {
    const url = `${this.baseUrl}/srv/timeline-profile/screen-name/${encodeURIComponent(username)}`;
    let waitedMs = 0;
    let backoffStep = 0;

    for (let attempt = 0; ; attempt += 1) {
      let result;
      try {
        result = await this.attemptFetch(url, deadlineAt);
      } catch (err) {
        // Deadline expiry is final; other transport failures retry.
        if (err.code === 'deadline_exceeded') throw err;
        if (attempt < this.maxRetries) {
          const waitMs = Math.min(MAX_WAIT_MS, 500 * 2 ** backoffStep);
          backoffStep += 1;
          if (waitedMs + waitMs <= this.retryBudgetMs && this.nowFn() + waitMs < deadlineAt) {
            waitedMs += waitMs;
            await this.sleepImpl(waitMs);
            continue;
          }
        }
        throw err;
      }

      if (result.status === 200) {
        return result.bodyText;
      }

      if (result.status === 429) {
        const suggestedMs =
          parseRetryAfter(
            result.headers && typeof result.headers.get === 'function'
              ? result.headers.get('retry-after')
              : null,
            this.nowFn()
          ) ??
          rateLimitResetMs(result.headers, this.nowFn()) ??
          Math.min(MAX_WAIT_MS, 1000 * 2 ** backoffStep);
        backoffStep += 1;
        // Fail fast when the suggested wait exceeds the per-wait cap:
        // retrying earlier would just hit the limit again.
        if (suggestedMs > MAX_WAIT_MS) {
          throw new TwitterApiError('The upstream feed rate limit was reached.', {
            status: 429,
            retryAfterMs: suggestedMs,
            code: 'rate_limited',
          });
        }
        const canRetry =
          attempt < this.maxRetries &&
          waitedMs + suggestedMs <= this.retryBudgetMs &&
          this.nowFn() + suggestedMs < deadlineAt;
        if (!canRetry) {
          throw new TwitterApiError('The upstream feed rate limit was reached.', {
            status: 429,
            retryAfterMs: suggestedMs,
            code: 'rate_limited',
          });
        }
        waitedMs += suggestedMs;
        await this.sleepImpl(suggestedMs);
        continue;
      }

      if (result.status === 404) {
        throw new TwitterApiError(`User "@${username}" was not found.`, {
          status: 404,
          code: 'user_not_found',
        });
      }

      throw new TwitterApiError(`The upstream feed answered HTTP ${result.status}.`, {
        status: result.status,
        code: 'upstream_http',
      });
    }
  }

  /**
   * Resolve the latest post of a public user from the syndication feed.
   *
   * @param {string} username - screen name (a leading "@" is stripped)
   * @param {object} [options]
   * @param {boolean} [options.excludeRetweets=true]
   * @param {boolean} [options.excludeReplies=true]
   * @param {number} [options.deadlineAt] - shared operation deadline (ms)
   * @returns {Promise<{user: {id: string|null, username: string, name: string},
   *   tweet: {id: string, text: string, created_at: string} | null}>}
   *   `tweet` is null when the user exists but no post matches the
   *   filters. Throws TwitterApiError with status 404 ONLY for the
   *   measured not-found signature (well-formed page, no profile
   *   header, empty timeline); status 429 when the feed rate limit
   *   outlasts the retry policy; status 502 (code 'upstream_malformed')
   *   when the page structure deviates from the measured shape.
   */
  async getLatestPost(username, { excludeRetweets = true, excludeReplies = true, deadlineAt } = {}) {
    const name = normalizeUsername(username);
    if (!name) {
      throw new TwitterApiError(`Invalid username: "${username}".`, {
        status: 400,
        code: 'invalid_username',
      });
    }
    const deadline = typeof deadlineAt === 'number' ? deadlineAt : this.operationDeadlineAt();
    const html = await this.fetchTimelineHtml(name, deadline);
    const data = parseNextData(html);
    if (!data) {
      throw new TwitterApiError('The upstream feed page had an unexpected structure.', {
        status: 502,
        code: 'upstream_malformed',
      });
    }
    const { screenName, headerState, tweets, malformed, entryCount } = extractTimeline(data);
    if (
      malformed ||
      (entryCount > 0 && tweets.length === 0) ||
      headerState === 'invalid' ||
      (!screenName && entryCount > 0)
    ) {
      // Structure deviates from the measured feed shape: a header
      // object without a screen name, or posts on a page that has no
      // profile header at all. This is an upstream problem, never
      // evidence that the user does not exist.
      throw new TwitterApiError('The upstream feed page had an unexpected structure.', {
        status: 502,
        code: 'upstream_malformed',
      });
    }
    if (!screenName && entryCount === 0) {
      // The measured not-found signature: a well-formed page with no
      // profile header and an empty timeline — what the feed returns
      // for unknown accounts. (Protected accounts keep their header
      // and never reach this branch; suspended accounts were not
      // measured.)
      throw new TwitterApiError(`User "@${name}" was not found.`, {
        status: 404,
        code: 'user_not_found',
      });
    }

    // Author consistency: when the profile's screen name is known,
    // only that author's posts are candidates. (For a retweet entry
    // the legacy payload's `user` is the retweeter — the profile
    // owner — so retweets remain eligible.) A page whose tweets are
    // ALL by other authors contradicts the profile-feed structure
    // and is treated as malformed rather than silently returning a
    // stranger's post.
    let candidates = tweets;
    if (screenName) {
      const wanted = screenName.toLowerCase();
      candidates = tweets.filter(
        (t) => t.user.username && t.user.username.toLowerCase() === wanted
      );
      if (tweets.length > 0 && candidates.length === 0) {
        throw new TwitterApiError('The upstream feed page had an unexpected structure.', {
          status: 502,
          code: 'upstream_malformed',
        });
      }
    }

    const own = candidates.length > 0 ? candidates[0].user : null;
    const anyUser = own || (tweets.length > 0 ? tweets[0].user : null);
    const user = {
      id: anyUser ? anyUser.id : null,
      username: screenName || (anyUser ? anyUser.username : null) || name,
      name: anyUser && anyUser.name ? anyUser.name : screenName || name,
    };

    let best = null;
    for (const tweet of candidates) {
      if (excludeRetweets && tweet.isRetweet) continue;
      if (excludeReplies && tweet.isReply) continue;
      if (!best || tweet.createdMs > best.createdMs) best = tweet;
    }
    return {
      user,
      tweet: best ? { id: best.id, text: best.text, created_at: best.created_at } : null,
    };
  }
}

module.exports = {
  TwitterClient,
  TwitterApiError,
  DEFAULT_BASE_URL,
  MAX_WAIT_MS,
  normalizeUsername,
  parseRetryAfter,
  rateLimitResetMs,
  parseNextData,
  extractTimeline,
  normalizeTweet,
};
