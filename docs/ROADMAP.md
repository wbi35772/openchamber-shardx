# 路线图

目标：250 个槽位像一张固定矩阵——槽位、端口、出口身份、浏览器实例一一对应；用户和
Agent 都能安全地编排同一批浏览器，而不互相踩线。

## 已完成（v2.0.0）

- [x] 槽位契约：`slot-001..slot-250 ↔ 24001..24250`，端口数学集中在 `core/contract.js`
- [x] egress 租约与出口身份对齐（代理 / 时区 / locale / `webrtc=proxy`）
- [x] 启动链幂等：已运行实例直接 CDP 接管，未运行才启动
- [x] 换血冻结屏障：`PRE_ROTATION_FREEZE` → `ACK_FREEZE` → 等待 resume，动作不穿透
- [x] 泊松动作延迟 400–1800ms；任务逐步日志、重试、取消
- [x] 语义快照（`e1..eN`）与 15 种页面动作
- [x] AES-256-GCM 凭据存储与 Cookie 导入
- [x] 250 宫格面板：筛选、抽屉、截图、动作流、设置、总线状态灯
- [x] 5 个 MCP 工具（stdio + SSE），服务端唯一编排
- [x] `node:test` 端到端 8 用例，mock egress / ShardX / CDP，无真实浏览器
- [x] 文档对齐 v2（README / 架构 / 运维 / MCP）

## 下一步（2.0.x）

### 1. 部署与实机验收

- 安装到 `~/.config/openchamber/extensions/shardx-matrix`，重启宿主；
- 绑定 1 个 Profile，跑通「启动 → 观测 → 动作 → 截图 → 休眠」；
- 验收：面板状态灯四绿，`/bus-health` 的 `wsClients ≥ 1`，槽位端口与 egress 租约一致。

### 2. MCP 客户端接入

- 在 opencode / OpenChamber 里注册 stdio；需要时再验证 SSE；
- 验收：`tools/list` 返回 5 个工具，`shardx_slot_launch` 能驱动真实槽位。

### 3. 观察者与多面板

- `role=observer` 只收事件不 ACK，用于第二块屏 / 监控页；
- 验收：两个面板同时打开，冻结 ACK 只由主面板回。

## 中期（2.1.x）

### 4. 槽位分组与批量编排

- 按 Profile 文件夹 / 国家 / 路由平面分组，批量启动与任务扇出；
- 每槽位独立并发上限，失败重试不阻塞其他槽位；
- 验收：20 个槽位并行启动，失败 2 个，其余 18 个正常进入 `RUNNING`。

### 5. 观测与回放

- 任务录制（过滤密码字段）→ 生成 steps JSON → 在另一槽位回放；
- 截图时间轴与 HAR 导出；
- 验收：录制一次登录流程，换槽位回放成功。

### 6. 指标与告警

- 每槽位 CDP 延迟、动作耗时、冻结次数、重连次数；
- 面板状态栏阈值标红，事件流保留最近 100 条；
- 验收：人为断 egress，5s 内变红，恢复后自动转绿。

## 长期

- 多启动器 / 远程节点（Profile 标注来源节点，按节点维护连接池）；
- 代理延迟探测与自动换槽建议；
- CI：`npm run check` + `npm test` + 文档链接检查。

> `docs/canvas/` 是 v1 的项目图鉴，仅作历史参考；v2 的架构以
> [ARCHITECTURE.md](ARCHITECTURE.md) 为准。
