# ShardX Workspace · MCP 工具参考

> 自动生成，请勿手改。数据源：`manifest.json`（v1.4.0）。
> 重新生成：`bun run docs:gen`

MCP 服务端为 `index.js`（stdio、零依赖、Node ≥ 22），工具在 OpenChamber 内显示为
`shardx-workspace_<tool>`。共 **32** 个工具。

## 目录

- [环境与实例](#环境与实例) · 4
- [页面自动化](#页面自动化) · 8
- [分组与环境档案](#分组与环境档案) · 7
- [代理与指纹](#代理与指纹) · 5
- [Skill 自动化](#skill-自动化) · 4
- [工作区状态](#工作区状态) · 1
- [服务器控制](#服务器控制) · 3

## 调用约定

- `session_id` 把同一轮对话的多次调用串到同一实例；不同 `session_id` 之间实例隔离。
- 同一 profile 同时只能被一个会话独占；一个会话可以持有多个实例，用 `profile_id` 指定。
- 所有工具失败时返回 MCP `isError` 与可读错误文本，不会静默成功。
- 共享状态文件：`%APPDATA%\shardx-workspace\state.json`，可用 `SHARDX_WORKSPACE_STATE` 覆盖。


## 环境与实例

| 工具 | 作用 |
|---|---|
| `list_and_bind_profile` | 列出本机 ShardX 指纹环境（带文件夹分组统计），或把某个空闲 profile 绑定到当前会话并启动实例；action=folders 只返回分组摘要。同一 profile 只能被一个会话独占，一个会话可以有多个实例。 |
| `session_attach` | 接管一个已经在 ShardX 中运行的实例（不重复启动），把它绑定到当前会话并写入共享映射。 |
| `session_stop_and_release` | 关闭当前会话绑定的指纹浏览器实例并释放独占锁。不传 profile_id 时释放该会话的全部实例。 |
| `session_status` | 列出当前会话拥有的全部实例：profile、名称、CDP 页面 session、当前 URL 与标题。多实例场景先看这个再操作。 |

### `list_and_bind_profile`

列出本机 ShardX 指纹环境（带文件夹分组统计），或把某个空闲 profile 绑定到当前会话并启动实例；action=folders 只返回分组摘要。同一 profile 只能被一个会话独占，一个会话可以有多个实例。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `session_id` | string |  | "default" | 会话标识，用于隔离实例；同一次对话保持一致 |
| `action` | enum: list / folders / bind / auto-bind | 是 |  | list=列出环境；folders=只看分组；bind=绑定 profile_id；auto-bind=自动挑一个未占用且未运行的 |
| `profile_id` | string |  |  | 要绑定的 profile ID（action=bind 时必填） |
| `folder` | string |  |  | 按文件夹筛选（list / auto-bind 时可选） |
| `query` | string |  |  | 按名称 / ID / 文件夹模糊筛选（action=list） |
| `limit` | number |  |  | action=list 最多显示多少个环境 |
| `include_profiles` | boolean |  |  | action=folders 时是否带上每个分组的 profile 列表 |
| `headless` | boolean |  |  | 无头启动（action=bind / auto-bind） |
| `password` | string |  |  | 受密码保护的 profile 需要密码 |

### `session_attach`

接管一个已经在 ShardX 中运行的实例（不重复启动），把它绑定到当前会话并写入共享映射。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `session_id` | string |  | "default" | 会话标识，用于隔离实例；同一次对话保持一致 |
| `profile_id` | string | 是 |  | 要接管的 profile ID |
| `name` | string |  |  | 可选显示名，默认取 ShardX 里的环境名 |
| `headless` | boolean |  |  | 实例没在运行时是否无头启动 |
| `password` | string |  |  | 受密码保护的 profile 需要密码 |

### `session_stop_and_release`

关闭当前会话绑定的指纹浏览器实例并释放独占锁。不传 profile_id 时释放该会话的全部实例。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `session_id` | string |  | "default" | 会话标识，用于隔离实例；同一次对话保持一致 |
| `profile_id` | string |  |  | 只释放这个实例（可选） |

### `session_status`

列出当前会话拥有的全部实例：profile、名称、CDP 页面 session、当前 URL 与标题。多实例场景先看这个再操作。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `session_id` | string |  | "default" | 会话标识，用于隔离实例；同一次对话保持一致 |

## 页面自动化

| 工具 | 作用 |
|---|---|
| `session_navigate` | 在当前会话绑定的指纹浏览器里打开或跳转 URL，并等待页面加载。会话有多个实例时用 profile_id 指定。 |
| `session_interact` | 在当前会话实例中执行交互：click / type / scroll / hover / press / select / check / uncheck / back / forward / reload / get_text / get_html / get_value / exists / count / links / wait / snapshot / tabs / evaluate_js。 |
| `session_extract_dom` | 提取当前实例页面的文本、Markdown、HTML 或表单结构。会话有多个实例时用 profile_id 指定。 |
| `session_manage_cookies` | 读取、注入或清空当前实例的 Cookie。会话有多个实例时用 profile_id 指定。 |
| `session_tabs` | 管理实例的浏览器标签：list 列出全部页面 target，open 新建，switch 切换，close 关闭；切换后后续工具都作用在新标签上。 |
| `session_wait` | 等待页面条件满足：selector 出现、text 出现、url 包含、或 JS expression 为真；超时抛错。比盲目 sleep 稳定。 |
| `session_snapshot` | 一次性返回页面快照：URL、标题、可见文本、链接、表单字段与按钮。用于让 Agent 低成本理解页面并决定下一步。 |
| `session_screenshot` | 截取当前实例可见区域（或整页）PNG，直接作为图片返回。 |

### `session_navigate`

在当前会话绑定的指纹浏览器里打开或跳转 URL，并等待页面加载。会话有多个实例时用 profile_id 指定。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `session_id` | string |  | "default" | 会话标识，用于隔离实例；同一次对话保持一致 |
| `profile_id` | string |  |  | 会话内多实例时指定要操作的实例；省略时用该会话唯一的实例 |
| `url` | string | 是 |  | 目标 URL |
| `wait_until` | enum: load / domcontentloaded / networkidle |  | "networkidle" |  |

### `session_interact`

在当前会话实例中执行交互：click / type / scroll / hover / press / select / check / uncheck / back / forward / reload / get_text / get_html / get_value / exists / count / links / wait / snapshot / tabs / evaluate_js。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `session_id` | string |  | "default" | 会话标识，用于隔离实例；同一次对话保持一致 |
| `profile_id` | string |  |  | 会话内多实例时指定要操作的实例；省略时用该会话唯一的实例 |
| `action` | enum: click / type / scroll / hover / press / select / check / uncheck / back / forward / reload / get_text / get_html / get_value / exists / count / links / wait / snapshot / tabs / evaluate_js | 是 |  |  |
| `selector` | string |  |  | CSS 选择器 |
| `text` | string |  |  | 输入文本（action=type） |
| `key` | string |  |  | 按键，例如 Enter、Escape、Control+A（action=press） |
| `value` | string |  |  | select 的选项值 |
| `url` | string |  |  | wait 需要匹配的 URL 片段 / tabs 新标签地址 |
| `expression` | string |  |  | wait 需要为真的 JS 表达式 |
| `timeout_ms` | number |  |  | wait 超时毫秒，默认 30000 |
| `tab_action` | enum: list / open / switch / close |  |  | action=tabs 时的标签操作 |
| `index` | number |  |  | 标签序号（tabs switch/close） |
| `target_id` | string |  |  | 标签 targetId（tabs switch/close） |
| `x` | number |  |  | 点击 X 坐标（可选，配合 y） |
| `y` | number |  |  | 点击 Y 坐标 / 滚动像素（可选） |
| `script` | string |  |  | JS 代码（action=evaluate_js） |

### `session_extract_dom`

提取当前实例页面的文本、Markdown、HTML 或表单结构。会话有多个实例时用 profile_id 指定。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `session_id` | string |  | "default" | 会话标识，用于隔离实例；同一次对话保持一致 |
| `profile_id` | string |  |  | 会话内多实例时指定要操作的实例；省略时用该会话唯一的实例 |
| `selector` | string |  |  | CSS 选择器，省略则整页 |
| `mode` | enum: markdown / html / forms / text |  | "markdown" |  |

### `session_manage_cookies`

读取、注入或清空当前实例的 Cookie。会话有多个实例时用 profile_id 指定。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `session_id` | string |  | "default" | 会话标识，用于隔离实例；同一次对话保持一致 |
| `profile_id` | string |  |  | 会话内多实例时指定要操作的实例；省略时用该会话唯一的实例 |
| `action` | enum: get / set / clear | 是 |  |  |
| `cookies_json` | string |  |  | Cookie 数组 JSON（action=set），字段同 CDP Network.setCookies |

### `session_tabs`

管理实例的浏览器标签：list 列出全部页面 target，open 新建，switch 切换，close 关闭；切换后后续工具都作用在新标签上。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `session_id` | string |  | "default" | 会话标识，用于隔离实例；同一次对话保持一致 |
| `profile_id` | string |  |  | 会话内多实例时指定要操作的实例；省略时用该会话唯一的实例 |
| `action` | enum: list / open / switch / close | 是 |  |  |
| `url` | string |  |  | open 时要打开的地址，默认 about:blank |
| `index` | number |  |  | 标签序号（switch / close） |
| `target_id` | string |  |  | 标签 targetId（switch / close） |

### `session_wait`

等待页面条件满足：selector 出现、text 出现、url 包含、或 JS expression 为真；超时抛错。比盲目 sleep 稳定。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `session_id` | string |  | "default" | 会话标识，用于隔离实例；同一次对话保持一致 |
| `profile_id` | string |  |  | 会话内多实例时指定要操作的实例；省略时用该会话唯一的实例 |
| `selector` | string |  |  |  |
| `text` | string |  |  |  |
| `url` | string |  |  |  |
| `expression` | string |  |  |  |
| `timeout_ms` | number |  | 30000 |  |

### `session_snapshot`

一次性返回页面快照：URL、标题、可见文本、链接、表单字段与按钮。用于让 Agent 低成本理解页面并决定下一步。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `session_id` | string |  | "default" | 会话标识，用于隔离实例；同一次对话保持一致 |
| `profile_id` | string |  |  | 会话内多实例时指定要操作的实例；省略时用该会话唯一的实例 |
| `max_text` | number |  |  | 正文最多字符，默认 6000 |
| `max_links` | number |  |  | 链接最多条数，默认 80 |
| `max_fields` | number |  |  | 表单字段最多条数，默认 60 |

### `session_screenshot`

截取当前实例可见区域（或整页）PNG，直接作为图片返回。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `session_id` | string |  | "default" | 会话标识，用于隔离实例；同一次对话保持一致 |
| `profile_id` | string |  |  | 会话内多实例时指定要操作的实例；省略时用该会话唯一的实例 |
| `full_page` | boolean |  |  | true 时截整页 |

## 分组与环境档案

| 工具 | 作用 |
|---|---|
| `folder_list` | 读取 ShardX 的分组：每个文件夹的环境数、运行中数量、已分配 Skill；可选带上分组内 profile 列表。轻量，不受 profile 列表长度影响。 |
| `folder_rename` | 重命名一个文件夹，ShardX 会同步重打所有成员的 folder 标签。 |
| `folder_delete` | 删除文件夹。delete_profiles=true 连同环境一起删；false（默认）只把环境移出分组，不删环境。 |
| `profile_get` | 按 ID 读取一个指纹环境的完整配置。 |
| `profile_create` | 创建一个指纹环境：不传 fingerprint 时按 platform 自动生成；folder 直接归档到分组（不存在的分组会随创建出现）。 |
| `profile_edit` | 修改指纹环境：改名、备注、移动到分组（folder="" 取消归档）、换代理、换颜色、扩展、指纹；只改传入的字段。 |
| `profile_delete` | 把指纹环境移入 ShardX 回收站（可恢复），不是永久删除。 |

### `folder_list`

读取 ShardX 的分组：每个文件夹的环境数、运行中数量、已分配 Skill；可选带上分组内 profile 列表。轻量，不受 profile 列表长度影响。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `include_profiles` | boolean |  |  | 是否返回每个分组里的 profile 列表 |

### `folder_rename`

重命名一个文件夹，ShardX 会同步重打所有成员的 folder 标签。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `folder` | string | 是 |  |  |
| `name` | string | 是 |  |  |

### `folder_delete`

删除文件夹。delete_profiles=true 连同环境一起删；false（默认）只把环境移出分组，不删环境。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `folder` | string | 是 |  |  |
| `delete_profiles` | boolean |  | false |  |

### `profile_get`

按 ID 读取一个指纹环境的完整配置。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `profile_id` | string | 是 |  |  |

### `profile_create`

创建一个指纹环境：不传 fingerprint 时按 platform 自动生成；folder 直接归档到分组（不存在的分组会随创建出现）。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `name` | string |  |  |  |
| `notes` | string |  |  |  |
| `folder` | string |  |  |  |
| `proxy` | string |  |  | 代理字符串，例如 socks5://user:pass@host:port |
| `proxy_id` | string |  |  | 已存代理的 ID |
| `platform` | enum: Windows / macOS / Linux |  |  |  |
| `color` | string |  |  | #rrggbb |
| `extensions` | array of string |  |  | 扩展库 ID 列表 |
| `refresh_rate` | number |  |  | 声称的屏幕刷新率 24-480 |
| `fingerprint` | object |  |  | 完整指纹对象；省略则自动生成 |

### `profile_edit`

修改指纹环境：改名、备注、移动到分组（folder="" 取消归档）、换代理、换颜色、扩展、指纹；只改传入的字段。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `profile_id` | string | 是 |  |  |
| `name` | string |  |  |  |
| `notes` | string |  |  |  |
| `folder` | string |  |  | 目标文件夹；"" 表示移出分组 |
| `proxy_id` | string |  |  | "" 解绑代理 |
| `proxy` | string |  |  |  |
| `color` | string |  |  |  |
| `extensions` | array of string |  |  |  |
| `refresh_rate` | number |  |  |  |
| `fingerprint` | object |  |  |  |
| `rev` | number |  |  | 乐观锁版本；省略时用刚读到的版本 |
| `password` | string |  |  | 受保护 profile 的密码 |

### `profile_delete`

把指纹环境移入 ShardX 回收站（可恢复），不是永久删除。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `profile_id` | string | 是 |  |  |

## 代理与指纹

| 工具 | 作用 |
|---|---|
| `proxy_list` | 列出已保存的代理（不返回账号密码）。 |
| `proxy_add` | 添加代理到代理库；已存在的相同代理会复用。传 proxy 字符串或 host+port 显式字段。 |
| `proxy_delete` | 按 ID 删除代理库里的代理。 |
| `fingerprint_new` | 生成一份新的唯一化指纹（不落盘）；platform 省略时用本机系统。 |
| `fingerprint_list` | 列出指纹库条目（id、标签、平台、Chrome 版本、GPU、是否内置）。 |

### `proxy_list`

列出已保存的代理（不返回账号密码）。

_无参数。_

### `proxy_add`

添加代理到代理库；已存在的相同代理会复用。传 proxy 字符串或 host+port 显式字段。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `proxy` | string |  |  |  |
| `kind` | enum: socks5 / http / https |  |  |  |
| `host` | string |  |  |  |
| `port` | number |  |  |  |
| `username` | string |  |  |  |
| `password` | string |  |  |  |
| `name` | string |  |  |  |
| `country` | string |  |  |  |
| `notes` | string |  |  |  |

### `proxy_delete`

按 ID 删除代理库里的代理。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `proxy_id` | string | 是 |  |  |

### `fingerprint_new`

生成一份新的唯一化指纹（不落盘）；platform 省略时用本机系统。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `platform` | enum: Windows / macOS / Linux |  |  |  |

### `fingerprint_list`

列出指纹库条目（id、标签、平台、Chrome 版本、GPU、是否内置）。

_无参数。_

## Skill 自动化

| 工具 | 作用 |
|---|---|
| `skill_list` | 列出共享的 Skill 与分配关系，可按关键词过滤；传 profile_id 或 folder 时返回对该目标生效的 Skill。 |
| `skill_save` | 创建或更新一个 Skill。步骤 JSON 支持 navigate / reload / wait / click / type / evaluate / extract。 |
| `skill_assign` | 把 Skill 分配给一个实例（profile）或整个文件夹；remove=true 时移除分配。 |
| `skill_run` | 在指定实例（或当前会话唯一实例）上逐步执行一个 Skill，返回每一步的结果；首个失败步骤会中断执行。 |

### `skill_list`

列出共享的 Skill 与分配关系，可按关键词过滤；传 profile_id 或 folder 时返回对该目标生效的 Skill。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `query` | string |  |  |  |
| `profile_id` | string |  |  |  |
| `folder` | string |  |  |  |

### `skill_save`

创建或更新一个 Skill。步骤 JSON 支持 navigate / reload / wait / click / type / evaluate / extract。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | string |  |  | 已有 Skill ID；省略则新建 |
| `name` | string |  |  |  |
| `site` | string |  |  |  |
| `url_pattern` | string |  |  |  |
| `description` | string |  |  |  |
| `steps` | array of object |  |  | 步骤数组，例如 [{"action":"navigate","url":"https://example.com"},{"action":"wait","ms":800}] |
| `skill_json` | string |  |  | 整个 Skill 的 JSON 字符串（与上面的字段二选一） |

### `skill_assign`

把 Skill 分配给一个实例（profile）或整个文件夹；remove=true 时移除分配。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `skill_id` | string | 是 |  |  |
| `target_type` | enum: profile / folder | 是 |  |  |
| `target_id` | string | 是 |  |  |
| `remove` | boolean |  | false |  |

### `skill_run`

在指定实例（或当前会话唯一实例）上逐步执行一个 Skill，返回每一步的结果；首个失败步骤会中断执行。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `session_id` | string |  | "default" | 会话标识，用于隔离实例；同一次对话保持一致 |
| `profile_id` | string |  |  | 会话内多实例时指定要操作的实例；省略时用该会话唯一的实例 |
| `skill_id` | string | 是 |  |  |

## 工作区状态

| 工具 | 作用 |
|---|---|
| `workspace_state` | 读取或修改面板与 MCP 共享的映射状态（%APPDATA%\shardx-workspace\state.json）：get 读取全部；mapping 写入映射；unmap 删除映射；settings 保存启动器路径。 |

### `workspace_state`

读取或修改面板与 MCP 共享的映射状态（%APPDATA%\shardx-workspace\state.json）：get 读取全部；mapping 写入映射；unmap 删除映射；settings 保存启动器路径。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `action` | enum: get / mapping / unmap / settings | 是 |  |  |
| `profile_id` | string |  |  |  |
| `profile_name` | string |  |  |  |
| `session_id` | string |  |  |  |
| `source` | string |  |  |  |
| `launcher_path` | string |  |  |  |

## 服务器控制

| 工具 | 作用 |
|---|---|
| `server_status` | 读取 ShardX 启动器状态：安装发现、运行中、版本、API 端口与开关、数据目录、进程列表与共享状态文件路径。 |
| `server_control` | 启动、停止或重启 ShardX 启动器，并等待 /health 就绪；可传 launcher_path 覆盖共享设置里的路径。 |
| `server_sync` | 从 ShardX API 同步分组、环境、代理与运行中实例。folderSummary 先返回，避免长 profile 列表把分组信息截断；include_profiles=false 可只拿摘要。 |

### `server_status`

读取 ShardX 启动器状态：安装发现、运行中、版本、API 端口与开关、数据目录、进程列表与共享状态文件路径。

_无参数。_

### `server_control`

启动、停止或重启 ShardX 启动器，并等待 /health 就绪；可传 launcher_path 覆盖共享设置里的路径。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `action` | enum: start / stop / restart | 是 |  |  |
| `launcher_path` | string |  |  |  |

### `server_sync`

从 ShardX API 同步分组、环境、代理与运行中实例。folderSummary 先返回，避免长 profile 列表把分组信息截断；include_profiles=false 可只拿摘要。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `include_profiles` | boolean |  | true | false 时不返回完整 profiles 数组 |
