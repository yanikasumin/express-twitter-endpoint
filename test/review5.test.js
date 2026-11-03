'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TwitterClient, TwitterApiError } = require('../src/twitterClient');
const { legacyTweet, pageProps, feedHtml, htmlResponse, queuedFetch, recordingSleep } = require('./helpers');

const okHtml = () => feedHtml(pageProps({ tweets: [legacyTweet({})] }));

test('operationDeadlineAt is now + deadlineMs', () => {
  const client = new TwitterClient({
    fetchImpl: async () => htmlResponse(''),
    deadlineMs: 45_000,
    nowFn: () => 1_000_000,
  });
  assert.equal(client.operationDeadlineAt(), 1_045_000);
});

test('no attempt is started after the deadline', async () => {
  const seen = [];
  const client = new TwitterClient({
    fetchImpl: queuedFetch([htmlResponse(okHtml())], seen),
    nowFn: () => 5_000,
  });
  await assert.rejects(
    client.getLatestPost('nasa', { deadlineAt: 4_999 }),
    (err) => err instanceof TwitterApiError && err.code === 'deadline_exceeded'
  );
  assert.equal(seen.length, 0);
});

test('a retry wait that would cross the deadline is not taken', async () => {
  const waits = [];
  // Deadline 3 s from the fixed "now": the server asks for a 7 s wait,
  // which cannot fit, so the client must surface the 429 at once.
  const client = new TwitterClient({
    fetchImpl: queuedFetch([
      htmlResponse('rl', { status: 429, headers: { 'Retry-After': '7' } }),
    ]),
    sleepImpl: recordingSleep(waits),
    nowFn: () => 10_000,
    deadlineMs: 60_000,
  });
  await assert.rejects(
    client.getLatestPost('nasa', { deadlineAt: 13_000 }),
    (err) => err.status === 429 && err.retryAfterMs === 7000
  );
  assert.deepEqual(waits, []);
});

test('a body that stalls after a 200 header is aborted by the attempt timeout (no hang past the deadline)', async () => {
  const stallingFetch = async (_url, opts) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: () =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
  });
  const client = new TwitterClient({ fetchImpl: stallingFetch, timeoutMs: 30, maxRetries: 0 });
  await assert.rejects(client.getLatestPost('nasa'), (err) => {
    assert.ok(err instanceof TwitterApiError);
    assert.equal(err.code, 'upstream_timeout');
    return true;
  });
});

test('a body read that throws is classified as an upstream error, not a bare exception', async () => {
  const throwingFetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => {
      throw new Error('connection reset mid-body');
    },
  });
  const client = new TwitterClient({ fetchImpl: throwingFetch, maxRetries: 0 });
  await assert.rejects(client.getLatestPost('nasa'), (err) => {
    assert.ok(err instanceof TwitterApiError);
    assert.equal(err.code, 'upstream_network');
    return true;
  });
});

test('each attempt carries an AbortSignal, shrunk to the time left before the deadline', async () => {
  const seen = [];
  const client = new TwitterClient({
    fetchImpl: queuedFetch([htmlResponse(okHtml())], seen),
    timeoutMs: 60_000,
  });
  await client.getLatestPost('nasa', { deadlineAt: Date.now() + 2_000 });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].opts.signal instanceof AbortSignal);
});
