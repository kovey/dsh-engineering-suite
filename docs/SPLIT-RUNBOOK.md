# 拆分派发运维手册（split runbook）

适用对象：要让一个**真实仓库**跑起"拆分派发"（`split` → `split-review` → `implement` 派 worker），
以及运行之后要回答"并行到底划不划算 / 某个子任务为什么卡住 / 崩溃后留下的 worktree 怎么收"的人。

本手册只描述**已经实现**的行为。配置示例都要由人写进 profile / 项目文件——本仓库的任何脚本都**不代改
profile**（`.dsh/**` 与 profile 都在信任根里，Agent 写不了）。

目录：

1. [打开 `split.enabled`：**只看项目 `models.json`**](#1-打开-splitenabled只看项目-modelsjsonprofile-只作缺省)
   - [1.1 `team_delegate` 的准入检查：派单不能绕过 split](#11-team_delegate-的准入检查派单不能绕过-split)
2. [项目侧 `models.json`（含重试上限 `maxAttempts`）](#2-项目侧-modelsjson含重试上限-maxattempts)
3. [真机接入：`DSH_SMOKE_REAL=1` 的步骤与判据](#3-真机接入dsh_smoke_real1-的步骤与判据)
4. [本机没有 `dsh` 时的 SKIP 边界](#4-本机没有-dsh-时的-skip-边界)
5. [三条运维命令](#5-三条运维命令)
6. [判定规则速查](#6-判定规则速查)
7. [诚实边界](#7-诚实边界)

---

## 1. 打开 `split.enabled`：**只看项目 `models.json`**（profile 只作缺省）

拆分的两个阶段（`split` / `split-review`）插在 `spec-approve` 与 `implement` 之间，默认**关**。
开关只有一个来源：**项目** `<repo>/.dsh/engineering-suite/models.json`（没有命名空间目录的老仓库是
`<repo>/.dsh/models.json`）里的 `split.enabled`。profile 的 `orchestrator.config.split.enabled` 只是
**新项目的缺省**——项目写了显式值就由项目决定（写 `false` 也能压过 profile 的 `true`），没写才看 profile，
两层都没写 = 关。

同一台宿主服务多个仓库时，每个仓库按自己的文件决定；流水线（`orchestrate({ action: "stages" })` /
`advance`）与 `team_delegate` 的准入检查用的是**同一个生效值**（`orchestrator` 服务的
`effectiveSplit(cwd)`，返回里带 `source`：`project` / `profile` / `default`）。

**A 项目：开**

```json
{
  "split": { "enabled": true },
  "worker": { "model": "deepseek/deepseek-chat", "reasoningEffort": "low" },
  "planner": { "model": "deepseek/deepseek-reasoner", "reasoningEffort": "high" }
}
```

（流水线：`… → spec-approve → split → split-review → implement → …`；`team_delegate` 在非 `implement`
阶段拒绝派单。**只需要这一个文件**。）

**B 项目：关**

```json
{
  "split": { "enabled": false }
}
```

（同一个 profile 下，这个仓库保持六阶段流水线，`team_delegate` 行为一字不变。显式 `false` 是"本项目
不走拆分"的决定：profile 里 `enabled: true` 也不会打开它。）

profile 侧**可以什么都不配**。要给"没写开关"的新项目一个缺省时才需要：

```yaml
# profile 侧（由人改；本仓库不代改）
- id: orchestrator
  name: 'dsh-orchestrator'
  config:
    split:
      # 缺省层：只在项目 models.json 没写 split.enabled 时生效。
      enabled: false
      # 阈值/模型的缺省层：项目 models.json 优先，这里只在项目没写时兜底。
      # 形状与项目 models.json 的四个段完全一致（planner/worker/split/quality）。
      models:
        worker: { model: 'deepseek/deepseek-chat' }
        planner: { model: 'deepseek/deepseek-reasoner' }
```

要点：

- **不依赖 `autoDispatch.enabled`**：`split.enabled` 本身就是"这个仓库要派 worker"的决定；再叠一道默认
  关闭的开关会让整个功能默认永不派发（§5.38 的 A 段）。
- **`split` 段里的 `models` 是 profile 侧的默认层**：项目 `models.json` 的同名段优先（两层都没有时按
  下面"可选覆盖"的规则走宿主默认）。
- **模型段是可选覆盖，不是前提**：两层都没写 `model` 时，派发请求**省略** `model`/`provider`，由**宿主默认
  模型**执行——任务照常派发（不失败、不中止），`split/run.json` 的 `tasks[].modelNote` 与 run 级
  `modelNotes` 记一句「worker 模型未配置，使用宿主默认」，缺模型**不**计入返工率（返工率只由真失败/
  冲突/超时产生）。需要升级而 `planner` 未配时降级到已配置的 `worker`（否则宿主默认），并在
  `split/rework.json` 与告警行写「无法升级到 planner：未配置，继续使用 …」。
- **审批不是额外配置**：`split-review` 问人的方式与 `spec_approve` **同一套体验**——宿主提供
  `nvim-tui` 扩展 API 时给 `ui.picker` 菜单（查看计划 / 批准并派发 / 打回重写 / 取消），选"查看"用**同一份
  只读预览**打开 `split/plan.md`（`q` 关闭回到菜单，见 §5.38.3）；没有 nvim-tui（desktop / web / headless）
  时走宿主同一条审批接缝（`ctx.get('approval')`），卡片里带着 `split/plan.md` 这个可读工件与摘要/任务数/
  并行组数，配置了 IM 即走 IM。宿主两条面都没有时按名字拒绝（「宿主没有 approval 接缝」），不会自动通过。
- **审核的是 `plan.md`，绑定的是 `plan.json` 的摘要**：每次写/更新计划都会同时重写
  `missions/<id>/split/plan.md`（标题、摘要、任务表、并行组、四道校验结果——含每任务 AC 上限、审核状态），
  人看的是它；门禁、派发与导入仍只认 `plan.json` 的摘要与 `review.json`。改 `plan.md` 不改变任何裁决。
- **审批策略 `never` 时不会弹卡，也不会记成打回**：宿主审批服务在该会话策略为 `never` 时直接返回
  `rejected`（不派发任何提示面）。`split-review` 在提问前读 `effectivePolicy(agent.session)`：`never` →
  直接 BLOCK 并说明「提示被禁用、本轮未记录成'人工打回'、不计入 `maxReworkRounds`、切到 ask 后重新
  advance」，`reviews.jsonl` 一行不写。**这条在 TUI 菜单路径之前生效**：有 nvim-tui 也不会绕过"别问我"。
  所以"一张审核卡都没看到就被降级"不会是套件的轮数逻辑造成的：先看一下本会话的审批策略。这是宿主策略，
  不是套件故障；读不到策略（旧宿主/无 session/抛错）时仍按原逻辑提问，只记日志。
- **只有 `split.enabled` 是真开关**：项目 `models.json` 的 `split.enabled` 决定"这个仓库要不要派 worker"，
  profile 的同名键只作缺省；模型段、审批通道、`autoDispatch` 都不是拆分能否运行的前提。

项目的 `split.enabled: true` 之后，流水线是：

```
spec-clarify → test-design-review → spec-approve → split → split-review → implement → quality-verify → delivery
```

`implement` 阶段入口会派发（`splitDispatch`）：前提是磁盘上有 plan、且 plan 摘要**仍等于**人工审核记录
的摘要；未审核 / 摘要已变 / 依赖有环都会**拒绝派发**并写 `split/run.json`（`state=refused`），不会建
worktree、不会派 worker。

### 1.1 `team_delegate` 的准入检查：派单不能绕过 split

开了拆分之后，"谁能派单、什么时候能派"也由流程决定：`team_delegate` 会先做一次**准入检查**
（`packages/dsh-role-guard/src/split-gate.ts`），通过了才创建子会话。拒绝是**拒绝**（工具报错、不创建
子会话、不写委派台账），不是"警告后继续"。

生效的开关是**同一个生效值**：`team_delegate` 优先读 `orchestrator` 服务的 `effectiveSplit(cwd)`
（项目 `models.json` 的 `split.enabled` 决定、profile 只作缺省，与插流水线的是同一份），所以"两处都开"
的旧缺口在结构上没有了。宿主没挂载该服务（旧宿主 / 单插件安装）时回退到自读项目 `models.json`，并在
`role-guard` 日志里写一句原因——回退仍按项目文件拦截，**不是**"跳过拆分"（已知边界见 §7）。

| 当前事实 | 结果 |
|----------|------|
| 生效值不是 `true`（没写 / `false`） | 不检查，派发行为与以前一字不差 |
| 生效值是 `true`，但调用方**没有绑定 mission** | 不拦截；`role-guard` 日志留一句"按未绑定处理" |
| 生效值是 `true`，绑定还在但 mission 记录读不出来（损坏/丢失） | **拒绝**（fail closed）：读不到不等于没开拆分 |
| 阶段不是 `implement`（`spec-clarify` / `test-design-review` / `spec-approve` / `split` / `split-review` …） | **拒绝**：先 advance 到 split 完成拆分与审核 |
| `implement` + 磁盘上**没有** `split/plan.json` | 放行（"不值得拆"/轮数超限降级就是这条合法路径） |
| `implement` + 有 plan，但 `split/review.json` 缺失 / `rejected` / 摘要与当前 plan 不一致 | **拒绝**：要求重新送审（文案给出两个短摘要） |
| `implement` + 有 plan 且 `approved`、`planDigest` 与当前 plan 摘要一致 | 放行 |

阶段不对时的拒绝文案（节选）：

```
team_delegate 拒绝：本仓库的拆分已开启（项目 models.json 的 split.enabled 决定，profile 只作缺省），派发前必须先经过 split 的拆分与 split-review 的审核；当前阶段 spec-approve 不允许派单。
- 当前阶段：spec-approve（mission <id>）—— 只有 implement 阶段才允许派单
- 缺少的步骤：先走 split 阶段产出 split/plan.json（planner 拆分 + 四道自动校验），需要审核时再由人完成 split-review，然后才能进入 implement
- 下一步：开启拆分后必须先 advance 到 split 完成拆分与审核（orchestrate({ action: "advance" }) 按流水线推进），再重试本次 team_delegate
- 合法路径：拆分被判定"不值得拆"/轮数超限降级 plain implement 也是合法路径，但必须先经过 split 阶段的判定，不能跳过——跳过 split 直接派单就是这里拒绝的行为
```

审核过期时，文案会同时给出**当前 plan 摘要**与**审核记录引用的摘要**，并明确"必须重新审核"：

```
team_delegate 拒绝：split/plan.json 还没有通过审核（stale），未审核的计划不能派发。
- 当前 plan 摘要：3f9c0a1b2c3d（split/plan.json；审核记录引用的是 51ad2f6c7e90）
- 下一步：把当前 plan 重新送审（进入 split-review 完成人工审核，或重新拆一次），让审核记录引用摘要 3f9c0a1b2c3d，再重试本次派发
```

遇到这三种情况先看这几处：`orchestrate({ action: "status" })` 的当前阶段、`split/plan.json` 是否存在、
`split/review.json` 的 `decision` 与 `planDigest`（`docs/ARCHITECTURE.md` §5.38.5）。

## 2. 项目侧 `models.json`（含重试上限 `maxAttempts` 与每任务 AC 上限）

放在布局根（`<repo>/.dsh/engineering-suite/models.json`；没有命名空间目录的老仓库是
`<repo>/.dsh/models.json`）：

```json
{
  "planner": { "model": "deepseek/deepseek-reasoner", "reasoningEffort": "high" },
  "worker": { "model": "deepseek/deepseek-chat", "reasoningEffort": "low" },
  "split": {
    "enabled": true,
    "reviewRequired": true,
    "maxTasks": 8,
    "maxParallel": 2,
    "maxReworkRounds": 2,
    "taskTimeoutMs": 600000,
    "maxAttempts": 2,
    "maxAcceptancePerTask": 3
  },
  "quality": { "maxReworkRatio": 0.3 }
}
```

| 字段 | 含义 | 缺省 / 边界 |
|------|------|-------------|
| `split.enabled` | 本仓库是否跑拆分（**唯一开关**）：决定流水线插不插 `split` / `split-review`，也决定 `team_delegate` 的准入检查拦不拦"跳过 split 直接派单"（§1、§1.1） | 缺省 `false`（不写 = 不检查、行为不变）；显式 `false` 压过 profile 的 `true`；非布尔值点名后按未开启处理 |
| `split.maxParallel` | 一组内同时跑几个 worker（上限，不是日程表） | 默认 3；`1` = 退化串行 |
| `split.taskTimeoutMs` | 单个 worker 的截止时间 | 缺省跟随宿主 `autoDispatch.timeoutMs`，再缺省 600000 |
| `split.maxAttempts` | 一个子任务允许的**派发尝试次数** | 缺省 1（不重试），允许 1..3，非法值点名后回退 1 |
| `split.maxAcceptancePerTask` | 一个子任务**最多**映射几条验收标准；超出即 plan 不合格 | 缺省 3，允许 1..10，非法值点名后回退 3 |
| `quality.maxReworkRatio` | 返工率超过它就**把后续**子任务升级到 `planner` 模型（不中止） | 默认 0.3 |

`split.enabled` 与 profile 的 `orchestrator.config.split.enabled`（§1）**不是两处开关**：项目文件的显式值
是唯一决定，profile 只是新项目的缺省层。同一份生效值同时决定"流水线里有没有 `split` / `split-review`"和
"`team_delegate` 的准入检查生不生效"，所以**不需要在两处一起配置**：只写项目文件就够，显式 `false` 也能
关掉一个 profile 开着的缺省（§1.1、§7）。

`maxAttempts` 的语义（AC-002）：

- 失败且 `attempts < maxAttempts` → **同一个 worktree** 里重新派发（不重建目录，不重复 prepare）；
- 每次尝试都计入 `attempts`，失败的尝试计入返工（`signals` 里留 `acceptance-failed` / `timeout`），
  即使后来成功也算一次返工；
- 用尽仍失败 → 该任务 `state: needs-resplit`，它的 `dependsOn` 后继**一律 blocked 并点名它**；
- **不可重试的失败仍是 `failed`**：worktree 建不出来——重新拆一次也不会好，要修环境。**模型类没配
  `model` 不在此列**：那是可选覆盖，任务照常派发（走宿主默认），见 §1。

`maxAcceptancePerTask` 的语义（AC-001 / AC-003）：

- 每条子任务的 `acceptance` 长度不得超过它；**超出即 plan 不合格**（`ac-over-budget`，problems 原文
  「任务 `<id>` 映射了 N 条验收标准（上限 M）：请按 AC 边界拆小」），`split_plan` 不写盘、`split` 阶段
  BLOCK，没有任何"警告后继续"的分支；
- 它是**每任务上限**，不是平均值：13 条 AC 的 spec 至少需要 ⌈13/3⌉ = 5 个子任务才可能通过；4 个子任务
  无论怎么分，总有一个装 4 条以上；
- 单任务 plan 只有在 AC 数 ≤ 预算时才可能被判 `not-worth-splitting`；`implement` 入口对磁盘上的 plan
  会复算这条预算，所以手写的"一个任务装 12 条 AC"不会绕过拆分审核变成 plain implement；
- `plan.md` 的"四道自动校验"表第 2 行写明上限与是否通过（上限取本次校验实际使用的值）；具体违规的
  任务在门禁/工具的 refusal 报告里点名。

## 3. 真机接入：`DSH_SMOKE_REAL=1` 的步骤与判据

`scripts/split-smoke.sh` 在 `mktemp -d` 的临时仓库里跑完整条链：
写 plan（走 `split_plan` 的校验路径）→ 审核 → 派发 → 导入 → 清理。默认分支**不派发**（见下一节），
要真派发就：

```bash
export DSH_SMOKE_REAL=1
export DSH_SMOKE_PROFILE=<你的 profile 名>      # 该 profile 必须已把本套件挂上（临时仓库会在 models.json 里写 split.enabled）
export DSH_SMOKE_MODEL=deepseek/deepseek-chat   # 临时仓库 models.json 的 worker/planner 模型
# 可选：
#   DSH_SMOKE_TIMEOUT=600      等待 dsh 会话的秒数
#   DSH_SMOKE_KEEP=1           保留临时仓库并打印路径（排查用）
bash scripts/split-smoke.sh
```

判据只有一条：**`split/run.json` 的 `state=ran`**（脚本会打印 `dispatch: state=ran tasks=N`）。
脚本**不看** `dsh` 进程的退出码——一个"退出 0 但什么都没做"的 `dsh` 会以
`真实派发没有留下 …/split/run.json` 失败（exit 1）。这条路是唯一能证明"真 worker 会写出合格 commit"的
方式；本仓库的验收跑只覆盖 SKIP 分支与它的反证（见 §4）。

真派发时脚本只做一件事：在临时仓库里让一个真实 `dsh` 会话走到 `implement` 阶段（触发入口派发），
然后读临时仓库的 `split/run.json`。它不写你的仓库、不改你的 profile。

## 4. 本机没有 `dsh` 时的 SKIP 边界

默认（不设 `DSH_SMOKE_REAL`）：

- 派发分支**实测拒绝**：`runSplitPlan` 在没有 `ctx.subagents` 时返回 `state=refused`，脚本打印
  `SKIP: 没有可用的真实子代理通道` 与 `未验证派发`，**exit 0**；
- 写 plan / 审核 / 导入 / 清理**照常真实执行**：脚本造一个 `simulated worker`（worktree + commit +
  本地 evidence + 合并），走真实导入器与清理器，并在输出里标明"模拟"；
- **SKIP 绝不算通过**：脚本不会打印 `PASS`/`已验证派发`；`scripts/selftest-ops.sh` C22 钉住这一点。

反证（C22 固化）：

| 输入 | 期望 |
|------|------|
| 默认 | exit 0 + `SKIP: 没有可用的真实子代理通道` + `未验证派发` |
| `DSH_SMOKE_REAL=1` 但没有 `dsh` | **exit 2**（要求真派发就不能悄悄降级成跳过） |
| `DSH_SMOKE_REAL=1` + 一个"退出 0 但什么都不做"的假 `dsh` | **exit 1** + `真实派发没有留下 …` |
| `DSH_SMOKE_REAL=yes`（拼错） | **exit 2** |

## 5. 三条运维命令

### 5.0 审一次拆分：菜单里看 `plan.md`，再决定

审核本身没有 CLI——它是一个人做的决定，入口是 `split-review` 阶段。在 nvim-tui 里它长这样（与
`spec_approve` 同形）：

```
拆分计划审核（mission m-1 · 摘要 1a2b3c4d5e6f · 子任务 3 / 并行组 1）
  > 查看拆分计划（只读预览，q 关闭） — .dsh/engineering-suite/missions/m-1/split/plan.md
    ✅ 批准并派发（写审核记录，进入 implement）
    🛑 打回重写（说明要改什么，回到 split 重新拆）
    取消（不写审核记录，阶段保持 entered）
```

选"查看"会用与需求审批**同一份**只读预览打开 `plan.md`（`q` 关闭后菜单回来，不写任何记录）：

```markdown
# 拆分计划：给 CLI 加一个 --json 输出

- Mission：`m-1`
- plan 摘要：`1a2b3c4d5e6f`（审核绑定这个摘要；改动 plan 就换摘要，必须重新审核）
- 子任务：3 个；并行组：1 个
- 写入时间：2026-11-20 10:02:11Z

## 子任务

| id | 目标 | 路径 | 覆盖 AC | 依赖 |
|----|------|------|---------|------|
| T-001 | 抽出序列化层 | `packages/cli/src/serialize/**` | AC-001 | - |
| T-002 | 接上 --json | `packages/cli/src/flags/**` | AC-002 | T-001 |
| T-003 | 补文档 | `docs/**` | AC-003 | T-002 |

## 并行组

- 组 1：`T-001`、`T-002`、`T-003`

## 四道自动校验

整体结论：✅ 四道校验全部通过

| 校验 | 结果 | 说明 |
|------|------|------|
| 1. 每个子任务映射真实验收标准 | ✅ 通过 | 子任务 3 个；映射的标准都在规格里 |
| 2. 每个子任务最多映射 3 条验收标准 | ✅ 通过 | 上限来自 models.json 的 split.maxAcceptancePerTask（缺省 3；这里是本次校验实际使用的值） |
| 3. 并行组内路径不重叠 | ✅ 通过 | 并行组 1 个；组内两两比较路径 |
| 4. 每个验收标准都被覆盖 | ✅ 通过 | 覆盖：AC-001、AC-002、AC-003 |

## 审核状态

- 写入时的状态：plan 摘要 `1a2b3c4d5e6f` 还没有人工审核记录（split/review.json 缺失）
```

没有 nvim-tui（desktop / web / headless / IM）时同一份材料走宿主审批卡：卡片里带 `split/plan.md`、
摘要、子任务数与并行组数。两种情况下的决定含义完全一样：批准写 `approved` 并放行派发；打回写 `rejected`
（占一轮 `maxReworkRounds`）并回退重拆；取消/Esc 一行不写、阶段保持 entered。

### 5.1 看状态：`orchestrate({ action: "status" })` 的 `## 拆分` 段

只读，不写任何台账、不记录门禁。它回答：plan 摘要 / 审核状态 / 每个子任务的 `state`（含
`needs-resplit`）、commit、导入条数、是否清理 / 返工率与是否升级 / 待导入条数 / **孤儿目录**：

```
## 拆分
- plan：摘要 1a2b3c4d5e6f（3 个子任务，1 个并行组）
- 审核：approved（…）
- 运行：ran
- 返工率：1/3 = 0.333（阈值 0.3，已升级 planner 模型）
- 模型：worker 模型未配置，使用宿主默认
- 待导入：1 条（1 个子任务）；可清理：否（先导入这些证据，cleanup 会拒绝）
- 孤儿：1 个 / 待导入残留：1 个 / 可安全清理：0 个（磁盘共 2 个目录；run.json 已读）
- T-003：needs-import（run=无记录，1 条待导入，目录 不是活 worktree）
- T-009：orphan（run=无记录，目录 是活 worktree）
- 待导入的目录**不能删**：先导入这些证据，clean 会拒绝（…）
- 清理命令：bash scripts/split-clean.sh --orphans --mission <id>（默认 dry-run 只打印；--apply 才…）
```

没有 plan 的 mission**整段不出现**——旧输出逐字节不变。

### 5.2 收孤儿目录：`scripts/split-clean.sh --orphans`

```bash
# 1) 默认 dry-run：只打印候选与将要执行的删除，一个目录都不动
bash scripts/split-clean.sh --orphans --mission <mission-id>

# 2) 确认之后才真删（每个目录都走"先导入再删"检查）
bash scripts/split-clean.sh --orphans --mission <mission-id> --apply
```

- `--mission` 必填：不猜"最近一个 mission"（删错目录不可撤销）；
- 候选只有 `orphan` 与 `safe-to-clean`；`needs-import` **永远不是候选**，而且只要本 mission 还有任何
  未导入的本地证据，**整批中止**（exit 1）并列出待导入清单；
- 删除复用 `cleanupTaskWorktree`：`git worktree remove`（不带 `--force`），脏目录会被 git 拒绝并保留；
  **分支从不删除**，commit 仍在 `split/<missionId>/<taskId>` 上；
- 未知参数（例如 `--aply`）exit 2，拼写错误不会变成"什么都不做"或"直接删"。

### 5.3 看成本：`split/report.json`

与 `split/run.json` 同时写、来自同一次运行，**不被任何门禁/回执读取**：

```bash
node -e 'const r=require(process.argv[1]); const e=r.economics
console.log(e.verdict, "speedup", e.speedup, "wall", e.wallClockMs, "serial", e.serialEstimateMs)
console.log(e.reasons.join("\n")); console.log(e.tokens)' \
  .dsh/engineering-suite/missions/<mission-id>/split/report.json
```

`economics.tokens` 恒为：

```json
{ "state": "unavailable", "reason": "宿主 subagent 接缝不暴露 usage" }
```

——宿主 `dsh-subagent` 的派发结果**没有** `usage`/token 字段，所以这一项**不估算、不写 0**。
`economics` 的每任务 `durationMs`/`prepareMs`/`attempts` 与整体 `serialEstimateMs`/`wallClockMs`/
`speedup`/`verdict`/`reasons[]` 见下一节。

`report.json` 顶层的 `modelNotes[]` 是模型回退的一句话（`[]` = 用到的模型类都配了）：
「worker 模型未配置，使用宿主默认」/「无法升级到 planner：未配置，继续使用 …」——与 `run.json` 的
`modelNotes`、每个任务的 `tasks[].modelNote` 是同一句。它记录的是"这一轮用了什么模型"，不是失败。

## 6. 判定规则速查

### 6.0 plan 是否合格：四道自动校验（AC-001 / AC-002）

| 校验 | 失败时 | problems 原文 / 关键字段 |
|------|--------|---------------------------|
| 1. 每个子任务映射真实验收标准 | BLOCK（不写盘、不送审） | `task-without-ac` / `unknown-ac` / `dependency` |
| 2. 每个子任务最多映射 `split.maxAcceptancePerTask` 条 AC（缺省 3） | BLOCK（不写盘、不送审） | `ac-over-budget`：`任务 <id> 映射了 N 条验收标准（上限 M）：请按 AC 边界拆小` |
| 3. 同一并行组内路径不重叠 | BLOCK | `paths-overlap`，点名两个任务与两个路径 |
| 4. 每个验收标准都被覆盖 | BLOCK | `ac-uncovered`，点名未覆盖的 AC |

四道都通过的 plan 还要过 §5.38.2 的门槛（`maxTasks` / `maxParallel` / 任务数 <2 / 路径完全相同）才决定
"派发"还是"不值得拆"。**顺序是先校验、后门槛**：单任务 plan 只有在 AC 数 ≤ 预算时才可能被判
`not-worth-splitting`；否则先被第 2 道校验拒掉，要求重拆。

### 6.1 `economics.verdict`（AC-001）

`serialEstimateMs` = 各子任务 `durationMs` 之和（含每个任务一次性的 worktree `prepareMs`）；
`wallClockMs` = run 开始到收尾（合并/导入/清理）结束；`speedup = serial / wall`（两位小数）。

| 条件 | verdict |
|------|---------|
| `wall < 0.9 × serial` | `worth-parallel` |
| `wall > 1.1 × serial` | `slower-than-serial`（准备/合并/导入开销吃掉了并行收益） |
| 其余（10% 以内） | `unknown` |
| 实际执行 < 2 个子任务 / 0 个子任务 / 串行估算为 0 / 墙钟为 0 | `unknown` + 理由 |

`reasons[]` 一定带数字与依据；`speedup` 在无墙钟时是 `null`（不是 0）。

### 6.2 `needs-resplit`（AC-002）

`split/report.json` 的 `tasks[].state` 与 `orchestrate status` 的表格里都会出现 `needs-resplit`：
**这个子任务用尽了 `maxAttempts` 次尝试**。正确反应是回到 `split`/`split-review` 重新拆分与审核，
而不是用同一个 plan 再派一次（同样的输入会同样失败）。它的后继在 `run.json` 里是 `blocked`，
`problems` 会写出"依赖 T-001（需要重新拆分）未完成"。

### 6.3 孤儿分类（AC-003）

| 分类 | 判定 | 能删吗 |
|------|------|--------|
| `needs-import` | 该目录还有未导入主 mission 的本地 evidence | **不能**：先导入；clean 会拒绝并列出清单 |
| `safe-to-clean` | `run.json` 记录该任务 `done`，且没有待导入 | 可以（`--apply`）；删目录不删分支 |
| `orphan` | `run.json` 里没有这个任务，或状态不是 `done`，且没有待导入 | 可以（`--apply`）；`git` 会拒绝脏目录 |

`run.json` 缺失或解析失败时：**不做状态猜测**——目录全部按 `orphan` 列出，并在 `problems` 里点名
那个读不出来的文件。

### 6.4 子任务的提交 = `base..HEAD` 的差集（基线提交不参与判定）

一个子任务"有没有提交"不看 worktree 的裸 `HEAD`，看它相对**基线**新增了什么：`base` 是建 worktree 之前
主树的 HEAD（也是分支的起点），写进 `run.json` 的 `tasks[].base`（短哈希）。判定顺序是确定的：

| 事实（`git rev-list --count base..HEAD`） | 判定 | `problems` 原文 |
|------------------------------------------|------|-----------------|
| `0` 且 worktree **干净**（`git status --porcelain` 为空） | 失败（`acceptance-failed` → `needs-resplit`），**标题一字不读** | `worker 没有产生提交（HEAD 仍是基线 <base8>）：无法证明这次任务做过任何事` |
| `0` 但 worktree **有未提交改动** | runner 代提交（`<taskId>: <摘要>（run 由 runner 代提交）`）后**重新判定**，见 §6.5 | 成功时无 failure problem；代提交本身写一条 `runner 代提交：…` 的 note（见 §6.5） |
| `≥1` 且任一标题以 `<taskId>:` 开头（容忍全角 `：`） | `done` | — |
| `≥1` 但都不带前缀 | 失败（`acceptance-failed` → `needs-resplit`） | `本次 N 个新提交里没有一个带 "<taskId>:" 前缀（base <base8> → HEAD <head8>）：无法证明它属于子任务 <taskId>。新提交标题："…"`（最多列 3 个） |

**为什么必须这样**：真实故障里 worker 一个提交都没产生，worktree 的 HEAD 还是基线，而基线恰好是 dsh-memory
的 session-end 自动提交；旧实现拿裸 HEAD 的标题去校验前缀，于是**别人的提交**被当成这个任务的证据拒掉，
任务进入 `needs-resplit`，它的后继全 `blocked`。所以有两句话要记住：

- **基线提交的标题不参与任何判定**：它看起来像工具提交（`dsh-memory: …`）也好、像任务提交（`T-001: …`）
  也好，`0` 个新提交就是 `0` —— 后者尤其重要，任何"读 HEAD 标题"的实现都会在那里误判成通过；
- **门槛没有放宽**：无提交仍然失败，只是失败原因从"前缀不符"变成"没有产生提交"。

诊断（都从产物出发，不猜）：

```bash
# 1) 这个任务自己新增了哪些提交？（base 取自 run.json 的 tasks[].base）
git -C <worktree> log --oneline <base>..HEAD
# 2) 如果这里为空：worker 没提交，重派/重拆之前先问"它卡在哪"，别去改标题
# 3) 如果这里非空但没有 <taskId>: 开头的那条：说明它提交了、只是标题不合规 → 按返工处理
```

`run.json` 里该任务的 `commit` 只在 `count ≥ 1` 时才有值：读到一个 `commit` 不代表"任务完成"，它只代表
"这个分支相对基线至少多了一条提交"。

### 6.5 worker 必须提交；runner 只在它忘了时补一次

`run.json` 的空 `commit` + 「没有产生提交」有两种完全不同的成因，必须分开反应：

| 成因 | runner 的行为 | `run.json` 里的痕迹 |
|------|---------------|---------------------|
| worker 写了文件但**没提交** | 代提交 `git add -A && git commit -m "<taskId>: <摘要>（run 由 runner 代提交）"`，再按新的 `base..HEAD` 判定 → 通常 `done` | 该任务 `autocommit: true`；`tasks[].problems` 与 run 级 `warnings` 各有一条 `runner 代提交：<taskId> 的 worker 没有提交，但 worktree 有未提交改动，已由 runner 代提交 <commit8>（run.json 的 tasks[].autocommit=true）` |
| worker **什么都没改** | **不代提交**，原句失败 | 无 `autocommit`；`problems` 仍是 `worker 没有产生提交（HEAD 仍是基线 <base8>）：无法证明这次任务做过任何事` |
| 代提交本身失败（身份未配置 / hook 拒绝 / git 不在） | 不伪造 commit：任务失败，原样报出 git 的 stderr | `problems` 以 `runner 代提交失败：…` 开头（仍会附上"没有产生提交"那句） |

worker 侧的契约（`split-worker.ts` 的 `workerPrompt` 第 3 条，原文）：

```text
3. **完成修改后必须提交**：在 worktree 里执行 `git add -A && git commit -m "<taskId>: <摘要>"`（例如 <taskId>: <目标>）。
   runner 只认你在 <taskId> 分支上产生的提交，**不提交视为未完成**：它不会替你证明做过事；
   若你留下未提交的改动，runner 会代提交并在 run.json 记 autocommit=true（那是兜底记录，不是你的产出）。
```

两条要记住的性质：

- **代提交不进 `signals`**：返工率回答"这个任务被做了几次"，不是"谁补的提交"；代提交也不改变
  `needs-resplit` 的语义（它只由 attempt 失败产生）。`autocommit: true` 是"这一轮的记录不完整"的信号，
  值得在 review 时看一眼，但它不阻断交付、不写门禁。
- **兜底不掩盖"什么都没做"**：清理过的 worktree 是干净的，`git status --porcelain` 为空 → 直接失败。
  代提交只在**确实有改动**时发生，且提交里就是那些改动（`git add -A`）。

诊断（都从产物出发）：

```bash
# 1) 这个任务为什么失败？先看 run.json 的 tasks[]：state / commit / autocommit / problems
# 2) 有 autocommit: true：worker 改了但没提交，runner 补了。看那条 note 与 commit 的标题
git -C <主树> log -1 --format=%s <tasks[].commit>
# 3) 没有 autocommit 且 commit 为空：worker 确实什么都没改。别去改标题，先问它卡在哪
# 4) worktree 还在（超时/待导入）时：git -C <worktree> status --porcelain 看它到底留下了什么
```

## 7. 诚实边界

- **度量与恢复不参与交付判定**：`economics` 与 doctor 的输出不写门禁、不被 `mission_complete` 读取
  （AC-005）。删掉或改掉 `split/report.json` 不改变任何裁决；`orchestrate status` 的拆分段是纯读视图
  （测试用 `.dsh` 前后逐字节快照钉住）。
- **`report.json` 是投影，不是证据**：它不能证明子任务做对了；交付仍是"合并后的主树完整跑一次质量门禁 +
  lead 签发回执"。
- **doctor 看不到未提交的文件**：它只按产物分类；`clean` 的删除原语是 `git worktree remove`（无
  `--force`），未提交/未忽略的文件会让 git 自己拒绝。分支永不删除，commit 仍可达。
- **代提交不评价 worker 改得对不对**：它只把"有改动但没提交"变成一条可核验的 `<taskId>:` 提交；改动是否
  满足验收标准仍由门禁与评审回答。被仓库忽略的路径（典型是 worktree 内的 `.dsh/` 本地台账）**不算改动**，
  所以"只写了 evidence、没改代码"的 worker 依旧是"什么都没做"。
- **clean 不会"顺手导入"**：本套件没有独立的导入 CLI；先把证据导入（走 runner 收尾或 `split_plan` 之后的
  导入路径），再清理。
- **真派发需要真 profile + 真 `dsh`**：本仓库的验收跑覆盖的是 SKIP 分支与它的四条反证，不证明"真 worker
  一定写出合格 commit"；那一条只能在 `DSH_SMOKE_REAL=1` 的真机路径上得到证据。
- **没有 token 数据就不要假装有**：`usage` 缺失是宿主接缝的事实，不是可以插值的空白。
- **"没看到卡"有三种原因，别混为一谈**：① 策略是 `never`（宿主不弹卡、直接 rejected，套件已在提问前
  BLOCK，见 §1）；② 接缝没有应答者（`unavailable`，阶段保持 entered）；③ 宿主是 nvim-tui——此时没有
  "卡"，而是一个菜单（§5.0），选"查看计划"只会打开只读预览、不写记录，只有点了批准/打回才有记录。
  三者都不会在没人决定时写 `reviews.jsonl`；只有"人真的按了打回"才会记一行。诊断顺序：先看运行界面与
  本会话审批策略，再看 `reviews.jsonl` 与阶段状态。
- **`plan.md` 只是给人看的投影**：它由写 `plan.json` 的过程生成（同一写入点），审核决定不会立刻重写它；
  改它不改变任何裁决（门禁与派发只认 `plan.json` 的摘要与 `review.json`）。
- **AC 预算是"每任务上限"，不是"拆得好"**：它不阻止 `maxTasks` 个任务各自 3 条 AC 的宽计划，也不评价
  切分质量（那是审核人的问题）；`plan.md` 第 2 行写的是本次校验实际使用的上限，不是重新读配置得来的。
  门槛（`decideSplit`）本身没有预算概念——只有"先校验、后门槛"的组合顺序才是权威。
- **开关只有一个来源；profile 只是缺省**：`team_delegate` 的准入检查（§1.1）与流水线读的是**同一个**
  `effectiveSplit(cwd)`（`orchestrator` 服务；项目 `models.json` 的 `split.enabled` 优先、profile 只作缺省）。
  两处不会再各读一处，"两处一起打开"不再是使用前提。旧宿主没有该服务时回退到自读项目文件并记日志——
  这条回退路径看不到 profile，属于已知边界；项目文件写着 `true` 时它照样拦截。
- **系统提示里的流水线是宿主级投影**：prompt section 渲染的是宿主进程 cwd 的生效流水线（`text()` 拿不到
  会话工作区）；多项目宿主以 `orchestrate` / `team_delegate` 的按工作区判定为准，prompt 只是提示。
- **没有 plan 就是放行**：`not-worth-splitting` / 降级 plain implement 的产物就是"没有可用 plan"，所以
  删掉 `split/plan.json` 在准入层面与这两个合法结果等价；拦截的是"跳过整个 split 阶段"，不是"没有 plan"
  这一状态。真正的防篡改在摘要绑定（派发与导入只认 `review.json` 引用的摘要）。
