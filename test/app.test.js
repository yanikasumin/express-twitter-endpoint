'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
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

// Fully mocked X API: no real network calls to api.twitter.com.
function mockFetch(url) {
  if (url.includes('/users/by/username/elonmusk')) {
    return jsonResponse({ data: { id: '44196397', name: 'Elon Musk', username: 'elonmusk' } });
  }
  if (url.includes('/users/by/username/ratelimited')) {
    return jsonResponse({ title: 'Too Many Requests', detail: 'Rate limit' }, { status: 429 });
  }
  if (url.includes('/users/by/username/')) {
    return jsonResponse({ errors: [{ message: 'Not Found Error' }] }, { status: 404 });
  }
  if (url.includes('/users/44196397/tweets')) {
    return jsonResponse({
      data: [
        {
          id: '1853000000000000000',
          text: 'Mocked latest tweet text',
          created_at: '2026-11-03T01:23:45.000Z',
          author_id: '44196397',
        },
      ],
      meta: { result_count: 1 },
    });
  }
  throw new Error(`Unexpected URL in mock: ${url}`);
}

let server;
let baseUrl;

before(async () => {
  const client = new TwitterClient({ bearerToken: 'TEST_TOKEN', fetchImpl: mockFetch });
  const app = createApp({ client, username: 'elonmusk', cacheTtlMs: 60_000 });
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

test('GET /health returns ok', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('GET /latest-tweet returns text, created_at and link as JSON', async () => {
  const res = await fetch(`${baseUrl}/latest-tweet`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.id, '1853000000000000000');
  assert.equal(body.text, 'Mocked latest tweet text');
  assert.equal(body.created_at, '2026-11-03T01:23:45.000Z');
  assert.equal(body.url, 'https://twitter.com/elonmusk/status/1853000000000000000');
  assert.deepEqual(body.author, { id: '44196397', username: 'elonmusk', name: 'Elon Musk' });
  assert.equal(body.cached, false);
});

test('second identical request is served from cache', async () => {
  const res = await fetch(`${baseUrl}/latest-tweet`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.cached, true);
});

test('unknown user returns 404 with a clear error body', async () => {
  const res = await fetch(`${baseUrl}/latest-tweet?username=doesnotexist123`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'user_not_found');
});

test('upstream rate limit is mapped to 503 rate_limited', async () => {
  const res = await fetch(`${baseUrl}/latest-tweet?username=ratelimited`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, 'rate_limited');
});

test('unknown route returns 404 JSON', async () => {
  const res = await fetch(`${baseUrl}/nope`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'not_found');
});
