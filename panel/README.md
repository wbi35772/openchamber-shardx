# panel/

面板源码。入口 `index.html` → 构建产物 `main.js`（`package.json` 的 `contributes.panel`）。

完整功能、安装与 MCP 说明见仓库根目录 [README](../README.md)；架构与不变量见
[../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)。

## 模块

| 文件 | 职责 |
|---|---|
| `main.ts` | 宿主握手、`transport.setHost`、`WorkspaceClient` 初始化、启动 UI |
| `transport.ts` | `host.serviceRequest` 封装；非 2xx 抛 `TransportError`，`NO_SERVICE` 提示开启服务能力 |
| `api.ts` | ShardX REST：profiles / start / stop / proxies / discover / 运行实例 |
| `cdp.ts` | `CdpMultiplexer`：单调 id、Promise 池、事件分发、断线判定 |
| `router.ts` | `SessionIsolationRouter`：会话 ↔ profile 独占、target 列表、活动 session |
| `bridge.ts` | 面板侧控制：启动、接管运行实例、释放；工具动作实现 |
| `mirror.ts` | `LauncherMirror`：截图轮询、输入转发、`Emulation` 自适应、重启启动器 |
| `ui.ts` | 标签工作台、环境/映射/Skill/服务器四页、排序、文件夹标签、接管提示 |
| `workspace.ts` | 共享状态客户端（mapping / skill / assign / settings / server） |
| `types.ts` | ShardX 数据结构与 UI 类型 |
| `util.ts` | `el` / `button` / `toast` 等 DOM 小工具 |
| `style.css` | 暗色极客主题、标签栏、卡片/列表/分组、镜像布局 |

## 约定

- 面板**不直接访问网络**，一律经 `transport.call()` → 宿主 → `service/main.js`。
- 新增 UI 状态优先放 `localStorage`，跨设备/跨会话状态才写 `state.json`。
- 关闭实例标签只移除 UI；只有「停止并释放」才停止实例并解锁 profile。
- 改完运行 `bun run typecheck` 与 `bun run build`，两个产物都要提交。
