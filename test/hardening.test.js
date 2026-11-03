'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp, parseFlag, isValidUsername, apiKeyMatches } = require('../src/app');

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

function countingClient() {
  const calls = [];
  return {
    calls,
    operationDeadlineAt: () => Date.now() + 60_000,
    getLatestPost: async (username, opts) => {
      calls.push({ username, opts });
      return {
        user: { id: '1', username, name: username },
        tweet: { id: '9', text: 'x', created_at: '2026-11-02T00:00:00.000Z' },
      };
    },
  };
}

test('isValidUsername accepts the X username shape and rejects the rest', () => {
  assert.equal(isValidUsername('nasa'), true);
  assert.equal(isValidUsername('a_b_1'), true);
  assert.equal(isValidUsername(''), false);
  assert.equal(isValidUsername('has space'), false);
  assert.equal(isValidUsername('dot.name'), false);
  assert.equal(isValidUsername('a'.repeat(15)), true);
  assert.equal(isValidUsername('a'.repeat(16)), false);
  assert.equal(isValidUsername(null), false);
});

test('parseFlag understands exclude/include spellings and falls back to the default', () => {
  assert.equal(parseFlag('exclude', false), true);
  assert.equal(parseFlag('include', true), false);
  assert.equal(parseFlag('TRUE', false), true);
  assert.equal(parseFlag('0', true), false);
  assert.equal(parseFlag(undefined, true), true);
  assert.equal(parseFlag('garbage', false), false);
});

test('apiKeyMatches is exact and length-sensitive', () => {
  assert.equal(apiKeyMatches('s3cret', 's3cret'), true);
  assert.equal(apiKeyMatches('s3cret', 's3creT'), false);
  assert.equal(apiKeyMatches('s3cret', 's3cret-longer'), false);
  assert.equal(apiKeyMatches('', 's3cret'), false);
  assert.equal(apiKeyMatches(undefined, 's3cret'), false);
});

test('createApp refuses a missing client and an invalid default username', () => {
  assert.throws(() => createApp({ username: 'nasa' }), /requires a client with getLatestPost/);
  assert.throws(
    () => createApp({ client: countingClient(), username: 'bad name!' }),
    /Invalid default username/
  );
});

test('a repeated ?username= (array value) is a 400, not a crash', async () => {
  const client = countingClient();
  const app = createApp({ client, username: 'nasa' });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/latest-tweet?username=a&username=b`);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_username');
    assert.equal(client.calls.length, 0);
  });
});

test('a structured ?username[x]= value is a 400, not a crash', async () => {
  const client = countingClient();
  const app = createApp({ client, username: 'nasa' });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/latest-tweet?username%5Bx%5D=y`);
    assert.equal(res.status, 400);
    assert.equal(client.calls.length, 0);
  });
});

test('a bare "@" as username is a 400 after stripping', async () => {
  const client = countingClient();
  const app = createApp({ client, username: 'nasa' });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/latest-tweet?username=%40`);
    assert.equal(res.status, 400);
    assert.equal(client.calls.length, 0);
  });
});

test('the API-key gate: missing/wrong key -> 401, right key -> 200, /health stays open', async () => {
  const client = countingClient();
  const app = createApp({ client, username: 'nasa', apiKey: 's3cret' });
  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/latest-tweet`)).status, 401);
    assert.equal(
      (await fetch(`${base}/latest-tweet`, { headers: { 'x-api-key': 'wrong' } })).status,
      401
    );
    assert.equal(
      (await fetch(`${base}/latest-tweet`, { headers: { 'x-api-key': 's3cret' } })).status,
      200
    );
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal(client.calls.length, 1);
  });
});

test('cache keys ignore username case (X screen names are case-insensitive)', async () => {
  const client = countingClient();
  const app = createApp({ client, username: 'nasa', cacheTtlMs: 60_000 });
  await withServer(app, async (base) => {
    await (await fetch(`${base}/latest-tweet?username=nasa`)).json();
    const second = await (await fetch(`${base}/latest-tweet?username=NASA`)).json();
    assert.equal(second.cached, true);
    assert.equal(client.calls.length, 1);
  });
});

test('cache entries are separated by the exclude flags', async () => {
  const client = countingClient();
  const app = createApp({ client, username: 'nasa', cacheTtlMs: 60_000 });
  await withServer(app, async (base) => {
    await (await fetch(`${base}/latest-tweet`)).json();
    await (await fetch(`${base}/latest-tweet?exclude_retweets=include`)).json();
    await (await fetch(`${base}/latest-tweet`)).json();
    assert.equal(client.calls.length, 2);
  });
});
