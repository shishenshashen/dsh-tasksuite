# 落地组合方案：以 AWR + DSH 打造不输 Claude Code 的长任务编程工具

> 目标：任务分配 + 蜂窝（并行）处理 + 连续运行超过 7 天或自动拉起续跑；对标 Claude Code。
> 原则：状态外置给 AWR，执行交给 DSH，语义记忆交给 OpenViking，自动拉起用 AWR execution/recovery + DSH 外层调度。全部通过 `awr` 记录。

---

## 1. 总体架构（三层 + 一个调度环）

```
┌─────────────────────────── OpenViking（跨会话语义记忆，ov add-memory / ov find）─┐
│                                                                                  │
└───────────────────────────────────────────────────────────────────────────────────┘
                                   ↑ 语义召回/记录
┌──────────────────────────────────────────────────────────────────────────────────┐
│   DSH（执行层：模型/UI/子代理/作业/工作流/goal/checkpoint/headless）              │
│   · 主 agent：任务分配、蜂窝扇出、收证                                          │
│   · tool-subagent / tool-workflow：并行子代理（蜂窝处理）                        │
│   · tool-jobs：后台作业（承载 awr execution run 续命）                           │
│   · goal + round-driver：会话内自动续跑                                          │
│   · session-checkpoint-policy：崩溃可恢复 checkpoint                             │
│   · client-ui-goal/jobs/subagent/workflow-run：任务/作业面板                     │
└──────────────────────────────────────────────────────────────────────────────────┘
                                   ↑ CLI / MCP / 层次化合
┌──────────────────────────────────────────────────────────────────────────────────┐
│   AWR（状态层：目标/验收/证据/检查点/会话/认领/上下文/乐观并发）                  │
│   · work-ledger.yaml + GOALS.md + PLAN.md 权威源                                 │
│   · awr session start/resume/checkpoint/end（claim、revision）                   │
│   · awr context compile（有界、省 73% 上下文）                                   │
│   · awr evidence add / work complete（验收↔证据映射）                            │
│   · awr execution run / recovery inspect（跨会话续命）                           │
│   · awr workspace publish/sync（跨机蜂窝）                                       │
└──────────────────────────────────────────────────────────────────────────────────┘
                ▲                                              │
                └── 外层调度环（自动拉起）──────────────────────┘
```

核心洞见：**AWR 是「状态」、DSH 是「执行」、OpenViking 是「记忆」——三者正交互补，组合起来补上 DSH 在「跨重启自动拉起」和「上下文不膨胀」上的短板，也补上 AWR 在「模型/UI/执行」上的空档。**

---

## 2. 四类需求如何落地

### 2.1 任务分配（Task Allocation）
- DSH 主 agent 把大目标拆成多条 `awr work create --input`（每条带 goal、acceptance、next_action、priority）；或直接向 `work-ledger.yaml` 追加（走 awr 源编辑流程 + expected-revision 防冲突）。
- 每次写操作带 `--expected-revision $REV`（上一条命令的 project_revision），多 agent 并行不互相覆盖。
- 状态一览：`awr status` / `awr ready`（可认领项 / 准备度）。

### 2.2 蜂窝并行处理（Parallel / Cell Swarm）
- 蜂窝 = 把目标切成可独立完成的 cell，并行派发。
- **DSH 侧**：tool-subagent（独立 context 子代理，durable id 可续）或 tool-workflow（JS 编排的 pipeline/parallel，跨很多 agent 并行扇出）。可 `subagent_fork` 继承父会话上下文。
- **AWR 侧**：每条 cell 是独立 work item；并行 agent `session start --claim` 前先 `session list --active` 防重复认领；`--expected-revision` 防踩踏；claim 排他。
- **跨机器**：awr workspace publish/sync 交换源+证据+handoff（对象存储）。
- **团队进阶**：team-postgres / team-access / workstreams（开发分支，适合多成员，个人路径用 SQLite）。

### 2.3 连续运行超过 7 天（或自动拉起续跑）
这是要重点设计的一环。DSH 内建 goal/round-driver 只在「同进程活 agent」里自动续跑，**进程/会话边界上不自动复活（安全设计）**。因此 7 天不中断由「状态外置 + 外层调度」解决：

1. **每轮末尾写 AWR checkpoint**：`awr session checkpoint`（或 work progress）记录精确 next-action + open-loop。保存成功推进 revision，是恢复的唯一事实点。
2. **恢复不靠模型记忆**：中断/轮次耗尽/进程重启 → 外层从上次 checkpoint 拿 next-action + `awr context compile` 出有界上下文 → 交给新 agent 继续。
3. **外层调度环拉起来**（推荐组合）：
   - **AWR execution run + recovery（首选）**：把「一轮工作」放进独立 supervisor 续命；异常/结束由 AWR 记账；外部轮询 `recovery inspect` 拿到可恢复的 checkpoint → `session resume --from-session <last>` → 继续。命令退出也不杀 supervisor，天然跨 crash 存活。
   - **dsh headless + cron/systemd**：每轮结束由 cron/systemd 重新拉起一次 headless，命令带 AWR 会话 id，headless 内 resume 续跑。适合无 UI 守护场景。
   - **schedule + live root agent**：schedule 设提醒，常驻 root agent 空闲时把「继续目标」当新消息注入、重新武装 goal。适合有人在线盯。
   - **prompt 注入（自动注入语言拉起）**：在 soul preset 指令里固化——「长任务中断/轮次到/checkpoint 可恢复时，自动发起 update_goal resume + awr session resume，并把下一步作为新消息注入」。这是把「语言拉起」固化进 persona 的最轻量手段。
4. **上下文不膨胀**：靠 AWR context compile（有界、硬事实不截断），7 天会话不会因上下文塞不下而死。

### 2.4 任务管理面板（可视化）
- DSH 已有 **client-ui-goal**（目标卡片）、**client-ui-jobs**（后台作业面板）、**client-ui-subagent**（子代理卡片）、**client-ui-workflow-run**（工作流运行）。
- **新增缺口**：把 AWR work item 挂上 UI 的「任务看板」。落地方向（Client Slot 插件，用 cordis_define）：侧边栏渲染 `awr status`/`work show` 的 P0/P1 优先级 + readiness + 阻塞 + next-action，并可一键 `session resume`。
- 每个想要命名的插件见 §5。

---

## 3. 推荐的「分层 + 一个调度环」落地实现

### 3.1 首选实现（AWR execution run + recovery）
```
每轮:
  1. 主 agent 用 awr 认领: session start --work W --claim --expected-revision $REV
  2. 编译上下文: awr context compile --session S --work W
  3. DSH 蜂窝扇出: tool-workflow/tool-subagent 并行子代理
  4. 每轮末尾: awr session checkpoint  (精确 next-action + open-loop)
  5. 若有新进展: awr work progress / evidence add
  6. 收证并 complete: awr evidence add + awr work complete W --session S

外层调度环(Cron / always-on agent):
  while 目标未完成:
    -- 检测中断/轮次耗尽/进程退出 --
    next = awr recovery inspect --session <last>   # 只读,拿可恢复 checkpoint
    if next.workable:
        awr session resume --from-session <last>
        continue                                    # 新 agent 继承 checkpoint 继续
    else:
        # 没有可恢复点 = 真正阻塞,如实上报
        break
```

### 3.2 说明：为什么不是纯 DSH / 纯 AWR
- 纯 DSH：执行原语齐全，但 goal 不能跨重启自动复活、jobs 非持久、上下文靠会话累积——撑不起 7 天。
- 纯 AWR：状态/恢复/并发完美，但没有模型/UI/执行——是「地基」不是「房子」。
- **两者组合**才是「状态外置 + 执行补齐 + 记忆持久」。

---

## 4. 与 Claude Code 的能力对照

| 能力 | Claude Code | AWR + DSH 组合 |
|---|---|---|
| 恢复续跑 | continue/--resume（靠会话记忆） | session resume / recovery inspect（靠状态,不靠记忆） |
| 项目记忆 | CLAUDE.md（自由文本） | AWR 源+索引+证据（结构化,可查询） |
| 任务计划 | todos 工具（会话内） | work item + ledger（跨会话/+优先级/阻塞） |
| 并行子代理 | subagents | tool-subagent / workflow 蜂窝 |
| 上下文 | 会话累积+compaction | context compile（有界,省 73%） |
| 并发一致性 | 无显式记账 | revision 乐观并发 + claim 排他 |
| 跨机协作 | 无/受限 | awr workspace publish/sync |
| 超长(>7天) | 依赖人工反复 resume | execution run + 外层调度环自动拉起 |

结论：在「结构性、一致性、可恢复、跨机、超长自动拉起」上，AWR+DSH 组合可做到不输乃至强于 Claude Code；付出的代价是 AWR 台账/expected-revision 的维护纪律。

---

## 5. 若要落地为 DSH 动态插件（当前阶段为方案，未写代码）

| 插件 | 位置 | 作用 |
|---|---|---|
| awr-goal-supervisor | Host | 外层调度环：定时检测 AWR recovery/status,发现可恢复 checkpoint 就自动发起 resume+goal resume（封装 AWR CLI） |
| awr-task-board | Client | 把 `awr status`/`work show` 渲染成侧边栏任务看板,一键 resume/claim |
| awr-tools | Host | 把 awr work/session/evidence 封装成 DSH model Tool（可选,先用 CLI） |

> 当前阶段仅交付方案与证据文件,未创建任何插件；若用户要继续落地,先 `cordis_inspect_list/query` 核对 exact Service/Event/契约,再用 `cordis_define` 定义、`cordis_run` 激活。

---

## 6. 结论（可召回的一句话记忆）

**用 AWR 当「状态层」（目标/验收/证据/检查点/上下文/乐观并发），DSH 当「执行层」（子代理蜂窝并行 + jobs/workflow + goal 续跑 + checkpoint 持久 + UI 面板），OpenViking 当「语义记忆层」，再用「AWR execution run + recovery 外层调度环」做跨重启自动拉起——组合起来即是一个不输 Claude Code、能连续运行超过 7 天或任意异常自动续跑的长任务编程工具。**
