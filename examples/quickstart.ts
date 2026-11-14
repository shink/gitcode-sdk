/**
 * 运行：GITCODE_TOKEN=... npx ts-node examples/quickstart.ts
 */
import { GitCodeClient } from '../src';

async function main(): Promise<void> {
  const token = process.env.GITCODE_TOKEN;
  if (!token) throw new Error('GITCODE_TOKEN is required');

  const client = new GitCodeClient({ token });
  const repo = client.repo({
    owner: process.env.GITCODE_OWNER ?? 'jiyuanhao',
    repo: process.env.GITCODE_REPO_NAME ?? 'hcomm',
  });

  const issues = await repo.issues.listAll({ state: 'open' });
  console.log(`open issues: ${issues.length}`);
  for (const issue of issues.slice(0, 10)) {
    console.log(`#${issue.number} ${issue.title}`);
  }

  const pulls = await repo.pulls.listAll({ state: 'all' });
  console.log(`pull requests: ${pulls.length}`);

  client.close();
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
