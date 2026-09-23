# AWR（agent-work-runtime）项目精髓调研报告

> 调研对象：GitHub https://github.com/originoneai/agent-work-runtime · npm `@originoneai/agent-work-runtime`（0.4.0/0.5.0）
> 来源：仓库原生文档（各条目内注 URL）+ 本地源码 checkout（/home/wdf-pai/kf/src/agent-work-runtime）。

## 1. AWR 是什么 / 解决什么问题

一句话：让 coding agent「换会话/换机器/进程重启后仍能接着项目干」，不必重读全部项目历史。

官方定位：*"Persistent project state and focused context for coding agents. A new chat should be able to find the current goal, unfinished work, constraints and next action without rereading the entire project history."*

```
项目源文件 → AWR 索引与检查点 → 当前任务上下文(Bounded) → Coding Agent
    ↑                                              │
    └──────── 经审查的修改与进度记录 ────────────────┘
```

解决问题域（README.zh-CN）：
1. 减少重复阅读：公共基准（150 合成任务）全量读取 18,955 tokens，AWR 最大单任务上下文仅 4,998（省 73.6%），676/676 必要事实通过；编译 p95 108ms，本地编译、零模型调用。
2. 跨会话接续：保存检查点与未完成事项，恢复前查来源变化。
3. 接入已有项目：发现源/映射，缺结构时给 Agent 明确补建步骤（不编造业务意图）。
4. 保留权威：Markdown/YAML 仍为权威；SQLite 只存索引与运行状态；revision 拒绝过期写入。

关键定位（docs/integrations/README.md）：Host-agnostic——AWR 拥有目标/事项/认领/检查点/证据；agent 拥有模型/UI/原生会话；产品边界是共享 CLI/MCP 合同。深度生命周期自动化可选，非产品边界。

## 2. 核心概念

| 概念 | 含义 | 出处 |
|---|---|---|
| Work item + ledger | `work-ledger.yaml` 权威源，含 goal/acceptance/next_action/依赖；识别中文字段 | TAKEOVER.md |
| Session/Claim | 会话绑工作与 host 会话；claim 运行时所有权（不改 source status），TTL，同工作唯一 | session-workflow.md |
| Checkpoint | 存实际 context hash、digest、精确 next-action、所有 open-loop；成功保存推进 revision | session-workflow.md |
| Context compile | 有 token 预算的有界上下文包；硬事实绝不截断，BudgetExceeded 显式报错 | session-workflow / context-continuity |
| Evidence | 完成/验收用证据绑定（external_key/scope/locator/source_sha/command）；AWR 校验但不执行；complete 要求每验收精确映射非空证据 | TAKEOVER / awr-mcp README |
| Revision / Expected-revision | 每次写带 expected-revision；被改则 RevisionConflict/SourceStale | session-workflow |
| Recovery | `session resume --from-session` 建后继继承 checkpoint/claim；execution/recovery inspect 只读查上次 checkpoint 与子进程结果 | TAKEOVER |
| Branch | 工作分支保留替代方案/叉基线 | awr-mcp README / workstreams |
| Workspace exchange | 跨机 publish/sync 经对象存储交换源+证据+handoff；.awr/与凭据不外传；SessionStart 自动 pull 并自愈 | workspace-exchange.md |
| MCP service | `awr-mcp` stdio 或共享 Streamable HTTP（多项目多客户端、bearer 鉴权、持久会话/请求回执） | mcp-service.md |

MCP 工具全集（约 29–30，0.4.0）：读 `awr_project_status/work_ready/work_get/context_compile/search`；写 `awr_work_transition/event_append/evidence_record`；生命周期 `awr_session_start/get/list/checkpoint/claim/end/resume/wait/reply`、`awr_operation_get/recover`、`awr_source_reindex`、`awr_compaction_observe/get/defer`。

## 3. 精髓提炼——为什么适合 7 天超长任务

AWR 是**可被任何 agent 共享的一层持久工作状态层**。精髓五条：

1. **状态外置进程**：目标/验收/下一步/证据/检查点存权威源+SQLite；进程死、压缩、换模型都不影响。重生的是状态而非记忆——多次重启/断电/轮次耗尽续跑的第一前提。
2. **上下文按需编译而非累积**：每次现算有界、硬事实保证、可哈希的包；上下文不会随任务变长爆炸——7 天不会因一次会话塞不下而死。
3. **乐观并发+revision，天然支持蜂窝并行**：写带期望修订、claim 排他、branch 隔离；大目标切成多个 work item 交给多个 agent 并行互不踩踏。
4. **检查点即交接物**：context hash+digest+next-action+open-loop 完整继承给后继；中断/超时后新会话第一条指令就知道下一步。
5. **任意异常可自动拉起续跑**：execution run 独立 supervisor 续命；recovery inspect 只读查上次 checkpoint；SessionStart 自动 sync 对端并自愈。外部调度器只需：检测异常 → session resume --from-session <last> → 拿 next-action → compile → 继续。**续跑不靠恢复模型记忆，靠重现状态。**

基准（workflow.md）：30 次合成流程保持相同完成合同，工具调用省 18–27%。

## 4. 与 Claude Code 对比

Claude Code 靠 continue/--resume、CLAUDE.md 记忆、checkpoint、subagents、todos 工具、会话存储/compaction——会话/记忆中心方案，恢复依赖保留聊天记录与 CLAUDE.md 书写纪律。

AWR 强：状态显式结构化、确定性跨重启恢复；生产级并发一致（revision/claim/证据验收校验）；上下文预算受控（省 73%）；主机无关（Codex/Cursor/Grok/Kimi/Claude Code 都只读同一份状态）。

AWR 弱：不自带模型/对话/UI/执行，深度自动化可选且需宿主配合；维护有成本（每次写带 expected-revision）；官方不作模型质量/端到端账单承诺。

Claude Code 集成层级：L0 通用（`--client generic` + `host:` 前缀会话 ID）；仓库无 `docs/integrations/claude.md`；存在 `codex.md`（L2 原生钩子）、`cursor/grok/kimi`（L1 注记）。（来源：docs/integrations/README.md）

## 5. 集成与组合模式

**被 agent 调用**：本地 `awr-mcp --project`（stdio）或 `awr` CLI；共享 HTTP 服务 `awr-mcp --registry … --listen`（bearer 鉴权、工具显式带 project、写需 request_id+expected_revision、awr_operation_get/recover 处理丢响应）。L0 client bind --client generic；L2（仅 Codex）client install 自动合并 SessionStart/PreCompact/PostCompact/Stop/SessionEnd/Interrupt 钩子。

**团队协作**：
- team-postgres：协同状态放 PG（个人路径仍 SQLite）；池化/一致性读、claim/lease、work fence、execution outbox、import/restore、epoch+fencing。
- team-access：角色模板 reader/developer/maintainer/project_admin + 动作矩阵（review.decide 独立 add-on），未知默认 deny。
- workstreams：主线隔离 + 跨主线依赖、权限化读、会计——蜂窝并行/团队分工进阶维度。
- 注意：team/HTTP 多为开发分支；个人路径（SQLite+CLI/MCP）是当前正式产品。

## 6. 结合 DSH 做 7 天超长任务 / 自动拉起续跑

AWR 与 DSH 的 goal / round-driver / 后台作业 / 子代理正交互补（详见 sibling 文件 longtask-dsh-execution.md 与 longtask-combined-solution.md）：
- 任务分配：DSH 主 agent 拆多个 awr work create（带 goal+acceptance+next_action），各自可认领。
- 蜂窝并行：多个 DSH 子代理并行，claim 前 session list --active 防重复，--expected-revision 防踩踏；跨机 awr workspace publish/sync。
- 连续 >7 天：每轮末尾 session checkpoint + 精确 next-action，下轮 resume --from-session 继任而非重读全史；上下文有界；DSH 后台作业承载 execution run 续命。
- 任意异常自动拉起：round-driver 检测异常/进程重启/轮次耗尽 → recovery inspect 读上次 checkpoint → resume --from-session → 拿 next-action → compile → 交新 agent；收尾 evidence add + work complete（验收↔证据精确映射）。

## 关键来源 URL
- 主页 https://github.com/originoneai/agent-work-runtime · 中文 https://github.com/originoneai/agent-work-runtime/blob/main/README.zh-CN.md
- 接入层级 docs/integrations/README.md · L0 会话流程 docs/integrations/session-workflow.md
- TAKEOVER docs/TAKEOVER.md · 上下文连续性 docs/integrations/context-continuity.md
- 共享 MCP 服务 docs/reference/mcp-service.md · 跨机交换 docs/reference/workspace-exchange.md
- 工作流主线 docs/reference/workstreams.md · 团队权限 docs/reference/team-access.md · 团队 PG docs/reference/team-postgres.md
- Codex docs/integrations/codex.md · Cursor docs/integrations/cursor.md
- MCP 工具合同 crates/awr-mcp/README.md · 基准 docs/benchmarks/README.md · 0.4.0 发布 docs/release/0.4.0.md
- 外部参考：PyPI https://pypi.org/project/agent-work-runtime/ · Anthropic 长任务 harness https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
