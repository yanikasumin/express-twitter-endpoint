'use strict';

/**
 * Regression tests for the round-3 review (REVIEW-3.md / FIXLOG-3.md):
 *  - username type contract (screen name, "@" handling, invalid rejection)
 *  - API response classification (HTTP errors vs 2xx errors-only bodies)
 *  - timeout covering the body read (must surface as ETIMEDOUT, not as an
 *    empty result), and timeouts not being retried
 *  - a total 429 retry-wait budget (retryBudgetMs)
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/app');
const { TwitterClient, TwitterApiError, normalizeUsername } = require('../src/twitterClient');

function fakeRes({ status = 200, body = null, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status-${status}`,
    headers: { get: (k) => (k.toLowerCase() in headers ? headers[k.toLowerCase()] : null) },
    json: async () => body,
  };
}
const noSleep = async () => {};

// ---------- username type contract (P0-1) ----------

test('normalizeUsername strips one leading @ and keeps valid screen names', () => {
  assert.equal(normalizeUsername('elonmusk'), 'elonmusk');
  assert.equal(normalizeUsername('@elonmusk'), 'elonmusk');
  assert.equal(normalizeUsername('NASA'), 'NASA');
});

test('normalizeUsername rejects IDs with invalid characters and non-strings before any HTTP call', () => {
  for (const bad of ['bad-name', 'has space', '@@double', 'way_too_long_name1', '', 44196397, null]) {
    assert.throws(
      () => normalizeUsername(bad),
      (e) => e instanceof TwitterApiError && e.code === 'EINVALIDUSERNAME',
      `expected EINVALIDUSERNAME for ${String(bad)}`
    );
  }
});

test('getUserByUsername("@elonmusk") requests the clean screen-name URL (no %40)', async () => {
  const urls = [];
  const client = new TwitterClient({
    bearerToken: 't',
    fetchImpl: async (url) => {
      urls.push(url);
      return fakeRes({ body: { data: { id: '1', username: 'elonmusk', name: 'E' } } });
    },
    sleepImpl: noSleep,
  });
  const user = await client.getUserByUsername('@elonmusk');
  assert.equal(user.id, '1');
  assert.equal(urls.length, 1);
  assert.ok(urls[0].includes('/users/by/username/elonmusk?'), urls[0]);
  assert.ok(!urls[0].includes('%40'), urls[0]);
});

test('getUserByUsername rejects an invalid username without calling fetch', async () => {
  let calls = 0;
  const client = new TwitterClient({
    bearerToken: 't',
    fetchImpl: async () => { calls += 1; return fakeRes({}); },
    sleepImpl: noSleep,
  });
  await assert.rejects(
    client.getUserByUsername('bad-name'),
    (e) => e instanceof TwitterApiError && e.code === 'EINVALIDUSERNAME'
  );
  assert.equal(calls, 0);
});

test('"@ELONMUSK" and "elonmusk" share the same cache entry', async () => {
  let calls = 0;
  const client = new TwitterClient({
    bearerToken: 't',
    fetchImpl: async () => {
      calls += 1;
      return fakeRes({ body: { data: { id: '1', username: 'elonmusk', name: 'E' } } });
    },
    sleepImpl: noSleep,
  });
  await client.getUserByUsername('elonmusk');
  await client.getUserByUsername('@ELONMUSK');
  assert.equal(calls, 1);
});

// ---------- API response classification (P0-2) ----------

test('HTTP error statuses with error bodies throw TwitterApiError carrying that status', async () => {
  for (const status of [401, 403, 404, 500]) {
    let calls = 0;
    const client = new TwitterClient({
      bearerToken: 't',
      fetchImpl: async () => {
        calls += 1;
        return fakeRes({ status, body: { errors: [{ message: 'boom', detail: 'boom' }], title: 'Error' } });
      },
      sleepImpl: noSleep,
    });
    await assert.rejects(
      client.getLatestTweet('123'),
      (e) => e instanceof TwitterApiError && e.status === status,
      `status ${status} must surface as-is`
    );
    assert.equal(calls, 1, `status ${status} must not be retried or swallowed`);
  }
});

test('a 2xx body with errors and no data is an upstream error, not an empty result', async () => {
  const client = new TwitterClient({
    bearerToken: 't',
    fetchImpl: async () =>
      fakeRes({ body: { errors: [{ message: 'User has been suspended.', detail: 'suspended' }] } }),
    sleepImpl: noSleep,
  });
  await assert.rejects(
    client.getLatestTweet('123'),
    (e) => e instanceof TwitterApiError && e.code === 'EUPSTREAMERRORS'
  );
  await assert.rejects(
    client.getUserByUsername('someone'),
    (e) => e instanceof TwitterApiError && e.code === 'EUPSTREAMERRORS' && e.status !== 404
  );
});

test('a 2xx body with BOTH data and errors (partial success) is still used', async () => {
  const client = new TwitterClient({
    bearerToken: 't',
    fetchImpl: async () =>
      fakeRes({
        body: {
          data: [{ id: '10', text: 'hello', created_at: '2026-11-03T00:00:00.000Z' }],
          errors: [{ message: 'a referenced resource was missing' }],
        },
      }),
    sleepImpl: noSleep,
  });
  const tweet = await client.getLatestTweet('123');
  assert.equal(tweet.id, '10');
});

// ---------- app-level classification ----------

let server;
let baseUrl;

before(async () => {
  const client = new TwitterClient({
    bearerToken: 't',
    fetchImpl: async (url) => {
      if (url.includes('/users/by/username/')) {
        // X answers 200 with an errors-only body for e.g. suspended accounts.
        return fakeRes({ body: { errors: [{ message: 'User has been suspended.', detail: 'suspended' }] } });
      }
      throw new Error(`Unexpected URL in mock: ${url}`);
    },
    sleepImpl: noSleep,
  });
  const app = createApp({ client, username: 'elonmusk', cacheTtlMs: 0 });
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('app maps a 2xx errors-only upstream body to 502 upstream_error (not 404)', async () => {
  const res = await fetch(`${baseUrl}/latest-tweet?username=suspendeduser`);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error, 'upstream_error');
});

// ---------- timeout semantics (P1: body read) ----------

test('a timeout during the body read surfaces as ETIMEDOUT, not as an empty result', async () => {
  const client = new TwitterClient({
    bearerToken: 't',
    timeoutMs: 60,
    maxRetries: 3,
    fetchImpl: async (url, opts) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      json: () =>
        new Promise((_, reject) => {
          opts.signal.addEventListener('abort', () => {
            const e = new Error('The operation was aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }),
    }),
    sleepImpl: noSleep,
  });
  await assert.rejects(
    client.getLatestTweet('1'),
    (e) => e instanceof TwitterApiError && e.code === 'ETIMEDOUT'
  );
});

test('timeouts are not retried (only HTTP 429 is)', async () => {
  let calls = 0;
  const client = new TwitterClient({
    bearerToken: 't',
    timeoutMs: 60,
    maxRetries: 3,
    fetchImpl: (url, opts) => {
      calls += 1;
      return new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => {
          const e = new Error('The operation was aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    },
    sleepImpl: noSleep,
  });
  await assert.rejects(client.getLatestTweet('1'), (e) => e.code === 'ETIMEDOUT');
  assert.equal(calls, 1);
});

// ---------- 429 total wait budget (P1) ----------

test('the default retry budget is 90000 ms', () => {
  const client = new TwitterClient({ bearerToken: 't', fetchImpl: async () => fakeRes({}) });
  assert.equal(client.retryBudgetMs, 90_000);
});

test('retrying stops when the next wait would exceed the total budget', async () => {
  const waits = [];
  let calls = 0;
  const client = new TwitterClient({
    bearerToken: 't',
    maxRetries: 10,
    retryMaxDelayMs: 30_000,
    retryBudgetMs: 45_000,
    fetchImpl: async () => {
      calls += 1;
      return fakeRes({ status: 429, body: { title: 'Too Many Requests' }, headers: { 'retry-after': '3600' } });
    },
    sleepImpl: async (ms) => { waits.push(ms); },
  });
  await assert.rejects(
    client.getLatestTweet('1'),
    (e) => e instanceof TwitterApiError && e.status === 429
  );
  // First wait (30 s) fits the 45 s budget; the second (another 30 s) does not.
  assert.deepEqual(waits, [30_000]);
  assert.equal(calls, 2);
});

test('within the budget, retries proceed up to maxRetries as before', async () => {
  const waits = [];
  let calls = 0;
  const client = new TwitterClient({
    bearerToken: 't',
    maxRetries: 2,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 30_000,
    retryBudgetMs: 90_000,
    fetchImpl: async () => {
      calls += 1;
      return fakeRes({ status: 429, body: { title: 'Too Many Requests' } });
    },
    sleepImpl: async (ms) => { waits.push(ms); },
  });
  await assert.rejects(client.getLatestTweet('1'), (e) => e.status === 429);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [100, 200]);
});

// ---------- README guards ----------

test('README documents the retry budget setting and the username contract', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.ok(readme.includes('TWITTER_RETRY_BUDGET_MS'), 'README must document TWITTER_RETRY_BUDGET_MS');
  assert.ok(/screen name/i.test(readme), 'README must state the username is a screen name');
});
