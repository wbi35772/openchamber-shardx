# 运维手册

构建、部署、升级、排障。所有命令默认在仓库根目录执行。

## 1. 环境要求

| 组件 | 版本 | 说明 |
|---|---|---|
| OpenChamber | ≥ 2.5.0 | 扩展 API v1（panel + service + tools） |
| ShardX Launcher | 2.1.x | 需开启自动化 API，默认 `127.0.0.1:40325` |
| Bun | 最新稳定版 | 仅构建需要 |
| Node | ≥ 22 | MCP 服务端需要全局 `WebSocket` |
| Windows | 10/11 | 镜像依赖 WebView2；其余能力跨平台 |

## 2. 构建与校验

```powershell
bun install
bun run typecheck
bun run validate        # manifest.json 结构校验
bun run build           # panel/main.js + service/main.js
bun run docs:gen        # manifest → docs/MCP-TOOLS.md + Canvas 数据
```

`bun run build` 会覆盖两个入库的产物文件；提交前务必重跑并检查 diff。

## 3. 部署

```powershell
$dst = "$env:USERPROFILE\.config\openchamber\extensions\shardx-workspace"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item index.js, manifest.json, icon.svg, package.json -Destination $dst -Force
Copy-Item panel, service -Destination $dst -Recurse -Force
```

部署后：

1. 重新加载扩展或重启 OpenChamber。
2. 面板打开「环境」，确认能发现 ShardX。
3. Agent 会话重启后 MCP 工具才刷新（`shardx-workspace_*`）。

升级时保留 `%APPDATA%\shardx-workspace\state.json`；删除它会丢失映射、Skill 与启动器路径。

## 4. MCP 注册

`~/.config/opencode/opencode.json`：

```json
{
  "mcp": {
    "servers": {
      "shardx-workspace": {
        "type": "local",
        "enabled": true,
        "command": [
          "C:\\Users\\<你>\\.local\\tools\\node\\node.exe",
          "C:\\Users\\<你>\\.config\\openchamber\\extensions\\shardx-workspace\\index.js"
        ]
      }
    }
  }
}
```

## 5. 环境变量

| 变量 | 使用方 | 作用 |
|---|---|---|
| `OPENCHAMBER_SERVICE_PORT` | 宿主 → service | 回环服务监听端口（宿主分配） |
| `OPENCHAMBER_SERVICE_TOKEN` | 宿主 → service | 所有路由的 Bearer 校验 |
| `SHARDX_WORKSPACE_STATE` | service / MCP | 覆盖共享状态文件路径 |
| `SHARDX_LAUNCHER_SETTINGS` | service / MCP | 覆盖启动器 `settings.json` 路径 |
| `SHARDX_LAUNCHER_PATH` | service | 启动器可执行文件路径提示（优先级最高） |
| `SHARDX_MIRROR_PORT` | service | 镜像 CDP 端口提示（探测顺序第一位） |
| `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` | 启动器 | 注入 `--remote-debugging-port=… --remote-allow-origins=*` |

镜像端口探测顺序：`SHARDX_MIRROR_PORT` → 用户已有参数中的端口 → `40326` → `9333` → `9222` → `9223`。

## 6. 冒烟检查

```powershell
# 扩展服务（端口与 token 从宿主日志或进程环境读取）
$h = @{ Authorization = "Bearer $env:OPENCHAMBER_SERVICE_TOKEN" }
Invoke-RestMethod "http://127.0.0.1:$env:OPENCHAMBER_SERVICE_PORT/health" -Headers $h

# 发现启动器（应返回 found/running/port/version）
Invoke-RestMethod "http://127.0.0.1:$env:OPENCHAMBER_SERVICE_PORT/shardx/discover" -Method POST -Headers $h

# 启动器状态（应带 launcherPath 与 processes）
Invoke-RestMethod "http://127.0.0.1:$env:OPENCHAMBER_SERVICE_PORT/workspace/server/status" -Headers $h
```

MCP 冒烟：

```powershell
node index.js   # 手写一行 JSON-RPC initialize 即可验证 stdio 正常
```

## 7. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 面板所有请求 401 | 宿主 token 未注入或服务不是宿主启动的 | 重新加载扩展；不要手动裸跑 service |
| `/shardx/discover` 返回 `found:false` | 启动器未安装或 `settings.json` 不存在 | 设置 `SHARDX_LAUNCHER_SETTINGS` 或安装启动器 |
| `running:false` 且不自动恢复 | 启动器路径解析失败 | 「服务器」页填一次路径；成功后会自动落盘 |
| 镜像区域空白 | 启动器未带调试端口 | 点「重启并启用镜像」；仍失败检查 40326 是否被占用 |
| 镜像点击位置偏移 | 容器尺寸与视口不一致 | 确认 `ResizeObserver` 生效；缩放窗口后重试 |
| 实例没有 CDP 端口 | 启动器窗口启动且 `extra_args` 未注入 | 「接管 N 个运行实例」或重启启动器 |
| 绑定提示已被占用 | 另一会话持有 profile 独占锁 | 在持有方释放，或选其它 profile |
| MCP 工具不出现 | OpenCode 配置未生效 | 重启 Agent 会话；检查 `index.js` 路径与 Node ≥ 22 |
| 列表拖拽无效 | 当前不是「手动排序」 | 排序下拉切回「手动顺序」，或切到具体文件夹标签 |

## 8. 回滚

```powershell
# 查看可用版本
git log --oneline --decorate

# 切回上一个提交并重新部署
git checkout <commit>
bun run build
# 重复「部署」一节的复制命令
```

共享状态文件与版本无关，回滚不需要动它。若新版本改过 state 结构，先备份：

```powershell
Copy-Item "$env:APPDATA\shardx-workspace\state.json" "$env:APPDATA\shardx-workspace\state.backup.json"
```

## 9. 文档与图鉴

`docs/MCP-TOOLS.md` 与 `docs/canvas/tool-data.js` 都由 `manifest.json` 生成，改完工具后执行：

```powershell
bun run docs:gen        # 重新生成 MCP 工具参考与图鉴数据
```

`docs/canvas/index.html` 是自包含图鉴（每页最多约 1 MB），包含 Chart.js 图、d3 关系图、mermaid 时序图、工具搜索、截图灯箱和 `localStorage` 标签记忆。它同时发布为 Canvas 工件，工件 id：

```
06GXXCJ5G4WNT2E9Z2T6K5ZTWT-shardx-workspace
```

更新步骤：先 `canvas.read` 取当前 `version`，再 `canvas.update`（`baseVersion` 必填，`directoryPath` 指向 `docs/canvas`，`entry` 为 `index.html`）。Canvas 会自动注入固定版本的 chartjs / d3 / mermaid，**不要**把 CDN 当唯一来源；HTML 里的 CDN `<script>` 只是本地直接打开时的降级。新增截图放进 `docs/canvas/assets/`，然后重跑上面的更新。图鉴内容与仓库一起提交，保证历史版本可回溯。
