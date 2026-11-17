# 运维手册（v2）

所有命令默认在仓库根目录执行；部署路径以 Windows 为例。

## 1. 环境要求

| 组件 | 版本 / 说明 |
|---|---|
| OpenChamber | ≥ 2.5.0，扩展 API v2 |
| Node | ≥ 20（无第三方运行时依赖） |
| ShardX 启动器 | 需开启自动化 API；`%APPDATA%\shardx-launcher\settings.json` 里有 `api_port` / `api_secret` |
| egress-matrix | `127.0.0.1:19880`，提供租约与换血 WS |
| cf-matrix / instabox-matrix | `19882` / `19883`，仅用于面板状态灯与 `/integrations` |
| Windows / WSL2 | 启动器在 Windows；WSL2 宿主会自动跨 `/mnt/c/Users/*/AppData/Roaming` 查找设置 |

## 2. 校验与测试

```powershell
npm run check   # node --check 全部源码
npm test        # node:test：8 个用例
```

当前基线：8/8 通过、约 0.4s、进程正常退出。测试用 mock egress / ShardX / CDP，
不启动真实浏览器，也不会占用 19884。

## 3. 部署

```powershell
$dst = "$env:USERPROFILE\.config\openchamber\extensions\shardx-matrix"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item package.json, icon.svg -Destination $dst -Force
Copy-Item core, lib, service, mcp, panel -Destination $dst -Recurse -Force
```

然后重新加载扩展或重启 OpenChamber。宿主按 `package.json` 的
`contributes.service` 启动 `service/main.js`（端口 19884），并注入
`OPENCHAMBER_SERVICE_TOKEN`；面板与 HTTP 接口同源。

手工启动（调试用）：

```powershell
$env:OPENCHAMBER_SERVICE_TOKEN = ""   # 空 token = 本机免鉴权
node service/main.js
curl.exe -s http://127.0.0.1:19884/health
curl.exe -s http://127.0.0.1:19884/api/v1/shardx/bus-health
```

## 4. MCP 注册

stdio：

```json
{
  "mcp": {
    "servers": {
      "shardx-matrix": {
        "type": "local",
        "enabled": true,
        "command": [
          "node",
          "C:\\Users\\<you>\\.config\\openchamber\\extensions\\shardx-matrix\\mcp\\server.js"
        ]
      }
    }
  }
}
```

SSE：

```powershell
node mcp/server.js --sse --port 19885
# 客户端连接 http://127.0.0.1:19885/sse，按 endpoint 事件回传 /messages?sessionId=...
```

MCP 只连服务，不碰启动器与浏览器；服务未启动时工具报
`ERR_EGRESS_UNAVAILABLE` / HTTP 503。

## 5. HTTP 接口

前缀 `http://127.0.0.1:19884`，除静态文件、`/health`、`bus-health`、WS 外都需要
`Authorization: Bearer <OPENCHAMBER_SERVICE_TOKEN>`（token 为空时放行）。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/` `/index.html` `/style.css` `/main.js` `/icon.svg` | 面板静态资源 |
| GET | `/health` | 进程、版本、状态目录、uptime |
| GET | `/api/v1/shardx/bus-health` | 槽位 / 运行数 / 任务 / WS 客户端 / egress |
| GET | `/api/v1/shardx/ws` | WebSocket 总线 |
| GET | `/api/v1/shardx/slots?includeUnbound=1` | 槽位列表 |
| GET | `/api/v1/shardx/slots/{slot}` | 单槽位视图 |
| POST | `/api/v1/shardx/slots/{slot}/bind` | 绑定 `{ profileId, profileName }` |
| POST | `/api/v1/shardx/slots/{slot}/unbind` | 解绑 |
| GET | `/api/v1/shardx/profiles?refresh=1` | ShardX Profile + 绑定关系 |
| GET | `/api/v1/shardx/proxies` | ShardX 代理列表 |
| POST | `/api/v1/shardx/profile/launch` | `{ matrixSlotId, startUrl? }` |
| POST | `/api/v1/shardx/profile/close` | `{ matrixSlotId, keepUrl? }` |
| POST | `/api/v1/shardx/profile/sleep-all` | 全部休眠 |
| POST | `/api/v1/shardx/profile/sync-proxies` | 逐槽位对齐代理 |
| POST | `/api/v1/shardx/page/observe` | `{ matrixSlotId }` |
| POST | `/api/v1/shardx/page/act` | `{ matrixSlotId, ...step }` |
| POST | `/api/v1/shardx/page/screenshot` | `{ matrixSlotId, persist? }` |
| POST | `/api/v1/shardx/task/execute` | `{ matrixSlotId, steps[] }` |
| POST | `/api/v1/shardx/task/cancel` | `{ taskId, reason? }` |
| GET | `/api/v1/shardx/tasks?matrixSlotId=&limit=` | 任务列表 |
| GET | `/api/v1/shardx/tasks/{taskId}` | 单任务 |
| GET/PUT/POST/DELETE | `/api/v1/shardx/credentials/{slot}` | 凭据元数据 / 写入 / 删除 |
| POST | `/api/v1/shardx/credentials/import` | `{ matrixSlotId, cookies[] 或 cookieString, url? }` |
| GET | `/api/v1/shardx/events?limit=` | 事件流 |
| GET/POST | `/api/v1/shardx/settings` | 读取 / 更新设置（立即持久化） |
| GET | `/api/v1/shardx/state` | 完整状态快照 |
| GET | `/api/v1/shardx/integrations?refresh=1` | 四条总线探测 |
| GET | `/api/v1/shardx/status` | 编排器 + hub 状态 |

统一响应：`{ ok: true, ... }` 或 `{ ok: false, error: { code, message } }`；请求体上限 16MB。

## 6. 状态与备份

默认目录 `~/.openchamber-shardx-matrix`，可用 `SHARDX_MATRIX_STATE_DIR` 覆盖。

```powershell
# 备份
Copy-Item "$env:USERPROFILE\.openchamber-shardx-matrix" "$env:USERPROFILE\.openchamber-shardx-matrix.bak" -Recurse -Force
# 重置（会丢绑定、凭据、任务历史）
Remove-Item "$env:USERPROFILE\.openchamber-shardx-matrix" -Recurse -Force
```

`matrix-state.json` 与 `credentials.json` 都是原子写；并发写由 `store-lock` 串行化。
不要手工编辑 `secret.key`，删除它会让旧凭据无法解密。

## 7. 环境变量

| 变量 | 作用 |
|---|---|
| `OPENCHAMBER_SERVICE_TOKEN` | 宿主注入；HTTP / WS 鉴权 Bearer |
| `SHARDX_MATRIX_SERVICE_URL` | MCP 上游，默认 `http://127.0.0.1:19884` |
| `SHARDX_MATRIX_STATE_DIR` | 状态目录 |
| `SHARDX_API_BASE` | 显式启动器 REST（优先于 settings.json） |
| `SHARDX_LAUNCHER_SETTINGS` | 显式 settings.json 路径 |
| `SHARDX_MCP_LOG=1` | MCP 日志到 stderr |

## 8. 排障

| 现象 | 检查 / 处理 |
|---|---|
| 启动失败 `launcher_settings_missing` | 先启动 ShardX；或设置 `SHARDX_LAUNCHER_SETTINGS`；WSL2 下确认 `/mnt/c/Users/<you>/AppData/Roaming/shardx-launcher/settings.json` 可读 |
| `api_secret 为空` | 在启动器里打开「自动化 API」后重启启动器 |
| 启动失败 `ERR_EGRESS_UNAVAILABLE` | egress-matrix 未起或地址不对；`curl 127.0.0.1:19880/api/v1/egress/bus-health`；面板状态灯应标红 |
| `ERR_EGRESS_SLOT_BLOCKED` | 槽位在冷却 / 隔离 / WARP 溢出；更换槽位或等换血完成 |
| `egress_rotation_timeout` | 总线迟迟不发 resume；看 egress 日志，必要时调大 `freezeTimeoutMs` |
| 面板一直「连接中」，WS 1006 | 服务没起、端口被占或代理层改写了 WS；`netstat -ano | findstr 19884`；确认经 19884 同源打开面板 |
| 401 `unauthorized` | MCP / 脚本没带宿主 token；设置 `OPENCHAMBER_SERVICE_TOKEN` 后重试 |
| 启动后立刻 `session_missing` | CDP 未就绪或 `DevToolsActivePort` 不可读；调大 `launchTimeoutMs`，确认 Profile 允许调试 |
| 截图不更新 | 页面在后台或实例已停止；先「启动」再「截图」；`screenshotRetention` 只保留最近 N 张 |
| 凭据解密失败 | `secret.key` 丢失或被换；重新导入 Cookie |

日志：服务端非 2xx 只在 ≥500 时写 stderr；MCP 用 `SHARDX_MCP_LOG=1` 打开。
测试产生的 mock 服务监听随机端口，不占用 19880–19885。

## 9. 升级

1. 覆盖 `core lib service mcp panel package.json icon.svg`。
2. 保留状态目录；状态版本由 `normalizeState` 迁移（当前 `STATE_VERSION=2`）。
3. 重载扩展，打开面板确认「绑定槽位 / 运行中 / 出口健康」计数正常。
4. `npm run check && npm test` 必须全绿再提交或发布。
