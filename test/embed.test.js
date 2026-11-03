'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const pkg = require('../package.json');
const lib = require('../src/index');
const { legacyTweet, pageProps, feedHtml, htmlResponse, queuedFetch } = require('./helpers');

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

function offlineClient() {
  const html = feedHtml(pageProps({ tweets: [legacyTweet({})] }));
  return new lib.TwitterClient({ fetchImpl: queuedFetch([htmlResponse(html), htmlResponse(html), htmlResponse(html)]) });
}

test('package.json main points at the library entry, which loads without side effects', () => {
  assert.equal(pkg.main, 'src/index.js');
  for (const name of ['TwitterClient', 'TwitterApiError', 'createApp', 'createLatestTweetHandler', 'parseNextData', 'extractTimeline']) {
    assert.equal(typeof lib[name], 'function', `missing export: ${name}`);
  }
});

test('level 1: the client works on its own, no HTTP involved', async () => {
  const client = offlineClient();
  const { user, tweet } = await client.getLatestPost('nasa');
  assert.equal(user.username, 'nasa');
  assert.equal(tweet.id, '1001');
});

test('level 2: the handler mounts on a host app under a custom path', async () => {
  const host = express();
  host.get('/posts/latest', lib.createLatestTweetHandler({ client: offlineClient(), username: 'nasa' }));
  host.get('/other', (_req, res) => res.json({ mine: true }));
  await withServer(host, async (base) => {
    const res = await fetch(`${base}/posts/latest`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).id, '1001');
    // The host's own routes and behaviour are untouched.
    assert.deepEqual(await (await fetch(`${base}/other`)).json(), { mine: true });
  });
});

test('level 3: createApp mounts as a sub-application under a prefix', async () => {
  const host = express();
  host.use('/x', lib.createApp({ client: offlineClient(), username: 'nasa' }));
  await withServer(host, async (base) => {
    const res = await fetch(`${base}/x/latest-tweet`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).author.username, 'nasa');
    assert.equal((await fetch(`${base}/x/health`)).status, 200);
  });
});

test('customisation: a custom User-Agent and base URL reach the feed request', async () => {
  const seen = [];
  const html = feedHtml(pageProps({ tweets: [legacyTweet({})] }));
  const client = new lib.TwitterClient({
    fetchImpl: queuedFetch([htmlResponse(html)], seen),
    baseUrl: 'http://feed.internal:8080/',
    userAgent: 'MyBot/1.0',
  });
  await client.getLatestPost('nasa');
  assert.equal(seen[0].url, 'http://feed.internal:8080/srv/timeline-profile/screen-name/nasa');
  assert.equal(seen[0].opts.headers['User-Agent'], 'MyBot/1.0');
});

test('customisation: a wrapped fetchImpl can observe and pass through requests', async () => {
  const html = feedHtml(pageProps({ tweets: [legacyTweet({})] }));
  const inner = queuedFetch([htmlResponse(html)]);
  let observed = 0;
  const client = new lib.TwitterClient({
    fetchImpl: async (url, opts) => {
      observed += 1;
      return inner(url, opts);
    },
  });
  await client.getLatestPost('nasa');
  assert.equal(observed, 1);
});

test('two handler instances keep separate caches (no cross-mount leakage)', async () => {
  const clientA = offlineClient();
  const clientB = offlineClient();
  const host = express();
  host.get('/a', lib.createLatestTweetHandler({ client: clientA, username: 'nasa' }));
  host.get('/b', lib.createLatestTweetHandler({ client: clientB, username: 'nasa' }));
  await withServer(host, async (base) => {
    await (await fetch(`${base}/a`)).json();
    const second = await (await fetch(`${base}/a`)).json();
    assert.equal(second.cached, true);
    const other = await (await fetch(`${base}/b`)).json();
    assert.equal(other.cached, false);
  });
});
