# dsh-tasksuite

自研的 **DeepSeek Harness (DSH) 长任务插件集** —— 让 DSH 具备「任务分配 + 蜂窝并行 + 跨重启自动拉起续跑 + 假死(zombie)恢复」的长时程编程能力，状态层落在 AWR 账本、执行层落在 DSH agent、记忆层落在 OpenViking，用一层外层调度环把三者接起来。

这是把「AWR + DSH 长任务编程工具」从方案落到**可运行插件**的公开仓库。

## 背景与设计

见 `docs/`：

- `docs/compat-research.md` —— 插件市场兼容性研判（DSH 官方/社区、MCP 目录、Claude Code/Cordis 生态），结论：**同会话续跑现成，跨重启自动拉起必须自研**；AWR-MCP 可通过 DSH 内置 `dsh-mcp-client` 零适配 bridge。
- `docs/awr-essence.md` —— AWR 0.5.0 精髓（状态外置、上下文按需编译、revision 乐观并发 + claim 排他、检查点即交接物、execution run + recovery）。
- `docs/combined-solution.md` —— 三层一环总体方案。

## 插件清单（plugins/）

| 插件 | 平台 | 角色 | 是否可省 |
| --- | --- | --- | --- |
| `awr-goal-supervisor` | Host | **外层调度环 + 心跳 + 假死(zombie)恢复 + 跨重启真正拉起(recovery-driver)**。监听 `agent/session-start` / `agent/pre-step` / `agent/turn-stopping` / `agent/error`：刷新心跳、维护**持久化会话台账**、在新会话启动时对 AWR 账本 reconcile；内部 watchdog 检测心跳超时并打 FAKE-DEATH 标记；宿主重启后对「上次活跃、当前不在 live registry、且 AWR 仍有未完成 work」的会话**真正调用 `ctx.agents.resume` 拉起来**（非只打标记）。 | **核心，不可省** |
| `awr-tasksuite/awr-tools` | Host | 克制版只读 Tool 封装（`awr_status` / `awr_ready` / `awr_work_show` / `awr_session_show`），把 AWR CLI 暴露给模型。 | 可选 |
| `awr-task-board` | Host + Client | GUI 任务看板（Client Slot + Host RPC `awr-status`）。 | 可选 |

### 假死(zombie)恢复 —— 用户重点关切

「假死」= 进程还活着、但 agent 停滞不再推进（模型调用挂起 / turn 卡死 / 未来 step 永不 resolve），且没有任何 tool 在运行。

`awr-goal-supervisor` 的处理：

1. **心跳**：每个 step 开始（`agent/pre-step`）和安全边界（`agent/turn-stopping`）刷新 `lastHeartbeat`，并把该会话写入**持久化台账**（`workdir/.dsh-tasksuite/sessions-ledger.json`，跨重启留存其 `lastSeen`）。
2. **watchdog**：fiber 内 `timer.interval` 每 `heartbeatMs` 检查一次，若 `now - lastHeartbeat > stalenessMs`，判定假死，输出 FAKE-DEATH 标记并跑 `awr recovery check`。
3. **跨重启真正拉起（闭环）**：进程死了由 OS 层（cron/systemd）在重启后拉起宿主。宿主首次遇到 `agent/session-start` 时执行 `reconcile()` + 自动恢复扫描 `resumeStaleSessions()`：读台账，凡「`lastSeen` 在 `resumeWindowMs` 内、当前不在 `ctx.agents.list()`（live registry）、且 `awr status` 显示仍有 continue/claimable/waiting/blocked 未完成 work」的会话，**真正调用 `ctx.agents.resume({ resumeSessionId })` 拉回来续跑**——不是只打标记，而是真正把遗留会话重新拉起（需 `session-persistence-jsonl` 已挂载，`dryRun:false` + `resume:true` 时生效）。

> 边界说明：DSH 没有任何受支持的、能在进程内部杀死一个正在飞行的 turn 的机制，所以**真正杀掉卡死进程**这一刀属于 OS 层（systemd `TimeoutStopSec` 等）；supervisor 负责**检测 + 标记 + 进程重启后用 `agents.resume` 真正把遗留/卡死会话拉回来**，形成「进程内只能检测、跨重启真正拉起」的闭环。README 的「部署建议」给出 systemd unit 示例思路。`dryRun:true` 时只打日志、不真正调用 resume，便于先观察再翻转。

## mcp/ —— AWR-MCP bridge（可选增强）

`awr-mcp` 是 AWR 官方标准 MCP server。DSH 内置 `dsh-mcp-client` 支持 stdio 与 Streamable HTTP 双传输，工具变为 `mcp__awr__*`，零适配 bridge AWR 全部工具。`mcp/README.md` 给了两种传输的配置与验证步骤。

## presets/ —— 组合样例

- `presets/tasksuite/preset.yml` + `presets/tasksuite/agent.cordis.yml`：把三个自研插件组合进一个 agent preset 的**模板**（含配置项、plane 说明）。
- `presets/tasksuite/host.cordis.yml.example`：当你想让 supervisor **进程级全局**生效时，挂进 host `cordis.yml` 的示例。

## 本地验证

```bash
# 静态 + 形状校验（不依赖 AWR CLI）
node scripts/verify-host.js

# 同上，并跑一次真实 `awr status` 证明 CLI 通路（需已装 awr）
node scripts/verify-host.js --reload-awr

# 纯语法检查
npm run check
```

**动态在-Cordis 验证**（真正的运行验证，在本机 DSH 会话内）：

1. 用 cordis_define 定义 `awr-goal-supervisor`（code.host 为 `plugins/awr-goal-supervisor/index.js` 的 trimmed body），
2. `cordis_run` 激活 → 观察 state=running、`waitingFor: []`、`provides: []`，
3. 插件日志打印 `armed. watchers: pre-step, turn-stopping, error, session-start`。

> awr-tools 的动态验证已在开发过程中通过（工具注册成功，`mcp__awr__*`/`awr_*` 可见）；awr-task-board 的 Client 半侧需要浏览器页面、且 approval disabled 时走 awaiting-approval，只能静态/形状验证 + 部署后由真实会话确认。

## 结语

- 同会话续跑：DSH 现成（dsh-goal + session）。
- 跨重启自动拉起续跑：**本仓库 `awr-goal-supervisor` 补上**（`agents.resume` 真正拉起遗留会话）。
- 假死恢复：**同上，supervisor 的 heartbeat + FAKE-DEATH 检测 + 重启后真正拉起**。
- 蜂窝并行：DSH 现成（`tool-subagent` / `-workflow` / `-ralph` + `schedule`）。
- 任务分配/状态层：AWR（claim/排他/revision）。
- 记忆层：OpenViking。

## License

MIT
