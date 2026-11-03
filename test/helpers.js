'use strict';

/**
 * Shared fixtures for the syndication-version test suite.
 *
 * The upstream feed returns an HTML page with a `__NEXT_DATA__` JSON
 * block; `feedHtml` builds such a page from a pageProps object, and
 * `legacyTweet` builds one legacy-format tweet object as observed in
 * the real feed payload (2026-11-03).
 */

function legacyTweet({
  id = '1001',
  text = 'a post',
  createdAt = 'Mon Nov 02 10:00:00 +0000 2026',
  screenName = 'nasa',
  userId = '11348282',
  userName = 'NASA',
  retweetedStatus = undefined,
  inReplyToStatusId = undefined,
} = {}) {
  const tweet = {
    id_str: id,
    full_text: text,
    text,
    created_at: createdAt,
    conversation_id_str: id,
    display_text_range: [0, text.length],
    entities: {},
    favorite_count: 0,
    reply_count: 0,
    retweet_count: 0,
    user: {
      id_str: userId,
      screen_name: screenName,
      name: userName,
      protected: false,
    },
  };
  if (retweetedStatus !== undefined) tweet.retweeted_status = retweetedStatus;
  if (inReplyToStatusId !== undefined) tweet.in_reply_to_status_id_str = inReplyToStatusId;
  return tweet;
}

function pageProps({ screenName = 'nasa', tweets = [], withHeader = true } = {}) {
  const props = {
    contextProvider: {},
    timeline: {
      entries: tweets.map((tweet, i) => ({
        type: 'tweet',
        entry_id: `tweet-${tweet.id_str}`,
        sort_index: String(10_000 - i),
        content: { tweet },
      })),
    },
  };
  if (withHeader && screenName) {
    props.headerProps = { screenName };
    if (tweets.length > 0) props.latest_tweet_id = tweets[0].id_str;
  }
  return props;
}

function feedHtml(props) {
  const data = { props: { pageProps: props }, page: '/', query: {} };
  return (
    '<!DOCTYPE html><html><head></head><body>' +
    `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>` +
    '</body></html>'
  );
}

/** Minimal fetch Response stand-in with case-insensitive headers. */
function htmlResponse(html, { status = 200, headers = {} } = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (map.has(name.toLowerCase()) ? map.get(name.toLowerCase()) : null) },
    text: async () => html,
  };
}

/** fetchImpl that replays a queue of responses (or Errors) in order. */
function queuedFetch(queue, seen = []) {
  return async (url, opts) => {
    seen.push({ url, opts });
    if (queue.length === 0) throw new Error('queuedFetch: no response left in queue');
    const item = queue.shift();
    if (item instanceof Error) throw item;
    return item;
  };
}

/** sleepImpl that records waits instead of sleeping. */
function recordingSleep(waits = []) {
  return async (ms) => {
    waits.push(ms);
  };
}

module.exports = { legacyTweet, pageProps, feedHtml, htmlResponse, queuedFetch, recordingSleep };
