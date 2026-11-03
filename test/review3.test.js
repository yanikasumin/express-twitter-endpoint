'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TwitterClient, TwitterApiError, parseNextData, extractTimeline } = require('../src/twitterClient');
const { legacyTweet, pageProps, feedHtml, htmlResponse, queuedFetch } = require('./helpers');

test('a page without __NEXT_DATA__ is an upstream error, never an empty result', async () => {
  const client = new TwitterClient({
    fetchImpl: queuedFetch([htmlResponse('<html><body>something else</body></html>')]),
  });
  await assert.rejects(client.getLatestPost('nasa'), (err) => {
    assert.ok(err instanceof TwitterApiError);
    assert.equal(err.status, 502);
    assert.equal(err.code, 'upstream_malformed');
    return true;
  });
});

test('a page whose __NEXT_DATA__ is not valid JSON is an upstream error', async () => {
  const html =
    '<script id="__NEXT_DATA__" type="application/json">{not json</script>';
  const client = new TwitterClient({ fetchImpl: queuedFetch([htmlResponse(html)]) });
  await assert.rejects(client.getLatestPost('nasa'), (err) => {
    assert.equal(err.code, 'upstream_malformed');
    return true;
  });
});

test('empty timeline with no header = user_not_found (unknown/protected/suspended are indistinguishable)', async () => {
  const html = feedHtml(pageProps({ tweets: [], withHeader: false, screenName: null }));
  const client = new TwitterClient({ fetchImpl: queuedFetch([htmlResponse(html)]) });
  await assert.rejects(client.getLatestPost('ghostuser'), (err) => {
    assert.equal(err.status, 404);
    assert.equal(err.code, 'user_not_found');
    return true;
  });
});

test('existing user with zero posts resolves the user and returns tweet = null', async () => {
  const html = feedHtml(pageProps({ tweets: [], withHeader: true, screenName: 'quietuser' }));
  const client = new TwitterClient({ fetchImpl: queuedFetch([htmlResponse(html)]) });
  const { user, tweet } = await client.getLatestPost('quietuser');
  assert.equal(tweet, null);
  assert.equal(user.username, 'quietuser');
});

test('entries without a usable tweet are skipped instead of failing the parse', async () => {
  const props = pageProps({ tweets: [legacyTweet({ id: '5001' })] });
  props.timeline.entries.unshift({ type: 'tweet', entry_id: 'x', content: {} });
  props.timeline.entries.push(null);
  props.timeline.entries.push({ type: 'cursor', entry_id: 'c', content: {} });
  const client = new TwitterClient({
    fetchImpl: queuedFetch([htmlResponse(feedHtml(props))]),
  });
  const { tweet } = await client.getLatestPost('nasa');
  assert.equal(tweet.id, '5001');
});

test('full_text is preferred; text is the fallback; missing dates disqualify a tweet', async () => {
  const noFullText = legacyTweet({ id: '5002', createdAt: 'Mon Nov 02 12:00:00 +0000 2026' });
  delete noFullText.full_text;
  noFullText.text = 'fallback text';
  const badDate = legacyTweet({ id: '5003', createdAt: 'not a date' });
  const { tweet } = await new TwitterClient({
    fetchImpl: queuedFetch([htmlResponse(feedHtml(pageProps({ tweets: [badDate, noFullText] })))]),
  }).getLatestPost('nasa');
  assert.equal(tweet.id, '5002');
  assert.equal(tweet.text, 'fallback text');
});

test('parseNextData / extractTimeline units: garbage in, malformed out', () => {
  assert.equal(parseNextData('no script here'), null);
  assert.equal(parseNextData(42), null);
  assert.equal(extractTimeline(null).malformed, true);
  assert.equal(extractTimeline({ props: {} }).malformed, true);
  assert.deepEqual(extractTimeline(null).tweets, []);
});

test('the __NEXT_DATA__ tag is found regardless of attribute order or extra attributes', async () => {
  const props = pageProps({ tweets: [legacyTweet({ id: '6001' })] });
  const data = JSON.stringify({ props: { pageProps: props }, page: '/', query: {} });
  const html =
    `<html><body><script type="application/json" data-x="1" id="__NEXT_DATA__">${data}</script></body></html>`;
  const client = new TwitterClient({ fetchImpl: queuedFetch([htmlResponse(html)]) });
  const { tweet } = await client.getLatestPost('nasa');
  assert.equal(tweet.id, '6001');
});

test('a well-formed JSON whose pageProps is empty is malformed (502), not user_not_found', async () => {
  const html =
    '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}}}</script>';
  const client = new TwitterClient({ fetchImpl: queuedFetch([htmlResponse(html)]) });
  await assert.rejects(client.getLatestPost('nasa'), (err) => {
    assert.equal(err.status, 502);
    assert.equal(err.code, 'upstream_malformed');
    return true;
  });
});

test('entries that is not an array is malformed (502)', async () => {
  const html =
    '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"timeline":{"entries":{}}}}}</script>';
  const client = new TwitterClient({ fetchImpl: queuedFetch([htmlResponse(html)]) });
  await assert.rejects(client.getLatestPost('nasa'), (err) => err.status === 502);
});

test('headerProps present but null is malformed (502), not absent', async () => {
  const props = pageProps({ tweets: [], withHeader: false });
  props.headerProps = null;
  const client = new TwitterClient({ fetchImpl: queuedFetch([htmlResponse(feedHtml(props))]) });
  await assert.rejects(client.getLatestPost('nasa'), (err) => {
    assert.equal(err.status, 502);
    assert.equal(err.code, 'upstream_malformed');
    return true;
  });
});

test('a data-id attribute is not mistaken for the __NEXT_DATA__ id', async () => {
  const props = pageProps({ tweets: [legacyTweet({ id: '6020' })] });
  const realData = JSON.stringify({ props: { pageProps: props }, page: '/', query: {} });
  const html =
    '<html><body>' +
    '<script data-id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}}}</script>' +
    `<script id="__NEXT_DATA__" type="application/json">${realData}</script>` +
    '</body></html>';
  const client = new TwitterClient({ fetchImpl: queuedFetch([htmlResponse(html)]) });
  const { tweet } = await client.getLatestPost('nasa');
  assert.equal(tweet.id, '6020');
});

test('a header object without a screenName is malformed (502), even with an empty timeline', async () => {
  const props = pageProps({ tweets: [], withHeader: false });
  props.headerProps = { followersCount: 3 }; // header exists, screenName missing
  const client = new TwitterClient({ fetchImpl: queuedFetch([htmlResponse(feedHtml(props))]) });
  await assert.rejects(client.getLatestPost('nasa'), (err) => {
    assert.equal(err.status, 502);
    assert.equal(err.code, 'upstream_malformed');
    return true;
  });
});

test('a header object without a screenName is malformed (502) when posts exist too', async () => {
  const props = pageProps({ tweets: [legacyTweet({ id: '6010' })], withHeader: false });
  props.headerProps = {};
  const client = new TwitterClient({ fetchImpl: queuedFetch([htmlResponse(feedHtml(props))]) });
  await assert.rejects(client.getLatestPost('nasa'), (err) => err.status === 502);
});

test('posts on a page with NO profile header at all are malformed (502), not a result', async () => {
  const props = pageProps({ tweets: [legacyTweet({ id: '6011' })], withHeader: false });
  const client = new TwitterClient({ fetchImpl: queuedFetch([htmlResponse(feedHtml(props))]) });
  await assert.rejects(client.getLatestPost('nasa'), (err) => {
    assert.equal(err.status, 502);
    assert.equal(err.code, 'upstream_malformed');
    return true;
  });
});

test('entries exist but none carries a usable tweet -> malformed (502), not user_not_found', async () => {
  const props = pageProps({ tweets: [], withHeader: false, screenName: null });
  props.timeline.entries = [
    { type: 'tweet', entry_id: 'a', content: { tweet: { nope: true } } },
    { type: 'tweet', entry_id: 'b', content: { tweet: { id_str: '1' } } },
  ];
  const client = new TwitterClient({
    fetchImpl: queuedFetch([htmlResponse(feedHtml(props))]),
  });
  await assert.rejects(client.getLatestPost('nasa'), (err) => {
    assert.equal(err.status, 502);
    assert.equal(err.code, 'upstream_malformed');
    return true;
  });
});

test('an upstream HTTP 500 surfaces its status as an upstream error', async () => {
  const client = new TwitterClient({
    fetchImpl: queuedFetch([htmlResponse('oops', { status: 500 })]),
  });
  await assert.rejects(client.getLatestPost('nasa'), (err) => {
    assert.equal(err.status, 500);
    assert.equal(err.code, 'upstream_http');
    return true;
  });
});

test('an upstream HTTP 404 surfaces as user_not_found', async () => {
  const client = new TwitterClient({
    fetchImpl: queuedFetch([htmlResponse('nope', { status: 404 })]),
  });
  await assert.rejects(client.getLatestPost('nasa'), (err) => {
    assert.equal(err.status, 404);
    assert.equal(err.code, 'user_not_found');
    return true;
  });
});
