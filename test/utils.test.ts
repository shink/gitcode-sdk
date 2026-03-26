import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_BASE_URL,
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT_MS,
  normalizeBaseUrl,
  normalizeRepository,
  resolveGitCodeConfig,
} from '../src/core/config';
import type { Repository } from '../src/types';
import { mapLimit, sleep } from '../src/utils/concurrency';
import { BoundedSet, LruCache } from '../src/utils/dedup';
import { toIsoDate, toTimestamp } from '../src/utils/time';
import { encodePathSegment, repoPath } from '../src/utils/url';
import { VERSION } from '../src/version';

test('repoPath encodes every path segment', () => {
  const repo: Repository = { owner: 'a b', repo: 'c/d' };
  assert.equal(repoPath(repo, 'issues', 1, 'comments'), '/repos/a%20b/c%2Fd/issues/1/comments');
  assert.equal(repoPath(repo), '/repos/a%20b/c%2Fd');
  assert.equal(encodePathSegment('标签 name'), '%E6%A0%87%E7%AD%BE%20name');
  assert.throws(() => encodePathSegment('   '), /must not be empty/);
});

test('time helpers handle offsets, empty values and invalid input', () => {
  assert.equal(toTimestamp(''), null);
  assert.equal(toTimestamp(undefined), null);
  assert.equal(toTimestamp('not-a-date'), null);
  assert.equal(toTimestamp('2026-01-01T00:00:00+08:00'), Date.parse('2025-12-31T16:00:00.000Z'));
  assert.equal(toIsoDate('2026-01-01T00:00:00+08:00'), '2025-12-31T16:00:00.000Z');
  assert.equal(toIsoDate(undefined), undefined);
  assert.equal(toIsoDate(new Date('2026-01-01T00:00:00Z')), '2026-01-01T00:00:00.000Z');
});

test('BoundedSet evicts the oldest entries and deduplicates', () => {
  const set = new BoundedSet(2);
  assert.equal(set.addIfNew('a'), true);
  assert.equal(set.addIfNew('b'), true);
  assert.equal(set.addIfNew('b'), false);
  set.add('c');

  assert.equal(set.size, 2);
  assert.equal(set.has('a'), false);
  assert.equal(set.has('b'), true);
  assert.equal(set.has('c'), true);

  set.clear();
  assert.equal(set.size, 0);
});

test('LruCache refreshes entries on get and evicts the least recently used', () => {
  const cache = new LruCache<string, number>(2);
  cache.set('a', 1);
  cache.set('b', 2);

  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);

  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('c'), 3);
});

test('mapLimit preserves order and limits concurrency', async () => {
  let active = 0;
  let maxActive = 0;

  const results = await mapLimit([1, 2, 3, 4, 5], 2, async value => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(5);
    active -= 1;
    return value * 2;
  });

  assert.deepEqual(results, [2, 4, 6, 8, 10]);
  assert.ok(maxActive <= 2);
  await sleep(0);
});

test('config defaults and validation', () => {
  const resolved = resolveGitCodeConfig({ token: ' token ' });
  assert.equal(resolved.token, 'token');
  assert.equal(resolved.baseUrl, DEFAULT_BASE_URL);
  assert.equal(resolved.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(resolved.retries, DEFAULT_RETRIES);
  assert.match(resolved.userAgent, /^gitcode-sdk\//);
  assert.equal(resolved.keepAlive, true);

  assert.throws(() => resolveGitCodeConfig({ token: '' }), /token is required/);
  assert.throws(
    () => resolveGitCodeConfig({ token: 't', timeoutMs: 0 }),
    /timeoutMs must be a positive/
  );
  assert.throws(
    () => resolveGitCodeConfig({ token: 't', retries: -1 }),
    /retries must be a non-negative/
  );

  const custom = resolveGitCodeConfig({
    token: 't',
    baseUrl: 'https://example.com/api/v5/',
    keepAlive: false,
    headers: { 'X-Test': '1' },
  });
  assert.equal(custom.baseUrl, 'https://example.com/api/v5');
  assert.equal(custom.keepAlive, false);
  assert.deepEqual(custom.headers, { 'X-Test': '1' });
});

test('normalizeBaseUrl accepts host-only values and rejects non-http protocols', () => {
  assert.equal(normalizeBaseUrl(), DEFAULT_BASE_URL);
  assert.equal(normalizeBaseUrl('https://api.gitcode.com'), 'https://api.gitcode.com/api/v5');
  assert.equal(
    normalizeBaseUrl('https://api.gitcode.com/api/v5///'),
    'https://api.gitcode.com/api/v5'
  );
  assert.throws(() => normalizeBaseUrl('ftp://example.com'), /must use http or https/);
  assert.throws(() => normalizeBaseUrl('not a url'), /Invalid GitCode baseUrl/);
});

test('normalizeRepository trims and rejects malformed input', () => {
  assert.deepEqual(normalizeRepository({ owner: ' owner ', repo: ' repo ' }), {
    owner: 'owner',
    repo: 'repo',
  });
  assert.throws(() => normalizeRepository({ owner: '', repo: 'x' }), /non-empty/);
  assert.throws(() => normalizeRepository({ owner: 'a/b', repo: 'c' }), /must not contain/);
});

test('VERSION matches package.json', () => {
  const packageJson = JSON.parse(
    readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
  ) as { version: string };
  assert.equal(VERSION, packageJson.version);
});
