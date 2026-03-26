/**
 * 运行：GITCODE_TOKEN=... npx ts-node examples/listener.ts
 *
 * 首次轮询只建立基线；之后只处理新增事件。Ctrl+C 退出。
 */
import { GitCodeApp } from '../src';

const token = process.env.GITCODE_TOKEN;
if (!token) throw new Error('GITCODE_TOKEN is required');

const app = new GitCodeApp(
  { token },
  {
    owner: process.env.GITCODE_OWNER ?? 'jiyuanhao',
    repo: process.env.GITCODE_REPO_NAME ?? 'hcomm',
  },
  {
    autoStart: false,
    intervalMs: 10_000,
  }
);

app.on('issue.opened', async context => {
  console.log(`[issue.opened] #${context.issue.number} ${context.payload.title}`);
  await context.issue.createComment('已收到，我们会尽快处理。');
});

app.on('issue.commented', context => {
  console.log(
    `[issue.commented] #${context.issue.number} ${context.payload.comment.body.slice(0, 120)}`
  );
});

app.on('pr.opened', context => {
  console.log(`[pr.opened] #${context.pullRequest.number} ${context.payload.title}`);
});

app.on('pr.commented', context => {
  console.log(`[pr.commented] #${context.pullRequest.number} id=${context.payload.comment.id}`);
});

app.on('pr.commits', context => {
  console.log(`[pr.commits] #${context.pullRequest.number} ${context.payload.commit.sha}`);
});

app.onError(error => {
  console.error('[error]', error);
});

app.start();
console.log('listener started; press Ctrl+C to stop');

process.on('SIGINT', () => {
  app.dispose();
  process.exit(0);
});
