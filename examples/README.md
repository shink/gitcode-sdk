# Examples

- `quickstart.ts`：使用 `GitCodeClient` 读取 Issue/PR，不启动轮询。
- `listener.ts`：使用 `GitCodeApp` 监听事件。

运行前先构建或直接使用 ts-node：

```bash
GITCODE_TOKEN=... npx ts-node examples/quickstart.ts
GITCODE_TOKEN=... npx ts-node examples/listener.ts
```

监听示例会在新 Issue 下自动评论，请只在测试仓库运行。
