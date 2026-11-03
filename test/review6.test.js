'use strict';

// Round-6 review regressions (all P2):
// - P2-1: once the (shared) deadline has passed, _get must throw
//   EDEADLINE immediately instead of starting one more attempt with a
//   1 ms timeout. In particular the second stage of an operation whose
//   first stage consumed the whole budget must not call fetch at all.
// - P2-2: README error-classification wording — a malformed user object
//   is a 502, but a malformed individual tweet entry is skipped and can
//   yield 404; the old blanket "all of those anomalies are upstream
//   errors" sentence must be gone. Retry-After must be described as
//   honoured "up to the configured cap".
// - P2-3: README must recommend the Developer Console Spending limit as
//   a spending cap separate from the prepaid balance.
// - P2-4: package-lock.json root engines must match package.json.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TwitterClient, TwitterApiError } = require('../src/twitterClient');

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  };
}

const USER_BODY = { data: { id: '1', name: 'N', username: 'nasa' } };

// ---------- P2-1: no attempt is started after the deadline ----------

test('a deadlineAt already in the past throws EDEADLINE and never calls fetch (stage 1)', async () => {
  let fetchCalls = 0;
  const client = new TwitterClient({
    bearerToken: 'T',
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse(USER_BODY);
    },
    deadlineMs: 60_000,
  });
  await assert.rejects(
    client.getUserByUsername('nasa', { deadlineAt: Date.now() - 1 }),
    (err) => err instanceof TwitterApiError && err.code === 'EDEADLINE'
  );
  assert.equal(fetchCalls, 0);
});

test('second stage with an exhausted shared deadline throws EDEADLINE and never calls fetch', async () => {
  let fetchCalls = 0;
  const client = new TwitterClient({
    bearerToken: 'T',
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse(USER_BODY);
    },
    deadlineMs: 60_000,
  });
  const deadlineAt = Date.now() - 5_000; // stage 1 already used the budget
  await assert.rejects(
    client.getLatestTweet('1', { deadlineAt }),
    (err) => err instanceof TwitterApiError && err.code === 'EDEADLINE'
  );
  assert.equal(fetchCalls, 0);
});

test('a deadlineAt exactly at now also starts no attempt', async () => {
  let fetchCalls = 0;
  const client = new TwitterClient({
    bearerToken: 'T',
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse(USER_BODY);
    },
    deadlineMs: 60_000,
  });
  await assert.rejects(
    client.getUserByUsername('nasa', { deadlineAt: Date.now() }),
    (err) => err instanceof TwitterApiError && err.code === 'EDEADLINE'
  );
  assert.equal(fetchCalls, 0);
});

test('a still-valid deadlineAt is unaffected by the guard (attempt runs normally)', async () => {
  const client = new TwitterClient({
    bearerToken: 'T',
    fetchImpl: async () => jsonResponse(USER_BODY),
    deadlineMs: 60_000,
  });
  const user = await client.getUserByUsername('nasa', { deadlineAt: Date.now() + 30_000 });
  assert.equal(user.username, 'nasa');
});

// ---------- P2-2 / P2-3: README wording ----------

test('README separates user-shape 502s from skipped tweet entries, and caps the Retry-After claim', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.ok(!readme.includes('All of those anomalies'), 'blanket 502 sentence must be gone');
  assert.ok(readme.includes('malformed individual tweet entry is simply skipped'));
  assert.ok(readme.includes('honours `Retry-After` up to the configured cap'));
  assert.ok(readme.includes('up to the configured per-wait cap'));
});

test('README recommends the Developer Console Spending limit as a separate cap', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.ok(readme.includes('Spending limit'));
  assert.ok(readme.includes('auto-recharge')); // round-5 caveat still present
});

// ---------- P2-4: package-lock engines consistency ----------

test('package-lock.json root engines match package.json', () => {
  const dir = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[''].engines.node, pkg.engines.node);
});
