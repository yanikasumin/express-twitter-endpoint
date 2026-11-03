'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TwitterClient, TwitterApiError } = require('../src/twitterClient');

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  };
}

test('constructor requires a bearer token', () => {
  assert.throws(() => new TwitterClient({}), /TWITTER_BEARER_TOKEN/);
});

test('getUserByUsername resolves username -> id and sends the Bearer header', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, opts });
    return jsonResponse({ data: { id: '44196397', name: 'Elon Musk', username: 'elonmusk' } });
  };
  const client = new TwitterClient({ bearerToken: 'TEST_TOKEN', fetchImpl });

  const user = await client.getUserByUsername('elonmusk');
  assert.equal(user.id, '44196397');
  assert.equal(user.username, 'elonmusk');
  assert.match(seen[0].url, /\/users\/by\/username\/elonmusk/);
  assert.equal(seen[0].opts.headers.Authorization, 'Bearer TEST_TOKEN');
});

test('getUserByUsername caches the resolved user', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({ data: { id: '1', name: 'A', username: 'a' } });
  };
  const client = new TwitterClient({ bearerToken: 'T', fetchImpl });
  await client.getUserByUsername('a');
  await client.getUserByUsername('A');
  assert.equal(calls, 1);
});

test('getLatestTweet requests max_results and exclude params', async () => {
  let requestedUrl = null;
  const fetchImpl = async (url) => {
    requestedUrl = url;
    return jsonResponse({
      data: [{ id: '123', text: 'hello', created_at: '2026-11-03T00:00:00.000Z', author_id: '44196397' }],
      meta: { result_count: 1 },
    });
  };
  const client = new TwitterClient({ bearerToken: 'T', fetchImpl });
  const tweet = await client.getLatestTweet('44196397', { excludeRetweets: true, excludeReplies: false });

  assert.equal(tweet.id, '123');
  const u = new URL(requestedUrl);
  assert.equal(u.searchParams.get('exclude'), 'retweets');
  assert.equal(u.searchParams.get('max_results'), '5');
});

test('getLatestTweet returns null when there are no tweets', async () => {
  const fetchImpl = async () => jsonResponse({ meta: { result_count: 0 } });
  const client = new TwitterClient({ bearerToken: 'T', fetchImpl });
  const tweet = await client.getLatestTweet('999', {});
  assert.equal(tweet, null);
});

test('API errors are surfaced as TwitterApiError with status', async () => {
  const fetchImpl = async () =>
    jsonResponse({ title: 'Too Many Requests', detail: 'Rate limit exceeded' }, { status: 429 });
  const client = new TwitterClient({ bearerToken: 'T', fetchImpl });
  await assert.rejects(
    () => client.getUserByUsername('elonmusk'),
    (err) => err instanceof TwitterApiError && err.status === 429
  );
});
