# dsh-orchestrator

dsh 工程体系的**顶层流程编排插件**（docs.md §4）：定义“什么阶段用哪个插件”，探测插件是否挂载，
用确定性门禁管理流转，门禁失败**回退**而非跳过，反复失败则**熔断**；阶段结果落盘，支持断点恢复
与阶段重跑。插件 id `orchestrator`，包名 `dsh-orchestrator`，`inject = ['tools', 'systemPrompt']`，
唯一工具 `orchestrate`（不注册别名）。

## 1. 阶段定义与默认流水线

与 docs.md §5 完全一致（id 是契约）：`spec-clarify → test-design-review → spec-approve → implement
→ quality-verify → delivery`。

| # | 阶段 id | 任务（prompt） | requiredPlugins | 门禁 | onFail | 上限 | 角色 |
|---|---------|----------------|-----------------|------|--------|------|------|
| 1 | `spec-clarify` | 澄清需求，产出规格草稿 | `dsh-spec-gate` | 无 | —（首阶段） | 3 | — |
| 2 | `test-design-review` | 评审测试设计，确保覆盖度与可执行性 | `dsh-test-design-gate` | 进入：`mission.testDesign` 存在且评审通过 | `spec-clarify` | 3 | — |
| 3 | `spec-approve` | 审批规格（人工审批门禁） | `dsh-spec-gate` | 进入：`mission.spec.approvedAt` 存在 | `test-design-review` | 3 | — |
| 4 | `implement` | 按规格实现代码 | `dsh-role-guard` | 无 | `spec-approve` | 3 | `developer` |
| 5 | `quality-verify` | 执行质量门禁并登记证据 | `dsh-quality-gate`, `dsh-evidence-gate` | 离开：`lastGate(PASS)` 且 `checkedAt > enteredAt` | `implement` | 3 | — |
| 6 | `delivery` | 交付审计与回执 | `dsh-evidence-gate`, `dsh-audit-trail` | 离开：`readReceipts(id).length > 0` | `quality-verify` | 3 | — |

`next` 默认是下一个阶段（末阶段无 `next`，通过即交付并置 `delivered`）；`maxAttempts` 由
`defaultMaxAttempts` 填充；阶段结果写入 `.dsh/missions/<id>/stages/<stageId>.json`。

**角色只声明 `implement → developer`**：内置流水线里只有这一个角色绑定，因为只有
`packages/dsh-role-guard/roles/` 下真实存在 `developer` / `reviewer` / `qa` 三个角色文件——凭阶段 id
臆造 `qa`/`evidence` 角色等于宣告一个工作区里并不存在的角色。`autoAdvance` 默认全部关闭
（默认流水线的行为与之前完全一致）。用户自定义 `stages` 时角色**不会**按 id 继承：只有显式写出的
`role` 才会生效。

## 2. 能力探测表（docs/PLUGIN-CONVENTIONS.md §7）

阶段只有在**所有 requiredPlugins 都已挂载**时才能进入。探测只有两条确定性来源：
`ctx.tools.get(toolName, agent)`、`ctx.get(serviceName)`；探测不到即未挂载（fail closed）。

| 插件 | 探测 tool | 插件 | 探测 tool |
|---|---|---|---|
| `dsh-role-guard` | `team_delegate` | `dsh-evidence-gate` | `mission_complete` |
| `dsh-spec-gate` | `spec_create` | `dsh-audit-trail` | `audit_report` |
| `dsh-test-design-gate` | `test_design_review` | `dsh-quality-gate` | `quality_gate_run` |

`config.probes` 可按插件覆盖（`{ 'dsh-x': { tool?, service? } }`，同时给出则任一命中即算挂载；
空对象沿用内置探测）。缺插件的拒绝文本给出**插件名、探测的 tool/service**、修复方式
（加进 profile 的 `dsh.profile.bundles`）和下一步动作。

## 3. 门禁与回退语义

- **进入门禁**（spec-approve / test-design-review）：不满足 → 拒绝进入，给出缺失的确定性事实与
  产出它的工具；**不写任何阶段结果**，重试不消耗尝试次数。
- **退出门禁**（quality-verify / delivery）：不满足 → 当前阶段记 `failed`（`gateState` 为该次裁决），
  按 `onFail` 回退，目标阶段 `attempt + 1`。
- 门禁裁决只来自工件：`mission.spec.approvedAt`、`mission.testDesign`、`store.lastGate(PASS)`、
  `store.readReceipts()`。`verdict` 只是记录：`BLOCK` 强制走失败/回退路径，而 `PASS` 永远无法把
  未通过的门禁“说成”通过。
- **后继不可进入则不结算**：下一阶段插件缺失时当前阶段保持 `entered`（不会先记 `passed` 再被拦住）。

## 4. 熔断规则（迭代上限）

- 阶段尝试次数达上限（回退/重跑都算“重新进入”）后：拒绝回退/重跑，`mission.status = 'blocked'`，
  当前阶段记 `failed`，返回中文熔断报告（已尝试次数、上限、需人工查看的工件路径、恢复方式）。
  **幂等**：`blocked` 后继续 `advance` 只重复报告，不会无限循环、不增长计数。恢复：修复根因后
  `orchestrate({ action: 'rerun', stageId })`；或调整 `maxAttempts` / `defaultMaxAttempts` 后重启。

## 5. `orchestrate` 各 action

| action | 入参 | 行为 / 返回 |
|---|---|---|
| `stages` | — | 流水线清单：id、prompt、门禁、onFail、上限、角色、自动推进开关、每个插件的挂载状态+探测名 |
| `start` | `summary?`（新 mission 标题） | 建立/绑定 mission，第一阶段写 `entered` 并设 `mission.stage`；返回 prompt、所需插件、门禁现状与下一步 |
| `advance` | `stageId?`、`summary?`、`verdict?` | 探测插件 → 退出门禁 → 后继可进入才记 `passed` → 进 `next`；门禁失败按 `onFail` 回退（记 `failed`） |
| `status` | — | 流水线视图：state / attempt / 进入与完成时间 / 门禁裁决 / 角色 + 插件挂载列；末尾列出未挂载插件 |
| `rerun` | `stageId?`（默认当前阶段）、`summary?` | 重新进入该阶段（`attempt + 1`），同样受熔断约束 |
| `resume` | — | 从 `mission.stage` 的断点恢复（保留原 `attempt` 与 `enteredAt`），并说明这是恢复 |

公共参数：`missionId?`（`store.resolveForAgent(exec.agent, { explicitId, fallbackLatest: true })`：
显式 id → 本会话/委派父会话绑定 → 工作区最新 mission）与 `verdict?: PASS|WARN|BLOCK`。

## 条件边（docs.md §4 路径二）

阶段出口的策略是**宿主声明**的：

```yaml
stages:
  - id: quality-verify
    gate: { kind: 'quality-pass', verdict: 'pass-or-warn' }   # 允许带风险（WARN）交付
    onFail: implement                                          # 门禁失败时回退到哪
    next: delivery
```

- `verdict: 'pass-only'`（默认，exit 阶段）：只认 `PASS`，`WARN`/`BLOCK` 都算失败 → 按 `onFail` 回退。
- `verdict: 'pass-or-warn'`：`WARN` 放行（docs.md §3.4「只有非必需命令失败 = WARN：可以带风险交付」），
  阶段结果里会记 `gateState: WARN`，便于事后审计"这次的绿是带风险的绿"。
- `next` / `onFail` / `maxAttempts` 共同构成条件路由：正向边、回退边、迭代熔断。

### 自动推进与角色激活

docs.md §4.2 要求「自动触发下一阶段，并激活对应插件」、§4.3 要求「在进入『实现』阶段前激活
developer 角色」。两者都是**宿主声明**的，模型既不能触发也不能阻止：

```yaml
stages:
  - { id: plan, prompt: 写计划, requiredPlugins: [] }
  - id: implement
    prompt: 按规格实现代码
    requiredPlugins: [dsh-role-guard]
    role: developer            # 声明本阶段的角色（默认流水线里只有 implement → developer）
    gate: spec-approved        # 只有「有门禁」的阶段才可能被自动推进
    autoAdvance: true          # 默认 false：不写就完全维持原来的模型驱动行为
    next: quality-verify
turnStop:
  maxAutoAdvancesPerTurn: 2    # 每个 turn 内自动推进的次数上限（默认 2；0 = 关闭自动推进）
```

**触发点**：`agent/turn-stopping`（与 `dsh-quality-gate` 同一个「本轮即将收尾」边界，串行、被 await）。
命中时走的是**与 `advance` 完全相同**的代码路径（`verdict: 'PASS'`），只是发起者从模型换成了宿主。

**触发条件（全部满足才推进）**：

1. 阶段显式声明了 `autoAdvance: true`，**且**该阶段门禁不是 `none`（没有确定性事实就没有自动推进的依据）；
2. 门禁当前**已经通过**（进入型门禁看 `mission.spec.approvedAt` / `mission.testDesign`；退出型看
   `lastGate(PASS)` / `readReceipts()`）；
3. mission 绑定在**这个 agent 自己的 session** 上（`store.active(sessionId)`；绝不取「工作区最新
   mission」，委派子 agent 的收尾也不会结算父会话的阶段）；
4. 该阶段当前记录是 `entered`（已 `passed`/`failed` 的阶段不会被再结算一次），且 mission 不是 `blocked`；
5. 本阶段与**后继阶段**的 `requiredPlugins` 都已挂载——插件缺失时按老规矩「拒绝，不结算」，阶段保持
   `entered`，不消耗尝试次数。

**循环安全**：每个 turn-stopping 最多推进**一个**阶段（推进后会给模型一条 `steer` 通知，让它按新阶段
继续，而不是在一次回调里连跳多个阶段）；同一 `(missionId, stageId, attempt)` 在一个 turn 内只尝试一次；
每个 turn 的次数受 `turnStop.maxAutoAdvancesPerTurn`（默认 2）约束；预取消（signal 已 abort）的 turn 不做
任何事；自动推进失败只记日志，**绝不影响本轮收尾**。

**可观测性**：阶段结果文件（`.dsh/missions/<id>/stages/<stageId>.json`，含 `role` 与 `gateState: PASS`）、
一行 `阶段自动推进：<from> → <to>` 日志，以及给模型的 `steer` 通知
（`source: { kind: 'plugin', plugin: 'dsh-orchestrator', form: 'notice', summary: '阶段自动推进：<from> → <to>' }`）。
`orchestrate({ action: 'status' })` 的表格里有 `角色` 列，`stages` 清单里每个阶段都会打印
`角色：…` 与 `自动推进：已启用/未启用`。

**角色：声明 vs 执行（诚实说明）**：编排插件只做两件事——把角色记在 mission（`mission.roles`，已使用角色的
集合）与阶段工件上，并在阶段文本里给出**具体调用**：

> `角色：developer —— 本阶段请通过 team_delegate({ role: "developer", ... }) 派发实现（角色定义与工具白名单由 dsh-role-guard 执行）`

真正的人设与**工具白名单由 `dsh-role-guard` 执行**（`roles/*.md` + `team_delegate`），编排插件不授予任何权限，
也不校验角色是否存在（角色可以来自内置、`.dsh/roles/*.md` 或配置，那是 role-guard 的领域）：`role` 只校验
「非空字符串」，写错类型才回退默认流水线。默认流水线只绑定一个角色（`implement → developer`），因为只有
`developer` / `reviewer` / `qa` 是 role-guard 内置的角色文件。

## 熔断的解除（人工）

`blocked` 是一个 latch：`advance` / `rerun` / `resume` 都会拒绝执行，避免"反复失败照常推进"。
解除只能由人显式发起：

```
orchestrate({ action: "unblock", summary: "根因已修复，人工放行" })
```

解除动作会写一条 `manual` 证据（谁在什么时候解除了熔断），并把状态恢复为 `draft`/`spec-approved`。

## 跨 run 经验蒸馏（docs.md §8 第四阶段）

- 流水线走到最后一个阶段结束时**自动**生成复盘；也可以随时用 `orchestrate({ action: "retro" })` 生成。
- 工件：`.dsh/missions/<id>/retrospective.{json,md}`（本次返工信号 + 规则推导的候选经验），
  以及只追加的跨 run 台账 `.dsh/retrospectives.jsonl`（下次开工前可 grep 历史模式）。
- 候选经验是**提示**不是结论：工具返回的下一步会要求把真正可复用的 1–3 条用 `memory_save`
  沉淀（项目级；工具链事实才写 global），从而在下次同类任务开工时自动召回。
- **回注上下文**：`orchestrate({ action: "start" })` / `resume` 会读 `.dsh/retrospectives.jsonl`
  的最近 5 条，把"历史返工模式"（BLOCK/WARN 次数、回退次数、熔断次数、规格返工比例）附在输出里——
  这样经验是在**规划阶段**被读到的，而不是靠人记得去 grep。
返回均为中文结构化文本，**末行固定是下一步动作**。

## 6. 配置

```yaml
- id: orchestrator
  name: 'dsh-orchestrator'
  config:
    enabled: true
    logFile: '~/.dsh/orchestrator.log'
    layout: { rootDir: '.dsh', missionsDir: '.dsh/missions', specsDir: '.dsh/specs' }
    defaultMaxAttempts: 3
    # 省略 stages = 默认流水线；提供则整体替换。gate 取 none|spec-approved|test-design|
    # quality-pass|receipt，next/onFail 必须指向已知阶段，maxAttempts ≥ 1；
    # role 是非空字符串（是否存在由 dsh-role-guard 判定），autoAdvance 是布尔值。
    stages:
      - { id: spec-clarify, prompt: 澄清需求，产出规格草稿, requiredPlugins: [dsh-spec-gate],
          gate: none, maxAttempts: 3, next: test-design-review }
    probes: { dsh-quality-gate: { tool: quality_gate_run } }
    turnStop: { maxAutoAdvancesPerTurn: 2 }  # autoAdvance 阶段的每 turn 自动推进上限
    prompt: { enabled: true, order: 660 }   # systemPrompt section: eng:orchestrator
```

`stages` 严格校验（id 唯一、`next`/`onFail` 指向已知阶段、`maxAttempts` ≥1、gate 类型已知、
`role` 非空字符串、`autoAdvance` 布尔）；**校验失败则记日志并回退默认流水线**，绝不弄坏宿主会话。

## 7. 断点恢复与审计

- 阶段进入/结算都落盘在 `.dsh/missions/<id>/stages/<stageId>.json`；中断后用
  `orchestrate({ action: 'resume' })` 从 `mission.stage` 继续，恢复不重置 `attempt` / `enteredAt`，
  退出门禁的“新鲜度”判断不会被绕过。阶段重跑覆盖同名文件，历史仍可从 `evidence.jsonl`、
  `gates/`、`audit/` 追溯（工件均为 UTF-8 文本/JSON，可 diff）。
