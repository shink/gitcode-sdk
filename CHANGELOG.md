# Changelog

## 1.1.0

### Added

- `GitCodeClient` / `GitCodeRepo` 门面：不启动轮询即可按需操作 Issue/PR。
- 自动分页：`listAll()`、`getComments()`、`getCommits()`，列表默认 `per_page=100`。
- HTTP 超时、keep-alive、幂等请求指数退避重试、`Retry-After` 支持。
- `GitCodeApiError`：状态码、GitCode 错误码、`trace_id`，并避免 token 泄漏。
- 增量轮询：水位线 + 事件 ID 去重，首次轮询建立基线，失败不推进水位线。
- `pollNow()`、`once()`、`onError()`、`dispose()`、可注入 Logger/HttpClient/Clock。
- 结构化日志：按级别过滤、作用域、自定义 sink，默认不写文件。
- 单元测试（node:test + ts-node）、CI、真实 API 冒烟脚本。