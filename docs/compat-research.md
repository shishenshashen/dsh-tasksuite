# DSH 插件兼容性调研报告：能否直接/轻配置组合出「任务分配 + 蜂窝并行 + 自动拉起续跑」

> 调研人：DSH 插件兼容性研究子代理
> 目标栈：**AWR（状态层）+ DSH（执行层）+ OpenViking（记忆层）**
> 对标能力：Claude Code 级别的**任务分配 + 蜂窝并行 + 跨重启自动拉起续跑**
> 方法：联网调研（GitHub / 官方文档 / Smithery 注册表 API / 本地已装 DSH 包 README 作为 Layer 1 的一手事实），逐条给来源 URL；无法核实的项一律标注 **待核实**。
> 交付物：本文件 + 文末「来源 URL 清单」。

---

## 0. 结论性研判（先读这段）

**核心答案：现有插件可以「直接或轻配置」地覆盖 1.5 层能力，但无法完整覆盖第三层「跨重启自动拉起续跑」——这一层必须自研一个外层调度插件（supervisor），它把 AWR 的 recovery 与 DSH 的 goal 骨架串起来。**

按「任务分配 / 蜂窝并行 / 自动拉起续跑」三个能力拆解：

| 能力 | 现成可复用 | 结论 |
|---|---|---|
| 任务分配（任务拆解/状态板/认领） | **AWR（工作账本 work-ledger + 会话认领）**、DSH `todo`、MCP 目录里的 Asana/ClickUp/taskpile 类 | 基本现成，主要靠 AWR 已有，无需自研 |
| 蜂窝并行（多 agent 同时干活） | **DSH 原生三件套**：`dsh-tool-subagent(-control)`、`dsh-tool-workflow`、`dsh-tool-ralph`（+ `dsh-schedule`） | **完全现成**，天然支持蜂窝并行 |
| 自动拉起续跑（跨重启/跨会话自动复活） | goal/schedule/jobs 都**只覆盖同进程/同会话**，跨重启不自动复活 | **自研** `awr-goal-supervisor`（外层调度环：AWR checkpoint/resume + DSH 启动钩子） |

**一个决定性、可直接落地的架桥事实**（第四层调研的新发现）：

> **AWR 官方提供的是标准 MCP server（crate `awr-mcp`，基于官方 `rmcp` SDK），且同时支持 stdio 与共享 Streamable HTTP 两种传输。而 DSH 自带的 `dsh-mcp-client` 就内置了 stdio + streamable-http 两种 MCP client，工具名自动映射为 `mcp__<serverName>__<tool>`。**
> → 意味着 **`dsh-mcp-client` 可以零适配地直接 bridge 进 AWR 的全部 ~26–30 个 `awr_*` MCP 工具**，让 DSH 的任意 agent 直接调用 AWR 的状态层原语（work_checkpoint / work_resume / work_claim / session_start / recovery…）。
> → 这为此前设计的「AWR=状态层、DSH=执行层」提供了**第二种、更轻的实现路径**：不必像 AWR 官方 Codex 适配器那样做原生生命周期钩子，直接走 **AWR-MCP × DSH-MCP-client** 即可让「状态层 ↔ 执行层」互相读写。

**三个「轻配置即可用」的 MCP 目录外援**（若想不加包、秒上）：

- `heavysword1/agentcron`（Smithery 545 次使用）：持久 cron，「会话结束后 30 天内仍调度任务运行」——可充当**半自动拉起**（定时踢一脚，非异常自动复活）。
- `aislabs/ais-recorder`：**死锁开关（dead-man switch）心跳**——父进程心跳超时即判定失控，配合 supervisor 做崩溃检测。
- `omegamemory/omega-memory`（3.5k+ 次使用）/ `mem0ai`：可复用为记忆/检查点（不过本栈已有 OpenViking，纯属冗余替代）。

**自研最小集（在既有设计 longtask-combined-solution.md 基础上收敛为 3 个插件）**：

1. `awr-goal-supervisor`（**Host**，核心，唯一不可省）——外层调度环：监听 DSH agent/session-start 与 turn-stopping 扩展点，挂 AWR `session start/checkpoint/resume`；把 DSH goal 的「同会话续跑」升级为「AWR 驱动的跨重启续跑」。之所以必须自研：DSH 内置 goal 与 jobs 的自动续跑是**进程内/会话内**的，跨重启不自动复活（见 L1）。
2. `awr-task-board`（**Client**，可选，看板）——把 AWR 工作账本渲染成 DSH Client Slot 里的任务看板。
3. `awr-tools`（**Host**，可选）——若不想走 MCP 全量暴露 26+ 工具，只把 `awr work/session/evidence/context` 高频子命令包装成少量 model Tool。

> ⚠️ 关键区分：**「同会话/同进程的自动续跑」是现成的；「跨重启的自动拉起续跑」必须自研。** 下面的四层详细调研就是为了把这两句边界证据化。

---

## 1. 第一层：DSH 内置插件（一手事实，来自本机已装包的 README）

> 以下内容以**本地安装的 `@deepseek-ai/dsh` 各包 README**为一手依据（比任何二手描述可靠）。路径：
> `/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/<pkg>/README.md`

### 1.1 自动续跑（goal 族）

- **`dsh-goal`**（goal tools：`create_goal`/`update_goal`/`get_goal`）
  - 事件溯源式**同会话**目标，状态在**进程重启后不丢**（storm state survives restart），默认轮次上限 256。
  - **硬边界**：active goal 在**任何 session-start 边界被 disarm（解除武装）**，且**永远不会自行复活**；必须靠人/外部再次 `resume` 才重新武装。→ **状态持久，自动续跑不持久。**
- **`dsh-goal-round-driver`**
  - 明确「**same-session execution only**（仅同会话执行）」；**从不派生全新 agent**，**在 resume/fork/unload 之后从不自动复活**，也**不对外部异常做自动重试**。→ 它是「同一场会话内的轮次驱动器」，不是「跨重启的拉起器」。

### 1.2 蜂窝并行（原生，最现成）

- **`dsh-tool-subagent` / `dsh-tool-subagent-control`**：子代理，可并行派发多个独立子任务；后台默认，互不阻塞。→ **蜂窝并行的主力。**
- **`dsh-tool-workflow`**：把工作跨多个子代理扇出（用户显式要求 workflow/大规模多代理编排时用）。**注意**：父 turn 会**阻塞到整个 workflow settle**，无「后台启动 + 事后轮询」语义——适合**一批**蜂巢，不适合长期后台常驻。
- **`dsh-tool-ralph`**：前台、**有限轮次、带边界报告**的「fresh-agent 循环」（Ralph loop），**无进程级 resume/checkpoint/scheduler**——适合有界的多轮迭代，不属于续跑设施。
- **`dsh-schedule`**：**提醒在重启后存活**（持久化），但**投递依赖一个活的 root agent**；它做「定时踢一脚」，不做「异常自动复活」。

### 1.3 任务分配（骨架）

- **`dsh-tool-tasks` / `dsh-tool-todo`**（todo tools）：同一会话内的任务清单/看板骨架；**不是跨会话的状态层**。

### 1.4 跨进程持久执行（缺口所在，最关键的负面证据）

- **`dsh-jobs`（`dsh-jobs-local`）**：**进程内（in-process）**；README 明确指出「**jobs die with the harness process；跨重启的持久执行需要不同的后端**」。
- **`dsh-session-persistence` + `dsh-session-checkpoint-policy`**：提供**进程崩溃级别的持久性/检查点**（会话状态不丢、可从 checkpoint 恢复），但**未知结局、不自动重试**——是有「恢复能力」，不是有「自动拉起」。
- **`dsh-headless`**：**一次性、无 Host 的 runner**——官方定位就是给 **cron/systemd** 做「重启拉起器」用的。→ 可作为 supervisor 的底层执行器，但需要外层自己调度。

### 1.5 生态桥

- **`dsh-mcp-client`**：支持 **stdio + streamable-http** 两种 MCP 传输；**仅工具（tools-only）**，resources/prompts 不支持；工具名 `mcp__<serverName>__<tool>`；**任务必需型（task-required）工具会被拒**。AWR-MCP 用的是标准 tools（rmcp），能过这个过滤（详见 L3）。→ **这是 Layer 3 的直接入口。**
- **`dsh-hooks-codex` / `dsh-hooks-claude-code`**：只桥 **5 个 Codex 事件**（启动/session 类），**没有 PreCompact / PostCompact / SessionEnd**。→ 无法直接复用 AWR 面向 Codex 的「PreCompact/SessionEnd 自动写 checkpoint」语义（见 L4）；DSH 侧要自动 checkpoint 必须走**原生扩展点**（agent/session-start、agent/pre-step、agent/turn-stopping）。

**L1 小结**：并行、todo、同会话续跑、MCP 桥全现成；**「跨重启自动拉起续跑」在本层明确没有现成**，负面证据来自 `dsh-goal`（session-start 边界 disarm）与 `dsh-jobs-local`（die with process）的 README。

---

## 2. 第二层：MCP 目录（Smithery 注册表为主，其余状况说明）

> 调研现实（如实报告）：`registry.modelcontextprotocol.io`（官方）的 API 端点在本轮全部 404，无法枚举；`mcp.so` / `glama.ai` / `pulsemcp.com` 为 JS SPA，其 REST API 也 404。因此**本层的具体数字只来自可用的 Smithery registry API**（`https://registry.smithery.ai/servers?q=<query>`，返回 JSON），其余目录**只在来源清单里标注存在，具体条目待核实**。

按能力检索到的候选（均可用 `dsh-mcp-client` 作为普通 MCP server 接入，工具名 `mcp__<server>__*`）：

| 能力 | server（命名空间/作者slug） | 使用量/备注 |
|---|---|---|
| 任务管理 | `tabai/core`、`twomasc/taskpile`、`donebear` | 通用任务板 |
| 任务管理（企业） | Asana（~94 uses）、ClickUp | 需账号，重 |
| 持久 cron / 自动拉起 | **`heavysword1/agentcron`（545 uses）** | 「tasks run even when session ends, up to 30 days」→ 最接近「半自动拉起」 |
| cron 调度 | `giorgio-zamparelli/croncool`、`tickstem`、`axel-belfort/cron-parser` | 定时器 |
| 看门狗/心跳 | **`aislabs/ais-recorder`** | dead-man switch 心跳，崩溃检测 |
| 记忆/检查点 | `omegamemory/omega-memory`（3.5k+ uses）、`mem0ai` | 本栈已有 OpenViking，冗余 |
| 编排/蜂群 | `zoro/orchestrator`、`delentia/jitna-swarm`、`eidetic-works/nucleus-mcp`、`a2a/*` | 调度/多人 |
| 并行 | `parallel/tasks` | 并行任务 |
| 可检查点计算 | `alex-0qvu/sprites`（Fly.io） | 状态化 worker |

**L2 结论**：这些 catalog server **都是「单功能」辅助件**，**没有任何一个等价于 AWR 的「完整状态层」**。最佳外援组合是 `agentcron`（定时拉起）+ `ais-recorder`（崩溃心跳）+ `omega-memory`/`mem0ai`（可选记忆）。**⚠️ 待核实**：Smithery 条目是 server 作者自述，各 server 能否被 dsh-mcp-client 顺利消费、是否满足「任务必需型工具过滤」、传输方式（stdio vs http），需要逐个实测后才能下结论——本层结论是**方向性**的。

---

## 3. 第三层：AWR 的 MCP 服务（关键架桥事实）

> 来源：AWR 仓库（已改名为 **`originoneai/awr`**，默认分支 `main`，原 `originoneai/agent-work-runtime` 会 301 到新名）：
> - `docs/reference/mcp-service.md`
> - `crates/awr-mcp/README.md`
> - `docs/integrations/codex.md`

### 3.1 传输与部署

- **stdio**：`awr-mcp --project /abs/path`
- **共享 Streamable HTTP**：`awr-mcp --registry /etc/awr/service.toml --listen 127.0.0.1:8080`；客户端访问 `/mcp`，带 **`Authorization: Bearer <token>`**。
- **算子级（operator）TOML 注册表**：per-client 配置**读写项目授权（read/write project grants）**，多个 project 共享一个 HTTP 端点。
- **鉴权**：**静态 bearer token**，非 OAuth（**待核实**：后续版本是否有变化，以 `crates/awr-mcp` 最新 README 为准）。

### 3.2 工具面（与「~29–30 个 awr_* 工具」的说法吻合）

- **8 个核心**：`awr_project_status` / `awr_work_ready` / `awr_work_get` / `awr_context_compile` / `awr_work_transition` / `awr_event_append` / `awr_evidence_record` / `awr_search`
- **~12 个生命周期/续跑**：`awr_session_start/get/list/checkpoint/claim/end/resume/wait/reply`、`awr_operation_get/recover`、`awr_source_reindex`
- **HTTP 专属**：`awr_projects_list`
- **开发者**：`awr_work_prepare`、`awr_compaction_*`（部分为 dev）
- 合计 **~26–30 个**，对本轮判断足够（**确数待核实**，随版本浮动）。
- **能力声明** `AwrCapability` 自 0.3.3 起；**本机本地 AWR 为 0.5.0**，高于该线。

### 3.3 与 DSH 的接法（本报告最重要的可操作结论）

- AWR-MCP 基于**官方 `rmcp` SDK**、用的是**标准 tools**。
- **DSH 的 `dsh-mcp-client` 支持 stdio 与 streamable-http 两种 client 传输**，且工具名为 `mcp__<serverName>__<tool>`。
- → **`dsh-mcp-client` 可以直接把 AWR-MCP 作为一个 server 接进来**：stdio 时 `awr-mcp --project <abs>`；HTTP 时配端点 + bearer header。标准工具能过 `dsh-mcp-client` 的「任务必需型工具拒绝」过滤（无需 AWR 侧特殊处理）。
- npm / PyPI 均出货启动器（`packaging/npm/bin/awr-mcp.cjs` 存在），部署成本低。

**L3 结论**：**AWR 的「状态层原语」能以标准 MCP 形式被 DSH 直接消费**——这消除了此前大量手写 RPC/CLI bridge 的必要。唯一需要自研补上的仍是**「谁来定时/在重启后主动触发 DSH 去 resume AWR 会话」**这个外层调度环（即 Supervisor）。

---

## 4. 第四层：Claude Code / Codex / Cursor 的长任务续跑设计 + DSH 参考

### 4.1 标杆生态

- **`wshobson/agents`**（GitHub 大仓库）：`.cursor-plugin` 94 文件、`plugins` 1007 文件、`tools` 34、`docs`——是当前最大的一站式 agent 插件集合，可作为「现成插件覆盖续跑能力」的对照面。**是否含真正的跨重启自动拉起**：需逐一核对，**默认待核实**。
- **Claude Code 插件市场**（`docs.anthropic.com` 之 Claude Code plugin-marketplaces）：有 plugin/tool/skill 三级，但 Claude Code 的续跑主要靠**会话手动 resume + hooks（SessionStart/PreCompact/SessionEnd）**，并非进程崩溃自动复活。

### 4.2 AWR 的 L2 适配器（给 DSH 自动 checkpoint 插件当范本）

- AWR 分层：**L0**=通用 CLI/MCP；**L1**=host notes；**L2**=原生适配器。
- **Codex 适配器**（`awr client install`，`docs/integrations/codex.md`）：project-local 生命周期钩子，把**原生对话→AWR 会话**映射，在 **SessionStart（startup|resume|clear|compact）/ PreCompact / SessionEnd** 处自动写 checkpoint；**SessionEnd 是短超时的 advisory 钩子**。
- ⇒ 这是在**宿主生命周期的压缩/结束点自动 checkpoint** 的权威范式。

### 4.3 为什么 DSH 不能照搬、要自研

- DSH 自己的 `dsh-hooks-codex` / `dsh-hooks-claude-code` 只支持 **5 个 Codex 事件，没有 PreCompact / PostCompact / SessionEnd**。
- → 想复刻「压缩前/结束时自动 checkpoint」的语义，**在 DSH 上必须走原生扩展点**：`agent/session-start`、`agent/pre-step`、`agent/turn-stopping`，自己挂 AWR checkpoint/resume。
- 这条正是 `awr-goal-supervisor` 的核心逻辑，也与 `longtask-combined-solution.md` 里「AWR execution run + recovery 首选」的结论一致。

**L4 结论**：标杆生态的续跑 =「生命周期钩子 + 手动/半自动 resume」；DSH 因 hook 面窄（5 事件），必须把「自动 checkpoint + 重启拉起」做成**原生扩展点上的 supervisor 插件**，而不是依赖现有的 codex/claude-code hook 桥。

---

## 5. 自研最小集（承接 longtask-combined-solution.md）

| 插件 | 平台 | 必要 | 职责 |
|---|---|---|---|
| `awr-goal-supervisor` | Host | ✅ 唯一不可省 | 外层调度环：扩展点挂 AWR `session start/checkpoint/resume`；把「DSH 同会话 goal 续跑」升级为「AWR 驱动的跨重启续跑」（重启后由 cron/systemd + dsh-headless 拉起的 root agent 先 AWR-recovers，再 resume DSH goal） |
| `awr-task-board` | Client | 可选 | AWR 工作账本渲染为 DSH Slot 任务看板 |
| `awr-tools` | Host | 可选 | 若不想全量暴露 26+ 工具，把 `awr work/session/evidence/context` 高频子命令封装成少量 model Tool |

> 实现首选路径（因 L3 结论而新增）：**不必先写 awr-tools**，直接用 `dsh-mcp-client` 把 AWR-MCP 全量接进来（`mcp__awr__*`），先跑通端到端；`awr-tools` 只是「更克制」的替代方案。而 `awr-goal-supervisor` 无论如何都要自研。

---

## 6. 待核实清单

1. 官方 MCP 目录 `registry.modelcontextprotocol.io` 的可枚举条目（本轮 API 404；**待核实**）。
2. `mcp.so` / `glama.ai` / `pulsemcp.com` 上的具体条目（本轮 SPA API 404；**待核实**）。
3. AWR `awr-mcp` 当前确切工具总数与每个工具的参数 schema（随版本浮动；**待核实**，以 `crates/awr-mcp` 最新 README / `rmcp` 元数据为准）。
4. L2 各 Smithery server（agentcron / ais-recorder / omega-memory 等）被 `dsh-mcp-client` 实际消费时的传输方式与任务必需工具过滤是否通过（**待核实**，需实测）。
5. AWR HTTP 服务的鉴权细节当前是静态 bearer 还是已引入 OAuth（**待核实**）。
6. `wshobson/agents` 各插件是否含真正的「跨重启自动拉起」实现（需逐一核对；**待核实**）。
7. DSH 原生扩展点 `agent/session-start`、`agent/pre-step`、`agent/turn-stopping` 的**精确签名**（实现 `awr-goal-supervisor` 前用 `cordis_inspect` 查询，本报告不解执行代码，不虚构签名）。

---

## 7. 来源 URL 清单

**Layer 1（DSH，一手）**
- DSH 仓库主页：https://github.com/deepseek-ai/deepseek-harness
- DSH 本地安装（LAyer1 一手事实来源）：`/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*/README.md`（goals/goal-round-driver、tool-subagent(-control)、tool-workflow、tool-ralph、tool-jobs、jenkins-jobs / dsh-jobs-local、schedule、session-persistence、session-checkpoint-policy、headless、mcp-client、hooks-codex、hooks-claude-code、tool-tasks/todo）
- npm 包页（待核实公开可达性）：`https://www.npmjs.com/package/@deepseek-ai/dsh-goal`（及同族包）

**Layer 2（MCP 目录）**
- 官方目录（存在性，条目待核实）：https://registry.modelcontextprotocol.io/
- Smithery 注册表 API：`https://registry.smithery.ai/servers?q=<query>`
- Smithery 条目页：`https://smithery.ai/server/heavysword1/agentcron`、`/aislabs/ais-recorder`、`/omegamemory/omega-memory`、`/tabai/core`、`/twomasc/taskpile`、`/parallel/tasks`、`/alex-0qvu/sprites` 等
- 其余目录（条目待核实）：`https://mcp.so`、`https://glama.ai/mcp/servers`、`https://www.pulsemcp.com`

**Layer 3（AWR MCP，一手）**
- 仓库（新名，301 自旧名）：https://github.com/originoneai/awr
- MCP 服务文档：https://github.com/originoneai/awr/blob/main/docs/reference/mcp-service.md （raw: `https://raw.githubusercontent.com/originoneai/awr/main/docs/reference/mcp-service.md`）
- `awr-mcp` crate README：https://github.com/originoneai/awr/blob/main/crates/awr-mcp/README.md （raw: `.../crates/awr-mcp/README.md`）
- Codex L2 适配器：https://github.com/originoneai/awr/blob/main/docs/integrations/codex.md （raw: `.../docs/integrations/codex.md`）

**Layer 4（生态/标杆）**
- 插件巨仓 wshobson/agents：https://github.com/wshobson/agents
- Claude Code 插件市场文档：https://docs.anthropic.com/en/docs/claude-code/plugin-marketplaces （待核实可达）
- 本栈既有设计：`/home/wdf-pai/kf/evidence/longtask-combined-solution.md`、`longtask-awr-essence.md`、`longtask-dsh-execution.md`

---

## 8. 一句话收束

**在本栈上，「任务分配（AWR 账本）+ 蜂窝并行（DSH 三件套）」现成、「AWR↔DSH 状态互通」可用 `dsh-mcp-client` 零适配地直接 bridge AWR-MCP（stdio / streamable-http，`mcp__awr__*`）实现；唯一必须自研的是 `awr-goal-supervisor` 这个外层调度环，用来把 DSH goal/作业那种「同会话续跑」升级为「跨重启自动拉起续跑」。**
