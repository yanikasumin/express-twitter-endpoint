'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('README states that no X API key, token or account is required', () => {
  assert.match(readme, /No X API key, developer account or login is required/);
});

test('README names the actual data source (the syndication feed)', () => {
  assert.match(readme, /syndication\.twitter\.com\/srv\/timeline-profile/);
});

test('README documents the unofficial-feed limitation honestly', () => {
  assert.match(readme, /not a documented API/);
  assert.match(readme, /protected/i);
});

test('README documents the rate-limit behaviour and the 30 s wait cap', () => {
  assert.match(readme, /x-rate-limit-limit/);
  assert.match(readme, /30 seconds/);
});

test('.env.example carries no credential and lists the runtime knobs the server reads', () => {
  assert.doesNotMatch(envExample, /BEARER/i);
  for (const key of [
    'TWITTER_USERNAME',
    'EXCLUDE_RETWEETS',
    'EXCLUDE_REPLIES',
    'CACHE_TTL_SECONDS',
    'UPSTREAM_TIMEOUT_MS',
    'UPSTREAM_MAX_RETRIES',
    'UPSTREAM_RETRY_BUDGET_MS',
    'REQUEST_DEADLINE_MS',
    'PORT',
    'HOST',
  ]) {
    assert.match(envExample, new RegExp(`^#? ?${key}=`, 'm'), `missing ${key} in .env.example`);
  }
});

test('server.js reads the same env names that .env.example documents', () => {
  const server = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  for (const key of ['UPSTREAM_TIMEOUT_MS', 'UPSTREAM_MAX_RETRIES', 'UPSTREAM_RETRY_BUDGET_MS', 'REQUEST_DEADLINE_MS']) {
    assert.ok(server.includes(`'${key}'`), `server.js does not read ${key}`);
  }
  assert.doesNotMatch(server, /BEARER/i);
});

test('package.json describes the no-key version and keeps the Node engine floor', () => {
  assert.match(pkg.description, /no X API key required/i);
  assert.equal(pkg.engines.node, '>=20.6.0');
});
