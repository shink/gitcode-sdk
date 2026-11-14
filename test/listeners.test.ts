import assert from 'node:assert/strict';
import test from 'node:test';

import { IssueEventHandler } from '../src/listeners/issue-listener';
import { PullRequestEventHandler } from '../src/listeners/pr-listener';
import { Logger } from '../src/logger';
import type { EventType, QueryParams, Repository } from '../src/types';
import {
  FakeHttpClient,
  asHttpClient,
  makeCommit,
  makeIssue,
  makeIssueComment,
  makePrComment,
  makePullRequest,
} from './helpers';

const repo: Repository = { owner: 'owner', repo: 'project' };
const issueEvents = new Set<EventType>(['issue.opened', 'issue.commented']);
const prEvents = new Set<EventType>(['pr.opened', 'pr.commented', 'pr.commits']);

function silentLogger(): Logger {
  return new Logger({ console: false });
}

class FailingIssueHttpClient extends FakeHttpClient {
  fail = true;

  override async get<T>(url: string, params: QueryParams = {}): Promise<T> {
    if (this.fail && url.endsWith('/issues')) {
      throw new Error('temporary failure');
    }
    return super.get<T>(url, params);
  }
}

class FailingPrCommentsHttpClient extends FakeHttpClient {
  fail = true;

  override async get<T>(url: string, params: QueryParams = {}): Promise<T> {
    if (this.fail && url.endsWith('/comments')) {
      throw new Error('comments unavailable');
    }
    return super.get<T>(url, params);
  }
}

class PartiallyFailingIssueClient extends FakeHttpClient {
  override async get<T>(url: string, params: QueryParams = {}): Promise<T> {
    if (/\/issues\/2$/.test(url)) {
      throw new Error('issue 2 unavailable');
    }
    return super.get<T>(url, params);
  }
}

test('IssueEventHandler establishes a baseline first and then emits incremental events', async () => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const fake = new FakeHttpClient();
  const handler = new IssueEventHandler(asHttpClient(fake), repo, {
    intervalMs: 1_000,
    overlapMs: 100,
    emitExisting: false,
    logger: silentLogger(),
    clock: () => now,
  });

  const baseline = await handler.checkEvents(now, issueEvents);
  assert.deepEqual(baseline, []);
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

  const events = await handler.checkEvents(now, issueEvents);
  assert.deepEqual(
    events.map(event => event.event),
    ['issue.opened', 'issue.commented']
  );
  const commentPayload = events[1].context.payload as {
    issue: { number: string };
    comment: { id: number };
  };
  assert.equal(commentPayload.issue.number, '1');
  assert.equal(commentPayload.comment.id, 10);

  // 即使服务端重复返回同一个 Issue/评论，去重集合也应拦截重复事件。
  fake.state.respectSince = false;
  now += 1_000;
  fake.state.issues[0].created_at = new Date(now - 100).toISOString();
  fake.state.issueComments[0].created_at = new Date(now - 100).toISOString();
  const duplicates = await handler.checkEvents(now, issueEvents);
  assert.deepEqual(duplicates, []);
});

test('IssueEventHandler does not advance its watermark when a request fails', async () => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const fake = new FailingIssueHttpClient();
  const errors: unknown[] = [];
  const handler = new IssueEventHandler(asHttpClient(fake), repo, {
    intervalMs: 1_000,
    overlapMs: 100,
    emitExisting: false,
    logger: silentLogger(),
    clock: () => now,
    onError: error => errors.push(error),
  });

  await handler.checkEvents(now, issueEvents);
  const baseline = handler.lastCheckedAt;

  now += 1_000;
  fake.state.issues = [makeIssue({ number: '2', created_at: new Date(now - 500).toISOString() })];
  const failed = await handler.checkEvents(now, issueEvents);
  assert.deepEqual(failed, []);
  assert.equal(handler.lastCheckedAt, baseline);
  assert.equal(errors.length, 1);

  fake.fail = false;
  const retried = await handler.checkEvents(now, issueEvents);
  assert.deepEqual(
    retried.map(event => event.event),
    ['issue.opened']
  );
  assert.equal(handler.lastCheckedAt, now);
});

test('IssueEventHandler emitExisting replays the initial lookback window', async () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const fake = new FakeHttpClient({
    issues: [makeIssue({ number: '5', created_at: new Date(now - 500).toISOString() })],
    issueComments: [
      makeIssueComment({
        id: 50,
        issueNumber: '5',
        created_at: new Date(now - 400).toISOString(),
      }),
    ],
  });
  const handler = new IssueEventHandler(asHttpClient(fake), repo, {
    intervalMs: 1_000,
    overlapMs: 100,
    initialLookbackMs: 1_000,
    emitExisting: true,
    logger: silentLogger(),
    clock: () => now,
  });

  const events = await handler.checkEvents(now, issueEvents);
  assert.deepEqual(
    events.map(event => event.event),
    ['issue.opened', 'issue.commented']
  );
});

test('PullRequestEventHandler emits comments and commits only when notes/head change', async () => {
  const base = Date.parse('2026-01-01T00:00:00Z');
  let now = base;
  const pr = makePullRequest({
    number: 5,
    created_at: new Date(base - 5_000).toISOString(),
    updated_at: new Date(base - 50).toISOString(),
    notes: 2,
    head: { sha: 'head-1' },
  });
  const fake = new FakeHttpClient({
    pulls: [pr],
    prComments: new Map([
      [5, [makePrComment({ id: 1, created_at: new Date(base - 4_000).toISOString() })]],
    ]),
    prCommits: new Map([
      [
        5,
        [
          makeCommit({
            sha: 'old',
            author: { login: 'a', date: new Date(base - 4_000).toISOString() },
          }),
        ],
      ],
    ]),
  });
  const handler = new PullRequestEventHandler(asHttpClient(fake), repo, {
    intervalMs: 1_000,
    overlapMs: 100,
    emitExisting: false,
    logger: silentLogger(),
    clock: () => now,
  });

  assert.deepEqual(await handler.checkEvents(now, prEvents), []);

  now += 1_000;
  // 第一次实际轮询看到的是一个存量 PR：建立 notes/head 基线，不发送事件。
  assert.deepEqual(await handler.checkEvents(now, prEvents), []);

  now += 1_000;
  pr.updated_at = new Date(now - 50).toISOString();
  pr.notes = 3;
  pr.head = { sha: 'head-2' };
  fake.state.prComments.set(5, [
    makePrComment({ id: 1, created_at: new Date(base - 4_000).toISOString() }),
    makePrComment({ id: 2, created_at: new Date(now - 200).toISOString() }),
  ]);
  fake.state.prCommits.set(5, [
    makeCommit({ sha: 'old', author: { login: 'a', date: new Date(base - 4_000).toISOString() } }),
    makeCommit({ sha: 'new', author: { login: 'a', date: new Date(now - 300).toISOString() } }),
  ]);

  const events = await handler.checkEvents(now, prEvents);
  assert.deepEqual(events.map(event => event.event).sort(), ['pr.commented', 'pr.commits']);

  fake.state.respectSince = false;
  now += 1_000;
  const duplicates = await handler.checkEvents(now, prEvents);
  assert.deepEqual(duplicates, []);
});

test('PullRequestEventHandler emits opened for a new PR', async () => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const fake = new FakeHttpClient();
  const handler = new PullRequestEventHandler(asHttpClient(fake), repo, {
    intervalMs: 1_000,
    overlapMs: 100,
    emitExisting: false,
    logger: silentLogger(),
    clock: () => now,
  });

  await handler.checkEvents(now, prEvents);
  now += 1_000;
  fake.state.pulls = [
    makePullRequest({
      number: 7,
      created_at: new Date(now - 500).toISOString(),
      updated_at: new Date(now - 400).toISOString(),
      notes: 0,
      head: { sha: 'head-7' },
    }),
  ];

  const events = await handler.checkEvents(now, prEvents);
  assert.deepEqual(
    events.map(event => event.event),
    ['pr.opened']
  );
});

test('PullRequestEventHandler emitExisting replays recent comments on existing PRs', async () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const fake = new FakeHttpClient({
    pulls: [
      makePullRequest({
        number: 5,
        created_at: new Date(now - 10_000).toISOString(),
        updated_at: new Date(now - 500).toISOString(),
        notes: 1,
        head: { sha: 'head-1' },
      }),
    ],
    prComments: new Map([
      [5, [makePrComment({ id: 9, created_at: new Date(now - 400).toISOString() })]],
    ]),
  });
  const handler = new PullRequestEventHandler(asHttpClient(fake), repo, {
    intervalMs: 1_000,
    overlapMs: 100,
    initialLookbackMs: 1_000,
    emitExisting: true,
    logger: silentLogger(),
    clock: () => now,
  });

  const events = await handler.checkEvents(now, new Set<EventType>(['pr.commented']));
  assert.deepEqual(
    events.map(event => event.event),
    ['pr.commented']
  );
});

test('PullRequestEventHandler keeps opened events when comment loading fails', async () => {
  const base = Date.parse('2026-01-01T00:00:00Z');
  let now = base;
  const fake = new FailingPrCommentsHttpClient();
  const errors: unknown[] = [];
  const handler = new PullRequestEventHandler(asHttpClient(fake), repo, {
    intervalMs: 1_000,
    overlapMs: 100,
    emitExisting: false,
    logger: silentLogger(),
    clock: () => now,
    onError: error => errors.push(error),
  });

  await handler.checkEvents(now, prEvents);
  const baseline = handler.lastCheckedAt;

  now += 1_000;
  fake.state.pulls = [
    makePullRequest({
      number: 8,
      created_at: new Date(now - 500).toISOString(),
      updated_at: new Date(now - 400).toISOString(),
      notes: 0,
      head: { sha: 'head-8' },
    }),
  ];

  const events = await handler.checkEvents(now, prEvents);
  assert.deepEqual(
    events.map(event => event.event),
    ['pr.opened']
  );
  assert.equal(handler.lastCheckedAt, baseline);
  assert.equal(errors.length, 1);

  fake.fail = false;
  now += 1_000;
  const retried = await handler.checkEvents(now, prEvents);
  assert.deepEqual(retried, []);
  assert.equal(handler.lastCheckedAt, now);
});

test('IssueEventHandler continues with other comments when one issue lookup fails', async () => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const fake = new PartiallyFailingIssueClient();
  const errors: unknown[] = [];
  const handler = new IssueEventHandler(asHttpClient(fake), repo, {
    intervalMs: 1_000,
    overlapMs: 100,
    emitExisting: false,
    logger: silentLogger(),
    clock: () => now,
    onError: error => errors.push(error),
  });

  await handler.checkEvents(now, issueEvents);
  const baseline = handler.lastCheckedAt;

  now += 1_000;
  fake.state.issues = [
    makeIssue({ number: '1', created_at: new Date(now - 5_000).toISOString() }),
    makeIssue({ number: '2', created_at: new Date(now - 5_000).toISOString() }),
  ];
  fake.state.issueComments = [
    makeIssueComment({
      id: 101,
      issueNumber: '1',
      created_at: new Date(now - 300).toISOString(),
    }),
    makeIssueComment({
      id: 102,
      issueNumber: '2',
      created_at: new Date(now - 200).toISOString(),
    }),
  ];

  const events = await handler.checkEvents(now, issueEvents);
  assert.deepEqual(
    events.map(event => event.event),
    ['issue.commented']
  );
  const context = events[0].context;
  assert.equal(context.event, 'issue.commented');
  if (context.event === 'issue.commented') {
    assert.equal(context.issue.number, '1');
  }
  assert.equal(handler.lastCheckedAt, baseline);
  assert.equal(errors.length, 1);
});
