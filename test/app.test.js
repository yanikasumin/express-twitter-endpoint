'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { TwitterApiError } = require('../src/twitterClient');

async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function stubClient(impl) {
  const calls = [];
  return {
    calls,
    operationDeadlineAt: () => Date.now() + 60_000,
    getLatestPost: async (username, opts) => {
      calls.push({ username, opts });
      return impl(username, opts);
    },
  };
}

const okResult = {
  user: { id: '11348282', username: 'nasa', name: 'NASA' },
  tweet: { id: '2002', text: 'hello', created_at: '2026-11-02T12:00:00.000Z' },
};

test('GET /health answers ok', async () => {
  const app = createApp({ client: stubClient(async () => okResult), username: 'nasa' });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  });
});

test('GET /latest-tweet returns the payload shape with a permalink and author', async () => {
  const client = stubClient(async () => okResult);
  const app = createApp({ client, username: 'nasa' });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/latest-tweet`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      id: '2002',
      text: 'hello',
      created_at: '2026-11-02T12:00:00.000Z',
      url: 'https://twitter.com/nasa/status/2002',
      author: { id: '11348282', username: 'nasa', name: 'NASA' },
      cached: false,
    });
    assert.equal(client.calls[0].username, 'nasa');
  });
});

test('a second identical request is served from cache (client called once)', async () => {
  const client = stubClient(async () => okResult);
  const app = createApp({ client, username: 'nasa', cacheTtlMs: 60_000 });
  await withServer(app, async (base) => {
    await (await fetch(`${base}/latest-tweet`)).json();
    const body = await (await fetch(`${base}/latest-tweet`)).json();
    assert.equal(body.cached, true);
    assert.equal(client.calls.length, 1);
  });
});

test('?username= overrides the default and a leading @ is stripped', async () => {
  const client = stubClient(async () => okResult);
  const app = createApp({ client, username: 'nasa' });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/latest-tweet?username=@spacex`);
    assert.equal(res.status, 200);
    assert.equal(client.calls[0].username, 'spacex');
  });
});

test('exclude flags from the query string reach the client', async () => {
  const client = stubClient(async () => okResult);
  const app = createApp({ client, username: 'nasa' });
  await withServer(app, async (base) => {
    await fetch(`${base}/latest-tweet?exclude_retweets=include&exclude_replies=include`);
    assert.equal(client.calls[0].opts.excludeRetweets, false);
    assert.equal(client.calls[0].opts.excludeReplies, false);
  });
});

test('invalid username -> 400 invalid_username, client untouched', async () => {
  const client = stubClient(async () => okResult);
  const app = createApp({ client, username: 'nasa' });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/latest-tweet?username=${encodeURIComponent('bad name!')}`);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_username');
    assert.equal(client.calls.length, 0);
  });
});

test('user exists but nothing matches the filters -> 404 no_tweets_found', async () => {
  const client = stubClient(async () => ({ user: okResult.user, tweet: null }));
  const app = createApp({ client, username: 'nasa' });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/latest-tweet`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'no_tweets_found');
  });
});

test('client 404 -> 404 user_not_found', async () => {
  const client = stubClient(async () => {
    throw new TwitterApiError('nope', { status: 404, code: 'user_not_found' });
  });
  const app = createApp({ client, username: 'nasa' });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/latest-tweet?username=ghostuser`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'user_not_found');
  });
});

test('client 429 -> 503 rate_limited with a Retry-After header', async () => {
  const client = stubClient(async () => {
    throw new TwitterApiError('rl', { status: 429, retryAfterMs: 7000, code: 'rate_limited' });
  });
  const app = createApp({ client, username: 'nasa' });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/latest-tweet`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'rate_limited');
    assert.equal(res.headers.get('retry-after'), '7');
  });
});

test('other upstream failures -> 502 upstream_error without internals leaking', async () => {
  const client = stubClient(async () => {
    throw new TwitterApiError('secret upstream detail', { status: 502, code: 'upstream_malformed' });
  });
  const app = createApp({ client, username: 'nasa' });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/latest-tweet`);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'upstream_error');
    assert.doesNotMatch(JSON.stringify(body), /secret upstream detail/);
  });
});

test('an unexpected client error -> 500 internal_error', async () => {
  const client = stubClient(async () => {
    throw new Error('boom');
  });
  const app = createApp({ client, username: 'nasa' });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/latest-tweet`);
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error, 'internal_error');
  });
});

test('unknown route -> 404 not_found', async () => {
  const app = createApp({ client: stubClient(async () => okResult), username: 'nasa' });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'not_found');
  });
});
