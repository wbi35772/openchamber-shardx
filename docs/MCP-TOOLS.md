# ShardX Matrix · MCP 工具参考（v2）

MCP 服务端：`mcp/server.js`，协议 `2024-11-05`，服务器名 `shardx-matrix`。
工具只做转发，真正的编排在 `service/main.js`（默认 `http://127.0.0.1:19884`）。

## 传输

| 模式 | 命令 | 端点 |
|---|---|---|
| stdio（默认） | `node mcp/server.js` | 按行 JSON-RPC；OpenChamber / opencode 作为子进程拉起 |
| SSE | `node mcp/server.js --sse [--port 19885]` | `GET /sse` 建立会话，`POST /messages?sessionId=...` 回传 |
| 健康检查（SSE） | `GET /health` | `{ ok, service: "shardx-mcp", version, sessions, upstream }` |

stdio 与 SSE 共用同一个 `createMcpServer()`；支持 `initialize`、`ping`、`tools/list`、
`tools/call`，以及空实现的 `resources/list`、`prompts/list`。

## 调用约定

- 槽位参数统一叫 `matrixSlotId`，必须匹配 `^slot-\d{3}$` 且在 `slot-001..slot-250`。
- 参数同时接受下划线别名（`matrix_slot_id`、`profile_id` 等），面板与 MCP 可混用。
- 成功返回 `{ ok: true, ... }` 文本；业务失败返回 MCP `isError: true` 和
  `{ ok: false, error: { code, message } }`，不会静默成功。
- 上游不可达、未授权、槽位不存在分别映射为 `ERR_EGRESS_UNAVAILABLE` / `unauthorized` /
  `invalid_slot` 等错误码。
- 认证：服务端设置 `OPENCHAMBER_SERVICE_TOKEN` 时，MCP 用 `Authorization: Bearer` 转发。

## 工具一览

| 工具 | 作用 | 上游 |
|---|---|---|
| `shardx_slot_launch` | 取租约、对齐代理、启动 / 复用 Profile、CDP 接管 | `POST /profile/launch` |
| `shardx_page_observe` | 语义快照：URL、标题、可见文本、ARIA、`e1..eN` | `POST /page/observe` |
| `shardx_page_act` | 单个页面动作 | `POST /page/act` |
| `shardx_task_run` | 顺序执行多步任务并返回任务记录 | `POST /task/execute` |
| `shardx_slot_close` | 断开 CDP、停止 Profile、保留绑定与凭据 | `POST /profile/close` |

## `shardx_slot_launch`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `matrixSlotId` | string | 是 | `slot-001..slot-250` |
| `startUrl` | string |  | 覆盖全局 `defaultStartUrl` |

启动链：egress 租约 → `ensureSlotProxy`（`127.0.0.1:240NN`）→ `alignProfileToLease`
（proxy / timezone / locale / webrtc）→ 运行中则直接取 CDP 地址，否则 `startProfile` →
`waitForCdp` → CDP attach → `goto(startUrl)`。重复调用是幂等的：已有 CDP 会话直接返回槽位视图。

## `shardx_page_observe`

| 参数 | 类型 | 必填 |
|---|---|---|
| `matrixSlotId` | string | 是 |

返回 `snapshot`：`url`、`title`、`text`、`aria`、`elements[]`。`elements` 里每项带稳定
`ref`（`e1..eN`）、role、name 和坐标；下一步动作优先用 `ref`，比 CSS 选择器稳。

## `shardx_page_act`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `matrixSlotId` | string | 是 | 槽位 |
| `action` | enum | 是 | `goto` `navigate` `click` `fill` `press` `scroll` `wait` `observe` `snapshot` `extract` `assertText` `assert` `screenshot` `eval` `hover` |
| `url` | string |  | `goto` 目标 |
| `ref` | string |  | `e1..eN` |
| `selector` | string |  | 没有 `ref` 时使用 |
| `text` / `value` | string |  | `fill` 内容、`wait` / `assert` 文本 |
| `key` | string |  | `press` 按键，如 `Enter` |
| `x` / `y` / `deltaX` / `deltaY` | number |  | 滚动与坐标 |
| `attribute` | string |  | `extract` 读取的属性 |
| `expression` | string |  | `eval` 的 JS 表达式 |
| `ms` | number |  | `wait` 毫秒 |
| `timeoutMs` / `retries` | number |  | 超时与 1–5 次重试 |
| `continueOnError` | boolean |  | 任务内失败是否继续 |
| `as` | string |  | 把结果写入 `results[key]` |
| `submit` / `clear` | boolean |  | `fill` 后回车 / 填前清空 |

每个动作前会 `waitForUnfrozen(slot)`，并按 400–1800ms 泊松延迟执行。

## `shardx_task_run`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `matrixSlotId` | string | 是 | 槽位 |
| `steps` | array | 是 | 1–200 个动作对象，字段同 `shardx_page_act` |
| `source` | string |  | 来源标记，默认 `mcp` |

返回 `task`：`taskId`、`state`（`QUEUED/RUNNING/DONE/FAILED/CANCELLED`）、每步结果、日志、
时间戳。任务串行执行；槽位休眠会取消进行中的任务。

示例：

```json
{
  "matrixSlotId": "slot-007",
  "steps": [
    { "action": "goto", "url": "https://example.com/login" },
    { "action": "observe" },
    { "action": "fill", "ref": "e3", "text": "USER" },
    { "action": "fill", "ref": "e5", "text": "PASS", "submit": true },
    { "action": "wait", "text": "Dashboard", "timeoutMs": 15000 },
    { "action": "extract", "ref": "e9", "attribute": "href", "as": "nextUrl" }
  ]
}
```

## `shardx_slot_close`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `matrixSlotId` | string | 是 | 槽位 |
| `keepUrl` | boolean |  | 保留最后 URL / 标题记录 |

保留 `slot↔profile` 绑定、加密凭据和任务历史；下次启动重新走完整链路。进行中的任务会被取消。

## 错误码

| code | 场景 |
|---|---|
| `invalid_slot` | 槽位格式或范围不对 |
| `binding_missing` | 槽位还没绑定 Profile |
| `ERR_EGRESS_UNAVAILABLE` | egress 总线不可达 |
| `ERR_EGRESS_SLOT_BLOCKED` | 槽位处于 `QUARANTINED` / `ROTATING` / `WARP_OVERFLOW` |
| `egress_rotation_timeout` | 冻结超过 `freezeTimeoutMs` |
| `session_missing` | 启动后拿不到 CDP 会话 |
| `unauthorized` | 缺少或错误的 Bearer token |
| `unknown_tool` | 工具名不在五个之列 |
