import assert from 'node:assert/strict';
import test from 'node:test';

import { GitCodeApiError } from '../src/core/errors';
import { Issue } from '../src/models/issue';
import { PullRequest } from '../src/models/pull-request';
import type { Repository } from '../src/types';
import {
  FakeHttpClient,
  asHttpClient,
  makeCommit,
  makeFileDiff,
  makeIssue,
  makeIssueComment,
  makePrComment,
  makePullRequest,
  lastCall,
} from './helpers';

const repo: Repository = { owner: 'owner', repo: 'project' };

test('Issue.list uses per_page=100 and maps query parameters', async () => {
  const issue = makeIssue({
    number: '22',
    created_at: '2026-01-02T00:00:00Z',
  });
  const fake = new FakeHttpClient({ issues: [issue] });
  const http = asHttpClient(fake);

  const issues = await Issue.list(http, repo, {
    state: 'open',
    labels: ['bug', 'urgent'],
    createdAfter: '2026-01-01T00:00:00+08:00',
    direction: 'asc',
  });

  assert.equal(issues.length, 1);
  assert.equal(issues[0].number, '22');

  const call = lastCall(fake);
  assert.ok(call);
  assert.equal(call.url, '/repos/owner/project/issues');
  assert.equal(call.params.per_page, 100);
  assert.equal(call.params.state, 'open');
  assert.equal(call.params.labels, 'bug,urgent');
  assert.equal(call.params.direction, 'asc');
  assert.equal(call.params.created_after, '2025-12-31T16:00:00.000Z');
});

test('Issue.listAll omits page/per_page and delegates to getAll', async () => {
  const fake = new FakeHttpClient({ issues: [makeIssue({ number: '1' })] });
  const http = asHttpClient(fake);

  await Issue.listAll(http, repo, { state: 'all', maxPages: 7 });

  const call = fake.calls.find(item => item.method === 'GET_ALL');
  assert.ok(call);
  assert.equal(call.url, '/repos/owner/project/issues');
  assert.equal(call.params.page, undefined);
  assert.equal(call.params.per_page, undefined);
  assert.deepEqual(call.getAllOptions, { maxPages: 7 });
});

test('Issue.getComments fetches all pages by default', async () => {
  const fake = new FakeHttpClient({
    issues: [makeIssue({ number: '22' })],
    issueComments: [
      makeIssueComment({ id: 1, issueNumber: 22 }),
      makeIssueComment({ id: 2, issueNumber: 22 }),
    ],
  });
  const http = asHttpClient(fake);
  const issue = await Issue.get(http, repo, 22);

  const comments = await issue.getComments();
  assert.equal(comments.length, 2);

  const call = fake.calls.find(item => item.method === 'GET_ALL');
  assert.ok(call);
  assert.equal(call.url, '/repos/owner/project/issues/22/comments');
});

test('Issue.update sends state=close not state_event', async () => {
  const issueData = makeIssue({ number: '22', state: 'open' });
  const fake = new FakeHttpClient({ issues: [issueData] });
  fake.responses.patch = { ...issueData, state: 'closed', title: 'changed' };
  const http = asHttpClient(fake);
  const issue = await Issue.get(http, repo, 22);

  const updated = await issue.update({ state: 'closed' });

  const call = lastCall(fake);
  assert.ok(call);
  assert.equal(call.method, 'PATCH');
  assert.equal(call.url, '/repos/owner/project/issues/22');
  assert.deepEqual(call.body, { state: 'close' });
  assert.equal((call.body as Record<string, unknown>).state_event, undefined);
  assert.equal(updated.state, 'closed');
  assert.equal(updated.title, 'changed');
  assert.equal(issue.state, 'closed');
});

test('Issue.close and reopen use the GitCode state aliases', async () => {
  const issueData = makeIssue({ number: '22' });
  const fake = new FakeHttpClient({ issues: [issueData] });
  fake.responses.patch = { ...issueData, state: 'closed' };
  const http = asHttpClient(fake);
  const issue = await Issue.get(http, repo, 22);

  await issue.close();
  assert.deepEqual(lastCall(fake)?.body, { state: 'close' });

  fake.responses.patch = { ...issueData, state: 'open' };
  await issue.reopen();
  assert.deepEqual(lastCall(fake)?.body, { state: 'reopen' });

  await issue.update({ state: 'open' });
  assert.deepEqual(lastCall(fake)?.body, { state: 'reopen' });
});

test('Issue.update rejects empty payloads', async () => {
  const fake = new FakeHttpClient({ issues: [makeIssue({ number: '22' })] });
  const http = asHttpClient(fake);
  const issue = await Issue.get(http, repo, 22);

  await assert.rejects(issue.update({}), /at least one field/);
});

test('Issue.create sends labels and security_hole fields', async () => {
  const created = makeIssue({ number: '23' });
  const fake = new FakeHttpClient({ issues: [created] });
  fake.responses.post = created;
  const http = asHttpClient(fake);

  const issue = await Issue.create(http, repo, {
    title: 'New issue',
    body: 'body',
    labels: ['bug'],
    assignee: 'tester',
    milestone: 3,
    securityHole: true,
  });

  assert.equal(issue.number, '23');
  const call = lastCall(fake);
  assert.ok(call);
  assert.equal(call.url, '/repos/owner/project/issues');
  assert.deepEqual(call.body, {
    title: 'New issue',
    body: 'body',
    labels: 'bug',
    assignee: 'tester',
    milestone: 3,
    security_hole: 'true',
  });
});

test('PullRequest.list uses per_page=100 and maps filters', async () => {
  const fake = new FakeHttpClient({
    pulls: [makePullRequest({ number: 5, notes: 2 })],
  });
  const http = asHttpClient(fake);

  const prs = await PullRequest.list(http, repo, {
    state: 'open',
    base: 'main',
    labels: 'bug',
    reviewer: 'alice',
    updatedAfter: '2026-02-01T00:00:00Z',
  });

  assert.equal(prs.length, 1);
  const call = lastCall(fake);
  assert.ok(call);
  assert.equal(call.url, '/repos/owner/project/pulls');
  assert.equal(call.params.per_page, 100);
  assert.equal(call.params.state, 'open');
  assert.equal(call.params.base, 'main');
  assert.equal(call.params.labels, 'bug');
  assert.equal(call.params.reviewer, 'alice');
  assert.equal(call.params.updated_after, '2026-02-01T00:00:00.000Z');
});

test('PullRequest comments and commits are fetched with all pages', async () => {
  const pr = makePullRequest({ number: 5, notes: 2 });
  const fake = new FakeHttpClient({
    pulls: [pr],
    prComments: new Map([[5, [makePrComment({ id: 1 }), makePrComment({ id: 2 })]]]),
    prCommits: new Map([[5, [makeCommit({ sha: 'abc' })]]]),
  });
  const http = asHttpClient(fake);
  const pullRequest = await PullRequest.get(http, repo, 5);

  const comments = await pullRequest.getComments();
  assert.equal(comments.length, 2);
  const commentCall = fake.calls.find(item => item.method === 'GET_ALL');
  assert.ok(commentCall);
  assert.equal(commentCall.url, '/repos/owner/project/pulls/5/comments');

  const commits = await pullRequest.getCommits();
  assert.equal(commits.length, 1);
  assert.equal(commits[0].sha, 'abc');
});

test('PullRequest.listComments passes comment_type and pagination', async () => {
  const fake = new FakeHttpClient({
    pulls: [makePullRequest({ number: 5 })],
    prComments: new Map([[5, [makePrComment({ id: 1 })]]]),
  });
  const http = asHttpClient(fake);
  const pullRequest = await PullRequest.get(http, repo, 5);

  await pullRequest.listComments({ perPage: 2, commentType: 'pr_comment' });

  const call = lastCall(fake);
  assert.ok(call);
  assert.equal(call.method, 'GET');
  assert.equal(call.params.per_page, 2);
  assert.equal(call.params.comment_type, 'pr_comment');
});

test('PullRequest.getFiles uses the files endpoint', async () => {
  const fake = new FakeHttpClient({
    pulls: [makePullRequest({ number: 5 })],
    files: [makeFileDiff({ filename: 'src/index.ts' })],
  });
  const http = asHttpClient(fake);
  const pullRequest = await PullRequest.get(http, repo, 5);

  const files = await pullRequest.getFiles();
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'src/index.ts');
  assert.equal(lastCall(fake)?.url, '/repos/owner/project/pulls/5/files');
});

test('PullRequest.update maps state and labels', async () => {
  const pr = makePullRequest({ number: 5 });
  const fake = new FakeHttpClient({ pulls: [pr] });
  fake.responses.patch = { ...pr, state: 'closed' };
  const http = asHttpClient(fake);
  const pullRequest = await PullRequest.get(http, repo, 5);

  const updated = await pullRequest.update({
    state: 'closed',
    labels: ['bug', 'p1'],
    draft: true,
    pruneBranch: true,
  });

  const call = lastCall(fake);
  assert.ok(call);
  assert.equal(call.method, 'PATCH');
  assert.deepEqual(call.body, {
    state: 'closed',
    labels: 'bug,p1',
    draft: true,
    prune_branch: true,
  });
  assert.equal(updated.state, 'closed');
});

test('PullRequest.merge maps legacy string and object parameters', async () => {
  const pr = makePullRequest({ number: 5 });
  const fake = new FakeHttpClient({ pulls: [pr] });
  fake.responses.put = { merged: 1, sha: 'merge-sha' };
  const http = asHttpClient(fake);
  const pullRequest = await PullRequest.get(http, repo, 5);

  const result = await pullRequest.merge('merge title');
  assert.equal(result.sha, 'merge-sha');
  assert.deepEqual(lastCall(fake)?.body, { title: 'merge title' });

  await pullRequest.merge({
    mergeMethod: 'rebase',
    squash: true,
    squashCommitMessage: 'squashed',
    forceMerge: false,
  });
  assert.deepEqual(lastCall(fake)?.body, {
    merge_method: 'rebase',
    squash: true,
    squash_commit_message: 'squashed',
    force_merge: false,
  });
});

test('PullRequest.isMerged treats 404 as not merged', async () => {
  const http = {
    get: async () => {
      throw new GitCodeApiError('not merged', { status: 404 });
    },
  } as unknown as Parameters<typeof PullRequest.get>[0];
  const pullRequest = new PullRequest(http, repo, makePullRequest({ number: 5 }));

  assert.equal(await pullRequest.isMerged(), false);
});

test('PullRequest.isMerged reads the merge endpoint', async () => {
  const fake = new FakeHttpClient({ pulls: [makePullRequest({ number: 5 })] });
  fake.responses.merge = { merged: 1 };
  const http = asHttpClient(fake);
  const pullRequest = await PullRequest.get(http, repo, 5);

  assert.equal(await pullRequest.isMerged(), true);
});

test('PullRequest.create sends required and optional fields', async () => {
  const created = makePullRequest({ number: 6 });
  const fake = new FakeHttpClient({ pulls: [created] });
  fake.responses.post = created;
  const http = asHttpClient(fake);

  const pullRequest = await PullRequest.create(http, repo, {
    title: 'PR title',
    head: 'feature',
    base: 'main',
    body: 'body',
    draft: true,
    labels: ['bug'],
    milestoneNumber: 2,
  });

  assert.equal(pullRequest.number, 6);
  assert.deepEqual(lastCall(fake)?.body, {
    title: 'PR title',
    head: 'feature',
    base: 'main',
    body: 'body',
    draft: true,
    labels: 'bug',
    milestone_number: 2,
  });
});

test('PullRequest.update rejects empty payloads', async () => {
  const fake = new FakeHttpClient({ pulls: [makePullRequest({ number: 5 })] });
  const http = asHttpClient(fake);
  const pullRequest = await PullRequest.get(http, repo, 5);

  await assert.rejects(pullRequest.update({}), /at least one field/);
});
