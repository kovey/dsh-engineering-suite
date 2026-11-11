# 架构：八个插件如何编织成一条可审计流水线

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

为仓库生成配置：`bash scripts/project-config.sh --workspace <repo> --write [--spec on] [--standards on]`

`--standards on` 会按仓库实际语言写出 `.dsh/standards.json` 骨架（目标阈值 + 生成/测试代码豁免 + 禁止循环依赖）；
阈值最终仍应由人在会话里用 `standards_bootstrap` 确认后冻结。

### 5.2.1 仓库内路径的默认值：只有一个来源（布局根），且可复核

配置分层决定了"谁说了算"，路径解析决定了"东西到底在哪"。这两件事共用一个事实：
**仓库的工程台账在哪个根目录下**。

```
<workspace>/.dsh/engineering-suite/      ← 迁移后的仓库（存在即优先）
<workspace>/.dsh/                        ← 未迁移仓库（回退，行为与迁移前逐字相同）
```

`resolveLayout(cwd, options)` 是唯一实现（`dsh-eng-core/src/paths.ts`）：显式 `layout.rootDir` 优先，
其次看命名空间目录是否存在，否则回退旧根。由此得到一条硬规矩：

- **仓库内数据/配置路径的默认值必须经布局根解析**，而不是写字面量。写法只有两种：
  空串默认值 + 解析 helper（`indexDirOf` / `ledgerFileOf` / `releasesFileOf` / `outboxFileOf` /
  `planFileOf` / `adrDirOf` / `standardsFileOf` …），或直接用已解析的 `layout`（`path.join(layout.rootDir, …)`）。
  配置层里这些键的默认值是**空串**，含义就是"跟随布局根"；显式值（profile / 项目文件）永远优先。
- **仓库外（宿主侧）路径**不跟随布局根：`~/.dsh/*.log`、`~/.dsh/interaction-approvers.txt`。
  它们属于宿主机而不是仓库，把它们搬进布局根等于把宿主文件写进项目里。审批人名单尤其如此：
  它是授权数据，仓库文件绝不能提供它。
- 旧根的名字只写一次（`LEGACY_TRAIL_DIR`）。需要"以 `.dsh/` 为锚"的模式/比较时用它拼，
  不要再拼字面量。

**为什么这件事需要审计而不是测试**：两种布局都是合法的，写死的默认值不会让任何测试变红——
文件被写到读者不看的地方，报告说"未配置"，而盘上那份配置完好无损。缺陷是静默的，所以规则要写成
可执行的检查：

```
bash scripts/audit-dsh-paths.sh            # 计数 + 逐条列出
bash scripts/audit-dsh-paths.sh --quiet    # 只报计数与结论
bash scripts/audit-dsh-paths.sh --selftest # 证明分类器两个方向都认得出
```

它扫 `packages/*/src/*.ts` 与 `packages/*/cordis.patch.yml`，把剩下的 `.dsh/` 字面量分成三类：

| 类别 | 含义 | 是否允许 |
|---|---|---|
| `functional` | 代码里的路径默认值/路径常量 | **必须为 0**（否则退出码 1） |
| `host` | `~/.dsh/…`：宿主路径 | 允许，且**不得**改成布局根 |
| `text` | 注释、提示文案；其中 `scope`（`.dsh/**` 信任根排除模式——命名空间根嵌套在 `.dsh/` 之内，一个模式覆盖两种布局）与 `legacy`（`LEGACY_*` 常量，只用于报告迁移）单独标注理由 | 允许 |

patch 文件（`cordis.patch.yml`）也在这条规矩里：patch 传的是**显式配置**，而显式值永远优先于代码默认值，
所以一个钉死路径的 patch 键会让布局根解析对那个插件彻底失效——路径键不应出现在 patch 里。

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
startActivation(...)  prompt = 阶段任务 + mission 上下文 + 规则（只做本阶段、不要调 orchestrate、如实汇报）
        ↓             阶段的 persona/工具限制经 `orchestrator:<role>` preset 在子作用域强制（见下方 0.2.2-rc.1 的接法）
        ↓ 等待（受 timeoutMs 约束，失败/超时都只记录）
产物 + 报告            .dsh/missions/<id>/stages/<stage>-dispatch.md；工具结果里给出运行 id/stopReason/权限来源
```

> **0.2.2-rc.1 的接法（2026-11 修正）**：上面那行旧写法 `subagents.start(provider, request)` **已经不存在**，
> 而且 `SubagentStartRequest` 删掉了 `persona` 与 `toolFilter` 两个字段——**persona / 工具白名单不再随启动
> 请求传递**。现在的接法是 `startActivation({ provider, label, request: { prompt, parent, signal, agentOptions, agentPreset }, signal, delivery: 'caller' })`
> 加一个 **Agent Preset**：`dsh-role-guard` 为每个角色注册 `id: role:<roleId>`（`presets.ts`），`dsh-orchestrator`
> 为每个被派发的阶段角色注册 `id: orchestrator:<role>`（`presets.ts`），`dsh-impact-gate` 为它那次可选的复核子会话注册
> `id: impact-gate:review`（`review.ts`）。三者的行**都挂同一个插件**
> `dsh-eng-core/scope`；插件**运行在子作用域**，在那里 `ctx.tools.restrict({allow, deny})` 并写入
> `role-guard:persona` section。工具白名单因此仍是**宿主强制**（白名单外的工具对子代理不可见，而不是"被提示词劝阻"），
> 并且限制先于 persona 应用：`restrict` 被拒绝时子代理**启动失败**，绝不吞掉错误让它带着父 Agent 的全部工具跑起来。
> 旧宿主（只有 `start(provider, request)`）仍走旧路径，工具输出会如实写明"旧宿主 / persona、toolFilter 随启动请求传递"。
> 四个前提（`startActivation`、`agentPresets` 服务、本插件注册的角色 preset、已注册的 provider）任一不成立都 **fail closed**，
> 报错点名缺什么、该挂哪个包。**`agentPreset` 必须随请求传**：不传时子代理加入父 Agent 的 composition，角色的 preset
> 根本不会挂载（"看起来派发了，其实没强制"）。
>
> **委派只有一份实现**：`planDelegation` / `startDelegation` / `registerDelegationPreset` 都在
> `packages/dsh-eng-core/src/delegation.ts`，五个调用点（曾各自手写一份，现已收敛）只提供自己的**领域**输入（哪个 preset、什么 persona/过滤、
> 旧宿主请求里带什么）。这不是"为了少写几行"：同一个接缝被手写过**五次**（role-guard、orchestrator、impact-gate、spec-gate 的草稿子代理、
> standards-gate 的结构评审子代理），其中三处在 0.2.2-rc.1
> 上直接起不来，而它们的限制在新宿主没有任何字段可放——复制一份的代价是**每一份都能各自漂移，而测试只覆盖迁走的那一份**。
> `packages/dsh-eng-core/test/delegation-seam.test.ts` 因此扫 `packages/*/src/**`：除该模块外再出现
> `subagents.start(` 调用即失败（注释除外；`startActivation(` 不算）。
>
> **scope 插件为什么上移到 eng-core（而不是各留一份）**：这个插件是"子作用域里到底强制了什么"的唯一实现点。
> 五处用法（`role:` / `orchestrator:` / `impact-gate:` / `standards-gate:` / `spec-gate:bootstrap:<allow 指纹>`）需要的语义完全相同——
> 先 `restrict` 再 persona、缺能力只告警、空白名单直接拒绝挂载。复制一份的代价不是几十行代码，而是**两处可以各自漂移**：
> 一边修好了拒绝空白名单、另一边没有，就会有一个子代理带着父 Agent 的全部工具在跑，而测试只覆盖了修好的那一边。
> 放在 eng-core 还有一个结构上的好处：eng-core **不依赖任何插件**，所以共享它不会让任何一个插件依赖另一个插件；
> preset 行里的名字是从实现里 `import` 的常量（`dsh-eng-core/scope`），而不是手写字符串——改名不会留下"指向旧名字的行"
> （那样的行加载失败，子代理就没有限制）。

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

## 5.7 代码规范门禁（`dsh-standards-gate`）：把"可维护"变成可门禁的

其他六个门禁回答"能不能跑 / 做的对不对 / 能不能证明"，第八个回答**"还可维护吗"**。它只做**可机械判定**的部分：

```
<repo>/.dsh/standards.json            阈值 + 分层依赖规则 + 豁免（仓库所有，模型改不了：在 spec-gate 信任根内）
<repo>/.dsh/standards-baseline.json   已接受的存量违规（棘轮；放宽需人工批准）
        ↓ measureWorkspace（dsh-eng-core，确定性、有上限、不跟随符号链接）
违规清单（文件/函数行数、嵌套、if 块、参数、导出面、分层、循环依赖）
        ↓ 与基线比对
added → 门禁失败；known → 不失败；fixed → 报告"已消除"（重构的进度）
        ↓
GateRecord(source: dsh-standards-gate) → 交付侧可要求"最新一条 PASS 且不早于最新 command/test 证据"
```

四条不变量：

1. **阈值归仓库**：插件不猜阈值；缺 `standards.json` 时报"去 bootstrap"而不是"默认放行"；
2. **棘轮只紧不松**：存量违规进基线后不挡门禁，**新增**违规才挡；放宽基线走人工审批
   （`.dsh/**` 在信任根内，模型写不了）；
3. **目标阈值而非 p90**：真机实测（`golang/im` 113 个 Go 文件）p90 文件长度是 588 行——
   拿它当上限等于没有门禁。推荐**用目标值（文件 400 / 函数 80 / 嵌套 4 / if 块 20 / 参数 5）**
   + 把当前违规冻结进基线，让数字随重构下降；
4. **机械层是下限，判断层是上限**：内聚、命名、抽象是否多余判不出来 —— 由 `standards_review` 派**只读子代理**
   （`allow: [read, glob, grep]`、剔除 `orchestrate`、`maxDepth: 1`）按 rubric 评审，结论标注为"意见"，
   不写任何门禁状态；`role-guard` 的 `reviewer` 角色指向同一份 rubric。

接入路径与 `spec_bootstrap` 对称：`standards_bootstrap({ action: "measure" })` 看分布与"按目标阈值现在有多少违规"，
`freeze` 经人工批准写入规范文件，第一次 `standards_check({ accept: true, note: "存量债务" })` 冻结基线。
生成代码（`*.pb.go`、`*.gen.go`、`mocks/`）与测试文件默认豁免：对生成代码执行人类阈值只会教人忽略门禁。

### 5.7.1 同一条规范，两种入口：`standards_check` 工具与 `scripts/standards-check.sh`

`standards_check` 是给会话里的 agent 用的；质量门禁需要的是**一条命令 + 一个退出码**。两者如果各写一套
规则，迟早会给出不同结论——所以脚本不重新实现规则（也不重新实现"读规范 / 读基线 / 比较 / 计数"），
而是调用插件自己导出的同一批函数：

```
bash scripts/standards-check.sh [--quiet]
   ↓ standardsFileOf / baselineFileOf（命名空间优先）+ resolveEffectiveConfig（profile 是上限）
   ↓ loadStandards（dsh-standards-gate/dist/tools.js，与 standards_check 同一个函数）
       <布局根>/standards.json：阈值归一化 + rules 模式的合法性告警都在这里
   ↓ measureWorkspace（dsh-eng-core/dist/metrics.js）
   ↓ readBaseline / compareViolations（棘轮：added + worsened 才失败）
   ↓ applyRuleModes / enforcingViolations（observe 只测量，不计入裁决）
无新增/恶化 → 摘要一行，exit 0
有新增/恶化 → 逐条列出（最多 40 条 + "另有 N 条"），exit 1
```

脚本自己只剩"把结论变成人读的输出 + 退出码"这一件事。**不允许有第二份判定**：脚本里再拼一个
`standards` 对象、再定义一次违规键、再数一次 bucket，都是在给未来的分叉留位置。

四条刻意写死的边界：

1. **配置缺失不静默**：没有 `standards.json` 时明确指向 `standards_bootstrap`，exit 1；没有（或无法解析）
   基线时把全部违规按新增计并明说，exit 1——"无法检查"和"没有违规"必须是两个结论，缺棘轮时静默通过
   等于把仓库里所有违规合法化；
2. **`enforce: warn|off` 不作用于这条命令**：仓库自己的文件不能把质量门禁里 `required` 的命令改成
   "只报告"；要"先测量再收紧"用规则级 `observe`（见 §5.20），那条通路只报不阻断，且不会移动棘轮；
3. **只读**：脚本不写阈值、不写基线，`.dsh/**` 仍是信任根（放宽走人工审批）；
4. **判定只有一份实现**：`scripts/selftest-ops.sh` 的 C17b 用一份夹具同时跑"脚本路径"与"插件函数路径"
   （`loadStandards → measureWorkspace → readBaseline → compareViolations`，同一份 `dist`），
   断言三种计数（已接受 / 新增 / 恶化）**逐项相等**；任何一边单独改动，自检直接红并把两个值都点出来。

#### 一次真实的分叉：574 vs 568（2026-11-11）

会话里的 `standards_check` 报"基线已接受 **574**，0 新增"，同一条命令报"接受 **568**，新增 5 / 恶化 2"。
根因不是比较逻辑写错，而是**两边跑的不是同一份引擎构建**：

- 长驻的宿主进程在启动时（13:59）把 `packages/dsh-eng-core/dist/metrics.js` 读进内存；此后
  `bash scripts/verify.sh` 在 16:29 重建了 `dist`（含 `c0d9789` 的"函数区间到配对花括号"修复），
  但**插件的内存副本不会跟着变**。脚本每次是新进程，读到的就是新构建。
- 证据：用 `c0d9789` 之前的构建（`2099d7f`）重测本仓库，得到 **574** 条违规，与插件当时记录的度量
  **逐条一致**（key / actual / limit / detail 全部相同）；用 HEAD 的构建则是 **575** 条
  （新增 5 / 恶化 2 / 4 条已消除）。因此那个 574 的基线是用旧度量冻结的，它把 `askHuman` 接受成
  1803 行（到文件末尾）之类的假值也冻了进去。

由此得到两条运维规则（比代码更常被忽略）：

1. **比较两边的数字之前，先确认引擎构建相同**。插件在会话进行中被重建的 `dist` 不会热加载——
   怀疑分叉时先重启宿主，再比对；
2. **基线必须由"和当前构建一致"的进程冻结**。用旧构建 `standards_check({ accept: true })` 冻结出来的
   基线，换成新构建就会冒出成批的"新增"——那些不是新债，是旧度量看不见的债。

脚手架（`scripts/project-config.sh`）只在目标仓库根存在**可执行**的 `scripts/standards-check.sh` 时，把

```json
{ "id": "standards", "name": "结构规范（棘轮）", "command": "bash scripts/standards-check.sh --quiet", "phase": "gate", "required": true }
```

追加进该仓库的 quality-gate 配置（`id=standards` 已存在时不重复）：一条指向不存在脚本的 `required` 命令，
会让每次交付 BLOCK 在一个跑不起来的东西上，比不配置更糟。

**本仓库自己的状态**：`.dsh/engineering-suite/quality-gate.json` 属于信任根，模型写不了；本仓库已（由人）
把这条命令加进 `commands`，因此它现在真的决定交付。当前它是 exit 1（新增 5 / 恶化 2）——原因是上面的
旧构建基线还没刷新，顺序是"**先重启宿主**（让插件加载修好的引擎）→ `standards_check({ accept: true, note })`
经人工批准重冻基线（574 → 575）→ 脚本与插件同时回到 575 / 0"，而不是去改脚本或改基线绕开它。

### 5.8 需求的增/改/删：编号是地址，修订即回到规格阶段

需求不是写一次就固定的：补一条、改措辞、砍范围都要发生，而且必须和初稿走同一条链路。区别只在于
"改一条"不该被实现成"整篇重写"——重写会顺手毁掉两样东西：

- **编号**：测试用例引用的是 `AC-003`。早期实现每次重写都从 1 重新编号，于是中间插入一条，
  后面所有引用**静默指向了另一条要求**（看起来覆盖齐全，实际什么都没验）；
- **历史**：谁在什么时候把哪条要求改成了什么，是审批人要看的核心信息。

现在的规则：

| 操作 | 工具 | 不变量 |
|---|---|---|
| 增 | `spec_amend({part, action:"add", text})` | 分配新编号（`max(现存 ∪ 已作废)+1`），不打乱已有编号 |
| 改 | `spec_amend({part, action:"update", target, text})` | 编号不变（编号是地址，文本是内容） |
| 删 | `spec_amend({part, action:"remove", target})` | 编号进入 `retired`，**永不复用**；被用例引用则拒绝，除非 `cascade: true`（连同用例移除并要求重新评审） |
| 整篇重写 | `spec_create` | 按**文本**保留未变条目的编号；`retired`/`changes` 一并继承 |

任何一条路径都会 **revision + 1 且清空审批**：人批准的是上一版文档。审批文档里会渲染"变更历史"
（时间 + 类型 + 编号 + 改动前后 + 理由）与"已作废编号"，`spec_status` 也显示最近改动。
于是流程自动回到 `test_design_review` → `spec_approve`，`spec-approved` 阶段门禁重新生效——
这就是"按标准流程"在代码里的含义。

### 5.9 变更影响分析（`dsh-impact-gate`）：把"改这里会影响谁"变成事实

模型读代码猜影响面，是不可复核的。改成从**导入图**算：

```
git diff -U0（或显式 paths）→ 变更文件 + 新增行范围
      ↓ 反向传递闭包（Go 的包目录 import、TS 相对路径、Python 包）
受影响文件（按距离，带"经由谁"）+ 测试选择（changed > imports-changed > same-package > name-match）
      ↓ 风险分级（扇入 ≥8 / 影响面 ≥25 / 导出面 ≥15 → high；无测试覆盖 → high）
artifact + 证据行（kind=artifact）
```

真机校准（`golang/im`）：改 `internal/storage/mysql/repos.go` → 1522 条导入边、影响面 9 个文件、
选中 8 个测试文件（`mysql_test.go`/`config_test.go`/`test/e2e/*`/parity 测试），与 `grep` 对账一致
（grep 反而会误命中架构测试里的字符串规则表）。**它会明确写出自己看不见什么**：接口分派、依赖注入、
反射、字符串查表都不是静态可判的——最小回归集是"必要"不是"充分"。

### 5.10 测试有效性（`dsh-coverage-gate`）：覆盖率、增量覆盖率与 flaky

其他门禁问"测试过了吗"，它问"测试有用吗"：解析 lcov / cobertura / go-cover / istanbul-json，
按阈值判总分与**本次新增行**的覆盖（真机：`golang/spider` 的 `go test -coverprofile` → 205 语句 / 157 命中 = 76.6%，
增量判定把 45 行新增里的 41 行纳入判定、列出 4 行"未插桩不可判"），以及重复执行检测 flaky
（按用例名归因，runner 不报名字时如实降级为"运行级"，并按策略 BLOCK/WARN/仅报告）。
**不判**：报告没插桩的行（单独列出，绝不算 0% 或 100%）、非 git 工作区里的"增量阈值"（直接 BLOCK）、
把覆盖率当正确性。

### 5.11 供应链与密钥（`dsh-supply-chain-gate`）：能不能上生产的硬门槛

默认只扫**本次改动新增的行**（"这次改动有没有引入"），11 条规则 + 熵检测 + 仓库自有 allowlist；
清单 diff 找出新增依赖并要求**人工批准**（拒绝/无通道 → BLOCK）；宿主配置的审计命令按 argv 执行、
按 severity 阻断；孤儿锁文件变更（锁文件动了而声明没动）也 BLOCK。
严重度分级是**真机逼出来的**：初版"任何命中即阻断"在 `golang/im` 上产生 461 条命中（几乎全是文档里的 base64），
这种门禁会被立刻关掉——现在只有已知凭据形状阻断，熵检测按上下文降为建议级（复测：阻断级 0 命中）。

### 5.12 审批接缝：同一个接口，任何通道都能回答

套件里所有"需要人点头"的动作——规格审批、交付审核、规范阈值/基线放宽、新增依赖——都走**同一个接缝**
`ctx.get('approval').request(...)`。这带来一个直接结论：**接 IM 不需要改各个插件**，只需要一个应答者。

接缝的返回**在套件侧**被扩展成"旧字符串 + 可选的溯源对象"：

```
'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'          ← 唯一的线上形态（见下）
{ decision, by?, messageId?, at?, source? }                          ← 我们的容忍形态，不是线上契约
```

**实测（0.1.7-rc.1）**：harness 的 `dsh-user-approval` 声明的 `ApprovalOutcome` 就是那四个字符串，
且它的实现是 `OUTCOMES.includes(outcome) ? outcome : 'unavailable'`——应答者返回对象会被**规范化成 `unavailable`（拒绝）**。
所以：规范化函数保留对象形态只为**向前兼容**（宿主将来放宽时不用改插件），
**不能把它当成能拿到身份的通路**；`by`/`messageId` 这类溯源今天的正确落点是**通道自己的台账**
（例如 IM 插件写 `.dsh/<channel>-approvals.jsonl`），套件侧记录的是"经 approval 接缝批准"这一事实。

- **一个规范化函数**（`normalizeApprovalReply`）处理两种形态：任何无法识别的返回值一律判为 `unavailable`（fail closed）——
  从不"猜一个决定"，否则"没人回答"就会变成"已批准"；
- **溯源落在被批准的那份工件上**：规格审批写 `spec.approvedBy/approvedSource/approvalMessageId`，
  交付审批进**回执**（`receipt.approval`，且在摘要内——回执不能换个人重新签发）。`mission.approval` 保持它原本的语义
  （最后一次人工决定，含打回），不被批准记录干扰；
- **卡片字段随理由一起传**：理由里嵌一段 ```approval-context``` JSON（kind/missionId/revision/artifacts/facts/channelHints）。
  通道层可以解析成字段渲染成卡片，纯文本应答者只看 prose（`proseOf` 剥掉机器块）；
- **人工审批在确定性检查之后**：`mission_complete` 的 `requireDeliveryApproval`（默认关）只在清单全绿后才问人——
  人能批准门禁接受过的交付，不能批准门禁已经拒绝的交付；
- 没有装配审批通道而宿主又要求人工审批 → **直接失败**（fails closed），不是静默放行。

IM 侧的职责（不在本仓库）：卡片按钮不可伪造且一次性、点击者要在项目级审批人名单里、
超时返回 `cancelled` 而不是落到别的应答者、每个决定写一条含 `messageId` 的台账。

### 5.13 六阶段视图与自检入口：一个工具回答"我们在哪、缺什么"

套件按**六个阶段**组织：**规划 → 实现 → 测试 → 交互 → 交付 → 部署**。这是给人的导航，
不是新的运行时抽象——每个阶段由已有插件承担，缺口也按阶段暴露：

| 阶段 | 承担者 | 产物 | 门禁 |
|---|---|---|---|
| 规划 | spec-gate（需求/AC/边界/负面约束/增改删/**非功能预算**/里程碑/ADR）、test-design-gate、impact-gate | `specs/<id>.md`、`mission.json`、`plan.jsonl` | `spec-approved`、`test-design` |
| 实现 | role-guard（权限/模型/派发）、standards-gate、quality-gate（写后 lint）、supply-chain-gate、audit-trail | 代码、审计 JSONL、门禁记录 | `standards-pass`（可选） |
| 测试 | quality-gate（跑命令）、coverage-gate、impact-gate（最小回归集）、test-design-gate | 覆盖率/flaky 工件、证据行 | `quality-pass` |
| 交互 | interaction-gate（ask/notify/progress + 通道注册）、宿主的 approval 接缝 | 决定台账 `interaction.jsonl` | 无（它是横切的） |
| 交付 | evidence-gate、audit-trail、orchestrator（receipt 门禁） | `receipts/`、`gates/`、`evidence.jsonl` | `receipt` |
| 部署 | deploy-gate | `deploy/*-plan.json`、部署台账 | `deploy-go`、`deploy-verified` |

**自检**是这套视图的入口：`dsh-eng-core` 的 `checkWorkspace()` 产出一份报告（配置是否就绪、
缺什么、下一步的确切命令、台账规模），三种消费方式共用同一份判定——

- `scripts/doctor.sh [--json] [<workspace>]`：人/CI 入口，必需项缺失时退出码 1；
- 插件 `suite_status`：在会话里补上**运行时事实**（哪些插件挂载、当前阶段、待审批、通道能力）；
- `checkWorkspace` 直接给测试用（12 条用例覆盖每条判定与每个"说不清"的分支）。

四条设计约束：

1. **读不到就不说 ok**：配置解析失败是 `unknown`（附解析器的原话），不是通过；离线看不到的事实
   （通道可用性、当前阶段）一律 `unknown`，由插件在运行时补齐。
2. **每条发现都要给下一步**：没有确切命令的发现是抱怨，不是诊断。
3. **粒度正确**：运行时台账必须被 git 忽略（否则 `requireCleanTree` 会把"每次门禁都改动工作区"
   报成两个不同的 diff 摘要），而配置类文件（`.dsh/*.json`、`roles/`）**不能**被忽略——它们属于信任根，
   应当提交评审。目录型忽略规则要用尾斜杠查询才能匹配，文件则不能带尾斜杠（两个 bug 都是在真实仓库上抓到的）。
4. **自检不改任何东西**：无门禁记录、无文件写入、无 mission 变更——它只报告。

### 5.14 部署也是门禁（`dsh-deploy-gate`）：`deploy-go` / `deploy-verified`

交付回执回答"这套改动可以交付"，部署门禁回答"这次交付真的上去了，并且验证通过"。两个门禁种类
读同一个来源 `dsh-deploy-gate` 的记录，规则与规范门禁一致：**最新一条必须是 PASS**，且**不早于阶段进入时间**
（上一轮的部署证明不了这一轮）。同一个来源承载运行与验证两种记录，是因为"最新一条"在部署阶段就是运行记录、
在验证阶段就是验证记录——不需要第二个来源 id 去同步。

部署阶段**不进默认流水线**：多数 mission 不部署，让每次交付都被部署阶段卡住是错的；宿主按需声明阶段
（示例见插件 README 与 §5.13 的表）。

### 5.15 测试有效性进阶：变异、预算、契约、flaky 隔离

覆盖率回答"这行跑过没有"，不回答"断言会不会发现它变坏"。四个新能力各补一个盲区，且都遵守同一条纪律：
**预算与阈值由仓库自己声明，插件的职责是把"变坏"变成一次可复现的裁决。**

- **变异测试**（`coverage-gate` 的 `mutation_check`）：16 个词法操作符（关系/布尔/算术/字面量边界），
  逐个改动源码、跑一次测试命令、**无论如何都按字节还原**（含 BOM/CRLF；还原校验不过就不给裁决）。
  分类只有三种：killed（测试失败）、survived（测试通过）、**run-error**（跑不起来/超时/取消）。
  run-error **绝不算 killed**，也不进分母——得分公式 `killed ÷ (killed + survived)` 与两个数字一起打印。
  词法而非解析器，所以"语法被改坏导致构建失败"会被算成 killed：分数是套件弱点的**下界**，不是质量分。
- **指标预算**（`quality-gate` 的 `budget_check`）：测量命令耗时，或用正则从输出里取一个数（取不到 = 拒绝，绝不按 0 计），
  支持绝对上下限与 `maxRegressionPercent`（对比**历史最好值**，消息里点名那个值和它的时间）。
  第一次运行只是**记录基线**并如实说"还没有数据"——没有测量就不是通过。
  **预算有两个来源**：宿主配置（部署上限）与**规格声明**（非功能需求，随规格审批、带 `requirementIds` 追溯）。
  同 id 时宿主生效，但两个值都会被写进报告与裁决 reason（绝不静默取其一）；`requireSpecBudgets: true`（宿主键，默认关）
  让"规格声明了、这次却没验证"的预算直接拒绝交付。
- **契约冒烟**（`quality-gate` 的 `contract_check`）：按声明跑命令并逐条断言（退出码/stdout 包含与不包含/JSON 路径的
  值与类型），每条期望一行结果；**路径不存在就是失败**（点名路径），不是"跳过"。
- **flaky 隔离计划**（`impact-gate` 的 `flaky_plan`/`flaky_status`）：把不稳定测试分类为 quarantine/investigate/
  suspect-instrumentation，并且**隔离是一笔有期限的借款**——必须写 owner 与到期时间，过期即升级为"要么修、要么删"；
  隔离后长期没再出现的测试会被单独指出（那等于静默丢覆盖）。

**怎么门禁一次数据库迁移**（目标里的"迁移等预算"，用已有原语表达，不另造门禁）：

```jsonc
// .dsh/quality-gate.json
{
  "contracts": [
    { "id": "migrate-up",   "name": "迁移可执行",   "kind": "command",
      "command": "npm run migrate -- up",   "expect": { "exitCode": 0 } },
    { "id": "migrate-down", "name": "迁移可回滚",   "kind": "command",
      "command": "npm run migrate -- down", "expect": { "exitCode": 0 } },   // 回滚没验证过 = 没回滚
    { "id": "old-client",   "name": "旧客户端仍可用", "kind": "command",
      "command": "node scripts/smoke-old-client.mjs",
      "expect": { "exitCode": 0, "stdoutNotContains": ["column does not exist"] } }   // 向后兼容
  ],
  "budgets": [
    { "id": "migrate-time", "name": "迁移耗时", "metric": "durationMs",
      "command": "npm run migrate -- up", "max": 2000 }
  ]
}
```

三条约束缺一不可：**可执行**（up 退出码 0）、**可回滚**（down 退出码 0，否则"回滚"只是口号）、
**向后兼容**（旧客户端/旧数据仍能跑）。部署侧再叠一层：`deploy-gate` 的环境**没有声明
`rollbackCommands` 就不判 go**（见 §5.14），所以"迁移回滚"必须作为环境的回滚步骤被声明出来，
而不是留在某人的记忆里。

**信任模型上的一条硬约束**（P4 实现时发现并固化）：辅助裁决（预算/契约）记录门禁时用
`scope.full = false`、不清 `pendingWrites`、reason 带前缀。否则"source 撞车 + full=true"就能在没有跑过宿主命令集的情况下
授权交付——见 `KNOWN-LIMITS` 附一之十四。

### 5.16 官方能力 vs 自研：采纳边界与守卫机制

0.2.0 带来了几个与"工程治理"相邻的官方能力。评估的结论不是"用哪个"，而是**按性质分层**：

| 官方能力 | 性质 | 判定 | 理由 |
|---|---|---|---|
| `dsh-experimental-agent-team`（`agentTeams` 服务 + `spawn_teammate`/`send_message`/`team_task_*`） | **协作面**（roster + 持久邮箱 + 共享任务 DAG） | 互补，但**官方 spawn 对我们不可用**（实测） | `SpawnTeammateRequest` 只有 `{name,description,prompt,context,provider,signal}`，**无法表达** persona / 工具白名单 / 模型路由 / 深度上限（缺口在官方请求类型这一层：0.2.2-rc.1 的 `startActivation` 只接受 `agentPreset` 这一个策略入口，persona 与工具白名单必须由 preset 的行插件在子作用域里强制，官方请求连 preset id 都没有）；每个可加载角色又都必须有 persona ⇒ 任何角色的策略都表达不了。因此 `role-guard` **点名拒绝**官方路径、回落到自研 `subagents` 路径，并把官方创建出的 teammate 记为 **ungoverned**（不是"已阻止"：工具守卫只覆盖模型面的 `spawn_teammate`，插件直接调服务即可绕过——声称阻止就是假保证） |
| `dsh-experimental-auto-review`（按工具调用的 LLM 授权判断） | **概率判断**，挂在 `tools/pre-execute` **瀑布**上 | **不接管授权**（但它只收紧） | 代码级核实：它只返回 `deny` / `ask` / `cancel`，**从不返回 `allow`**——因此它能加限制、能把调用升级成"问人"，却不能放行任何东西 |
| `dsh-workspace-changes`（`workspaceChanges` 服务） | **事实源**（宿主视角的变更） | **已采纳**（`impact-gate` 的 `changeSource`，默认 `auto`） | 语义是**按轮**：turn 起止快照、靠 `workspace/changes` 事件的 `seq` 定位、无变更的轮不产生事件、记录随会话消失。采纳后处处标注来源（`workspaceChanges（会话 … 第 N 轮）` / `git` / `git（回退：<原因>）`），不可用一律回退 git 并说明原因；与 `git diff <base>` 不一致时打印 ⚠️ 交叉核对（**报告，不作为裁决**） |
| `dsh-plugin-manager` / `dsh-config-editor` | 安装与编辑 | 各司其职 | 它们负责"装上"；**"装上之后真的工作吗"**由本套件的自检与验证脚本回答 |
| `dsh-workflow-ptc` / `dsh-ptc-runtime`（`run_code`） | **新的调用来源** | 已核实守卫语义（见下） | 模型写代码调工具，必须证明它不绕过我们的拦截 |

**守卫机制是这一切成立的前提。** harness 提供两种拦截点，语义完全不同：

- `ctx.on('tools/pre-execute')` 是**瀑布**：后注册的监听者可以返回自己的决定，也就是**可以覆盖**前面的；
- `ctx.tools.guard(fn)` 是**单调守卫**：在瀑布之后运行，官方注释写明"任何守卫都可以拒绝，**但没有任何守卫能强制放行**另一个守卫拒绝的调用"。

因此本套件所有**强制性**拦截都用单调守卫：`dsh-spec-gate`（写操作前置拦截）与 `dsh-role-guard`（工具白名单）注册的是 guard；
`dsh-audit-trail` 虽然挂在瀑布上，但**原样返回 `next()` 的决定**，只旁听不改变结论。

两个直接推论：

1. **任何插件都无法放行我们拒绝的操作**：我们的强制拦截是单调守卫，官方契约原文（`dsh-tools` 的 `contracts.d.ts`）写的是
   "Because guards have no allow result, listener ordering cannot turn a denial back into permission"——
   `0.2.2-rc.1` 起措辞与实现都有变动（方法 `guardReason` 更名为 `checkGuards`），但**语义未变**：瀑布决定 allow/ask/deny，
   随后 `checkGuards` 只能加拒绝，不能把拒绝翻回许可；
2. **自动评审也只会收紧**：`dsh-experimental-auto-review` 的返回值只有 `deny` / `ask` / `cancel`（代码级核实，**从不 `allow`**），
   所以挂上它的后果是"更严 + 更多问人 + 更多 LLM 调用"，而不是"绕过门禁"。它仍然不能成为**授权依据**：一个概率判断
   可以作为附加限制，不能作为放行的理由。

**PTC（`run_code`）的守卫语义——读码 + 真机双重核实**：`0.2.2-rc.1` 起 PTC 由**工具执行器**提供（`dsh-tool-executor-ptc`），
不再是 `dsh-tools` 的一个"呈现模式"。子调用仍走同一条受守卫的管线：执行器调用 `executor.prepare(input)`，管线是
`ToolExecutionPipeline.prepare/dispatch/complete`（`dsh-tool-executor-ptc` 内 `new ToolExecutionPipeline(...)` 后
`executeToolBatch`），也就是**先过 `waterfall('tools/pre-execute')`，再过只能加拒绝的 `checkGuards`**。
（`0.2.1` 及更早的实现叫 `prepareScheduledExecution` → `prepareExecution`；那段命名已不存在，结论不变。）

真机实验（0.2.0-rc.1 + 本套件 14 个插件，隔离 `DSH_HOME`）：PTC 程序里执行 `await tools.write({ path: 'src/ptc-before-approval.mjs', … })`，
审计台账如实记下**子调用自己的两行**（`write` 的 `pre`/`result`），结果是 spec-gate 的拒绝原文：
`Error: spec-gate: 该会话没有已登记的规格（mission），写操作被拒绝。… 下一步：调用 spec_create …`，文件**未被创建**，
拒绝作为程序错误传回 PTC 程序（无法装作写成功）。

两个工程结论：

1. **不存在绕过通道**，且审计覆盖延伸到 PTC 程序内部的每一次子调用；
2. **代价是调用量**：一次 `run_code` + 一个子调用产生 4 行审计（`run_code` 与子调用各 pre/result）——治理类插件按调用计数的
   预算、门禁计数与 turn 预算都要预期这个放大系数。

**启用方式（不要误解）**：`0.2.2-rc.1` 起 `dsh-tools` 的 `mode` 配置被**删除**（`z.never()`，写它就是一个硬配置错误：
"Removed. Mount a native or PTC tool executor instead."）。要用 PTC 就**挂执行器**：`dsh-base` 的 patch 里已有
`tool-executor-ptc` 这一行，但默认 `disabled: true`，需要显式启用；`run_code` 是否可见由所挂执行器决定，而不是某个 mode 开关。

### 5.17 项目知识库（`dsh-knowledge-base`）：让"回答项目问题"有据可查

需求是"把项目的需求、实现等整理成知识库，在 dsh 里让模型回答项目相关问题"。这类需求最常见的两种失败方式是：
把答案交给模型的印象（没有依据、无法核对），或者引入一个需要网络/嵌入模型的黑盒（不可复现、不可审计）。
本套件的做法是把问题**拆成两半**：检索必须是确定性的、可引用的；回答由模型来做，但**每个论断都要带引用**。

**索引什么**（六类来源，全部来自仓库自己的文件与台账）：

| 来源 | 内容 |
|---|---|
| `spec` | `.dsh/specs/*.md`：需求、验收标准、测试设计（按写入时的原文索引） |
| `adr` | `.dsh/adr/*.md` 与索引行：决策与备选方案 |
| `trail` | 每个 mission **一条摘要**（状态/阶段/规格审批/各来源最新门禁/回执）与每条发布记录——读 store，不手解 `mission.json` |
| `plan` | `.dsh/plan.jsonl`（需求 → mission/里程碑）与 `.dsh/releases.jsonl` |
| `docs` | 仓库自己的 markdown（`README.md`、`docs/**`、根级 `*.md`） |
| `code` | 源码：每个文件带**符号表**（名称/种类/行号，来自既有提取器）+ 分块正文 |

**怎么保证确定性**：分块 id 是内容寻址（`kind:path:from-to`），**不含时间戳**——仓库不变时重建，`chunks.jsonl`
逐字节相同，只有 `manifest.json` 的 `builtAt` 会变（测试就是这么断言的）。写盘走"临时文件 + rename"，
且 **manifest 最后写**：崩溃不可能留下"与自身 postings 不匹配的分块清单"。

**怎么检索**：ASCII 词（case-fold + 最小长度）+ CJK **重叠 bigram**（`登录失败` → 登录/录失/失败）；
打分为 **BM25**（`k1 = 1.2`、`b = 0.75`、`IDF = ln(1 + (N - df + 0.5)/(df + 0.5))`），
字段加权折进词频（BM25F 风格：`tf = 3·标题 + 2·符号 + 1·正文`），另有**精确 ID 加成**，让点名
`AC-003`/`R-7`/`M-…`/`ADR-0002`/`TC-001`/`GATE-…`/`RCP-…` 的查询即使上下文措辞不同也能命中。
每条结果给出 `路径:起-止`、片段、得分，以及**命中原因**（哪些词命中了哪些字段）——审计看的不是"一个分数"。

**fail-closed 与"缺口有名字"**：索引缺失时 `kb_search` 拒绝并点名 `kb_index`；索引相对当前 git 指纹**陈旧**时
先告警（"可能漏掉最近的改动"）而不是默默回答；跳过的文件（二进制/超大/不可读/语言不支持）逐个**列名并给原因**，
不是"不存在"。索引是运行时产物（`.dsh/kb/`），因此**必须被 git 忽略**——医生与脚手架都已覆盖这个目录
（否则每次重建索引都会弄脏工作区，交付时的 `requireCleanTree` 就会报指纹不一致）。

**它不是什么**：不是嵌入检索（词法召回会漏掉同义改写）、不是聊天机器人（回答由模型基于引用组织）、
不是 git 历史（只索引上述明确的来源）、更不是决策依据——决策的依据仍是门禁记录与回执。

### 5.18 把 IM 交互嵌进流程（可选通道，未配置即不启用）

套件里"要人拍板"的地方（规格送审、部署 go/no-go、上线后验证）都通过本套件的 `interaction` 注册表提问。
`dsh-chat-interaction` v0.3.0 提供了面向其他插件的稳定契约：`ctx.get('chatInteraction').api`
（`apiVersion >= 1`；发消息 / 阻塞问答 / 通知+按钮 / 命令注册 / 入站观察，一次性 token 防重放、能力降级显式、
文件仅限工作区）。于是集成方式是**在注册表里多挂一个通道**，而不是给每个门禁写一套 IM 代码：

- 挂载条件：`api.apiVersion >= 1`。服务缺席、版本过旧、对象不完整或访问抛错，一律等于"没有 IM 通道"，`apply` 照常完成；
- `im.channel`（宿主键）三档：`auto`（默认，有则用、无则本地）、`off`（**永不触碰**该服务，逐字节等于旧行为）、
  `required`（要求必须存在，缺席则在 apply 时明确拒绝并给出安装/配置指引）——"没配就不走 IM" 是 `auto` 的默认结果，
  而不是靠调用方记得关掉；
- 通道只做路由：连接、去重、卡片、等待、按钮一次性 token 都由官方插件负责；本套件保持**自己的问题身份**（`q-<128bit>` 台账 token），
  并把 IM 的答案映射回同一个 token——**一次回答只能消费一次**，重放的点击/重复回答得到 `unknown-token`；
- **失败关闭**：`timeout` / `aborted` / `send-failed` / `channel-unsupported` / `internal` 全部映射为本套件的
  `timeout`/`cancelled`/`refused:<原因>` 并写入台账；超时**不是同意**，任何门禁都读不到"允许"；
- 出站文本仍走既有脱敏（与宿主规则取并集）。

**审批目标必须显式，`p2pChat` 绝不能当审批目标（P0）**：不传 `chatId` 时 IM 插件用 `p2pChat || activeChat` 解析目标，
而 `p2pChat` 只是"最后一条给 bot 发消息的会话"——**任何人私聊 bot 都能把审批卡改投到自己那里**，如果落账只认"按钮被按了"，
这就是一条完整的越权链。所以审批路径上目标必须是**宿主的决定**（`im.approvalChatId`），并有三层校验：

1. **目标 + 白名单**：`api.ask({ chatId: im.approvalChatId, from: 宿主审批人名单 })`。上游对不在 `from` 里的回复
   **直接忽略并继续等待**（`dist/api.js:262`），所以"谁可以回答"不是我们事后挑，而是发送时就限定；
2. **落账前校验来源**：`answer.chatId` 必须等于配置目标，`im.p2pOnly` 时 `answer.chatKind` 必须是 `p2p`——
   **缺失按"未证明"处理**（fail closed），因为"平台没报会话类型"与"这是私聊"是两件事，而群聊是审批人控制不了的房间；
3. **既有的 `approveCheck`**：名单校验照旧运行（纵深防御：卡片出现在正确会话里，也不等于回答者在名单里）。

任一层不成立都写 `refused:*`（`wrong-chat` / `not-p2p` / `approvers-missing` / `bad-target` / `no-target`）且**不算决定**：
不写决定行、不把一次性令牌换成放行。目标已配置而名单为空时**连卡片都不发**（fail closed，而不是"先发了再看谁答"）。
未配置 `im.approvalChatId` 时行为与之前逐字一致（不传 `chatId`/`from`，也不做来源校验）——"没配就不走收紧路径"是默认结果，
唯一的例外是显式开了 `im.p2pOnly` 却没有目标：那是一个无从执行的要求，直接拒绝而不是看起来收紧了。

**这个设计的要点**：IM 是**通道**，不是授权来源。授权仍然由台账 + 门禁记录 + 回执构成；换个通道改变的是"人在哪里被问"，
不改变"什么算允许"。

**宿主的审批接缝也走这条路（P1，`im.approvalVia`）**：`@deepseek-ai/dsh-user-approval` 把每一次"可以吗"派发成
`approval/request` 瀑布（`ctx.waterfall`，`lib/index.js:201`）：监听器按注册顺序执行、**返回一个值就短路**、调用 `next()`
则交给下一个，最后一个落到宿主自己的 `() => 'unavailable'`；返回值被归一化成四词 `allowed-once / rejected / cancelled /
unavailable`。所以本插件在 `approvalVia != off` 时用 **`{ prepend: true }`** 注册 `approval/request`，把一次审批请求
变成**同一条提问路径**（一次性令牌、ask outbox、决策台账、P0 的 `from` 白名单与来源校验一个不落）——
这条路径本来就是 `interaction_ask` 用的那个实现，不是第二个副本。

- **`off`（默认）**：一个监听器都不注册、不碰通道、不写台账。宿主原有的应答者（终端）照旧，逐字节等于今天。
  不可用的值（拼错等）**报告并按 `off` 处理**，绝不升格：这个键决定"谁能放行一次权限"，打字错误不该把接缝打开。
- **`fallback`**：问不了就 `next()` 交还原通道。判定标准是**"一张卡片是否可能已经发出去了"**（`AskRefusal.cardAttempted`），
  不是猜原因列表：没发过卡片（没有可用通道 / 没有审批目标 / 名单为空 / 写不进 outbox）才落回；卡片发出之后一律
  `unavailable`——**同一道问题绝不能问两遍**（先发卡再落回，就是双问）。
- **`only`**：问不了一律 `unavailable`，**不调 `next()`**。说了"只走 IM"的部署，不该在一个写这条策略的人不看的终端里被回答。
- **四词映射**：回答 `allowed-once` → `allowed-once`；回答 `rejected` → `rejected`；请求信号 abort → `cancelled`；
  其余（没有通道、超时、回答者不在名单、来源不符、会话类型未证明）→ **`unavailable`**。
  **"没有人决定"绝不会被写成 `rejected`**——那是替人说"不"，和替人说"是"一样是伪造。
- **审批比普通提问更严，不会更宽**：审批路径额外要求 `requireAllowlist`（即使宿主没把名单设为强制），
  因为审批授出的是一次权限；名单为空时**连卡片都不发**（`refused:approvers-missing`）。
- **落账可区分**：由 IM 回答的审批写 `source: "approval-request"`，并带 `userId`（谁答的）、`chatId`（答案来自哪个会话，
  即被校验过的那个）、`messageId`（哪条消息）。`interaction_status` 单独一行计数——"门禁自己的提问被回答了"和
  "模型问了句话"是两件事。
- **诚实的边界**：瀑布里**表达不出**"先问终端、终端拒绝再问 IM"——最先返回的那个监听器就赢了，所以 `prepend` 的真实含义是
  "我们先问 IM"，而不是"IM 只是兜底"。`only` 则是明确拒绝这种兜底。一个部署若需要"终端优先"，就不该开 `approvalVia`。

**可运维性（P2）：这个问题属于自检，不属于"跑到一半才发现"**：`im.approvalVia` 非 `off` 而缺少 `im.approvalChatId`、
或审批人名单为空时，**每一次**审批都会在发卡之前被拒绝（`refused:no-target` / `refused:approvers-missing`）——
这个部署看起来"审批上手机了"，实际一次决定也做不出来，而人只会在需要放行的那一刻才发现。
所以 `suite_status` 的交互段有一项 `runtime.im-approval`（必需项）：它读宿主通过 `im()` 报告的**生效**配置
（`im.approvalVia` / `im.approvalChatId` / `im.p2pOnly` 都是宿主键，仓库文件里看不到，只有插件自己知道它要做什么）
与审批人名单（P2 当时是项目级 `approversFile`；**P3.1 起改成宿主的 `im.approvers` / `im.approversFile`**，见下），把修复的两条路一起写出来：补配置，或把 `im.approvalVia` 设回 `off`。
`off`（以及根本没有 interaction 服务的默认部署）只给一行 `ok`——默认部署不该被自己的自检唠叨。
`im.p2pOnly=true` 与"上游是否在答案里报告 `chatKind`"只能是**建议**（`runtime.im-approval-p2p`，`recommended`）：
没有任何 API 声明这项上游能力，写一个探测器就等于发明事实，所以报告只写后果（每个 IM 答案都会被按"未证明"拒绝）
与两种处置（`im.p2pOnly: false`，或留在 `off`）。同一组事实在 `interaction_status` 的「IM 审批」段一处看完：
模式、目标会话（说"已配置/未配置"，不隐藏缺席）、名单人数、被忽略的回答——其中"无法观测"（没有钩子可挂）与
"没有发生"（已挂钩、0 次）用不同的词，因为混用会让"看不到"读成"没人试过"。

**白名单必须宿主所有，减法才是仓库的杠杆（P3.1）**：P1 把"审批是权限"写进了 `approveCheck`，但名单**从哪来**
那一半没被看住——`approversFile` 是项目级可覆盖键，且默认解析成仓库里的 `.dsh/interaction-approvers.txt`。
于是完整的越权链是：仓库提交一个名单文件 → 名单里写上自己的人 → 审批卡片发出去时 `from` 白名单就是他 →
落账前的 `approveCheck` 也认他。**一条提交就能给自己发权限**，而所有校验都"通过"。

所以权威被收到宿主，并且是**结构性**的，不靠约定：

- `im.approvers`（内联数组）与 `im.approversFile`（宿主侧路径，默认 `~/.dsh/interaction-approvers.txt`）在
  `im` 块里，而 `im` 整个是宿主键——项目文件写 `im` 会被拒（既有机制）。工作区相对路径也被拒：`approversFile`
  若按仓库解析，洞就原地长回来，所以"不可用"（fail closed）比"猜一个路径"正确。
- **有效名单 = (内联 ∪ 文件) − denyApprovers**，大小写不敏感去重。这里的不变量是**单调**：仓库只能从集合里
  减元素。写一个"项目名单与宿主名单取并集"的实现看起来更灵活，但并集允许加人——那正是漏洞；交集又会把
  宿主新增的人挡在外面。减法是唯一既保留仓库自治、又不改变"谁能审批"的方向。
- 因此 deny 与宿主的 deny **取并集而非替换**：替换会让项目把宿主 deny 掉的 id 放回来，等价于加人。
- 空名单在**发卡之前**就拒绝（`refused:approvers-missing`），绝不回落到仓库文件——回退会让"fail closed"变成
  "fail open 到仓库"，而这正是被修的那条链。
- **迁移必须可见**：语义静默改变是比漏洞更糟的失败模式（旧仓库会以为名单还在生效，实际每次都拒绝）。
  所以 `interaction_status` 打一条 `⚠️ 迁移` 行、`suite_status` 多一项 `runtime.im-approval-legacy-list`，
  两边都说"这个文件不再影响审批""宿主侧名单在哪""这些 id 该怎么搬"。自检读宿主名单的方式是 `im()` 报告的
  `approvers` 字段（宿主键的投影），**不是**去读仓库文件——读仓库文件会在"宿主名单为空 + 仓库还有旧名单"这个
  最危险的组合上报告一个过时的真相。

一句话概括这条边界：**允许的是宿主写下的，仓库只能划掉。** 这与 §5.20 的影子模式、各处"项目只能收紧"的规则同源，
区别在于这里收紧的对象是"谁能放行一次权限"本身。

**按工作区分配审批会话（P3.2）**：P1/P3.1 给宿主**一个**审批会话与**一份**名单，那对一个只服务一个仓库的宿主是对的，
对一个服务多个仓库的宿主就是错的——A 仓库的卡片落进为 B 配置的会话，B 的人被要求批准 A 的工作。`im.approvals` 把
"这次审批发到哪个会话、由谁回答"变成**按工作区**的宿主决定。

- **为什么仍然是宿主键**：会话决定"这张卡片出现在谁的手机上"，名单决定"谁能回答"。让仓库自己选会话，就是让它选
  自己受审的房间；让它自己选审批人，就是让它给自己发权限（P3.1 的洞）。所以两个新键（`im.approvals`、
  `im.unmappedWorkspace`）都在 `im` 块里，项目文件写 `im` 一律被拒并记一条说明危害的问题；仓库唯一的杠杆仍是
  `denyApprovers` 这个减法——**映射项尤其不能取消它**：命中项声明了 `approvers` 时，有效名单 =
  该条名单 − denyApprovers，项目划掉的人不会因为换了会话又回来。
- **解析必须用 realpath**：会话可以从符号链接启动（`~/work/app` → `/Volumes/src/app`），而映射按真实路径写。
  拿原始字符串比较会得到"同一个仓库两个名字、两条都不匹配"——这正是本阶段要消灭的失败模式。所以先把**调用工作区**
  解析成真实路径（普通绝对路径条目也一并 realpath，链接写在条目侧同样能命中），再比较；解析不出来的工作区
  **匹配不到任何条目，并把这件事说出来**（"未解析的路径不参与匹配"），绝不用未解析的字符串凑一个匹配。
- **最具体者胜，怎么算具体**：普通路径按**路径边界**做前缀匹配（`/a` 命中 `/a` 与 `/a/b`，不命中 `/ab`）；
  条目可以用 `*`（恰好一段）与 `**`（任意深度，含零段），其余字符一律按字面处理（路径里合法出现 `?`/`[`，
  把它们当通配符是个更坏的意外）。排序键是**两段**：先比**字面前缀**（第一个通配符之前的字面文本，去掉尾斜杠；
  越长越具体），再比**通配符个数**（越少越具体；`**` 记两个，因为它比 `*` 更宽）。于是
  `/a/b` > `/a/**`（前缀更长）、`/a/*` > `/a/**`（通配更少）、`/w` > `/w/*`（前缀相同、通配更少——
  所以"给某个子目录单独分会话"要写那个子目录的**完整路径**，而不是靠 `*` 比通配数）。
- **同分就是拒绝，不是随机挑**：两条条目具体度完全相同却又都命中时，"这次审批属于哪个会话"没有答案。
  系统拒绝（`refused:ambiguous-workspace-mapping`）并**点名两条**（`im.approvals[i]` + 工作区键 + 掩码会话）：
  随机挑一条等于把卡片发到别人的会话里，而且没人会知道发生过。这条规则与"门禁不猜、不默认放行"同源。
- **未命中按策略，且策略必须写下来**：`im.unmappedWorkspace` 默认 `refuse`——未映射的工作区在**发卡之前**就被拒绝
  （`refused:no-workspace-mapping`），信息里给出工作区（原样 + realpath）、已声明条目数与一条可以直接抄的
  `{ workspace, chatId }`；`host-default` 则是宿主明确写下的"未映射就用 `im.approvalChatId` + 宿主名单"，
  状态行会说"这是策略允许的回落，不是映射命中的结果"。默认值必须是 `refuse`：漏加一条映射的代价是一次能自己
  开口的拒绝，而发错人的审批收不回来。
- **"没声明映射"不等于"工作区未映射"**：`im.approvals` 为空（默认）时功能未启用，行为与 P1 逐字一致；
  只有"声明了映射"（`declared > 0`，**包含被校验刷掉的坏条目**）才进入上面这条判定链。区别很重要：
  前者是默认值，前者不能拒绝任何东西；后者是一个拼错的条目**不该**悄悄退化成"等于没配"。
- **可见性**：`interaction_status` 的「工作区映射（im.approvals）」一行显示命中的是哪条（工作区键、会话掩码、
  审批人数、是否回落到宿主名单）或"未命中 + 策略 + 后果"或"歧义 + 两条候选"；「IM 审批目标」一行改为显示**生效**目标
  （来自映射时注明来源）。`im()` 报告新增按工作区解析的 `workspaceMapping`，于是 `suite_status` 能在**必需项**
  `runtime.im-approval-workspace` 上说"这个工作区有没有审批会话"：映射在用 + 未命中 + `refuse` ⇒ 必需失败
  （点名 `im.approvals`、一条具体条目、以及另外两条出路：`host-default` 或 `approvalVia: off`）；歧义同为必需失败；
  `host-default` 是**建议项**（写下来的策略不是遗漏）。映射未启用、`approvalVia=off`、或服务不报告映射时
  **不产出该项**：默认部署不该被唠叨，"读不到"也不能被写成某个状态。
- **诚实的边界**：映射的粒度是**工作区目录**，表达不了"同一个仓库的两个分支用不同会话"（分支不是目录）——
  那需要项目侧配置，而项目侧配置正是这里拒绝的（见 `docs/KNOWN-LIMITS.md`）。另外 `**` 不做 realpath：
  模式没有真实路径，符号链接写在**模式前缀**里不会被解析（写在普通路径条目里会）。

### 5.19 授权前史：Mandate v2（准入记录 + 策略版本 + 恢复前重校验）

在此之前，套件只能证明"这次交付被允许"，不能证明"这项工作从一开始就被允许、依据的是哪一版规则"。
`spec_approve` 只写了 `approvedBy`/`approvedAt`。Mandate v2 补的正是这段**授权前史**，其语义来自
`deepseek-ai/dsh-superagent-prototype` 的 Gate + Mandate + Revalidation（研究原型，仅借语义，不引入其运行时）。

**记录**（`spec_approve` 写入，不可变）：

```json
{ "version": 1, "strength": "explicit|inferred|legacy", "basis": "spec-approved",
  "scope": { "phases": [], "paths": ["src/**"] },
  "policyVersion": "<.dsh 信任根的 sha256>", "approvedBy": "…", "at": 0 }
```

外加 write-once 的 `missions/<id>/policy-fingerprint.json`（批准时刻的信任根逐文件摘要），用于事后回答"当时是什么规则"。

**四条硬规则**（每条都在补一个真实的洞）：

1. **不可变**：再次批准不覆盖旧 mandate；**要更宽的范围就开新 mission**（拒绝并说明）。否则"批准"会变成一个可以被悄悄放宽的字段。
2. **强度是算出来的，不是声称的**：子代理会话一律 `inferred`（即使在白名单里）；配了白名单 ⇒ 只有名单内的 `approvedBy` 才 `explicit`
   （IM 途径同样适用）；没配白名单 ⇒ 仅"本地/终端这类来源且非子代理"算 `explicit`，未知来源一律按远端处理；
   自动批准（`by: "auto"`，或历史记录里的 `automatic` 标记）**永远不是** `explicit`——一个配置开关不是人。
   这个取值本身已被移除（见 §5.29）：新配置写 `approval: "auto"` 会在加载期被拒绝，而历史 mandate 里的
   `by: "auto"` 仍可读取，强度规则对它们逐字不变（依旧永不 `explicit`）。
3. **只有人的 stop 才能撤销**：新增 `orchestrate({ action: 'stop' })` 记录 `withdrawn:{at,by,reason}`；
   `mission_complete`（交付完成）**不**撤销任何东西——交付是"做完"，不是"收回授权"。
4. **恢复前重校验**：`orchestrate({ action: 'unblock' })` 先校验 policyVersion、批准人是否仍在名单、是否已撤销、mandate 是否损坏；
   不通过就**失败关闭**（mission 仍 blocked，写一条 `result:"refused"` 的台账行并给出具体下一步）。
   因为 mandate 不可变，**策略漂移无法用"重新批准同一个 mission"来修**——拒绝信息与医生的修复建议都指向"新建 mission 并重新送审"。

**`inferred` 今天是失败关闭的**：它会被记录并在报告里点名，但**不满足**强制门禁——需要"已批准规格"的写操作仍被拒绝，
且拒绝理由点名 `inferred` 而不是"没有规格"。（"先影子观察再收紧"的 observe 模式属于下一阶段，尚未实现。）

**可见性**：医生新增 `mandate.policy` 检查——有在飞 mission 的 mandate 版本与当前不符时是**必需级缺口**
（列出 ≤5 个 mission id 与改动的信任根文件，修复命令是"新建 mission 重新送审"）；全都一致为 ok；无可判断时为 unknown 并说明原因。
`legacy`（本机制引入前批准的 mission）在报告里**永远作为事实陈述**，不是缺陷，且按 `explicit` 兼容处理。

### 5.20 影子模式：先测量，再收紧（`observe`）

门禁规则此前只有两种状态：通过、拦下。于是"如果我把这条规则打开会发生什么"无法回答——只能直接打开，
用真实交付去试错。`observe` 补的正是这一步，语义取法参考设计（`dsh-superagent-prototype` 的 observe 接受模式）：
**评估照做、结论照记，但不计入裁决**。

- 规则可带 `mode: 'observe' | 'enforce'`，**默认 `enforce`**（既有行为逐字节不变：没有 observe 规则时**不写** `observations` 字段，
  旧记录照常渲染）。未知取值是**配置问题**：保持 `enforce` 并报出可接受取值，绝不静默当成 observe。
- `observe` 规则**仍然恰好判定一次**（命中与否都记录），它的 `would` 写进
  `gates/*.json` 的 `observations: [{rule, mode:'observe', would, reason}]`（**按规则 id 排序**，确定性），
  但**不参与**门禁的有效裁决——会 BLOCK 的影子规则不能让门禁失败。
- **影子不能掩盖也不削弱强制裁决**：一个强制 BLOCK + 一个影子通过 = BLOCK，且报告只点名那个强制规则；
  报告里影子行渲染为 `[影子 would=…]`，永远不会显示成 PASS/FAIL/BLOCK。
- 报告有专段：`影子（observe）：本会拦下 N 条（M 条 observe 规则只记录，不计入本次 <STATE> 裁决）` + 每规则一行 + 切换前的下一步。
- **医生 `gate.observe`**（建议级、永不是阻塞项）：读最近 20 个 mission 的门禁记录，汇总"本会拦下"总数、按规则分组与连续零差异次数，
  修复建议是"同一规则连续 5 次零差异后再切 `enforce`"。
- 一个跨包细节值得记下：**影子预算行不写进 `results`**——`spec-gate` 的 plan ledger 从 `gate.state` + 按 id 的结果推导"预算已验证"，
  一条没被执行的预算**不能**读成已验证；它的测量结果只留在报告与 `observations` 里。
- **刻意不做**：`contract_check` 暂无 `mode`；**规格里声明的预算不能自带 `mode`**（规格是模型可写的，observe 会变成自我豁免）；
  无法测量的 observe 预算仍然**拒绝**（observe 降级的是裁决，不是"测量前提"）。

**推广到 `standards-gate`（并带来的那条硬规矩）**：规则级 `mode` 放在仓库自己的 `.dsh/standards.json` 的 `rules` 映射里
（与阈值同文件、同信任根，规则与模式不会各自漂移；缺省 `enforce`）。这里有一个**质量门禁没有的坑**：
规范门禁有**只收紧的基线（棘轮）**。因此：

> **影子测量永远不得写入基线。** 两条写入路径都必须只吃 enforce 规则——
> `accept` 冻结基线、自动收紧（按 `rule|path|label` 修剪已修复项）；并且**影子的"新增"和"恶化"都要排除**。
> 否则"观察一天"就会改变明天的裁决，与 observe 的目的正好相反。影子测量只保留在
> `observations` 与度量明细工件里，而门禁从不回读自己的测量，因此它不可能移动棘轮。

**`impact-gate` 不适用，且这是结论而不是遗漏**：它不写任何 `GateRecord`，输出是风险分类（low/medium/high/unknown）与选中的测试命令，
阈值是 core 里的代码常量，也没有门禁消费 `risk`——给它造一个 `mode` 等于凭空发明一条规则条目。
这一判断用两条"decision record"测试与 README 段落钉住。

### 5.21 提问必须落地：ask outbox（持久化 + 重放 + 保序 + 丢弃留证）

此前"要人拍板"是**内联发送并等待**：进程死掉、宿主重启、渠道抖动发生在"决定要问"与"卡片离开进程"之间时，
问题会**无声消失**，而门禁那边只看到"没有答案"。参考设计（`dsh-superagent-prototype` 的 Outbox/Effects）给的答案是
**先把意图落盘，再动手**。我们的做法（`.dsh/interaction/outbox.jsonl`，运行时目录）：

- **先落 `intent`，再碰网络**；之后每一次状态变化都是**追加一行**（`sent`/`answered`/`timeout`/`send-failed`/`deferred`/`dropped`），
  读取时"同 id 最后一行胜出"。**撕裂的末行被容忍并计数**——"0 行"与"读不出来的文件"绝不能长得一样。
- **内容寻址的 id**（`channel + chatId + questionId` 的哈希）：**重放同一个问题得到同一个 id**，因此重放绝不会凭空多问一次——id 是问题的身份，不是计数器。
- **一个会话同时只有一个未决问题**：同一 `(channel, chatId)` 上，后一条要等前一条落定或**连续失败到上限**（否则一个坏问题会把那个会话永久堵死，
  它转而在医生里成为系统问题）；不同会话之间互不等待。
- **"推迟"不是"失败"**：无可用槽位/宿主暂停/渠道临时不可用记成独立的 `deferred` 行，**不增加 `attempts`**；
  只有真实发送失败才增加并设置 `nextAttemptAt`（5s 起，翻倍至 300s）。
- **永久失败 = `dropped` + 原因，只记一次，永不再入队**（渠道消失/不存在/不支持该载荷，或问题在投递前过期）；报告读起来是 dropped，不是 sent。
- **重放是机会式的，不是定时器**：插件装配时、以及每次新提问之前。**空闲会话不会自己重试**——这是本设计的边界，写出来而不是藏起来。
- **outbox 行永远不是答案**：`intent`/`sent`/`send-failed`/`deferred`/`dropped` 都等于"人还没决定"；
  台账与一次性 token 仍是"人决定了什么"的唯一记录，重放一个 token 已过期/已消费的提问只会记 `timeout`/`dropped`，**既不重问也不放行**。

### 5.22 注意力是一等对象（Attention）与"暂停只顺延、不烧掉"

"要人拍板"此前只是台账里一条未决记录。它没有**为什么**、没有**是否还成立**，而 `suite_status` 是诊断清单而不是"现在要我做什么"。
参考设计把 **Attention** 做成一等概念（"等一个人回答的问题"），并规定面板只在**真的需要人、仍然有效、未被取代**时才请人；
同时明确 **暂停不使评估过期**（截止时间按暂停时长顺延）。

- **注意力是派生的，不是第三个真值源**：一个问题 = 台账里已有 `ask` 行且该 token 还没有决定行。
  只有**无法派生**的东西才落盘（`.dsh/interaction/attention.jsonl`）：`why`（为什么问你）、`superseded`/`withdrawn`、暂停区间。
  **回答仍然只来自一次性 token + 台账**——派生层永远不能放行任何东西。
- **`whyYou` 只有两个取值**：`decision-required`（门禁走不下去）与 `result-usable`（有结果可以用）。未知时默认前者，**绝不造第三个值**（造了就会被拒绝）。
- **`stale` 读时计算并给理由**：mandate 的策略版本不再匹配 / 等得太久（默认 24h，可配）/ mission 已结束。
  **陈旧的注意力仍然列出**（打标记），绝不静默隐藏——"看起来没有"是最危险的假象。
- **取代与撤回**：mission 交付完成或授权被撤回时，为它所有未决问题写**恰好一条** `superseded`（带原因与 mission id）；
  已回答的永不取代。**迟到答案一律拒绝**（`refused:superseded` / `refused:withdrawn`），**不写任何决定**——这一条是安全关键：
  否则一个"当时问的问题"可以在几小时后被点成批准。`withdrawn` 是问题级的，同样只记一次。
- **暂停只顺延**：等待期间若 mission 处于 blocked，`deadlineAt = askedAt + window + pausedMs`（精确相等，有测试）；
  等待**重新武装**而不是过期，超时文案写明"等待被延长 Nms"；恢复后从顺延后的截止时间继续。显式对应物是
  `interaction.pauseMission/resumeMission/supersedeMission/withdrawQuestion`。
- **操作者视图（`suite_status`）按顺序回答四个问题**：`## 1 现在需要我做什么？`（队列，最老在前，≤10 条，
  每条 mission/question id + `whyYou` + 年龄 + 陈旧徽章与原因；截断时写"另有 N 条（共 M 条）"；**读不出来就写"未知（读取失败，不是没有）"**）→
  `## 2 系统是否健康？`（既有检查不变，健康时只有一行）→ `## 3 历史`（一行指针，不重复已有页面）。
  断言的不变量：**计数等于它指向的列表长度**；健康时只有一行；截断必须说明隐藏了多少条；一次探测失败不产生任何阻塞/建议。

### 5.23 硬规矩：上下文不是授权

参考设计把这条写成了一句话——订阅到的消息"**bypasses the gate and grants no new authority**"：它是上下文，不是权限。
我们把它提升为套件的**全局硬规矩**，因为它同时约束四个方向：

| 上下文 | 可以影响 | **永远不能** |
|---|---|---|
| 知识库检索片段（`kb_search`） | 你对问题的理解、建议的写法 | 提升任何门禁结论、替代门禁记录 |
| IM 消息、卡片点击 | 让"问题"送达人、携带人的**决定**（经一次性 token） | 绕过 token 直接成为决定；重放旧卡片成为新决定 |
| 引用的文档/评论/引用文本 | 作为决策**输入**被阅读 | 改变规则、阈值、白名单（它们是信任根，见下） |
| 子代理/teammate 的产出 | 作为证据材料被检查 | 让工作开始（它的批准只能是 `inferred`）、自己批准自己 |

**这条规矩今天靠什么机制成立**（不是靠自觉）：

1. **授权强度**：Mandate 的 `explicit` 只给"白名单上的人 / 本地非子代理来源"；子代理、名单外的人、机器人一律 `inferred`，
   而 `inferred` **不满足**强制门禁（§5.19）。
2. **证据完整性**：交付要求 `scope.full === true` 且来源匹配（`DEFAULT_GATE_SOURCE`），一条 KB 片段不会进到证据链里。
3. **一次性 token**：回答只能由它携带的那个问题消费一次；重放/转发/别人的卡片都得到 `unknown-token`（§5.18、§5.22）。
4. **信任根封闭**：`.dsh/**` 的规则、阈值、白名单只能由人（或人运行的脚手架）改；写类工具被拦截。
5. **撤销与取代**：mission 结束或授权撤回后，旧问题的迟到答案被拒绝（`refused:superseded`）——上下文可以过时，授权必须失效。

**仍然是"提示级"的部分**（诚实标注）：提示词里"回答必须带引用""索引里没有就说没有"这类要求是**建议**，
机械保证只有"命中必带 `path:from-to`、没有就不返回"。也就是说：**引用是否准确仍要人核对**，
我们能保证的是"不会因为检索到某段文字而放行"。

### 5.24 单一写者纪律（每类状态只有一个写者）与它的可检查部分

套件的事实一直遵循"每类状态只有一个写者、其余人只能读或请求写者"，但**此前既没有写成条文，也没有检查**。
现在它是一张**代码里的表**（`dsh-eng-core/src/writers.ts` 的 `WRITERS`，并由 `renderWriterTable()` 渲染进 README——
文档漂移即测试失败）加一条医生检查：

| 状态 | 写者 |
|---|---|
| `missions/<id>/mission.json`（身份、状态、规格、mandate、撤回） | `MissionStore`（经 spec-gate / orchestrator / evidence-gate 的工具） |
| `missions/<id>/stages/*.json` | `dsh-orchestrator` |
| `missions/<id>/gates/*.json`（含 `observations`） | 产出它的那个门禁（`source` 必须是该门禁 id） |
| `missions/<id>/receipts/*.json` | 只有 `dsh-evidence-gate`（`issuedBy`） |
| `missions/<id>/evidence.jsonl` | 记录该证据的插件（`recordedBy`），只追加 |
| `missions/<id>/impact/*.json` | `dsh-impact-gate` |
| `missions/<id>/policy-fingerprint.json` | `dsh-spec-gate`（write-once） |
| `plan.jsonl` / `releases.jsonl` / `deployments.jsonl` | spec-gate / evidence-gate / deploy-gate |
| `interaction/{outbox,attention}.jsonl` | `dsh-interaction-gate` |
| `kb/**` | `dsh-knowledge-base` |
| `.dsh/*.json` 与 `roles/**` | **只有人**（信任根；写类工具被拒） |

**医生 `ledger.writers`** 只查**只读扫描能看见的**违规：门禁记录的 `source` 是否为已知门禁、
回执的 `issuedBy` 是否为 evidence-gate、证据行是否有 `recordedBy`（三者 `required`）；
`mission.json` 是否出现文档外顶层键、是否把 `mandate` 复制进了 `gates/`（`required`）、
`policy-fingerprint.json` 是否比 mandate 还新、是否存在未知的 `.dsh/` 子目录（`recommended`）。
**它明确承认自己抓不到"谁写的"**：形状合法但由别人写下的记录（"合法的谎"）只读不可见——
这正是那些字段存在的原因，`ok` 只等于"没有明显的第二个写入者"。另外 `stages/plan/releases/deployments/interaction/kb/信任根`
没有可判定字段（表里逐行注明 `checkable: false` 与原因，不假装查了它）。

### 5.25 一致性总览（Conformance）：回答"这一项离规则允许的范围有多远"

三个面各答一件事之后，还缺第三件：`doctor` 说"装置配好了吗"、`metrics` 说"交付在变好还是变坏"，
**没有一个输出能横向比较两个 mission 的整体状态**。设计见 `docs/CONFORMANCE.md`，实现是
`dsh-eng-core/src/conformance.ts` 的五个维度 + 一个头行状态：

| 维度 | 从哪算 |
|---|---|
| 授权 | mandate 的强度/范围/策略版本是否仍成立、是否撤回、`legacy`/缺失 |
| 证据 | 最新回执 → 它引用的门禁：来源是否必需、`scope.full`、结果非空且 PASS、证据 id 是否覆盖必填种类 |
| 门禁 | 每个来源的最新记录（BLOCK > WARN）；`observations`（影子）**在明细里可见但不计入裁决** |
| 新鲜度 | 策略版本、门禁指纹 vs 当前工作区指纹（排除 `.dsh`）、基线，以及**知识库索引**：按 manifest 声明的 `algorithm` + `excludes` 复算（见 §5.26） |
| 一致性 | `evidence.jsonl` 可解析、回执/证据引用的工件存在、`mandate.at` 与 `spec.approvedAt` 一致、部署门禁 ↔ `deployments.jsonl` |

**头行状态 = 最差维度**，且 **`unknown` 与 `partial` 同档**（`unknown` + `conformant` ⇒ `partial`，只有五维全未知才是 `unknown`）——
这是"未知不是好消息"这条纪律的又一次落地。**零权力**：`suite_status` 与 `metrics` 读它，
**任何门禁都不读**，`mission_complete` 仍然直接读门禁记录与回执；有一个测试用 grep 保证没有任何门禁包引用它。
**它是只读、派生、可复现的**：不写任何文件，同一棵台账两次运行输出逐字节相同；**不做加权分数**（分数会掩盖"哪个维度坏了"，
也会诱导优化分数本身），比较用同一组维度的分布，趋势用已有的 `metrics`。

### 5.26 让产物声明"怎么比较它"：知识库索引新鲜度的可复现化

一致性总览最初把"知识库索引是否陈旧"列为**盲区**，原因有两层：计算函数在 `dsh-knowledge-base`（`eng-core` 不能依赖它，会成环），
而更本质的一层是——索引指纹是在**排除了 `.dsh/kb`** 之后算的，这个"排除集"只存在于写者的代码里。读者若用自己的排除集
（例如排除整个 `.dsh`）去比，**永远不会相等**，结果是**永久假 stale**，比"不知道"更糟。

修法不是加依赖，而是**让产物声明它自己是怎么被比较的**：

- `dsh-eng-core/src/fingerprint.ts`（新增、纯加法，`gitFingerprint` 一字未改）：
  `fingerprintWithExcludes(cwd, { paths })` 用 git 的 pathspec 表达排除（`:(top,exclude,literal)<p>`，且 `-uall` 载重——
  否则未跟踪目录被折叠成一行 `?? .dsh/`，产物又通过父目录溜回来），`sameFingerprint(a, b)` 只比那六个字段；
  另有 `changedPathsWithExcludes()` 用来**点名**到底是哪些文件变了。
- 知识库的 manifest 现在写清楚：`fingerprint: { …六个字段, algorithm: 'git-status-v1', excludes: ['.dsh/kb'] }`。
  `indexFingerprint` 与 `stalenessOf` 仍从 `dist/index-store.js` 导出（`scripts/kb.mjs` 与包内测试都从那里取），
  但它们**只是 core 实现的薄转发**——全仓只有**一份**比较逻辑。
- 一致性总览据此复算：声明齐全 → `fresh` 或 `stale`（**并列出改动的文件**）；缺 `algorithm`/`excludes`（旧版本写的索引）
  → **`unknown` + 盲区行"旧索引未声明算法与排除集，无法复算"**，**绝不输出 `fresh`**；算法未知、排除集不可用、非 git 仓库同样 `unknown`。

有一条测试专门钉住这件事：**把 manifest 的 `excludes` 手改成 `[]`，结论必须随之改变**——它证明读者真的按产物声明在算，
而不是偷偷用自己的排除集（这正是在这之前会产生的"永久假 stale"）。另有测试断言 `kb_status`、`scripts/kb.mjs`、
一致性总览三处对同一状态给出一致结论，防止三个界面各说各话。

### 5.27 审批与提问的"面"（surfaces）：IM / TUI / desktop / web TUI

官方把**审批**与**自由文本提问**拆成两个接缝：`approval/request`（waterfall，四词结果
`allowed-once | rejected | cancelled | unavailable`）与 `user-questions/request`（绑定官方
`ask_user_question` 工具调用的 `callId`）。`dsh-api-remotes` 把**两者都**暴露给客户端，因此
**desktop 与 web TUI 本身就能回答审批**；`dsh-client-ui-approval` / `dsh-client-ui-user-questions`
是客户端的渲染侧；`dsh-sdk-jsonrpc-server`、`dsh-acp` 是另外两个应答者，都先判归属
（`ownsAgent` / `ownedRecord`）。

本套件在这张图里的位置：

- **审批**：`dsh-interaction-gate` 以 `{prepend:true}` 注册应答者，但**只在工作区被路由到 IM 时接管**
  （命中 `im.approvals`，或根本没有声明映射 = P1 行为）；未命中时一律 `next()`，把审批交还原生面。
  这是一切的前提：一个对**所有**请求 `prepend` 的插件会抢走 desktop / web TUI / 终端的 UI。
  `im.approvalVia=only` 是例外——它承诺"IM 或无人决定"，所以未命中时返回 `unavailable` 而不回落。
- **自由文本提问**：`interaction_ask` 走本套件自己的通道注册表（`chat-interaction` = IM，本地通道 = TUI）。
  我们**不**占用 `user-questions`：它的 `callId` 必须对应一次真实的 `ask_user_question` 调用，
  拿它承载插件自己的提问等于伪造一次从未发生的工具调用。有一条源码扫描用例钉住"零引用"。
- **新增一个面**：为它写一个通道适配器并加进 `im.channels` 顺序，调用方不用改。当前具名的面：
  `im`（chat-interaction 通道）与 `host-approval`（原生审批面：终端 / desktop / web TUI）。

### 5.28 门禁授权内核：一个入口 + 两种面 + 五个互不混淆的结果

5.27 说的是"审批的问答可以从哪些面进来"；这一节说的是**门禁怎么用它**。此前每个门禁各写一遍，
于是同一个"这里必须由人决定"在三处有不同语义：`spec_approve` 有自己的富审阅卡片并在最后回落到
宿主接缝；`standards_check` 与 `deploy_run` 直接问宿主接缝。这带来两个实际故障：

1. 宿主会话策略 `policy=never` 时，`dsh-user-approval` **在派发之前**就返回 `rejected`——只认接缝的
   门禁于是"静默拒绝"了一件根本没人被问到的事；
2. 拒绝 / 取消 / 无人应答被合并成一句"人工审批未通过（拒绝/取消/无审批通道）"，事后无法区分。

所以授权语义收敛到 `dsh-eng-core` 的 `requestGateApproval()`（`gate-approval/`：`decide.ts` 是唯一入口，
`types.ts` / `words.ts` / `policy.ts` / `text.ts` / `verdict.ts` 分别承载词表、策略读取、文案与裁决），两种呈现面：

- **`rich`**（富审阅）：需要看到甚至修改材料才能决定的场景（`spec_approve`）。面适配器由**调用方**提供：
  nvim-tui 扩展卡片（`via: 'tui-card'`）或 `userQuestions` 的 `plan-review`（`via: 'tui-approval'`）。
  内核**不会**把富审阅降级成只能点允许/拒绝的浮窗——那等于"盲批"，这正是 ADR 0001 否决的方案。
- **`binary`**（二元裁决）：只需要允许/拒绝的场景（基线放宽、部署、依赖批准）。先问**套件通道**
  （IM 卡片，`via: 'im'`），只有在"连问都问不了"（卡片没发出去）时才退回**宿主接缝**
  （`via: 'host-seam'`）。卡片已发出后超时 = 无人决定，绝不再问第二个面。

四条硬语义：

- **永不自动通过**：内核里没有 `auto` 分支；没有可用面就是 `no-answerer`，不可读的回复、
  抛错的适配器、未知的决定词一律 fail closed。`policy=never` 不阻止内核请人（它只影响宿主接缝哪一步）。
- **五个结果互不混淆**：`allowed-once` / `rejected` / `cancelled` / `no-answerer` /
  `rejected-by-host-policy`，每个都有一句独立文案（`describeGateApproval()`），调用方**不得**再合并。
  `rejected-by-host-policy` 只在"接缝返回 rejected **且**读到了 `policy=never`"时出现——读不到策略时
  仍是普通 `rejected`（不猜）。
- **批准绑定材料版本**：富审阅请求必须带被展示材料的 `digest`；批准时重读不一致 → `rejected` +
  `digest-mismatch`（"重新送审"）。`spec_approve` 把该摘要写进 mandate（`specDigest`）。
- **授权来源可审计**：结果带 `by` / `via` / `hostPolicy`；`spec-gate` 的 mandate 记录 `via`（哪张面）与
  `hostPolicy`（批准时的宿主策略，只记录、不参与判定），并把 `via` 映射回 `approvalStrength` 认识的
  强度词（`tui-card→tui`、`tui-approval→questions`、`host-seam→seam`、`im→im`），因此强度规则不变。

IM 面如何被发现：`dsh-interaction-gate` 导出 `imApprovalSurface(ctx, cwd) → { available, chatId?, reason }`，
只读 `interaction` 服务的 IM 报告与通道列表（通道必须 `canAsk`，即实现了 `wait()`）。
它**不影响** `im.approvalVia=off|fallback|only`：那三个值决定的仍然只是"本插件是否接管宿主的
`approval/request` 瀑布"，与"IM 卡片能不能承载一次门禁批准"是两件事。各门禁不 import 别的插件，
而是按结构读 `ctx.get('interaction')`（与 doctor 一样）。

### 5.29 移除 `approval: "auto"`：门禁批准不能由配置自动放行

`approval` 以前有两个取值：`seam`（走审批接缝问人）与 `auto`（**不问任何人**，直接返回
`allowed-once`，并把 `by: "auto"` 写进 mandate）。后者是一个授权洞，而且它不在 5.28 的内核里：
内核始终没有 `auto` 分支，这个短路分支长在 `spec_approve` 的调用方，绕过了整个 `requestGateApproval()`。
门禁批准是"谁、依据哪一版规则、允许这项工作开展"的授权记录，`auto` 却把**一个配置开关**写成了批准人——
谁改了 `.dsh/spec-gate.json`，谁就能让模型批准自己的规格，"批准人"一栏写的是 `auto` 而不是人。

改动（都在 `dsh-spec-gate`）：

- **只有一个取值**：`ApprovalMode` 只剩 `'seam'`；`approvalModeOf()` 是唯一的解析点，`resolveConfig()` 与
  项目级覆盖都走它。配置里写 `"auto"` 时**加载期抛错**并说明原因（改成 `seam`、确保有审批通道、
  历史记录仍可读），不再静默批准，也不再静默忽略——静默忽略会让人以为配置生效了。
- **没有自动批准路径**：`requestApproval()` 里的 `approval === 'auto'` 短路删除。拿到 `allowed-once` 只有
  一条路：经 `requestGateApproval()` 的某个面（nvim-tui 卡片 / `userQuestions` / 宿主接缝 / 套件 IM 卡片）
  真的得到答复，且决定绑定**被展示材料**的摘要（`digest`）。
- **历史记录照读**：`approvalStrength({ automatic })` 那条规则保留的是历史语义——旧 mandate 里的
  `by: "auto"`（或 `automatic: true`）仍然按"永不 `explicit`"计算，一个都不会因为这次移除而变成 `explicit`。
  `automatic` 现在恒为 `false`，因为它没有能产生 `true` 的来源了。

**迁移**：把 `approval: "auto"` 改成 `approval: "seam"`（或删掉该键，`seam` 是默认值），并确认部署里有一条
能回答的审批面：宿主接缝（`ctx.approval`）、nvim-tui 扩展卡片、`userQuestions` 接缝，或套件 IM 通道。
一个面都没有时的结果是 `no-answerer`（失败关闭，点明"没有人被问到"），**不是**自动通过。

**测试面**：原先依赖 `auto` 的用例改为 `seam` + 脚本化应答者（夹具的 `host({ approvalOutcome: 'allowed-once' })`），
断言语义与用例数量不变；`dsh-evidence-gate` 测试里那些 `approval: 'auto'` 本就不是它的配置键（被忽略的多余键），
直接删掉即可——断言未动。

## 6. 为什么这样切分

- **一个关注点一个插件**：门禁可以单独失效（例如先只上 quality-gate），不影响其它环节。
- **确定性放在宿主**：命令、白名单、上限都在 `Config` 里；模型只能在既定轨道上行动。
- **证据优先于声明**：`mission_complete` 不读模型的“我完成了”，只读门禁记录与证据账本。
- **可回滚**：写前快照让“Agent 改坏了”变成一次 `audit_rewind`，而不是一次 git 考古。
