'use strict';

// Round-4 review regressions:
// - app-layer username TYPE validation: the query parser can deliver an
//   array ("?username=a&username=b") or an object ("?username[x]=y");
//   these used to throw on .replace() before any validation ran and left
//   the request unanswered (unhandled rejection in Express 4). They must
//   now be a clean 400.
// - upstream 200-response validation: anomalous 200 bodies (no user
//   object, non-string id, non-JSON body, timeline "data" not an array)
//   must be EBADRESPONSE (-> 502), never "not found" / "no tweets"; the
//   genuine empty-timeline shape (200 with only meta) stays null.
// - overall deadline for one whole call (attempts + waits).
// - optional API key gate for /latest-tweet.
// - README / package.json Node.js version accuracy for --env-file.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/app');
const { TwitterClient, TwitterApiError } = require('../src/twitterClient');

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  };
}

function nonJsonResponse() {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => {
      throw new Error('invalid json');
    },
  };
}

function okFetch(url) {
  if (url.includes('/users/by/username/')) {
    return jsonResponse({ data: { id: '1', name: 'N', username: 'nasa' } });
  }
  return jsonResponse({
    data: [{ id: '10', text: 'hi', created_at: '2026-01-01T00:00:00.000Z' }],
    meta: { result_count: 1 },
  });
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

// ---------- app layer: username type validation + API key gate ----------

let server;
let base;
let keyedServer;
let keyedBase;

before(async () => {
  const client = new TwitterClient({ bearerToken: 'T', fetchImpl: okFetch });
  ({ server, base } = await startServer(createApp({ client, username: 'nasa' })));
  const keyedClient = new TwitterClient({ bearerToken: 'T', fetchImpl: okFetch });
  ({ server: keyedServer, base: keyedBase } = await startServer(
    createApp({ client: keyedClient, username: 'nasa', apiKey: 'test-secret-key' })
  ));
});

after(async () => {
  await closeServer(server);
  await closeServer(keyedServer);
});

test('array username (?username=a&username=b) is a 400, not a hang', async () => {
  const res = await fetch(`${base}/latest-tweet?username=a&username=b`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_username');
});

test('object username (?username[x]=y) is a 400, not a hang', async () => {
  const res = await fetch(`${base}/latest-tweet?username%5Bx%5D=y`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_username');
});

test('a normal string username still works after the type check', async () => {
  const res = await fetch(`${base}/latest-tweet?username=nasa`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).id, '10');
});

test('API key gate: missing or wrong key is 401, correct key passes, /health stays open', async () => {
  const noKey = await fetch(`${keyedBase}/latest-tweet`);
  assert.equal(noKey.status, 401);
  assert.equal((await noKey.json()).error, 'unauthorized');

  const wrongKey = await fetch(`${keyedBase}/latest-tweet`, {
    headers: { 'x-api-key': 'not-the-key' },
  });
  assert.equal(wrongKey.status, 401);

  const rightKey = await fetch(`${keyedBase}/latest-tweet`, {
    headers: { 'x-api-key': 'test-secret-key' },
  });
  assert.equal(rightKey.status, 200);

  const health = await fetch(`${keyedBase}/health`);
  assert.equal(health.status, 200);
});

test('anomalous upstream 200 (no user object) maps to 502 upstream_error, not 404', async () => {
  const badClient = new TwitterClient({
    bearerToken: 'T',
    fetchImpl: async () => jsonResponse({}),
  });
  const { server: s, base: b } = await startServer(createApp({ client: badClient, username: 'nasa' }));
  try {
    const res = await fetch(`${b}/latest-tweet`);
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, 'upstream_error');
  } finally {
    await closeServer(s);
  }
});

// ---------- client layer: 200-response validation ----------

const mkClient = (fetchImpl, extra = {}) =>
  new TwitterClient({ bearerToken: 'T', fetchImpl, maxRetries: 0, ...extra });

test('user lookup: 200 with no data object is EBADRESPONSE, not 404', async () => {
  const client = mkClient(async () => jsonResponse({}));
  await assert.rejects(
    () => client.getUserByUsername('nasa'),
    (err) => err instanceof TwitterApiError && err.code === 'EBADRESPONSE'
  );
});

test('user lookup: 200 with a non-string id is EBADRESPONSE', async () => {
  const client = mkClient(async () => jsonResponse({ data: { id: 123, username: 'nasa' } }));
  await assert.rejects(
    () => client.getUserByUsername('nasa'),
    (err) => err instanceof TwitterApiError && err.code === 'EBADRESPONSE'
  );
});

test('user lookup: 200 with a non-JSON body is EBADRESPONSE', async () => {
  const client = mkClient(async () => nonJsonResponse());
  await assert.rejects(
    () => client.getUserByUsername('nasa'),
    (err) => err instanceof TwitterApiError && err.code === 'EBADRESPONSE'
  );
});

test('user lookup: a genuine HTTP 404 is still a 404 (not EBADRESPONSE)', async () => {
  const client = mkClient(async () =>
    jsonResponse({ errors: [{ message: 'Not Found' }] }, { status: 404 })
  );
  await assert.rejects(
    () => client.getUserByUsername('nasa'),
    (err) => err instanceof TwitterApiError && err.status === 404 && err.code !== 'EBADRESPONSE'
  );
});

test('timeline: 200 with "data" present but not an array is EBADRESPONSE', async () => {
  const client = mkClient(async () => jsonResponse({ data: 'oops' }));
  await assert.rejects(
    () => client.getLatestTweet('1'),
    (err) => err instanceof TwitterApiError && err.code === 'EBADRESPONSE'
  );
});

test('timeline: 200 with only meta (genuine empty result) still resolves to null', async () => {
  const client = mkClient(async () => jsonResponse({ meta: { result_count: 0 } }));
  assert.equal(await client.getLatestTweet('1'), null);
});

// ---------- client layer: overall deadline ----------

test('deadline defaults to 60000 ms and can be disabled with 0', () => {
  assert.equal(new TwitterClient({ bearerToken: 'T', fetchImpl: okFetch }).deadlineMs, 60_000);
  assert.equal(new TwitterClient({ bearerToken: 'T', fetchImpl: okFetch, deadlineMs: 0 }).deadlineMs, null);
});

test('a hanging attempt is cut off at the overall deadline (EDEADLINE), not the per-request timeout', async () => {
  const hangingFetch = (_url, opts) =>
    new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const e = new Error('The operation was aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
  const client = mkClient(hangingFetch, { timeoutMs: 10_000, deadlineMs: 300 });
  const started = Date.now();
  await assert.rejects(
    () => client.getUserByUsername('nasa'),
    (err) => err instanceof TwitterApiError && err.code === 'EDEADLINE'
  );
  assert.ok(Date.now() - started < 5000, 'must be cut off near the 300 ms deadline, not after 10 s');
});

test('a 429 retry wait that would cross the deadline is not taken', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? '3600' : null) },
      json: async () => ({ title: 'Too Many Requests', detail: 'Rate limit' }),
    };
  };
  const client = mkClient(fetchImpl, { deadlineMs: 500, maxRetries: 3 });
  const started = Date.now();
  await assert.rejects(
    () => client.getUserByUsername('nasa'),
    (err) => err instanceof TwitterApiError && err.status === 429
  );
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 5000, 'must give up at the deadline instead of waiting 30 s');
});

// ---------- docs accuracy ----------

test('README and package.json state the Node.js version that supports --env-file', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.match(readme, /20\.6\.0/);
  assert.match(readme, /TWITTER_DEADLINE_MS/);
  assert.match(readme, /APP_API_KEY/);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.engines.node, '>=20.6.0');
});
