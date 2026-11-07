# ShardX Workspace 交接（2026-11-07）

## 现状
- 扩展 v1.3.0：MCP 32 个工具，覆盖分组、指纹环境、代理、指纹库、实例接管、标签、截图、快照、Cookie、Skill、服务器控制。
- 面板四页：环境（卡片 / 列表 / 居中标签组）、会话映射、操作 Skill、服务器管理。
- 多实例：一个会话可拥有多个 profile，实例标签以 `instance:<profileId>` 为键，profile 独占锁。
- 共享状态：`%APPDATA%\shardx-workspace\state.json`（mappings / skills / assignments / settings.launcher_path），面板与 MCP 读写同一份。
- MCP：`index.js`（Node ≥ 22，stdio，零依赖），已注册在
  `C:\Users\24999\.config\opencode\opencode.json` → `mcp.servers["shardx-workspace"]`。

## 真实端到端验证（2026-11-07）
用 `C:\Users\24999\AppData\Local\Temp\opencode\shx-mcp-e2e-test.mjs` 对真实 ShardX 实例跑通，退出码 0：

1. `list_and_bind_profile action=bind` → 绑定 `1c5bcd6d-68d4-414b-964e-8d55676bfe69`，拿到 page session。
2. `session_navigate` → `https://example.com/`，标题 `Example Domain`。
3. `session_status` → 1 个实例，target_id 与 page_session 正确。
4. `session_snapshot` → 正文、链接、滚动尺寸完整。
5. `session_tabs list/open/switch` → 新建 `https://example.org/` 标签并成功切换。
6. `session_wait text="Learn more"` → `textFound:true, ok:true`。
7. `session_screenshot` → 60,702 字节 PNG，实际渲染正确（深色 example.org 页面）。
8. `session_stop_and_release` → 关闭并释放 profile。

修复的 bug：`attachPage` 里 `(wantedTargetId && pages.find(...)) ?? ...` 在 `wantedTargetId=''` 时返回空字符串，`page.id` 变成 undefined；改为三元表达式后绑定正常。`attachTarget` 保留 targetId 归一化（`targetId ?? id`）与 3 次重试。

## 构建与部署
- `bun run typecheck`、`bun run build` 通过。
- 已部署到 `C:\Users\24999\.config\openchamber\extensions\shardx-workspace`，`index.js`、`manifest.json` 的 SHA256 与开发目录一致。
- MCP 工具重启会话后生效，名称形如 `shardx-workspace_session_navigate`。

## 明天从这里继续
1. 跨会话接管：两个 OpenChamber 会话抢同一 profile 时的独占冲突提示。
2. 面板内真实实例：实时视口、点击/键盘转发、Cookie、Skill 运行与释放（MCP 侧已真实验证）。
3. 小屏 800×900 复查映射 / Skill / 服务器页，必要时补 CSS。
4. 可选：README（安装、构建、部署、MCP 工具表）。

## 常用命令
- 类型检查：`bun run typecheck`
- 构建：`bun run build`（panel/main.js + service/main.js）
- 预览截图：`preview/index.html?mode=groups`、`?tab=mapping`、`?tab=skills&skill=skill-login`、`?tab=server`、`?view=instance2`
- 部署：复制 `index.js`、`manifest.json`、`icon.svg`、`panel/`、`service/` 到扩展安装目录
- MCP 冒烟：`C:\Users\24999\AppData\Local\Temp\opencode\shx-mcp-test.mjs`
- 真实 E2E：`C:\Users\24999\AppData\Local\Temp\opencode\shx-mcp-e2e-test.mjs`
