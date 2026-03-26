import assert from 'node:assert/strict';
import test from 'node:test';

import { GitCodeClient } from '../src/client';
import { makeIssue, makePullRequest, FakeHttpClient, asHttpClient } from './helpers';

test('GitCodeClient exposes repo-scoped issues and pulls', async () => {
  const fake = new FakeHttpClient({
    issues: [makeIssue({ number: '1' })],
    pulls: [makePullRequest({ number: 2 })],
  });
  const client = new GitCodeClient({ token: 'test' }, asHttpClient(fake));
  const repo = client.repo({ owner: 'owner', repo: 'project' });

  const issues = await repo.issues.list({ state: 'open' });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].number, '1');

  const pull = await repo.pulls.get(2);
  assert.equal(pull.number, 2);

  client.close();
  assert.equal(fake.calls.length, 2);
});
