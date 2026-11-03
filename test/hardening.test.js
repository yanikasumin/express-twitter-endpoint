'use strict';

/**
 * Hardening tests added after the first external review:
 *  - 429 retry control (Retry-After + exponential backoff + cap)
 *  - request timeout
 *  - Bearer token never leaks into error messages
 *  - malformed upstream payload validation
 *  - username input validation (400)
 *  - generalized client-facing error messages
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { TwitterClient, TwitterApiError, parseRetryAfter } = require('../src/twitterClient');
const { createApp } = require('../src/app');

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: {
      get: (name) => {
        const key = Object.keys(headers).find((k) => k.toLowerCase() === String(name).toLowerCase());
        return key === undefined ? null : headers[key];
      },
    },
    json: async () => body,
  };
}

const USER_BODY = { data: { id: '44196397', name: 'Elon Musk', username: 'elonmusk' } };
const RATE_LIMIT_BODY = { title: 'Too Many Requests', detail: 'Rate limit exceeded' };

function sleepRecorder() {
  const delays = [];
  return { delays, sleepImpl: async (ms) => { delays.push(ms); } };
}

/* ------------------------------ parseRetryAfter ------------------------------ */

test('parseRetryAfter handles seconds, HTTP-dates and garbage', () => {
  assert.equal(parseRetryAfter('2'), 2000);
  assert.equal(parseRetryAfter(' 5 '), 5000);
  const now = Date.parse('2026-11-03T00:00:00.000Z');
  assert.equal(parseRetryAfter('Tue, 03 Nov 2026 00:00:10 GMT', now), 10_000);
  assert.equal(parseRetryAfter('Tue, 03 Nov 2026 00:00:10 GMT', now + 20_000), 0);
  assert.equal(parseRetryAfter('not-a-date'), null);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(''), null);
});

/* --------------------------------- 429 retry -------------------------------- */

test('429 with Retry-After is retried after the server-requested wait', async () => {
  const { delays, sleepImpl } = sleepRecorder();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return jsonResponse(RATE_LIMIT_BODY, { status: 429, headers: { 'retry-after': '2' } });
    }
    return jsonResponse(USER_BODY);
  };
  const client = new TwitterClient({ bearerToken: 'T', fetchImpl, sleepImpl });
  const user = await client.getUserByUsername('elonmusk');
  assert.equal(user.id, '44196397');
  assert.equal(calls, 2);
  assert.deepEqual(delays, [2000]);
});

test('429 without Retry-After uses capped exponential backoff', async () => {
  const { delays, sleepImpl } = sleepRecorder();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls <= 2) return jsonResponse(RATE_LIMIT_BODY, { status: 429 });
    return jsonResponse(USER_BODY);
  };
  const client = new TwitterClient({
    bearerToken: 'T',
    fetchImpl,
    sleepImpl,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 250,
  });
  await client.getUserByUsername('elonmusk');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [100, 200]);
});

test('backoff never exceeds retryMaxDelayMs', async () => {
  const { delays, sleepImpl } = sleepRecorder();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls <= 3) return jsonResponse(RATE_LIMIT_BODY, { status: 429 });
    return jsonResponse(USER_BODY);
  };
  const client = new TwitterClient({
    bearerToken: 'T',
    fetchImpl,
    sleepImpl,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 150,
    maxRetries: 5,
  });
  await client.getUserByUsername('elonmusk');
  assert.deepEqual(delays, [100, 150, 150]);
});

test('429 beyond maxRetries throws TwitterApiError carrying retryAfterMs', async () => {
  const { delays, sleepImpl } = sleepRecorder();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(RATE_LIMIT_BODY, { status: 429, headers: { 'retry-after': '5' } });
  };
  const client = new TwitterClient({ bearerToken: 'T', fetchImpl, sleepImpl, maxRetries: 2 });
  await assert.rejects(
    () => client.getUserByUsername('elonmusk'),
    (err) => err instanceof TwitterApiError && err.status === 429 && err.retryAfterMs === 5000
  );
  assert.equal(calls, 3); // initial attempt + 2 retries
  assert.deepEqual(delays, [5000, 5000]);
});

test('non-429 errors are not retried', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({ title: 'Forbidden' }, { status: 403 });
  };
  const client = new TwitterClient({ bearerToken: 'T', fetchImpl, sleepImpl: async () => {} });
  await assert.rejects(
    () => client.getUserByUsername('elonmusk'),
    (err) => err instanceof TwitterApiError && err.status === 403
  );
  assert.equal(calls, 1);
});

/* ---------------------------------- timeout --------------------------------- */

test('a hanging request is aborted and reported as a timeout', async () => {
  const fetchImpl = (_url, opts) =>
    new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  const client = new TwitterClient({ bearerToken: 'T', fetchImpl, timeoutMs: 25 });
  await assert.rejects(
    () => client.getUserByUsername('elonmusk'),
    (err) => err instanceof TwitterApiError && err.code === 'ETIMEDOUT' && err.status === null
  );
});

/* ----------------------------- token leak safety ----------------------------- */

test('the Bearer token never appears in thrown error messages', async () => {
  const token = 'SECRET_TOKEN_XYZ';

  const httpFail = new TwitterClient({
    bearerToken: token,
    fetchImpl: async () => jsonResponse({ detail: 'some upstream detail' }, { status: 500 }),
  });
  await assert.rejects(
    () => httpFail.getUserByUsername('elonmusk'),
    (err) => !err.message.includes(token)
  );

  const networkFail = new TwitterClient({
    bearerToken: token,
    fetchImpl: async () => {
      throw new Error('socket hang up');
    },
  });
  await assert.rejects(
    () => networkFail.getUserByUsername('elonmusk'),
    (err) => !err.message.includes(token)
  );
});

/* --------------------------- payload shape validation ------------------------ */

test('getLatestTweet skips malformed entries and returns the first valid one', async () => {
  const fetchImpl = async () =>
    jsonResponse({
      data: [
        { id: '1' }, // missing text
        { text: 'no id' }, // missing id
        null,
        { id: '2', text: 'valid tweet', created_at: '2026-11-03T00:00:00.000Z' },
      ],
      meta: { result_count: 4 },
    });
  const client = new TwitterClient({ bearerToken: 'T', fetchImpl });
  const tweet = await client.getLatestTweet('44196397', {});
  assert.equal(tweet.id, '2');
  assert.equal(tweet.text, 'valid tweet');
});

test('getLatestTweet returns null when every entry is malformed', async () => {
  const fetchImpl = async () => jsonResponse({ data: [{ id: '1' }, { text: 'x' }], meta: {} });
  const client = new TwitterClient({ bearerToken: 'T', fetchImpl });
  assert.equal(await client.getLatestTweet('44196397', {}), null);
});

/* ------------------------------- app-level tests ----------------------------- */

function appMockFetch(url) {
  if (url.includes('/users/by/username/elonmusk')) {
    return jsonResponse(USER_BODY);
  }
  if (url.includes('/users/by/username/brokentweets')) {
    return jsonResponse({ data: { id: '777', name: 'Broken', username: 'brokentweets' } });
  }
  if (url.includes('/users/by/username/alwayslimited')) {
    return jsonResponse(RATE_LIMIT_BODY, { status: 429, headers: { 'retry-after': '7' } });
  }
  if (url.includes('/users/777/tweets')) {
    return jsonResponse({ detail: 'UPSTREAM_SECRET_DETAIL_XYZ' }, { status: 500 });
  }
  if (url.includes('/users/44196397/tweets')) {
    return jsonResponse({
      data: [{ id: '9', text: 'hi', created_at: '2026-11-03T00:00:00.000Z', author_id: '44196397' }],
      meta: { result_count: 1 },
    });
  }
  throw new Error(`Unexpected URL in mock: ${url}`);
}

let appServer;
let appBase;

before(async () => {
  const client = new TwitterClient({
    bearerToken: 'T',
    fetchImpl: appMockFetch,
    maxRetries: 0, // keep tests fast; retry behaviour is covered at client level
    sleepImpl: async () => {},
  });
  const app = createApp({ client, username: 'elonmusk', cacheTtlMs: 0 });
  await new Promise((resolve) => {
    appServer = app.listen(0, () => {
      appBase = `http://127.0.0.1:${appServer.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => appServer.close(resolve));
});

test('invalid usernames are rejected with 400 invalid_username', async () => {
  for (const bad of ['bad-name', 'bad name!', 'waytoolongusername1', 'dot.name', '']) {
    const res = await fetch(`${appBase}/latest-tweet?username=${encodeURIComponent(bad)}`);
    if (bad === '') continue; // empty falls back to the default user by design
    assert.equal(res.status, 400, `username=${bad}`);
    const body = await res.json();
    assert.equal(body.error, 'invalid_username');
  }
});

test('upstream failure detail is not leaked to the client', async () => {
  const originalError = console.error;
  console.error = () => {}; // keep test output clean; detail belongs in the server log
  try {
    const res = await fetch(`${appBase}/latest-tweet?username=brokentweets`);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'upstream_error');
    assert.ok(!JSON.stringify(body).includes('UPSTREAM_SECRET_DETAIL_XYZ'));
  } finally {
    console.error = originalError;
  }
});

test('503 rate_limited propagates the upstream Retry-After as a response header', async () => {
  const res = await fetch(`${appBase}/latest-tweet?username=alwayslimited`);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '7');
  const body = await res.json();
  assert.equal(body.error, 'rate_limited');
});
