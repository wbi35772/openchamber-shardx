# Changelog

所有值得注意的变更都记在这里。版本号同时更新 `package.json`。

## 2.0.0 — 2026-11-18

完全重写为矩阵家族第四扩展 `shardx-matrix`，与 egress（19880）、Cloudflare（19882）、
Instabox（19883）共用槽位契约。

### 新增

- 固定槽位契约：`slot-001..slot-250` ↔ `127.0.0.1:24001..24250`，统一
  `matrixSlotId` / `routingPlane` / `healthState` / `egressFingerprint` 字段
  （`core/contract.js`）。
- 跨进程原子状态：`store-lock`（PID 存活探测、Windows/WSL2 `EPERM`/`EBUSY` 退避）+
  `profile-store`（`matrixSlotId ↔ profileId` 1:1、任务环形 200 条、AES-256-GCM 凭据）。
- egress 租约与换血屏障：启动前取租约，`PRE_ROTATION_FREEZE` /
  `POST_ROTATION_RESUME` 驱动动作等待与 `ack-freeze`。
- ShardX 客户端：`settings.json` 发现、HS256 JWT 现场签发、代理 / 时区 / locale /
  `webrtc=proxy` 对齐、`DevToolsActivePort` 轮询；WSL2 宿主网关自动探测
  （`core/host-bridge.js`）。
- CDP 接管：`playwright-core` `connectOverCDP`，缺失时零依赖原生 CDP 回退；
  语义快照（URL / 标题 / 可见文本 / ARIA / `e1..eN`）；动作泊松延迟 400–1800ms。
- 服务 `127.0.0.1:19884`：`/profile/launch|close`、`/page/observe|act`、
  `/task/execute`、`/slots`、`bus-health`、`integrations`、WS
  `/api/v1/shardx/ws`、完整 CORS 与面板静态托管。
- MCP：stdio + SSE `19885`，5 个工具 `shardx_slot_launch` / `shardx_page_observe` /
  `shardx_page_act` / `shardx_task_run` / `shardx_slot_close`。
- 面板：250 宫格、双轨进度条、四扩展状态灯、批量启动 / 关闭 / 任务、抽屉截图与动作流。
- 测试：`node:test` 8 组端到端（mock egress / ShardX / CDP），零外网依赖。

### 变更

- `package.json` 升到 2.0.0（CommonJS），`openchamber` 字段直接声明 panel、service 与
  5 个工具；宿主发现不再依赖 `manifest.json`。
- 文档重写为 v2：README、ARCHITECTURE、MCP-TOOLS、OPERATIONS、ROADMAP。

### 移除

- v1（`shardx-workspace`）实现：`index.js`、`manifest.json`、`tsconfig.json`、
  `panel/*.ts`、`preview/`、`docs/canvas/`、`scripts/gen-docs.mjs`。

## 1.4.0 — 2026-11-15

项目整理与可视化文档版本。

### 新增

- 根目录 `README.md`：功能地图、安装、MCP 注册、架构、关键设计、路线图。
- `docs/ARCHITECTURE.md`：模块边界、调用链、状态模型、不变量、路由表。
- `docs/OPERATIONS.md`：构建、部署、升级、环境变量、冒烟检查、排障、回滚。
- `docs/ROADMAP.md`、`CHANGELOG.md`。
- `scripts/gen-docs.mjs`：从 `manifest.json` 自动生成
  `docs/MCP-TOOLS.md` 与 `docs/canvas/tool-data.js`，工具文档不再手工维护。
- `docs/canvas/`：Canvas 项目图鉴（架构图、能力图表、32 工具目录、部署卡片、路线图）。
- `bun run validate` 与 `bun run docs:gen` 脚本。

### 变更

- `package.json` 名称统一为 `openchamber-shardx`，版本对齐 1.4.0，补齐
  `repository` / `homepage` / `bugs` / `keywords`。
- `manifest.json` 版本 1.4.0；MCP `SERVER.version` 回退值同步。
- `panel/README.md` 改为指向根文档的模块速查，移除过时的「6 个工具」描述。
- 删除一次性实验脚本 `try-origin.mjs`。

### 保留

- 32 个 MCP 工具与 v1.3.0 行为一致（仅版本号变化）。
- 面板四页、镜像铺满、运行实例接管、连接自愈、列表文件夹标签与多字段排序。

## 1.3.0 — 2026-11-08

### 新增

- MCP 工具从 15 个扩展到 **32 个**：分组、环境档案、代理、指纹、Skill 分配/执行、
  工作区状态、服务器控制与同步。
- `session_attach` 接管已运行实例；`session_snapshot` / `session_wait` / `session_tabs`
  / `session_screenshot` 补齐页面自动化闭环。

### 修复

- `attachPage` 在 `wantedTargetId=''` 时返回空字符串导致 `page.id` 为 undefined；
  改为三元表达式并保留 targetId 归一化与 3 次重试。
- 真实 E2E 全链路验证：绑定 → 导航 → 状态 → 快照 → 标签 → 等待 → 截图 → 释放。

## 1.2.0 — 2026-11-07

### 新增

- 面板四页：环境（卡片/列表/标签组）、会话映射、操作 Skill、服务器管理。
- 浏览器式实例标签：地址栏、会话锁、`Target.getTargets` 子标签、实时视口、
  点击/键盘转发、检查器与 CDP 日志。
- 共享状态 `state.json`（mappings / skills / assignments / settings）。
- 15 个 MCP 工具；服务端 19 条桥接路由。
- 启动器自动发现：settings.json + HS256 JWT 现场签发。

### 后续补丁（同日）

- 环境主页改为 ShardX 主界面镜像，默认镜像模式，可切本地列表。
- 镜像按容器尺寸 `Emulation.setDeviceMetricsOverride` 铺满，输入全量转发。
- 运行中实例自动接管；`/instances/running` 补读 `DevToolsActivePort`。
- 列表 9 种排序字段、表头单击/双击、升降序、拖拽排序持久化。
- 分组入口与标签组视图；列表视图内置文件夹标签。
- 启动器路径自动解析与落盘；启动器关闭后自动拉起（20s 发现 / 30s 冷却）。
