'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TwitterClient } = require('../src/twitterClient');
const { legacyTweet, pageProps, feedHtml, htmlResponse, queuedFetch } = require('./helpers');

function clientWith(tweets) {
  return new TwitterClient({
    fetchImpl: queuedFetch([htmlResponse(feedHtml(pageProps({ tweets })))]),
  });
}

const rt = legacyTweet({
  id: '4003',
  text: 'RT @someone: boosted',
  createdAt: 'Mon Nov 02 12:00:00 +0000 2026',
  retweetedStatus: { id_str: '9001' },
});
const reply = legacyTweet({
  id: '4002',
  text: '@someone a reply',
  createdAt: 'Mon Nov 02 11:00:00 +0000 2026',
  inReplyToStatusId: '9000',
});
const plain = legacyTweet({
  id: '4001',
  text: 'original post',
  createdAt: 'Mon Nov 02 10:00:00 +0000 2026',
});

test('retweets are excluded by default and included on request', async () => {
  const excluded = await clientWith([rt, plain]).getLatestPost('nasa');
  assert.equal(excluded.tweet.id, '4001');
  const included = await clientWith([rt, plain]).getLatestPost('nasa', { excludeRetweets: false });
  assert.equal(included.tweet.id, '4003');
});

test('a post whose text starts with "RT @" counts as a retweet even without retweeted_status', async () => {
  const textOnlyRt = legacyTweet({
    id: '4004',
    text: 'RT @someone: boosted',
    createdAt: 'Mon Nov 02 12:30:00 +0000 2026',
  });
  const { tweet } = await clientWith([textOnlyRt, plain]).getLatestPost('nasa');
  assert.equal(tweet.id, '4001');
});

test('replies are excluded by default and included on request', async () => {
  const excluded = await clientWith([reply, plain]).getLatestPost('nasa');
  assert.equal(excluded.tweet.id, '4001');
  const included = await clientWith([reply, plain]).getLatestPost('nasa', { excludeReplies: false });
  assert.equal(included.tweet.id, '4002');
});

test('a self-reply (thread continuation) still counts as a reply', async () => {
  const selfReply = legacyTweet({
    id: '4005',
    text: 'continuing my own thread',
    createdAt: 'Mon Nov 02 13:00:00 +0000 2026',
    inReplyToStatusId: '4001',
  });
  const { tweet } = await clientWith([selfReply, plain]).getLatestPost('nasa');
  assert.equal(tweet.id, '4001');
});

test('posts by other authors are never selected, even when newer', async () => {
  const stranger = legacyTweet({
    id: '4006',
    text: 'someone else, newer',
    createdAt: 'Mon Nov 02 14:00:00 +0000 2026',
    screenName: 'someoneelse',
    userId: '999',
    userName: 'Someone Else',
  });
  const { user, tweet } = await clientWith([stranger, plain]).getLatestPost('nasa');
  assert.equal(tweet.id, '4001');
  assert.equal(user.username, 'nasa');
});

test('a page whose posts are ALL by other authors is malformed, not a result', async () => {
  const stranger = legacyTweet({
    id: '4007',
    text: 'not the owner',
    screenName: 'someoneelse',
    userId: '999',
    userName: 'Someone Else',
  });
  await assert.rejects(clientWith([stranger]).getLatestPost('nasa'), (err) => {
    assert.equal(err.status, 502);
    assert.equal(err.code, 'upstream_malformed');
    return true;
  });
});

test('when every post is filtered out, tweet is null (the user still resolves)', async () => {
  const { user, tweet } = await clientWith([rt, reply]).getLatestPost('nasa');
  assert.equal(tweet, null);
  assert.equal(user.username, 'nasa');
});
