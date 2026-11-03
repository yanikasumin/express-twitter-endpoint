'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TwitterClient, TwitterApiError } = require('../src/twitterClient');
const { legacyTweet, pageProps, feedHtml, htmlResponse, queuedFetch, recordingSleep } = require('./helpers');

const okHtml = () => feedHtml(pageProps({ tweets: [legacyTweet({})] }));

test('a 429 is retried and a later success is returned', async () => {
  const waits = [];
  const client = new TwitterClient({
    fetchImpl: queuedFetch([
      htmlResponse('Rate limit exceeded', { status: 429, headers: { 'Retry-After': '2' } }),
      htmlResponse(okHtml()),
    ]),
    sleepImpl: recordingSleep(waits),
  });
  const { tweet } = await client.getLatestPost('nasa');
  assert.equal(tweet.id, '1001');
  assert.deepEqual(waits, [2000]);
});

test('the wait honours x-rate-limit-reset when Retry-After is absent', async () => {
  const waits = [];
  const now = 1_000_000_000_000;
  const resetSeconds = String(Math.floor(now / 1000) + 5); // 5 s from now
  const client = new TwitterClient({
    fetchImpl: queuedFetch([
      htmlResponse('Rate limit exceeded', {
        status: 429,
        headers: { 'x-rate-limit-limit': '30', 'x-rate-limit-reset': resetSeconds },
      }),
      htmlResponse(okHtml()),
    ]),
    sleepImpl: recordingSleep(waits),
    nowFn: () => now,
    deadlineMs: 120_000,
  });
  await client.getLatestPost('nasa');
  assert.deepEqual(waits, [5000]);
});

test('a suggested wait beyond the 30 s cap fails fast: no shortened wait, no early retry', async () => {
  const waits = [];
  const seen = [];
  const client = new TwitterClient({
    fetchImpl: queuedFetch(
      [htmlResponse('Rate limit exceeded', { status: 429, headers: { 'Retry-After': '900' } })],
      seen
    ),
    sleepImpl: recordingSleep(waits),
  });
  await assert.rejects(client.getLatestPost('nasa'), (err) => {
    assert.ok(err instanceof TwitterApiError);
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterMs, 900_000);
    return true;
  });
  assert.deepEqual(waits, []);
  assert.equal(seen.length, 1);
});

test('the same fail-fast applies when the long wait comes from x-rate-limit-reset', async () => {
  const now = 1_000_000_000_000;
  const resetSeconds = String(Math.floor(now / 1000) + 600); // 600 s from now
  const client = new TwitterClient({
    fetchImpl: queuedFetch([
      htmlResponse('Rate limit exceeded', {
        status: 429,
        headers: { 'x-rate-limit-reset': resetSeconds },
      }),
    ]),
    sleepImpl: recordingSleep([]),
    nowFn: () => now,
  });
  await assert.rejects(client.getLatestPost('nasa'), (err) => {
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterMs, 600_000);
    return true;
  });
});

test('when the rate limit outlasts the retries, the error is 429 with the suggested wait attached', async () => {
  const client = new TwitterClient({
    maxRetries: 2,
    fetchImpl: queuedFetch([
      htmlResponse('Rate limit exceeded', { status: 429, headers: { 'Retry-After': '7' } }),
      htmlResponse('Rate limit exceeded', { status: 429, headers: { 'Retry-After': '7' } }),
      htmlResponse('Rate limit exceeded', { status: 429, headers: { 'Retry-After': '7' } }),
    ]),
    sleepImpl: recordingSleep([]),
  });
  await assert.rejects(client.getLatestPost('nasa'), (err) => {
    assert.ok(err instanceof TwitterApiError);
    assert.equal(err.status, 429);
    assert.equal(err.code, 'rate_limited');
    assert.equal(err.retryAfterMs, 7000);
    return true;
  });
});

test('the total wait never exceeds the retry budget', async () => {
  const waits = [];
  const client = new TwitterClient({
    maxRetries: 10,
    retryBudgetMs: 3000,
    fetchImpl: queuedFetch([
      htmlResponse('rl', { status: 429, headers: { 'Retry-After': '2' } }),
      htmlResponse('rl', { status: 429, headers: { 'Retry-After': '2' } }),
      htmlResponse('rl', { status: 429, headers: { 'Retry-After': '2' } }),
    ]),
    sleepImpl: recordingSleep(waits),
  });
  await assert.rejects(client.getLatestPost('nasa'), (err) => err.status === 429);
  assert.ok(waits.reduce((a, b) => a + b, 0) <= 3000, `waits were ${waits}`);
});

test('a transport failure is retried with backoff, then can succeed', async () => {
  const waits = [];
  const client = new TwitterClient({
    fetchImpl: queuedFetch([new Error('socket hang up'), htmlResponse(okHtml())]),
    sleepImpl: recordingSleep(waits),
  });
  const { tweet } = await client.getLatestPost('nasa');
  assert.equal(tweet.id, '1001');
  assert.deepEqual(waits, [500]);
});

test('persistent transport failure surfaces as upstream_network', async () => {
  const client = new TwitterClient({
    maxRetries: 1,
    fetchImpl: queuedFetch([new Error('boom'), new Error('boom')]),
    sleepImpl: recordingSleep([]),
  });
  await assert.rejects(client.getLatestPost('nasa'), (err) => {
    assert.equal(err.status, null);
    assert.equal(err.code, 'upstream_network');
    return true;
  });
});
