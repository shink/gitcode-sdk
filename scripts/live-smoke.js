#!/usr/bin/env node
/**
 * 只读冒烟脚本：使用真实 GitCode API 验证 SDK 的读取、分页和错误映射。
 *
 *   GITCODE_TOKEN=... GITCODE_REPO=jiyuanhao/hcomm node scripts/live-smoke.js
 *
 * 不会创建/修改/关闭任何 Issue 或 PR。
 */
const path = require('node:path');

const token = process.env.GITCODE_TOKEN;
const repoFullName = process.env.GITCODE_REPO || 'jiyuanhao/hcomm';
const baseUrl = process.env.GITCODE_BASE_URL;

if (!token) {
  console.error('GITCODE_TOKEN is required');
  process.exit(1);
}

const [owner, repoName, ...rest] = repoFullName.split('/');
if (!owner || !repoName || rest.length > 0) {
  console.error('GITCODE_REPO must be in "owner/repo" format');
  process.exit(1);
}

let sdk;
try {
  sdk = require(path.join(__dirname, '..', 'dist'));
} catch (error) {
  console.error('Unable to load built SDK. Run "npm run build" first.');
  console.error(error.message);
  process.exit(1);
}

const { GitCodeClient, GitCodeApiError } = sdk;
const client = new GitCodeClient({
  token,
  ...(baseUrl ? { baseUrl } : {}),
  timeoutMs: 30_000,
  retries: 1,
});
const repo = client.repo({ owner, repo: repoName });

async function main() {
  const user = await client.getCurrentUser();
  console.log(`user: ${user.login}`);

  const issuesPage = await repo.issues.list({ state: 'open', perPage: 5 });
  console.log(`issues first page: ${issuesPage.length}`);

  const issues = await repo.issues.listAll({ state: 'open' });
  console.log(`issues all pages: ${issues.length}`);

  const issueWithComments = issues.find(issue => (issue.data.comments ?? 0) > 0);
  if (issueWithComments) {
    const comments = await issueWithComments.getComments();
    console.log(`issue #${issueWithComments.number} comments: ${comments.length}`);
  }

  const repoComments = await client.http.getAll(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/issues/comments`,
    {},
    { perPage: 10 }
  );
  console.log(`repo-level issue comments (paginated): ${repoComments.length}`);

  const pulls = await repo.pulls.list({ state: 'all', perPage: 5 });
  console.log(`pulls first page: ${pulls.length}`);
  if (pulls.length > 0) {
    const pr = pulls[0];
    const [comments, commits] = await Promise.all([pr.getComments(), pr.getCommits()]);
    console.log(`pull #${pr.number}: comments=${comments.length}, commits=${commits.length}`);
  }

  const badClient = new GitCodeClient({
    token: 'invalid-token',
    retries: 0,
    timeoutMs: 10_000,
  });
  try {
    await badClient.repo({ owner, repo: repoName }).issues.list();
    throw new Error('Expected invalid token request to fail');
  } catch (error) {
    if (!(error instanceof GitCodeApiError) || error.status !== 401) {
      throw error;
    }
    console.log('error mapping: 401 GitCodeApiError');
  } finally {
    badClient.close();
  }
}

main()
  .then(() => {
    console.log('smoke test passed');
  })
  .catch(error => {
    console.error('smoke test failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    client.close();
  });
