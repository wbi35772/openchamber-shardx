# ShardX Matrix 交接

## v2（2026-11-17）

v2 在同一个仓库里重写为 `shardx-matrix`：250 个固定槽位（`slot-001..slot-250` ↔
`127.0.0.1:24001..24250`），服务端唯一编排器 `service/main.js`（19884），面板同源，
MCP 精简为 5 个工具（stdio / SSE 19885）。

- 入口：`package.json` → `openchamber.apiVersion=1`，panel `shardx-matrix`（同源
  `panel/index.html`，`page: true`），service 由宿主托管（端口经
  `OPENCHAMBER_SERVICE_PORT` 注入），MCP `mcp/server.js`（stdio / SSE 19885）。
- 面板双模式：应用内走宿主 postMessage 桥并按 5s 轮询（CSP 禁止直连 127.0.0.1）；
  单独打开 `http://127.0.0.1:<port>/` 时自动改用 fetch + WebSocket。
- 核心链：egress 租约 → 槽位代理 → Profile 对齐（proxy / 时区 / locale / webrtc）→
  CDP 接管 → 语义快照与动作；换血冻结期间动作等待 resume。
- 状态：`~/.openchamber-shardx-matrix`（`SHARDX_MATRIX_STATE_DIR` 可覆盖），凭据
  AES-256-GCM 加密。
- 发现文件：service 启动后写入 `OPENCHAMBER_SERVICE_DATA_DIR/service.json` 与
  `~/.openchamber-shardx-matrix/run/service.json`（port / token / pid），MCP 自动读取。
- 验证：`npm run check` 通过；`npm test` 8/8 通过（约 0.4s，进程正常退出）；manifest
  通过 SDK schema 校验；已部署到 `~/.config/openchamber/extensions/shardx-matrix` 并
  登记进 `extensions.json`（重启 OpenChamber 后加载）。
- 状态（2026-11-18 验收）：宿主已识别并加载 `shardx-matrix`（`/api/guests` 可见
  `pageEntry` 与 5 个工具）。授权 `service` 能力后宿主托管服务并注入随机端口
  （本次 62796），discovery 文件随之更新，MCP 自动跟随，无需重启。
- 实机链路已验证：`slot-004`（egress ACTIVE，出口 104.28.163.182 / AS13335）→ CDP
  接管 → `page_observe` 快照、`page_act` eval/extract、`task_run` 3/3 步通过
  （httpbin.org 提取 `Herman Melville - Moby-Dick`）、`slot_close` 休眠。
- 约束：`requireEgressLease=true` 的槽位必须先有 egress 租约；当前 egress 只给
  `slot-002`（COOLDOWN）/`slot-004`（ACTIVE）发了租约，其它槽位需要先
  `POST /api/v1/egress/lease/bind`。
- 面板视觉确认（2026-11-18）：左侧「ShardX Matrix」整页打开，iframe 内 250 槽位、
  统计条、状态灯全部渲染；Egress/ShardX 绿灯、Cloudflare/Instabox 暗（对应 19882/19883
  未起）；`宿主桥` 指示灯说明面板走的是 postMessage 代理；`slot-004` 显示出口
  104.28.163.182 / AS13335。截图：
  [docs/images/panel-2026-11-18.jpg](docs/images/panel-2026-11-18.jpg)。
- 面板动作链路确认（2026-11-18）：不点按钮，直接按按钮同款路径
  `POST /api/guests/shardx-matrix/service/request`
  `{method:'POST', path:'/api/v1/shardx/profile/launch', body:'{"matrixSlotId":"slot-004"}'}`
  返回 200，槽位转为 `RUNNING`、`cdpAttached:true`、出口换到新租约
  104.28.166.10 / AS13335；面板 5s 轮询后显示「运行中」与「休眠」按钮。截图：
  [docs/images/panel-running-2026-11-18.jpg](docs/images/panel-running-2026-11-18.jpg)。
- 环境前提：内置浏览器（agent web tool）需要
  `~/.config/openchamber/extensions/server-browser/config.json` 里显式
  `chromePath`（Chrome ≥109），改完需 `PUT /api/guests/server-browser/enabled`
  false→true 重启该服务才会重新读取。
- ShardX 升级（2026-11-18）：Launcher 2.1.4 → 2.1.5，便携版同路径替换，sha256
  `dfbb3fdb8a23c3b6c781a6b043b53e61e8b329538c5d380cb4c5ed56a9a4c529` 校验通过；旧版备份
  `D:\Tools\Auto-PC\shardx\backup\ShardBrowser-Launcher-portable-win-x64-2.1.4-20261118.exe`。
  流程：先 `POST /profiles/<id>/stop` 停 `slot-004`（浏览器 6208 退出、残留 chrome 0）→
  备份并退出启动器 → 替换 exe（ProductVersion 2.1.5）→ 重启 → `/health` 报 2.1.5。
  验证：profiles 23 个、`data_root=D:\Data\shardx` 未变；`slot-004` egress 租约 #876
  （104.28.166.10 / AS13335）→ CDP 接管 → `task_run` 3/3（httpbin H1
  `Herman Melville - Moby-Dick`）→ `slot_close` 全部通过。2.1.5 变化：品牌域名
  proxyshard→shardx、新增 `/extensions/updates*` 接口、Windows `platform_version`
  指纹池修正；本扩展用到的 profiles/proxies/start/stop 无破坏性变化。
- 真实站点验证（2026-11-18）：把邮箱 profile `2-aimeikeji135@gmail.com`
  （`1c8abde2-b646-477d-a41b-6c06ea34d99e`）绑到 `slot-004` 并启动，直落
  `mail.google.com/mail/u/0/#inbox`（已有登录态，未跳登录页），标题「收件箱 (352) -
  aimeikeji135@gmail.com - Gmail」，`page_observe` 读到 386 行会话列表，截图
  [docs/images/gmail-slot-004-2026-11-18.png](docs/images/gmail-slot-004-2026-11-18.png)。
- 缺陷与修复（2026-11-18）：启动链 `alignProfileToLease` 把 `fingerprint` 当成
  GET 返回的嵌套字段，但 2.1.x 的 `GET /profiles/<id>` 返回的是扁平配置，而
  `PATCH /profiles/<id>` 的 `fingerprint` 是**整体替换**——于是每次经扩展启动，
  config 被写成只剩 `timezone/locale/webrtc`，`name/notes/screen/webgl/noise/tls/...`
  全部丢失，启动器里显示 `(unnamed)`（该缺陷在 2.1.4 同样存在）。修复：
  `lib/shardx-client.js` 先 GET 完整配置，剔除 `_meta/running/cdp` 后合并回写，
  locale 改用实际字段 `icu_locale`；GET 失败时只写 `proxy_id`，绝不单发
  `fingerprint`。测试 mock 改为真实扁平结构 + 替换语义，断言 `name/notes/screen`
  保留，`npm test` 8/8。已同步部署目录并 `PUT /api/guests/shardx-matrix/enabled`
  false→true 重启服务（新 pid 22244 / port 56938，token 见 discovery），再启动
  `slot-004` 验证 name 与 config 保留。
- 受损 profile（仅经扩展启动过的两个）：`1c5bcd6d` 经 `myaccount.google.com`
  确认为登录账号 `jiaoben987@gmail.com`（页面显示名「照王」），已 PATCH 命名为
  `jiaoben987@gmail.com`；该 profile 属 2026-10-14 的导入批次，累计运行约 2.7h，
  名字丢失前是否有编号已无记录。`1c8abde2`（`2-aimeikeji135@gmail.com`）已 PATCH
  恢复名字，`icu_locale=nl-NL`，但 `screen/webgl/noise/...` 等原指纹字段无法还原
  （其余 21 个 profile 未受影响）。
- 受损 profile 重建（2026-11-18，已完成）：两个 profile 经 `GET /fingerprint/new`
  生成完整预设并 PATCH `fingerprint`，再 PATCH `name` 固化名字。两者均为 Windows
  Chrome 157 UA / 2560x1440 / `nl-NL` / `Europe/Amsterdam` / `webrtc=proxy`，
  22 个配置键；`1c5bcd6d`（jiaoben987@gmail.com）用 RTX 2070 SUPER、8 核，
  `1c8abde2`（2-aimeikeji135@gmail.com）用 GT 720、12 核。CDP 实测 UA/语言/
  screen/WebGL/timezone 与配置一致，`navigator.webdriver=false`。重新启动
  `slot-004` 后 Gmail 仍直落收件箱（352），egress 104.28.166.10（NL）正常；
  期间一次 `ERR_TUNNEL_CONNECTION_FAILED` 为 egress 瞬时故障，重试即恢复。
- 未做：尚未提交今天的验收改动（ROADMAP / HANDOFF）。

文档：README / docs/ARCHITECTURE.md / docs/OPERATIONS.md / docs/MCP-TOOLS.md 已对齐 v2。

---

# v1 交接（2026-11-07，历史）


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


## 环境主页镜像（2026-11-07 完成）

- 环境页默认进入「主界面」模式，直接把 ShardX 启动器 WebView2 的页面镜像进扩展；右上角可切回「本地列表」，选择存在 localStorage 的 `shardx-home-mode`。
- 启动器是 Tauri + WebView2。命令行参数无效，必须通过环境变量注入调试端口：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=40326 --remote-allow-origins=*'`。扩展启动 ShardX 时自动合并该变量；已有启动器可在镜像占位页点「重启并启用镜像」。
- 服务端新增 `GET/POST /launcher/status`：依次探测 `SHARDX_MIRROR_PORT`、用户已有参数中的端口、40326、9333、9222、9223 的 `/json/list`，返回 `{found, cdpPort, targets:[{id,title,url,webSocketDebuggerUrl}]}`。
- 面板 `panel/mirror.ts`：`LauncherMirror` 每 900ms `Page.captureScreenshot`，把 JPEG 画到 `<img>`；鼠标按下/释放/移动/滚轮/右键按 aspect-fit 映射转发 `Input.dispatchMouseEvent`；键盘、粘贴、IME 结果转发 `Input.dispatchKeyEvent` / `Input.insertText`；断线自动重连并保留占位页。
- 运行中实例自动接管：`refreshAll` 同时拉 `/running`，`syncRunningTabs` 对已有 `web_socket_debugger_url` 的 profile 调 `bridge.attachRunningProfile`，在后台开实例标签（不抢当前页，上限 18 个）；手动关闭的标签记入 dismissed，实例停止后清除；`startProfileInSession` 对已运行 profile 复用 CDP，不再重复 start。
- 验证：真实启动器 9333 端口通过服务端 `/cdp/*` 截图 103,568 字节、视口 1280×800；预览 `preview/console-mirror.png` 与 `preview/console-mirror-list.png` 分别确认镜像与本地列表两种模式。`bun run typecheck`、`bun run build` 均通过，已部署到扩展目录并核对 SHA256。

## 本轮增强（2026-11-07 晚）
- 镜像铺满：`panel/mirror.ts` 用 `ResizeObserver` 监听内容区，按容器实际像素调 `Emulation.setDeviceMetricsOverride`（dSF=1，上限 1920×1200），启动器页面随内容区重排，截图 1:1 铺满；`style.css` 去掉 viewport 内边距与图片留白。鼠标映射仍兼容缩放/letterbox。
- 启动器窗口启动的实例也能接管：`service/main.ts` 在启动/重启启动器前把 `--remote-debugging-port=0 --remote-allow-origins=*` 合并进 `settings.json` 的 `extra_args`（`POST /launcher/settings {ensure_debug:true}`），浏览器退出时把端口写进各自的 `user-data/<id>/DevToolsActivePort`。新增 `POST /instances/running`：先取启动器 `/running`，再为缺少 `cdp` 的条目补读 `DevToolsActivePort`（返回 `enriched`/`attachable`）。面板 `api.running()` 改走该接口，UI 启动的实例因此出现在实例标签页；仍无端口的旧实例在镜像工具栏出现「接管 N 个运行实例」，点击后停止并通过 API 重新启动（带调试参数）。
- 列表排序：工具栏新增排序字段下拉（手动 / 名称 / 平台 / 状态 / 代理 / 文件夹 / 最近启动 / 创建时间 / ID）与升序/降序按钮，表头单击/双击排序并显示箭头，选择写入 `shardx-sort`；非手动排序时关闭拖拽，手动模式下列表行也可直接拖拽。
- 分组入口：主界面栏新增「本地分组」，一键切到本地列表 + 标签组视图；分组内仍保留卡片/列表切换与拖拽排序。

## 本地列表分组标签页（2026-11-08）
- 列表视图现在自带文件夹标签条：`全部环境` + 各文件夹标签（含环境数、运行中数），点击标签只切换下方内容区列表，不再需要切到单独的「分组」视图。
- `panel/ui.ts` 新增 `buildProfileListWithTabs()`；选中标签写入 `localStorage.shardx-list-folder`，「全部环境」为 `__all__`，文件夹被删或过滤后自动回退。
- 「全部环境」显示文件夹列、不启用拖拽；切到具体文件夹标签后按该文件夹的手动顺序启用行拖拽，表头排序照常。
- 主界面「本地分组」按钮改为直达本地列表 + 标签分组。
- 验证：`bun run typecheck`、`bun run build` 通过；preview `?mode=list` 实测标签为 `全部环境 10 / 新账号 3 / Google 4 / 未分类 3`，点 Google 后内容区 4 行且可拖拽（4 个 grip），点回全部恢复 10 行、无拖拽，`shardx-list-folder` 依次写入 `Google` / `__all__`。

## 连接自动恢复（2026-11-07 深夜）
故障：OpenChamber 重启后 `autoDiscover` 因已存 token 直接 return，ShardX 启动器被关闭时面板全部请求失败；刷新也不恢复。
- `panel/ui.ts`：`autoDiscover` 改为每个环境页刷新周期（20s 节流）都向桥接服务要一次发现结果，运行中则静默保持；`running:false` 时调 `reviveLauncher()` 自动 `POST /workspace/server/control {action:"start"}`（30s 冷却），成功后重新发现并提示。连续失败才提示去「服务器」页填路径。
- `service/main.ts`：新增 `launcherCandidates()` / `resolveLauncherPath()` / `persistLauncherPath()`。`/workspace/server/status` 发现运行中的启动器时把可执行路径写回 state.json；`/workspace/server/control` 的 start/restart 在未传路径时按 state → 运行进程 → 常见安装目录依次解析，再注入 WebView2 调试参数启动。
- 兼容旧服务：已把 `settings.launcher_path` 写入 `%APPDATA%\shardx-workspace\state.json`，旧服务进程也能冷启动启动器；新服务随下次 OpenChamber 重启生效，此后无需再手填。
- 验证：`bun run typecheck`、`bun run build` 通过；独立起构建后的 `service/main.js`（临时端口/临时 state）实测 `/shardx/discover` 返回 found/running/port 40325 v2.1.4，`/workspace/server/status` 自动得到启动器路径并落盘，`/workspace/server/control start` 返回 200 且 `running:true`。

## GitHub 私有仓库与文档站（2026-11-15）
- 仓库：`https://github.com/wbi35772/openchamber-shardx`，私有，默认分支 `main`，源码包名 `openchamber-shardx` 版本 1.4.0。
- 文档：根 `README.md`、`docs/ARCHITECTURE.md`、`docs/MCP-TOOLS.md`（由 manifest 生成，32 工具）、`docs/OPERATIONS.md`、`docs/ROADMAP.md`、`CHANGELOG.md`、`panel/README.md`。
- Canvas 图鉴：工件 id `06GXXCJ5G4WNT2E9Z2T6K5ZTWT-shardx-workspace`；7 个标签页、Chart.js 两图、d3 依赖图、4 张 mermaid、工具搜索、截图灯箱、标签记忆。源文件在 `docs/canvas/`，更新流程见 `docs/OPERATIONS.md` 第 9 节。
- 校验：`bun run typecheck`、`bun run validate`（指向 `package.json`）、`bun run build`、`bun run docs:gen` 全部通过；Canvas 页面在真实 viewer 中验证 charts=2、graph=6、mermaid=4、tools=32、搜索与灯箱可用；修复了总览标签首次打开时 `chartsDrawn` TDZ 导致绘图中断的问题。

