import assert from 'node:assert/strict';
import test from 'node:test';

import { GitCodeApp } from '../src/app';
import { Logger } from '../src/logger';
import type { EventContext, Repository } from '../src/types';
import { FakeHttpClient, asHttpClient, makeIssue, makeIssueComment } from './helpers';

const repo: Repository = { owner: 'owner', repo: 'project' };

function silentLogger(): Logger {
  return new Logger({ console: false });
}

test('GitCodeApp polls incrementally, dispatches events and deduplicates', async t => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const fake = new FakeHttpClient();
  const app = new GitCodeApp({ token: 't' }, repo, {
    autoStart: false,
    httpClient: asHttpClient(fake),
    clock: () => now,
    intervalMs: 1_000,
    overlapMs: 100,
    maxPages: 5,
    logger: silentLogger(),
  });
  t.after(() => app.dispose());

  const events: string[] = [];
  app.on('issue.opened', context => {
    events.push(context.event);
  });
  app.on('issue.commented', context => {
    events.push(context.event);
  });

  await app.pollNow();
  assert.equal(fake.calls.length, 0);

  now += 1_000;
  fake.state.issues = [makeIssue({ number: '1', created_at: new Date(now - 500).toISOString() })];
  fake.state.issueComments = [
    makeIssueComment({
      id: 10,
      issueNumber: '1',
      created_at: new Date(now - 400).toISOString(),
    }),
  ];

  await app.pollNow();
  assert.deepEqual(events, ['issue.opened', 'issue.commented']);

  // 服务端重复返回时，App 层不应重复分发。
  fake.state.respectSince = false;
  now += 1_000;
  fake.state.issues[0].created_at = new Date(now - 100).toISOString();
  fake.state.issueComments[0].created_at = new Date(now - 100).toISOString();
  await app.pollNow();
  assert.deepEqual(events, ['issue.opened', 'issue.commented']);
});

test('GitCodeApp isolates listener failures and reports errors', async t => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const fake = new FakeHttpClient();
  const errors: unknown[] = [];
  const app = new GitCodeApp({ token: 't' }, repo, {
    autoStart: false,
    httpClient: asHttpClient(fake),
    clock: () => now,
    intervalMs: 1_000,
    overlapMs: 100,
    maxPages: 5,
    logger: silentLogger(),
    onError: error => errors.push(error),
  });
  t.after(() => app.dispose());

  const called: string[] = [];
  app.on('issue.opened', () => {
    called.push('first');
  });
  app.on('issue.opened', () => {
    throw new Error('listener boom');
  });
  app.on('issue.opened', () => {
    called.push('third');
  });

  await app.pollNow();
  now += 1_000;
  fake.state.issues = [makeIssue({ number: '2', created_at: new Date(now - 500).toISOString() })];
  await app.pollNow();

  assert.deepEqual(called, ['first', 'third']);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /listener boom/);
});

test('GitCodeApp once() only fires a single time', async t => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const fake = new FakeHttpClient();
  const app = new GitCodeApp({ token: 't' }, repo, {
    autoStart: false,
    httpClient: asHttpClient(fake),
    clock: () => now,
    intervalMs: 1_000,
    overlapMs: 100,
    maxPages: 5,
    logger: silentLogger(),
  });
  t.after(() => app.dispose());

  let count = 0;
  app.once('issue.commented', () => {
    count += 1;
  });

  await app.pollNow();
  now += 1_000;
  fake.state.issues = [makeIssue({ number: '3', created_at: new Date(now - 1_000).toISOString() })];
  fake.state.issueComments = [
    makeIssueComment({
      id: 30,
      issueNumber: '3',
      created_at: new Date(now - 900).toISOString(),
    }),
  ];
  await app.pollNow();
  assert.equal(count, 1);

  now += 1_000;
  fake.state.issueComments.push(
    makeIssueComment({
      id: 31,
      issueNumber: '3',
      created_at: new Date(now - 100).toISOString(),
    })
  );
  await app.pollNow();
  assert.equal(count, 1);
});

test('GitCodeApp off/removeAllListeners and start/stop state', () => {
  const fake = new FakeHttpClient();
  const app = new GitCodeApp({ token: 't' }, repo, {
    autoStart: false,
    httpClient: asHttpClient(fake),
    logger: silentLogger(),
  });

  const listener = (_context: EventContext): void => undefined;
  app.on('issue.opened', listener);
  app.off('issue.opened', listener);
  app.on('issue.opened', listener);
  app.removeAllListeners('issue.opened');
  app.removeAllListeners();

  assert.equal(app.isRunning, false);
  app.start();
  assert.equal(app.isRunning, true);
  app.start();
  assert.equal(app.isRunning, true);
  app.stop();
  assert.equal(app.isRunning, false);
  app.stop();
  app.dispose();
});

test('GitCodeApp exposes its client and repository', () => {
  const fake = new FakeHttpClient();
  const app = new GitCodeApp(
    { token: 't' },
    { owner: ' o ', repo: ' r ' },
    {
      autoStart: false,
      httpClient: asHttpClient(fake),
      logger: silentLogger(),
    }
  );

  assert.deepEqual(app.getRepo(), { owner: 'o', repo: 'r' });
  assert.equal(app.getHttpClient(), asHttpClient(fake));
  assert.equal(app.interval, 30_000);
  app.dispose();
});
