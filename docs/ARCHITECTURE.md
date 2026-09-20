# 架构：七个插件如何编织成一条可审计流水线

本文说明 `docs.md` 的设计如何在代码里落地：**共享契约是什么、每个插件负责什么、它们之间
如何在不互相 import 的前提下协作**。

## 1. 分层与依赖方向

```
                       ┌──────────────────────────────┐
                       │  dsh-orchestrator（编排层）   │  阶段序列 + 能力探测 + 回退/熔断
                       └──────────────┬───────────────┘
                                      │ 只通过 mission 状态 + 工具探测协作
   ┌──────────────┬──────────────┬────┴─────────┬──────────────┬──────────────┐
   │ dsh-role-    │ dsh-spec-    │ dsh-test-    │ dsh-quality- │ dsh-evidence-│ dsh-audit-
   │ guard        │ gate         │ design-gate  │ gate         │ gate         │ trail
   └──────┬───────┴──────┬───────┴──────┬───────┴──────┬───────┴──────┬───────┴──────┬───┘
          └──────────────┴──────────────┴──────────────┴──────────────┴──────────────┘
                                      │ 全部依赖
                              ┌───────┴────────┐
                              │  dsh-eng-core  │  MissionStore / runCommand / git / markdown
                              └────────────────┘
```

依赖方向只有一个：**插件 → dsh-eng-core**。插件之间**没有任何 import**，它们通过
`.dsh/missions/<id>/mission.json` 与各自的工具名协作。因此任意子集都能单独挂载，
少挂一个插件时流水线只是少了那道门禁，而不会崩。

## 2. 共享契约：Mission

`Mission` 是一个工作单元，也是跨插件的**唯一共享状态**：

```jsonc
{
  "id": "add-health-endpoint-20260917-150543",
  "title": "Add health endpoint",
  "status": "draft | spec-approved | implementing | verified | delivered | blocked",
  "cwd": "/path/to/workspace",
  "specPath": ".dsh/specs/<id>.md",
  "specDigest": "sha256(spec.md)",
  "spec": { "acceptanceCriteria": [{ "id": "AC-001", "text": "…" }], "fileBoundaries": ["…"],
            "negativeConstraints": ["…"], "approvedAt": 1758…, "approvedBy": "approval", "revision": 2 },
  "testDesign": { "cases": [ { "id": "TC-001", "kind": "positive", "covers": ["AC-001"], … } ],
                  "uncovered": [], "passed": true, "reviewedAt": 1758… },
  "stage": "quality-verify"
}
```

- **谁写**：spec-gate 写 `spec`；test-design-gate 写 `testDesign`；quality-gate 写 `gates/*.json`
  与门禁证据；evidence-gate 签发 `receipts/*.json` 并推进 `status`；orchestrator 写 `stages/*.json`
  与 `stage`；audit-trail 只读（它记的是工具调用，不碰 mission）。
- **怎么读**：`MissionStoreRegistry#for(cwd)` 按工作区缓存 store；每次写入都是
  read-modify-write + 原子替换，所以多个插件的多个 store 实例天然一致。
- **会话归属**：`store.bindSession(sessionId, missionId)`；子 Agent 通过自己 session header 里的
  `parentSession` 继承父会话的 mission（`resolveForAgent`），这样被派发的实现者不会因为
  “没有规格”被误拒。

## 3. 每个插件的一句话契约

| 插件 | 读 | 写 | 拒绝（fail closed）的时机 |
|---|---|---|---|
| role-guard | 角色文件、mission 的 spec | 子 Agent 的 persona/模型/工具白名单 | 角色不存在、宿主没有 `ctx.subagents` |
| spec-gate | mission | `specs/<id>.md`、`mission.spec` | 写类工具在规格未审批时被拒（`tools.guard`） |
| test-design-gate | `specs/<id>.md`（磁盘为准） | `mission.testDesign`、评审报告工件 | 覆盖度/场景/可执行性任一不达标 → `passed=false`，spec-gate 随即拒绝审批 |
| quality-gate | 宿主命令配置、mission | `gates/*.json` + 门禁证据 | 必需命令失败 = `BLOCK`：收尾被 steer 打断 |
| evidence-gate | mission、证据账本、门禁记录 | `receipts/*.json`、`mission.status` | 规格未审批 / 门禁缺失或非 PASS / 必需证据缺失 / 门禁早于最新证据（陈旧） |
| audit-trail | 所有工具调用事件 | `audit/<session>.jsonl`、快照 | 不改行为，只在越界/超大/自身目录时拒绝快照 |
| orchestrator | mission、阶段结果 | `stages/*.json`、`mission.stage/status` | 阶段所需插件未挂载 / 阶段出口门禁未通过（回退或熔断） |

## 4. 钩子与事件（全部为官方契约）

| 事件 | 模式 | 使用者 | 用途 |
|---|---|---|---|
| `tools/pre-execute` | waterfall | spec-gate（策略）、audit-trail（记录/快照） | 写操作前置拦截、审计与快照 |
| `tools/post-execute` | waterfall | quality-gate | 写后 lint 反馈回路（`block` 把失败塞回模型） |
| `tools/result` | emit | audit-trail | 结果与耗时落盘 |
| `agent/turn-stopping` | serial | quality-gate | “声称完成”边界：跑门禁，`BLOCK` 时 `agent.steer()` 阻止收尾 |
| `agent/pre-step` | waterfall | audit-trail | 学习当前 turn 号（`ToolExecution` 里没有 turn） |
| `agent/disposed` | emit | quality-gate | 清理会话级计数 |
| `ctx.tools.guard()` | 单调拒绝 | spec-gate | 任何 listener 都无法把拒绝翻回允许 |
| `ctx.tools.get()` | 查询 | orchestrator、role-guard | 能力探测 / 白名单裁剪 |
| `ctx.systemPrompt.section()` | 提示注入 | 全部 | 把契约写到模型看得见的地方 |
| `ctx.get('approval' / 'subagents' / 'subprocess')` | 服务读取 | spec-gate / role-guard / quality-gate | 人工审批、子代理、受管进程 |

## 5. 编排：阶段、门禁、回退、熔断

`orchestrate` 是唯一的推进入口，阶段默认即 `docs.md` §5 的六段：

```
spec-clarify → test-design-review → spec-approve → implement → quality-verify → delivery
```

- **进入阶段前**：探测 `requiredPlugins` 是否真的挂载（工具/服务探测），缺失就拒绝并说明要挂哪个包。
- **离开阶段前**：检查阶段出口门禁（例如 `spec-approve` 需要 `spec.approvedAt`，`quality-verify`
  需要一条晚于本阶段进入时间的 `PASS` 门禁记录，`delivery` 需要已签发回执）。
- **门禁失败**：按 `onFail` 回退到指定阶段（默认上一个），并把这次失败记入 `stages/<id>.json`。
- **迭代熔断**：同一阶段累计尝试超过 `maxAttempts` 时不再回退，mission 置为 `blocked` 并输出
  熔断报告，交给人处理。
- **断点恢复**：`mission.stage` + `stages/*.json` 就是断点，`orchestrate resume` 从那里继续。
- **条件边（路径二）**：出口策略由宿主的 `gate.verdict` 声明（`pass-only` / `pass-or-warn`），配合
  `next` / `onFail` / `maxAttempts` 就是"条件路由 + 循环 + 熔断"。
- **跨 run 经验蒸馏（§8 第四阶段）**：mission 结束自动生成复盘（返工信号 + 候选经验），
  落 `.dsh/missions/<id>/retrospective.{json,md}` 并追加到 `.dsh/retrospectives.jsonl`，
  由 agent 蒸馏成 `memory_save` 教训供下次开工召回。

## 5.1 审计后的加固（对抗式审计发现的真实漏洞与修法）

一轮"假设自己是攻击者"的审计（core/spec/role、quality/evidence、audit/orchestrator/test-design 三个方向）
找到了若干**在测试全绿的情况下依然成立**的 fail-open 路径，现已全部修掉并配了回归测试：

| 漏洞 | 影响 | 修法 |
|---|---|---|
| `.dsh/**` 写豁免 | Agent 可改写 `mission.json` 伪造 `spec.approvedAt` → 自我审批、全量放行 | 只豁免派生的 `specs/*.md`；其余台账路径一律拒绝（信任根） |
| 角色白名单清空即"无过滤" | 只读角色反而拿到父 Agent 的全部权限 | 白名单永远生效（空 = 空），并在派发前拒绝；`mode: read` 必须显式声明白名单 |
| 角色文件解析失败静默回退到内置角色 | 一个本意降权的文件变成提权 | 解析失败的角色 id 记为 broken，派发直接拒绝 |
| 验收标准表格互相串行 | 解析器把用例表当验收标准（凭空多出 AC） | `parseTable` 遇到下级标题即停；`### 测试设计` 也能识别 |
| 提交的用例行被静默丢弃 | 人工审批的工件与提交内容不一致 | `designRowCounts` 比对行数/条数，不一致直接拒绝写入 |
| 规格改版后旧评审仍可授权 | 新验收标准未经评审就放行 | `specReviewDigest` 绑定 + 改版即清空 `testDesign` |
| 门禁只跑部分命令也是 PASS | `only:['lint']` 即可交付 | `GateScope.full`；只有全量 PASS 才能交付；部分运行不清 pendingWrites |
| 证据只看"有没有" | exitCode=2 的测试行也算证据 | command/test 证据必须 exitCode=0、有命令、有输出；缺一不可 |
| 回执可跨轮复用 | 上一轮的验收给这一轮盖章 | 回执/门禁都必须晚于当前阶段进入时间；非 git 工作区显式标注"无法核对" |
| 熔断可被 resume 悄悄解除 | 反复失败后继续推进 | `blocked` 是latch：`advance`/`rerun`/`resume` 一律拒绝，只有人工 `orchestrate({action:"unblock"})` 能解除（写入 manual 证据） |
| `advance({stageId})` 可结算未进入的阶段 | 跳过阶段与其门禁 | `advance` 只能结算当前阶段；重开用 `rerun` |
| mission/session id 未校验 | `../../x` 逃逸工作区读写 | `assertSafeId` + `isInside`，逃逸即抛错 |
| 边界匹配不设仓库约束 | `**` 匹配 `../x`、`/etc/hosts` | 先判 `..`/绝对路径，再匹配边界 |
| 命令超时依赖 provider 自觉 | provider 不响应 abort 就永久挂起 | `runCommand` 自己 race 截止时间 + `terminate()`；进程组整组 kill |
| 跨会话解析到"最新 mission" | 未绑定会话能给别人的 mission 签回执 | spec/evidence/orchestrator 全部改为严格解析（显式 id → 本会话 → 委派父会话） |
| rewind 跟随符号链接 / 无条件删除 | 恢复错文件、删掉回滚点之后的新工作 | 符号链接一律跳过；创建型补偿需 digest/mtime 校验，`force` 才覆盖 |

## 5.2 配置的两层模型：profile 是上限，项目文件只能细化

一个 dsh 进程通常同时服务多个仓库（一个 Neovim、多个项目），所以"跑哪条测试命令""这个仓库要不要拦写"
必须是**按会话工作区**解析的，而不是进程级：

```
profile 的 loader 行 config           ← 宿主决策：是否启用、日志/工件路径、默认命令集
  └─ <workspace>/.dsh/<plugin-id>.json ← 仓库自己的细化（人类提交在仓库里）
```

| 插件 | 项目文件 | 可覆盖 | 不可覆盖（写了也忽略并记日志） |
|---|---|---|---|
| `dsh-quality-gate` | `.dsh/quality-gate.json` | `commands`（替换）、`limits`、`defaultTimeoutMs`、`maxOutputBytes`、`writeTools`、`turnStop`、`afterWrite` | `enabled`、`logFile`、布局 |
| `dsh-spec-gate` | `.dsh/spec-gate.json` | `enforce`、`enforceBoundaries`、`writeTools`、`shellTools`、`shellPolicy`、`boundaryExemptPaths`、`requireTestDesign`、`approval` | `enabled`、`logFile`、`rootDir`/`specsDir`/`missionsDir` |
| `dsh-evidence-gate` | `.dsh/evidence-gate.json` | `requiredEvidenceKinds`、`requireGate`、`gateSource`、`requireCleanTree`、`maxGateAgeMinutes`、`maxOutputTail` | `enabled`、`logFile`、布局、**`allowForceOverride`**（它放松的是模型能主动传的 `force`）、`prompt` |
| `dsh-test-design-gate` | `.dsh/test-design-gate.json` | `minTextLength`、`strict`、`allowDanglingCase`、`requireAllScenarios` | `enabled`、`logFile`、布局、`prompt` |
| `dsh-audit-trail` | `.dsh/audit-trail.json` | `snapshot.*`（开关/上限）、`writeTools`、`trackTools`、`ignoreTools`、`maxArgsSummary`、`maxResultTail`、`redactArgs` | `enabled`、`logFile`、`auditDir`/`rootDir`（审计轨迹的位置是部署决策）、`prompt` |

三条不变量：

1. **上限不可突破**：项目文件不能"关掉插件"或搬走工件目录；被拒的键会 warning，不会静默生效。
2. **信任根保护**：`.dsh/**` 对写类工具关闭（只有派生的 `specs/*.md` 可写），所以模型无法用 `write`
   把自己的门禁调松；`shell` 写 `.dsh/**` 由第 3 项的 shell 目标分析兜（`shellPolicy: strict` 更硬）。
3. **失败不静默**：文件损坏 → 回退 profile 配置并记日志；`commands: []` 是显式决定 → 裁决里 WARN
   并点名文件路径；两个插件的 status 工具都会显示"配置来源"。

实现落在 `dsh-eng-core/src/project-config.ts`（按 mtime+size 缓存的读取），五个插件共用同一层；
`dsh-role-guard` / `dsh-orchestrator` 目前不需要项目级配置（角色文件与阶段流水线本身就是仓库自带的工件）。

## 5.3 一个进程服务多个仓库：所有"会认错项目"的地方都要按会话解析

配置分层只是第一层。把整套东西盘一遍后，**必须按会话工作区解析**的有四类（否则会认错项目）：

| 类别 | 之前的状态 | 现在 |
|---|---|---|
| **配置** | profile 全局 | `<repo>/.dsh/<plugin-id>.json` 覆盖层（§5.2，四个插件） |
| **提示词段** | `text: () => sectionText(profileConfig)` 写死 profile | 按装配时的 `AssembleContext.scope`（= 调用方 agent）取 `header.cwd` → 渲染该仓库的生效值；取不到就回退 profile 文案，且绝不抛错 |
| **工具解析的工作区** | `header.cwd ?? process.cwd()` —— 未声明时会落到 harness 自己的目录 | 未声明 `header.cwd` 时**拒绝执行**并给出可执行提示（审计快照/证据/规格/门禁工具一致） |
| **计数与观测** | spec-gate 拦截计数进程级；status 里只能标注"进程级" | 计数按工作区记录，status 同时给出"本工作区 N 次 / 进程合计 M 次" |

仍然**故意全局**的东西（不属于"该按项目分"）：

- **日志文件**：默认写 `~/.dsh/<plugin>.log`（单文件，**行内带 `[项目目录名]`**，可 grep），
  宿主可用 host-only 的 `logFileTemplate` 改成**按项目分文件**：

  | 占位符 | 结果（`~/workspace/deepseek/dsh-project`） | 特点 |
  |---|---|---|
  | `{projectPath}` | `workspace-deepseek-dsh-project` | **完全可读**、无哈希、唯一（`$HOME` 以下路径用 `-` 连接；家目录外用全路径） |
  | `{project}` | `deepseek-dsh-project-44002d` | 更短：末两段 + 6 位短哈希，同名目录不会互串 |
  | `{basename}` | `dsh-project` | 只取目录名（同名目录会共用文件） |

  另有 `{tag}`/`{home}`。未绑定工作区的行（装配、探针等）仍写进 `logFile`，所以永远不会丢日志。
  项目文件**不能**改这两个键——否则一个仓库可以把自己的日志藏起来。
- **会话级内存态**（gate 计数、turn 归属、自动推进记账）：一个会话只属于一个工作区，按 session 键就是对的。
- **存储缓存**（`MissionStoreRegistry` 按 `rootDir`、项目配置按文件路径）：键已经是工作区粒度。
- **`role-guard` / `orchestrator`**：角色文件（`.dsh/roles/*.md`）与阶段工件（`.dsh/missions/*/stages/`）
  本身就是仓库自带的工件，天然按项目；按用户决定本轮不动它们。
- **profile 里显式写了绝对 `rootDir`/`auditDir`**：宿主主动把所有仓库的台账放到一处，这是部署选择
  （项目文件不能改布局）。

## 5.4 存量项目接入：智能在模型侧，确定性在插件侧

存量项目（代码在、规格无）进不了门禁。补法有一条容易走错的路和一条对的路：

| | 错的做法 | 现在的做法 |
|---|---|---|
| 谁读代码 | 插件用正则把仓库嚼成"证据摘要"，再一次问答交给模型 | **模型自己读**：当前 agent（`brief`）或用只读工具过滤派出的**子代理**（`draft`）拿 `read`/`grep`/`glob` 真读源码、测试、构建文件、文档 |
| 插件负责什么 | 试图"理解"代码 | **契约**（写什么、什么算可验证、用例必须有操作步骤/预期结果）、**校验**（解析、覆盖、步骤长度、占位符）、**边界**（只读子代理 + 超时 + 索引上限） |
| 失败时 | 用脚手架凑一份"看起来像规格"的东西 | **如实报错并附原始输出**，不写文件、不降级——草稿必须由读代码得出 |

```
spec_bootstrap({action:"brief"})   契约 + 只读索引（从哪看起）+ 已知缺口 → 当前 agent 自己读、自己写
spec_bootstrap({action:"draft"})   同一任务派给只读子代理（allow: read/grep/glob，无 write/edit/bash）
                                   → 父侧用与手写草稿相同的规则解析、校验、落盘
spec_bootstrap({action:"check"})   提交前自查：未覆盖的 AC、过短的步骤、未清的占位、行数与用例数不一致
        ↓
.dsh/bootstrap/<stamp>/spec-draft.md   草稿：无 digest、不建 mission、不进任何门禁、零审批效力
        ↓
spec_create → test_design_review → spec_approve    照常走门禁链
```

三条不变量：

1. **草稿不等于审批**：草稿文件不写 `mission.json`、不产生 mission、不签发任何门禁记录；
2. **只读是结构性的**：子代理的工具过滤里没有写类工具（不是靠提示词请求它别写），它也拿不到 mission，写守卫同样会拒绝；
3. **不做无根据的补全**：没有需求文档时，从代码推断的条目要标 `[推断]`，证据不足标 `[待确认]`；
   子代理回答不合格时宁可失败，也不产出"看起来完整"的假草稿。

扫描器（`dsh-eng-core/src/scan.ts`）只用来做**索引与缺口报告**（默认 4000 文件 / 单文件 256 KiB / 不跟随符号链接），
它不再充当草稿的"证据来源"。

## 5.5 按难度路由模型：声明在阶段，落实在派发

一个流水线里各步难度差别很大（澄清需求 vs 写代码），用同一个模型要么浪费要么不够。做法是**分层声明、单点落实**：

```
阶段（orchestrator）        difficulty: cheap | standard | deep，或显式 model: "provider/model"
        ↓ 解析（优先级：阶段显式 > 难度经 routing 映射 > 无）
宿主配置 routing             cheap/standard/deep → { provider, model, reasoningEffort, maxTokens }
                          例：cheap/standard → deepseek-official/deepseek-v4-flash；deep → deepseek-official/deepseek-v4-pro
        ↓ 记录 + 广播
阶段工件 route{...,source}   事后可审计"这步跑在哪个模型上"
        ↓ 阶段报告里给出确切调用（例：deepseek-official/deepseek-v4-pro）
team_delegate(role, model)  role-guard 按调用覆盖（逐字段：只换 effort 不会丢角色的模型）
        ↓
子代理 agentOptions         { provider, model, reasoningEffort, maxTokens } → 宿主 provider
```

三条边界：

1. **orchestrator 不改变会话模型**：它只能声明与广播，不能替宿主切换当前会话的模型——所以阶段报告里写的是
   应调用的确切形式，而不是"已切换"；
2. **类型错误与语义错误分开处理**：参数类型错误由工具 schema 在 `execute` 之前直接拒绝（模型立刻知道要传字符串），
   类型正确但无法成路由的值（空串、裸模型 id 但全局无 provider、非正数上限）才回落到角色路由并在结果里报告；
3. **成本可控**：宿主可 `allowModelOverride: false` 禁掉按调用覆盖，此时阶段难度只作为提示，派发沿用角色路由。

## 5.6 自主派发：进入阶段就把活交出去

默认的编排是"声明式"的：orchestrator 说清阶段任务、门禁与角色，具体谁做由模型决定（自己写或 `team_delegate`）。
`autoDispatch` 打开后变成"执行式"：**进入阶段的那一刻，orchestrator 自己派子代理**。

```
orchestrate(start|advance|rerun|resume)
        ↓ 记录阶段进入（stage artifact: state=entered）
autoDispatch 判定      阶段 autoDispatch:true/false 优先；否则看配置的 stages 列表
        ↓
权限与路由            阶段有 role 且 role-guard 提供 service → 角色的 persona/工具白名单/模型路由
        ↓             否则退回落配置 toolFilter + routing（并说明"角色服务不可用"）
subagents.start(...)  prompt = 阶段任务 + mission 上下文 + 规则（只做本阶段、不要调 orchestrate、如实汇报）
        ↓ 等待（受 timeoutMs 约束，失败/超时都只记录）
产物 + 报告            .dsh/missions/<id>/stages/<stage>-dispatch.md；工具结果里给出运行 id/stopReason/权限来源
```

四条不变量：

1. **派发不是结算**：子代理完成不写 gateState、不推进阶段；阶段门禁与 `autoAdvance` 完全不受影响；
2. **权限只来自角色**：用与 `team_delegate` 同一个解析器；未知角色 **拒绝派发**，不会退化成更宽权限；
   配置里的 `toolFilter` 只是"没有 role-guard 的部署"的兜底；
3. **失败可见且不阻断**：子代理报错/超时 → 阶段仍是 `entered`，报告写明原因，模型可自行完成该阶段；
4. **默认关闭**：`autoDispatch.enabled: false` 是默认值——唯一会自主消耗 token 的功能必须显式开启；
5. **子代理不可重入流水线**：派发时**强制从工具过滤里去掉 `orchestrate`** 并传 `maxDepth=1`。
   真机事故（2026-09-20）：子代理继承了 `orchestrate`，自己调 `orchestrate start` → 再次触发自动派发 →
   递归到深度上限，**一次阶段进入产生 ~800 个子会话**。提示词约束不算权限模型，必须结构性禁止；
6. **重复调用不放大工作量**：同一会话重复 `start` 对"正在进行的阶段"是幂等的；`resume` 按进入记录
   （`enteredAt`）判重，不会为同一次进入再派一个子代理；每次派发的产物名带 `attempt` 与 run id，不覆盖历史。

## 6. 为什么这样切分

- **一个关注点一个插件**：门禁可以单独失效（例如先只上 quality-gate），不影响其它环节。
- **确定性放在宿主**：命令、白名单、上限都在 `Config` 里；模型只能在既定轨道上行动。
- **证据优先于声明**：`mission_complete` 不读模型的“我完成了”，只读门禁记录与证据账本。
- **可回滚**：写前快照让“Agent 改坏了”变成一次 `audit_rewind`，而不是一次 git 考古。
