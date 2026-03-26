# Changelog

## 1.1.0

### Added

- `GitCodeClient` / `GitCodeRepo` 门面：不启动轮询即可按需操作 Issue/PR。
- 自动分页：`Issue.listAll()`、`PullRequest.listAll()`、`getComments()`、`getCommits()`。
- HTTP 超时、keep-alive、幂等请求指数退避重试、`Retry-After` 支持。
- `GitCodeApiError`：状态码、GitCode 错误码、`trace_id`，并避免 token 泄漏。
- 水位线 + 事件 ID 去重的增量轮询；失败不推进水位线。
- `pollNow()`、`once()`、`onError()`、`dispose()`、可注入 Logger/HttpClient/Clock。
- 单元测试（node:test + ts-node）、CI 配置、真实 API 冒烟脚本。

### Fixed

- `Issue.close()` / `reopen()` 之前发送 `state_event`，GitCode 接受但静默忽略；改用 `state=close/reopen`。
- `Issue.list()` / `PullRequest.list()` 默认只取 20 条导致漏数据；默认改为 100 并新增 `listAll()`。
- 评论/提交列表默认只取第一页；`getComments()` / `getCommits()` 现在自动翻页。
- `PullRequest.merge(string)` 之前发送无效的 `message` 字段；现在映射为合并标题。
- `PullRequest.update()` 之前用 PATCH 的部分响应覆盖本地数据；现在合并响应。
- 轮询首次运行会立即处理窗口内历史事件；现在默认建立基线，可用 `emitExisting` 显式开启补发。
- `setInterval(async ...)` 可能重叠执行；现在串行调度并跳过重叠轮次。
- 每个轮询为每个 Issue 拉评论的 O(N) 请求；改为仓库级评论 `since` 查询。
- Logger 在 import 时创建 `logs/` 并写文件；默认不再产生文件副作用。
- 构建不会清理 `dist`，旧文件残留；`build` 现在先清理。
- 仓库内临时调试脚本硬编码 token 的风险；移除临时脚本，改用环境变量。

### Changed

- 首次轮询默认建立基线，不补发历史事件。
- `stop()` 只停止定时器，不再清空监听器；新增 `dispose()`。
- 日志默认只输出到 stdout/stderr，不写文件。
- 事件上下文改为判别联合类型，`payload` 按事件类型收窄。
- `Issue.update({ state: 'closed' })` 归一化为 GitCode 需要的 `state: 'close'`。
- 类型定义按真实 API 修正：`IssueData.comments` 恢复，评论/提交/diff 的部分字段改为可选，并补充 `EventCallbackOf` 等泛型。

### Removed

- 旧版根目录调试脚本、API 响应 dump 与临时日志。
- 默认日志文件 `logs/gitcode-sdk.log`。
