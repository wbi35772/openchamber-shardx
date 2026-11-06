# ShardX Workspace 交接（2026-11-06）

## 现状
- 扩展 v1.2.0 已完成：构建、部署、MCP 冒烟全部通过。
- 面板四页：环境（卡片 / 列表 / 居中标签组）、会话映射、操作 Skill、服务器管理。
- 多实例：一个会话可拥有多个 profile，实例标签以 `instance:<profileId>` 为键，profile 独占锁；第二个实例新开标签已验证（`preview/ui-instance2.png`）。
- 共享状态：`%APPDATA%\shardx-workspace\state.json`（mappings / skills / assignments / settings.launcher_path）。面板与 MCP 读写同一份。
- MCP：`index.js`（Node ≥ 22，stdio，零依赖），15 个工具；已注册在
  `C:\Users\24999\.config\opencode\opencode.json` → `mcp.servers["shardx-workspace"]`。

## 验证证据
- `bun run typecheck`、`bun run build` 通过。
- MCP stdio 实测：`initialize` → serverInfo shardx 1.2.0；`tools/list` → 15；`workspace_state` → statePath 正确；`server_status` → running=true、2.1.4、port 40325、PID 19420；`skill_list` → 0。
- 部署目录 `C:\Users\24999\.config\openchamber\extensions\shardx-workspace` 与开发目录的 `index.js`、`panel/main.js`、`service/main.js` 哈希一致。
- 8 张逐页截图：`preview/ui-cards|list|groups|mapping|skills|server|instance|instance2.png`（preview 为假数据工装）。

## 明天从这里继续
1. 真实端到端：在面板启动真实实例（不是 preview 假 CDP），验证实时视口、点击/键盘、Cookie、Skill 运行与释放停止。
2. 跨会话接管：两个 OpenChamber 会话对同一实例的「接管」与独占冲突提示。
3. 小屏 800×900 复查映射 / Skill / 服务器页，必要时补 CSS。
4. 可选：README（安装、构建、部署、MCP 工具表）。

## 常用命令
- 类型检查：`bun run typecheck`
- 构建：`bun run build`（panel/main.js + service/main.js）
- 预览截图：`preview/index.html?mode=groups`、`?tab=mapping`、`?tab=skills&skill=skill-login`、`?tab=server`、`?view=instance2`
- 部署：复制 `index.js`、`manifest.json`、`icon.svg`、`panel/`、`service/` 到扩展安装目录
- MCP 冒烟：`C:\Users\24999\AppData\Local\Temp\opencode\shx-mcp-test.mjs`；MCP 工具重启会话后生效
