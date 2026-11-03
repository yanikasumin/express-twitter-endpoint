'use strict';

/**
 * Tests added after the second external review:
 *  - the 429 retry cap is pinned for the DEFAULT configuration (not only for
 *    an explicitly passed maxRetries), and for maxRetries: 0
 *  - each retry emits a warning log (attempt number + planned wait)
 *  - server error logs carry an ISO timestamp and a per-request ID
 *  - the README keeps stating the paid-access requirement (doc guard)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TwitterClient, TwitterApiError } = require('../src/twitterClient');
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

function captureConsole(method) {
  const lines = [];
  const original = console[method];
  console[method] = (...args) => {
    lines.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' '));
  };
  return { lines, restore: () => { console[method] = original; } };
}

const ISO_PREFIX = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/;
const REQUEST_ID = /requestId=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/* --------------------------- retry cap: defaults ---------------------------- */

test('default maxRetries (3) bounds a persistent 429 to 4 total attempts', async () => {
  const warn = captureConsole('warn');
  const delays = [];
  let calls = 0;
  try {
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse(RATE_LIMIT_BODY, { status: 429 });
    };
    // No maxRetries passed: the documented default (3) must apply — this is
    // the configuration server.js produces from a default .env.
    const client = new TwitterClient({
      bearerToken: 'T',
      fetchImpl,
      sleepImpl: async (ms) => { delays.push(ms); },
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 2,
    });
    await assert.rejects(
      () => client.getUserByUsername('elonmusk'),
      (err) => err instanceof TwitterApiError && err.status === 429
    );
  } finally {
    warn.restore();
  }
  assert.equal(calls, 4); // 1 initial attempt + 3 retries, never unbounded
  assert.equal(delays.length, 3);
  assert.equal(warn.lines.length, 3); // one warning per retry
});

test('maxRetries: 0 performs exactly one attempt on 429', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(RATE_LIMIT_BODY, { status: 429 });
  };
  const client = new TwitterClient({
    bearerToken: 'T',
    fetchImpl,
    sleepImpl: async () => {},
    maxRetries: 0,
  });
  await assert.rejects(
    () => client.getUserByUsername('elonmusk'),
    (err) => err instanceof TwitterApiError && err.status === 429
  );
  assert.equal(calls, 1);
});

test('each 429 retry logs a timestamped warning with attempt and wait', async () => {
  const warn = captureConsole('warn');
  let calls = 0;
  try {
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(RATE_LIMIT_BODY, { status: 429, headers: { 'retry-after': '2' } });
      }
      return jsonResponse(USER_BODY);
    };
    const client = new TwitterClient({ bearerToken: 'T', fetchImpl, sleepImpl: async () => {} });
    const user = await client.getUserByUsername('elonmusk');
    assert.equal(user.id, '44196397');
  } finally {
    warn.restore();
  }
  assert.equal(warn.lines.length, 1);
  assert.match(warn.lines[0], ISO_PREFIX);
  assert.match(warn.lines[0], /retry 1\/3 in 2000 ms/);
});

test('a Retry-After larger than retryMaxDelayMs is clipped to the cap', async () => {
  const warn = captureConsole('warn');
  const delays = [];
  let calls = 0;
  try {
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(RATE_LIMIT_BODY, { status: 429, headers: { 'retry-after': '60' } });
      }
      return jsonResponse(USER_BODY);
    };
    const client = new TwitterClient({
      bearerToken: 'T',
      fetchImpl,
      sleepImpl: async (ms) => { delays.push(ms); },
      retryMaxDelayMs: 100,
    });
    await client.getUserByUsername('elonmusk');
  } finally {
    warn.restore();
  }
  assert.equal(calls, 2);
  assert.deepEqual(delays, [100]); // 60 s requested, capped at 100 ms
});

/* ------------------------------ app log format ------------------------------ */

async function withServer(client, fn) {
  const app = createApp({ client, username: 'elonmusk', cacheTtlMs: 0 });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('upstream error log carries an ISO timestamp and requestId', async () => {
  const errors = captureConsole('error');
  const client = {
    getUserByUsername: async () => {
      throw new TwitterApiError('X API request failed (500): upstream detail', { status: 500 });
    },
    getLatestTweet: async () => null,
  };
  try {
    await withServer(client, async (base) => {
      const res = await fetch(`${base}/latest-tweet`);
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.error, 'upstream_error');
    });
  } finally {
    errors.restore();
  }
  assert.equal(errors.lines.length, 1);
  assert.match(errors.lines[0], ISO_PREFIX);
  assert.match(errors.lines[0], REQUEST_ID);
  assert.match(errors.lines[0], /username=elonmusk/);
  assert.match(errors.lines[0], /status=500/);
});

test('unexpected error log carries an ISO timestamp and requestId', async () => {
  const errors = captureConsole('error');
  const client = {
    getUserByUsername: async () => {
      throw new TypeError('boom');
    },
    getLatestTweet: async () => null,
  };
  try {
    await withServer(client, async (base) => {
      const res = await fetch(`${base}/latest-tweet`);
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(body.error, 'internal_error');
    });
  } finally {
    errors.restore();
  }
  assert.equal(errors.lines.length, 1);
  assert.match(errors.lines[0], ISO_PREFIX);
  assert.match(errors.lines[0], REQUEST_ID);
  assert.match(errors.lines[0], /Unexpected error in \/latest-tweet/);
});

test('a 403 from the X API is mapped to 502 upstream_auth_error', async () => {
  // 403 is what the API returns when the app's access level / credit balance
  // does not cover these endpoints (the "plan constraint" surfacing in code).
  const client = {
    getUserByUsername: async () => {
      throw new TwitterApiError('X API request failed (403): Forbidden', { status: 403 });
    },
    getLatestTweet: async () => null,
  };
  await withServer(client, async (base) => {
    const res = await fetch(`${base}/latest-tweet`);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'upstream_auth_error');
  });
});

/* ------------------------------ README guard ------------------------------- */

test('README states the paid-access requirement and current billing model', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.match(readme, /paid X API access is required/i);
  assert.match(readme, /pay-per-use/i);
  assert.match(readme, /pricing changes over time/i);
});
