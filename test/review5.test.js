'use strict';

// Round-5 review regressions:
// - the overall deadline must be shared across BOTH stages of one
//   request (username lookup + timeline fetch), not restarted per call:
//   one operationDeadlineAt() value is threaded through both calls.
// - required-field guarantees for the documented success response: a
//   user object without string username/name is EBADRESPONSE, and a
//   tweet entry without a string created_at is skipped like any other
//   malformed entry, so id / text / created_at / author fields are
//   always present in a 200 response.
// - README billing-cap wording: the prepaid console balance must not be
//   described as an unconditional hard cap (auto-recharge caveat).
//
// Deliberately NOT changed in this round (recorded in FIXLOG-5): the
// Retry-After cap at retryMaxDelayMs. Shortening a longer server
// instruction to the cap is the settled design of FIXLOG-1/2/3 (with its
// own regression tests in review2/review3); this file does not re-open it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/app');
const { TwitterClient } = require('../src/twitterClient');

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  };
}

const USER_BODY = { data: { id: '1', name: 'N', username: 'nasa' } };
const TWEET_BODY = {
  data: [{ id: '10', text: 'hi', created_at: '2026-01-01T00:00:00.000Z' }],
  meta: { result_count: 1 },
};

/** Fetch that never answers; only the AbortSignal ends it. */
function hangingFetch(_url, opts) {
  return new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
}

/** Slow user lookup (delayMs), then a hanging timeline fetch. */
function slowUserThenHangFetch(delayMs) {
  return async (url, opts) => {
    if (url.includes('/users/by/username/')) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return jsonResponse(USER_BODY);
    }
    return hangingFetch(url, opts);
  };
}

async function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

// ---------- shared deadline across both stages ----------

test('operationDeadlineAt returns now + deadlineMs, or null when disabled', () => {
  const enabled = new TwitterClient({ bearerToken: 'T', fetchImpl: async () => jsonResponse(USER_BODY), deadlineMs: 60_000 });
  const at = enabled.operationDeadlineAt();
  assert.ok(typeof at === 'number' && at > Date.now() && at <= Date.now() + 60_000);
  const disabled = new TwitterClient({ bearerToken: 'T', fetchImpl: async () => jsonResponse(USER_BODY), deadlineMs: 0 });
  assert.equal(disabled.operationDeadlineAt(), null);
});

test('one shared deadline bounds BOTH stages (slow lookup + hanging timeline)', async () => {
  // Stage 1 takes ~400 ms of the 600 ms deadline; the hanging stage 2
  // must then be cut off by the SAME deadline (~600 ms total). With a
  // fresh per-stage deadline it would only be cut at ~400 + 600 ms.
  const client = new TwitterClient({
    bearerToken: 'T',
    fetchImpl: slowUserThenHangFetch(400),
    timeoutMs: 10_000,
    deadlineMs: 600,
  });
  const deadlineAt = client.operationDeadlineAt();
  const started = Date.now();
  await assert.rejects(
    async () => {
      const user = await client.getUserByUsername('nasa', { deadlineAt });
      await client.getLatestTweet(user.id, { deadlineAt });
    },
    (err) => err.code === 'EDEADLINE'
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 850, `shared deadline must cut off near 600 ms total, took ${elapsed} ms`);
});

test('app level: /latest-tweet is bounded by the shared deadline end to end (502, not a hang)', async () => {
  const client = new TwitterClient({
    bearerToken: 'T',
    fetchImpl: slowUserThenHangFetch(400),
    timeoutMs: 10_000,
    deadlineMs: 600,
  });
  const { server, base } = await startServer(createApp({ client, username: 'nasa', cacheTtlMs: 0 }));
  try {
    const started = Date.now();
    const res = await fetch(`${base}/latest-tweet`);
    const elapsed = Date.now() - started;
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'upstream_error');
    assert.ok(elapsed < 1500, `request must end near the 600 ms deadline, took ${elapsed} ms`);
  } finally {
    await closeServer(server);
  }
});

// ---------- required-field guarantees ----------

test('user object without a username is EBADRESPONSE (never a permalink containing "undefined")', async () => {
  const client = new TwitterClient({
    bearerToken: 'T',
    fetchImpl: async () => jsonResponse({ data: { id: '1', name: 'N' } }),
  });
  await assert.rejects(() => client.getUserByUsername('nasa'), (err) => err.code === 'EBADRESPONSE');
});

test('user object without a name is EBADRESPONSE', async () => {
  const client = new TwitterClient({
    bearerToken: 'T',
    fetchImpl: async () => jsonResponse({ data: { id: '1', username: 'nasa' } }),
  });
  await assert.rejects(() => client.getUserByUsername('nasa'), (err) => err.code === 'EBADRESPONSE');
});

test('app level: user payload missing username maps to 502 upstream_error', async () => {
  const client = new TwitterClient({
    bearerToken: 'T',
    fetchImpl: async (url) => {
      if (url.includes('/users/by/username/')) return jsonResponse({ data: { id: '1', name: 'N' } });
      return jsonResponse(TWEET_BODY);
    },
  });
  const { server, base } = await startServer(createApp({ client, username: 'nasa', cacheTtlMs: 0 }));
  try {
    const res = await fetch(`${base}/latest-tweet`);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'upstream_error');
  } finally {
    await closeServer(server);
  }
});

test('tweet entries without a string created_at are skipped like other malformed entries', async () => {
  const client = new TwitterClient({
    bearerToken: 'T',
    fetchImpl: async () =>
      jsonResponse({
        data: [
          { id: '9', text: 'no timestamp' },
          { id: '10', text: 'valid', created_at: '2026-01-01T00:00:00.000Z' },
        ],
        meta: { result_count: 2 },
      }),
  });
  const tweet = await client.getLatestTweet('1', {});
  assert.equal(tweet.id, '10');
});

test('getLatestTweet returns null when every entry lacks created_at', async () => {
  const client = new TwitterClient({
    bearerToken: 'T',
    fetchImpl: async () => jsonResponse({ data: [{ id: '9', text: 'no timestamp' }], meta: {} }),
  });
  assert.equal(await client.getLatestTweet('1', {}), null);
});

// ---------- documentation guards ----------

test('README does not call the console balance an unconditional hard cap (auto-recharge caveat present)', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.ok(!readme.includes('the console balance is the hard cap'));
  assert.ok(readme.includes('auto-recharge'));
});

test('README describes the deadline as shared across both stages', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.ok(readme.includes('share a single deadline'));
});
