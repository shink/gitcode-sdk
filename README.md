# GitCode SDK

一个轻量级 [GitCode OpenAPI](https://docs.gitcode.com/docs/apis/) SDK，提供 Issue / Pull Request 操作、分页与错误处理，以及基于增量轮询的事件监听能力。

- 运行时依赖仅 `axios`
- TypeScript 严格模式，完整类型声明
- 支持 Node.js 18+

## 特性

- **Issue**：创建、查询、更新、关闭/重开、评论
- **Pull Request**：创建、查询、更新、合并、评论、提交、文件 diff
- **事件监听**：`issue.opened`、`issue.commented`、`pr.opened`、`pr.commented`、`pr.commits`
- **增量轮询**：基于 `since` 水位线 + 事件 ID 去重，避免每轮全量扫描
- **自动分页**：`listAll()`、`getComments()`、`getCommits()` 自动翻页
- **可靠 HTTP**：超时、keep-alive、幂等请求重试、429 `Retry-After`
- **结构化错误**：`GitCodeApiError` 保留状态码、错误码、`trace_id`，不泄漏 token
- **可注入**：HttpClient、Logger、Clock 均可注入，便于测试和复用连接

## 安装与构建

```bash
npm install
npm run build
```

包入口为 `dist/index.js`，类型声明为 `dist/index.d.ts`。

## 快速开始

### 1. 按需调用（推荐，不启动轮询）

```ts
import { GitCodeClient } from 'gitcode-sdk';

const client = new GitCodeClient({
  token: process.env.GITCODE_TOKEN!,
});
const repo = client.repo({ owner: 'jiyuanhao', repo: 'hcomm' });

const issues = await repo.issues.list({ state: 'open' });
console.log(issues.map(issue => `#${issue.number} ${issue.title}`));

const issue = await repo.issues.get(22);
await issue.createComment('收到，我们看一下。');
await issue.close(); // GitCode: PATCH state=close
await issue.reopen(); // GitCode: PATCH state=reopen

const prs = await repo.pulls.listAll({ state: 'open' });
const pr = await repo.pulls.get(5);
const comments = await pr.getComments();
const commits = await pr.getCommits();
const files = await pr.getFiles();

client.close(); // 释放 keep-alive 连接
```

### 2. 事件监听

```ts
import { GitCodeApp } from 'gitcode-sdk';

const app = new GitCodeApp(
  { token: process.env.GITCODE_TOKEN! },
  { owner: 'jiyuanhao', repo: 'hcomm' },
  {
    autoStart: false, // 推荐显式 start，避免构造期产生副作用
    intervalMs: 30_000,
  }
);

app.on('issue.opened', async context => {
  // context 是判别联合，按 event 自动收窄类型
  console.log(`新 Issue #${context.issue.number}: ${context.payload.title}`);
  await context.issue.createComment('感谢反馈，已收到。');
});

app.on('issue.commented', async context => {
  console.log(`Issue #${context.issue.number} 新评论: ${context.payload.comment.body}`);
});

app.on('pr.commented', async context => {
  console.log(`PR #${context.pullRequest.number} 新评论: ${context.payload.comment.id}`);
});

app.on('pr.commits', context => {
  console.log(`PR #${context.pullRequest.number} 新提交: ${context.payload.commit.sha}`);
});

app.onError(error => {
  console.error('SDK error:', error);
});

app.start();

process.on('SIGINT', () => {
  app.dispose();
  process.exit(0);
});
```

> `GitCodeApp` 默认 `autoStart: true` 以兼容 1.0；新代码建议传 `autoStart: false` 后显式 `start()`。

## 事件模型

轮询不是 webhook，语义为 **at-least-once + 进程内去重**：

1. 首次轮询默认只**建立基线**，不补发历史事件（避免进程重启后重复处理旧 Issue）。
2. 之后每轮用上次成功轮询时间减去 `overlapMs` 作为 `since` 查询下界，抵消 API 索引延迟。
3. 只有本轮请求全部成功才推进水位线；失败会在下一轮重试。
4. 事件按 `issue.opened:<number>`、`issue.comment:<id>`、`pr.comment:<pr>:<id>`、`pr.commit:<pr>:<sha>` 等 key 去重。
5. 去重状态保存在内存中，进程重启后不会恢复；需要跨重启精确一次处理时，应把事件 ID 落到外部存储。

如果需要补发最近一段时间的历史事件，可设置：

```ts
new GitCodeApp(config, repo, {
  emitExisting: true,
  initialLookbackMs: 5 * 60_000, // 首次轮询回看 5 分钟
});
```

### 轮询开销

| 场景       | 每轮请求数                                                        |
| ---------- | ----------------------------------------------------------------- |
| Issue 事件 | 新 Issue 列表 + 仓库级 Issue 评论列表（与 Issue 数无关）          |
| PR 事件    | 变化的 PR 列表 + 仅对 `notes` 或 `head.sha` 变化的 PR 拉评论/提交 |
| 无监听器   | 0（跳过轮询）                                                     |

相比 1.0 的“遍历每个 Issue 拉评论”，复杂度从 O(N) 降到接近 O(1) + O(变化数)。

## 配置

### `GitCodeConfig`

| 字段              | 默认值                                 | 说明                              |
| ----------------- | -------------------------------------- | --------------------------------- |
| `token`           | 必填                                   | Bearer Token                      |
| `baseUrl`         | `https://api.gitcode.com/api/v5`       | 只传主机名时会自动补 `/api/v5`    |
| `timeoutMs`       | `30000`                                | 单次请求超时                      |
| `retries`         | `2`                                    | 幂等请求重试次数；POST 默认不重试 |
| `retryDelayMs`    | `500`                                  | 指数退避基础值                    |
| `maxRetryDelayMs` | `10000`                                | 单次退避上限                      |
| `keepAlive`       | `true`                                 | 启用 HTTP keep-alive              |
| `maxSockets`      | `50`                                   | keep-alive 最大连接数             |
| `headers`         | `{}`                                   | 额外请求头                        |
| `userAgent`       | `gitcode-sdk/<version> node/<version>` | 自定义 UA                         |

### `GitCodeAppOptions`

| 字段                    | 默认值                   | 说明                             |
| ----------------------- | ------------------------ | -------------------------------- |
| `intervalMs`            | `30000`                  | 轮询间隔；兼容旧参数 `interval`  |
| `autoStart`             | `true`                   | 构造时自动启动；推荐 `false`     |
| `emitExisting`          | `false`                  | 首次轮询是否补发历史事件         |
| `initialLookbackMs`     | `intervalMs`             | `emitExisting` 的回看窗口        |
| `overlapMs`             | `min(5000, intervalMs)`  | 水位线重叠，抵消索引延迟         |
| `maxLookbackMs`         | `max(10*interval, 5min)` | 失败后最大回看，防止窗口无限增长 |
| `maxPages`              | `20`                     | 单次分页最大页数                 |
| `maxConcurrentRequests` | `5`                      | 并发处理 PR/Issue 数             |
| `logger`                | 全局 logger              | 注入自定义日志器                 |
| `httpClient`            | 自动创建                 | 注入 HttpClient 以复用连接       |
| `clock`                 | `Date.now`               | 可注入时钟                       |
| `onError`               | 无                       | 错误回调                         |
| `unref`                 | `false`                  | 定时器是否 `unref()`             |

## API 摘要

### GitCodeClient / GitCodeRepo

```ts
const client = new GitCodeClient(config);
const repo = client.repo({ owner, repo });

repo.issues.create(params);
repo.issues.list(params); // 单页，默认 per_page=100
repo.issues.listAll(params); // 自动翻页
repo.issues.get(number);

repo.pulls.create(params);
repo.pulls.list(params);
repo.pulls.listAll(params);
repo.pulls.get(number);

client.getCurrentUser();
client.http; // 直接访问底层 HttpClient
client.close();
```

### Issue

```ts
const issue = await repo.issues.get(22);
await issue.refresh();
await issue.update({ title, body, state: 'closed', labels: ['bug'] });
await issue.close();
await issue.reopen();
await issue.createComment('body');
await issue.getComments(); // 全部评论
await issue.listComments({ perPage: 20, page: 1 });
```

> GitCode 的 Issue PATCH 接口使用 `state=close|reopen`。SDK 会把 `state: 'closed'` 归一化为 `close`，不会发送无效的 `state_event`。

### PullRequest

```ts
const pr = await repo.pulls.get(5);
await pr.refresh();
await pr.update({ title, state: 'closed', labels: ['bug'] });
await pr.merge('合并标题'); // 兼容旧版字符串参数
await pr.merge({ mergeMethod: 'rebase', squash: true });
await pr.isMerged();
await pr.createComment('body');
await pr.getComments({ commentType: 'pr_comment' });
await pr.getCommits();
await pr.getFiles();
```

> `getFiles()` 会调用 GitCode 的 files 接口。该接口可能忽略 `per_page` 并一次返回全部文件（实测大 PR 可返回数百个），请按需调用。

### 分页

GitCode 不返回 `Link` 头，只能通过“本页是否取满 `per_page`”判断是否还有下一页。SDK 的处理：

- `getAll()` 默认 `per_page=100`、最多 50 页；
- 服务端忽略 `per_page`（返回条数 > `per_page`）时视为单页全量；
- 连续两页首条记录相同则停止，避免死循环；
- `list()` / `listComments()` 默认只取单页，需要全部数据时使用 `listAll()` 或传 `all: true`。

## 错误处理

```ts
import { GitCodeApiError, isGitCodeApiError } from 'gitcode-sdk';

try {
  await repo.issues.get(999999);
} catch (error) {
  if (isGitCodeApiError(error)) {
    console.error(error.status); // 404
    console.error(error.code); // 404
    console.error(error.codeName); // UN_KNOW
    console.error(error.traceId); // 便于反馈给 GitCode
  }
}
```

- 401/403/404/422 等不重试；
- 408/425/429/5xx 与网络错误按 `retryDelayMs` 指数退避；
- 429 优先使用 `Retry-After`；
- POST 默认不重试，避免重复创建 Issue/评论；需要时显式传 `{ retries: n }`。

## 日志

```ts
import { LogLevel, createLogger, setLogger } from 'gitcode-sdk';

const logger = createLogger({
  level: LogLevel.DEBUG,
  filePath: 'logs/gitcode-sdk.log', // 显式开启，默认不写文件
  color: false,
});

setLogger(logger); // 影响未显式传 logger 的 App/Handler
```

- 默认 INFO、输出到 stdout/stderr，**不会**在 import 时创建 `logs/` 目录；
- 支持注入自定义 `sink`、时间戳格式、子作用域 `logger.child('repo')`；
- `Logger.close()` 关闭文件流。

## 开发与测试

```bash
npm run lint        # ESLint + Prettier
npm run typecheck   # src + test 类型检查
npm test            # node:test + ts-node
npm run build       # 清理 dist 后编译
npm run test:coverage
```

### 真实 API 冒烟

只读验证（不会写仓库）：

```bash
GITCODE_TOKEN=... GITCODE_REPO=jiyuanhao/hcomm node scripts/live-smoke.js
```

如需验证事件轮询，可参考 `examples/listener.ts`，使用测试仓库并注意清理测试 Issue。

## 目录结构

```
src/
├── app.ts                  # GitCodeApp：轮询、分发、错误隔离
├── client.ts               # GitCodeClient / GitCodeRepo 门面
├── core/
│   ├── config.ts           # 配置校验与默认值
│   └── errors.ts           # GitCodeApiError、错误映射
├── http/http-client.ts     # axios 封装、超时/重试/分页
├── listeners/
│   ├── polling-state.ts    # 水位线、去重、选项解析
│   ├── issue-listener.ts   # Issue 增量轮询
│   └── pr-listener.ts      # PR 增量轮询
├── models/
│   ├── issue.ts
│   └── pull-request.ts
├── utils/                  # URL、时间、并发、LRU/去重
├── logger.ts
└── index.ts
```

## 从 1.0 迁移

1. **首次轮询不再补发**：默认建立基线。需要旧行为时设置 `emitExisting: true`。
2. **`stop()` 不再清空监听器**：只停止定时器；清空请用 `removeAllListeners()` / `dispose()`。
3. **默认不写日志文件**：需要文件日志时显式传 `filePath`。
4. **`Issue.close()/reopen()` 现在真正生效**：旧版本发送的 `state_event` 会被 GitCode 接受但忽略。
5. **列表默认 `per_page=100`**：旧版本默认 20，可能静默漏数据；全部数据请用 `listAll()`。
6. **`getComments()` 自动翻页**：需要单页时用 `listComments()`。
7. **`Issue.number` 仍为 string，`PullRequest.number` 仍为 number**：与 API 返回保持一致。

## 已知限制

- 轮询受 API 延迟、时钟偏差和进程重启影响，不保证 exactly-once。
- PR 评论检测依赖列表接口的 `notes` 数量；若评论在两次轮询间“先删后加”且数量不变，可能漏检。
- PR 评论/提交只对 `updated_at` 发生变化的 PR 检查；若 GitCode 未更新 `updated_at`，可能漏检。
- PR 提交检测依赖 `head.sha` 变化，并按作者时间过滤；强制 rebase 导致提交时间早于窗口时可能漏检。
- 停止/失败时间超过 `maxLookbackMs`（默认 5 分钟）时，更早的事件不会被补发。
- 不支持 webhook 验签；如有需要可另建 webhook 模块。
- GitCode 暂无 `Link` 分页头，超大仓库请结合业务侧游标或缩小 `since` 窗口。

## License

[Apache License 2.0](./LICENSE)
