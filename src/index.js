'use strict';

/**
 * Library entry point.
 *
 * This package is a backend component, meant to be embedded into a
 * larger system or customised, not only run as a standalone server:
 *
 *   // 1. Client only (no HTTP): fetch a user's latest post yourself.
 *   const { TwitterClient } = require('express-twitter-endpoint');
 *   const client = new TwitterClient();
 *   const { user, tweet } = await client.getLatestPost('nasa');
 *
 *   // 2. One route inside your own Express app, on your own path:
 *   const { createLatestTweetHandler } = require('express-twitter-endpoint');
 *   app.get('/posts/latest', createLatestTweetHandler({ client, username: 'nasa' }));
 *
 *   // 3. A complete mountable sub-application:
 *   const { createApp } = require('express-twitter-endpoint');
 *   host.use('/x', createApp({ client, username: 'nasa' }));
 *
 * The standalone server (src/server.js, `npm start`) is a thin
 * env-configured wrapper over level 3 and is NOT loaded by this entry
 * point: importing the package never listens, never reads the
 * environment and never exits the process.
 */

const {
  TwitterClient,
  TwitterApiError,
  DEFAULT_BASE_URL,
  MAX_WAIT_MS,
  normalizeUsername,
  parseRetryAfter,
  rateLimitResetMs,
  parseNextData,
  extractTimeline,
  normalizeTweet,
} = require('./twitterClient');

const {
  createApp,
  createLatestTweetHandler,
  parseFlag,
  isValidUsername,
  apiKeyMatches,
} = require('./app');

module.exports = {
  // Data layer
  TwitterClient,
  TwitterApiError,
  DEFAULT_BASE_URL,
  MAX_WAIT_MS,
  normalizeUsername,
  parseRetryAfter,
  rateLimitResetMs,
  parseNextData,
  extractTimeline,
  normalizeTweet,
  // HTTP layer
  createApp,
  createLatestTweetHandler,
  parseFlag,
  isValidUsername,
  apiKeyMatches,
};
