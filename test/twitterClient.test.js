'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TwitterClient, TwitterApiError, normalizeUsername } = require('../src/twitterClient');
const { legacyTweet, pageProps, feedHtml, htmlResponse, queuedFetch, recordingSleep } = require('./helpers');

test('constructor needs no token: a client can be built with defaults only', () => {
  const client = new TwitterClient({ fetchImpl: async () => htmlResponse('') });
  assert.equal(client.baseUrl, 'https://syndication.twitter.com');
  assert.equal(client.timeoutMs, 10_000);
  assert.equal(client.deadlineMs, 60_000);
});

test('constructor rejects out-of-range numeric options', () => {
  const fetchImpl = async () => htmlResponse('');
  assert.throws(() => new TwitterClient({ fetchImpl, timeoutMs: 0 }), /"timeoutMs"/);
  assert.throws(() => new TwitterClient({ fetchImpl, timeoutMs: NaN }), /"timeoutMs"/);
  assert.throws(() => new TwitterClient({ fetchImpl, maxRetries: -1 }), /"maxRetries"/);
  assert.throws(() => new TwitterClient({ fetchImpl, maxRetries: 1.5 }), /"maxRetries"/);
  assert.throws(() => new TwitterClient({ fetchImpl, retryBudgetMs: -5 }), /"retryBudgetMs"/);
  assert.throws(() => new TwitterClient({ fetchImpl, deadlineMs: Infinity }), /"deadlineMs"/);
});

test('normalizeUsername strips one leading @ and validates the shape', () => {
  assert.equal(normalizeUsername('@nasa'), 'nasa');
  assert.equal(normalizeUsername('nasa'), 'nasa');
  assert.equal(normalizeUsername('bad name'), null);
  assert.equal(normalizeUsername(''), null);
  assert.equal(normalizeUsername(42), null);
  assert.equal(normalizeUsername('a'.repeat(16)), null);
});

test('getLatestPost requests the syndication profile URL with a browser UA', async () => {
  const seen = [];
  const html = feedHtml(pageProps({ tweets: [legacyTweet({})] }));
  const client = new TwitterClient({ fetchImpl: queuedFetch([htmlResponse(html)], seen) });
  await client.getLatestPost('nasa');
  assert.equal(seen.length, 1);
  assert.equal(
    seen[0].url,
    'https://syndication.twitter.com/srv/timeline-profile/screen-name/nasa'
  );
  assert.match(seen[0].opts.headers['User-Agent'], /Mozilla\/5\.0/);
  assert.equal(seen[0].opts.method, 'GET');
});

test('getLatestPost returns the newest post and the author, with ISO created_at', async () => {
  const tweets = [
    legacyTweet({ id: '2002', text: 'newer', createdAt: 'Mon Nov 02 12:00:00 +0000 2026' }),
    legacyTweet({ id: '2001', text: 'older', createdAt: 'Mon Nov 02 09:00:00 +0000 2026' }),
  ];
  const client = new TwitterClient({
    fetchImpl: queuedFetch([htmlResponse(feedHtml(pageProps({ tweets })))]),
  });
  const { user, tweet } = await client.getLatestPost('nasa');
  assert.equal(tweet.id, '2002');
  assert.equal(tweet.text, 'newer');
  assert.equal(tweet.created_at, '2026-11-02T12:00:00.000Z');
  assert.deepEqual(user, { id: '11348282', username: 'nasa', name: 'NASA' });
});

test('selection is by timestamp, not feed order (a pinned older post must not win)', async () => {
  const tweets = [
    legacyTweet({ id: '3001', text: 'pinned old', createdAt: 'Wed Jan 01 10:00:00 +0000 2025' }),
    legacyTweet({ id: '3002', text: 'latest', createdAt: 'Mon Nov 02 08:00:00 +0000 2026' }),
  ];
  const client = new TwitterClient({
    fetchImpl: queuedFetch([htmlResponse(feedHtml(pageProps({ tweets })))]),
  });
  const { tweet } = await client.getLatestPost('nasa');
  assert.equal(tweet.id, '3002');
});

test('invalid username is rejected before any upstream call', async () => {
  const seen = [];
  const client = new TwitterClient({ fetchImpl: queuedFetch([], seen) });
  await assert.rejects(client.getLatestPost('not a user!'), (err) => {
    assert.ok(err instanceof TwitterApiError);
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_username');
    return true;
  });
  assert.equal(seen.length, 0);
});
