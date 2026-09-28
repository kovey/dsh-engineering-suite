# dsh-deploy-gate

**部署门禁**：把"上线"从**有人敲命令**变成**有证据的受控过程**——先算清楚能不能上，再让人批，按宿主声明的步骤
执行，部署后验证，出事时走**已经声明过**的回滚路径，全程记进门禁与台账。

这是套件里缺失的最后一个阶段：`dsh-engineering-suite` 把 规划 / 实现 / 测试 / 交互 / 交付 都变成了确定性门禁，
链条止于一张交付回执，而"部署"是人在终端里敲的那些命令。这个插件补上它，并且坚持三条：

- **命令来自宿主配置**，argv 直传、**绝不经 shell**；模型能选的只有**环境名**，不是命令行；
- **生产需要人**：kind=production（以及任何未声明 kind 的环境）默认必须人工批准，没有审批通道就**拒绝**，
  "没人回答"永远不会变成"同意"；
- **回滚必须已声明**：没有声明回滚命令的环境不会被判"可以上"，`deploy_rollback` 也不会去现场拼命令——
  未演练的回滚不是回滚。

## 五个工具

| 工具 | 作用 |
|---|---|
| `deploy_plan` | 对某个已声明环境做 **go/no-go**（见下表），列出**将要执行的确切命令**、canary 步骤与**回滚路径**。对**环境只读**：不执行任何命令、不请求任何审批。有 mission 时把计划落盘成 `.dsh/missions/<id>/deploy/<stamp>-plan.json`。 |
| `deploy_run` | 再算一次 go/no-go（不通过 → 直接拒绝，逐条列出未通过项），需要审批的环境**先问人**（`interaction` 服务 → 宿主审批通道；两者都没有 → 拒绝并说明），然后按配置顺序执行 `deployCommands`（argv 直传）。**非零退出立即停止**并带出输出尾部；有 canary 时按步执行（每步命令 → 等待 `waitMs` → 该步验证）。记录一条门禁 + 一行台账（revision / 审批人 / 审批消息 id）。`dryRun` 只打印会发生什么，**不写任何文件、不执行任何命令**。 |
| `deploy_verify` | 执行 `verifyCommands`，**有限次重试 + 退避**（`verifyRetries` / `verifyBackoffMs`）。任一次尝试全部退出码 0 → PASS；尝试用尽 → **BLOCK**，且报告里**原样列出该环境声明的回滚命令**，让下一步是可执行的而不是一句讨论。**只验证真的发生过的部署**：有 mission 时，台账里必须有一次成功、仍然上线、且 revision 与当前工作区一致的部署，否则拒绝并说明台账里实际找到的是哪一行——否则一次“只验证”的 PASS 会被编排器读成“部署已执行且通过”。 |
| `deploy_rollback` | 与 `deploy_run` **相同的审批规则**；环境没有声明 `rollbackCommands` → 拒绝。执行回滚命令，并记一行台账，`rollbackOf` 指向这次要撤销的部署（`to` 指向台账 id，或当前上线的那次，或最后一次尝试）。 |
| `deploy_status` | **只读**：已声明环境（是否需要审批、回滚是否已声明）、台账摘要（每环境最近一次 + 当前上线版本 + **回滚目标**）、最近一条 `dsh-deploy-gate` 门禁、挂起的提问、工作区 revision。 |

报告全部是中文，并且**每一条都以"下一步"结尾**——包括拒绝的报告。

## go/no-go 检查清单

`deploy_plan` / `deploy_run` 用的是同一个**纯函数**（`src/plan.ts`：无 I/O，事实全部注入，因此每一个分支都能被测试驱动）：

| # | 检查 | 依据 | 默认 |
|---|---|---|---|
| 1 | `mission` | 有归属的 mission，且未被熔断 | 恒开 |
| 2 | `mission-delivered` | `mission.status === 'delivered'` | 恒开 |
| 3 | `receipt` | 存在交付回执（`receipts/RCP-*.json`） | `goNoGo.requireReceipt` |
| 4 | `receipt-revision` | 回执绑定的工作区指纹 = 当前指纹（HEAD + diff 摘要） | 同上 |
| 5 | `gate` | 存在 `source=dsh-quality-gate` 的记录 | 恒开 |
| 6 | `gate-state` | 最新裁决是 **PASS**（WARN/BLOCK 不放行） | 恒开 |
| 7 | `gate-newer-than-evidence` | 门禁**严格晚于**最新 command/test 证据（同毫秒算陈旧） | `goNoGo.requireGateNewerThanEvidence` |
| 8 | `gate-age` | 门禁年龄 ≤ N 分钟 | `goNoGo.maxGateAgeMinutes`（0 = 关） |
| 9 | `asks` | 没有等待人工回答的提问 | `goNoGo.requireNoPendingAsks` |
| 10 | `clean-tree` | 工作区没有未提交改动（`.dsh/**` 与台账不计入） | `goNoGo.requireCleanTree` |
| 11 | `environment-deploy-commands` | 环境声明了部署命令 | 恒开 |
| 12 | `environment-verify-commands` | 环境声明了验证命令 | 恒开 |
| 13 | `environment-rollback-commands` | 环境声明了回滚命令 | 恒开 |
| 14–17 | `commands-deploy-usable` / `commands-verify-usable` / `commands-rollback-usable` / `commands-canary-usable` | 每一组命令都能 argv 直传（无 shell 元字符、无未知占位符）；只在该组有命令时出现 | 恒开 |

两点是刻意的：

- **"未校验"是一个可见状态**：非 git 工作区无法核对 revision、宿主声明 `requireReceipt: false`、没有装配
  `interaction` 服务（查不了挂起提问）时，那一项会通过但标成 `⚠️ 未校验`，报告里写明"本项未实际核对，不计为已验证"。
  一个部署裁决**不许暗示**一次没有发生的核对。
- **回滚与验证是恒开的**：`environment-verify-commands` / `environment-rollback-commands` 不是可关的开关。
  部署完不看结果、出事时现场想办法，都不是这个插件愿意签字的"上线"。

## 配置

profile（宿主上限）与 `<repo>/.dsh/deploy-gate.json`（项目级细化）：

```yaml
- id: deploy-gate
  config:
    enabled: true
    logFile: '~/.dsh/deploy-gate.log'
    logFileTemplate: '~/.dsh/logs/{project}/deploy-gate.log'   # 可选：一个进程服务多个仓库时按仓库分文件
    ledgerFile: '.dsh/deployments.jsonl'    # 部署台账（相对工作区）
    verifyRetries: 3        # 1–10：deploy_verify 的**最多尝试次数**
    verifyBackoffMs: 5000   # 两次尝试之间的退避（0–600000）
    commandTimeoutMs: 600000
    approvalTimeoutMs: 900000      # 一次审批提问的截止时间（宿主专属；超时 = 拒绝，不是同意）
    autoRollbackOnFailure: false   # true = 部署/验证失败后自动执行环境声明的回滚命令
    goNoGo:
      requireReceipt: true
      requireGateNewerThanEvidence: true
      requireNoPendingAsks: true
      maxGateAgeMinutes: 0        # 0 = 不检查门禁年龄
      requireCleanTree: true
    environments:
      - name: staging
        kind: staging              # local | staging | production | 宿主自定义
        deployCommands: ['bash scripts/deploy.sh']
        verifyCommands: ['bash scripts/healthcheck.sh']
        rollbackCommands: ['bash scripts/rollback.sh --to {revision}']
        # requiresApproval 省略 = 按 kind 推导：只有 local/staging 默认免审批
      - name: production
        kind: production           # production/未声明/自定义 kind → 默认需要人工批准
        approversFile: .dsh/deploy-approvers.txt   # 可选：审批人名单（一行一个，# 注释）
        deployCommands: ['bash scripts/deploy.sh --env production']
        verifyCommands: ['bash scripts/smoke.sh', 'bash scripts/healthcheck.sh']
        rollbackCommands: ['bash scripts/rollback.sh --env production --to {revision}']
        canary:
          steps:
            - { percent: 10, command: 'bash scripts/canary.sh --percent 10', waitMs: 60000, verifyCommands: ['bash scripts/smoke.sh'] }
            - { percent: 50, command: 'bash scripts/canary.sh --percent 50', waitMs: 120000 }
    prompt: { enabled: true, order: 650 }
```

**项目级可覆盖**：`environments`、`verifyRetries`、`verifyBackoffMs`、`commandTimeoutMs`——"这个项目怎么发布、
发到哪里"确实只有仓库自己知道。

**宿主专属**（项目级写了会被拒绝并记日志）：`enabled`、`logFile`、`logFileTemplate`、`layout`、`ledgerFile`、
`goNoGo`、`autoRollbackOnFailure`、`approvalTimeoutMs`、`prompt`。一个仓库不能给自己关掉门禁，不能把
`requireReceipt` 调松，也不能把“失败要不要自动回滚”“等人能等多久”的决定权拿走。**两个键是单调的**：

- `requiresApproval`：项目级可以把它加上，不能把 profile 声明的“需要人工批准”关掉（写 `false` 会被拒并保持 `true`）；
- `approversFile`：profile 声明了名单时，项目级**不能替换或去掉**它（换一份名单等于悄悄放宽“谁能批”）——
  只能为 profile 没声明的环境补一份；换名单的尝试会被拒绝并保持 profile 的名单。

其它规则：

- **不可用的值会被报告，并保留 profile 的值**：`verifyRetries: "3"`（字符串）、`-1`、`verifyBackoffMs` 超上限、
  `goNoGo` 里不认识的键——逐条记问题并回退，**不用一个更好看的默认值悄悄替代**。
- **同名环境按“它声明的键”合并**：项目级声明一个和 profile 同名的环境时，**只有它写出来的键**覆盖 profile
  （`kind` / `deployCommands` / `verifyCommands` / `rollbackCommands` / `canary` …），没写的键从 profile 继承。
  整条替换曾经是一条静默旁路：只写 `{"name": "production"}` 就会把 profile 的 `approversFile` 一起丢掉，
  于是一个不在名单上的人批的部署被放行（对抗式审计端到端复现过；现在由“合并 + 单调名单”堵住，
  `requiresApproval` / `approversFile` 不受“项目赢”规则影响，见上）。
- **`environments` 为空是合法配置**：只是每个工具都会拒绝并说明——插件默认的"部署到哪里"必然与宿主想的不一样，
  所以它没有默认。
- **无 shell**：命令是模板，先按引号规则切成 argv（`dsh-eng-core` 的 `splitCommand`），再按 token 替换占位符
  （带空格的路径仍是一个 argv 元素）。`; | & $ > < \`` 与换行**一律拒绝并解释原因**。占位符：
  `{workspace}`（仓库根）、`{environment}`（环境名）、`{revision}`（本次要落上去的 revision，回滚时是目标）、
  `{target}`（回滚目标部署 id，未知时为空串）；写错的占位符会列出可用集合，不会原样传给程序。
- **canary 步骤逐个校验**：`percent` 必须在 `(0, 100]`、`command` 非空、`waitMs ≥ 0`；不合法的步骤被丢弃并报告
  （不会退化成"一次性全量发布"还不说话）。

## 台账与门禁记录

**每次真正执行或拒绝都会留痕**（两处，各有用途；`deploy_plan` 只落盘计划工件、`deploy_status` 只读，两者都不写台账也不写门禁）。
**台账不可写时什么都不会执行**：`deploy_run` / `deploy_verify` / `deploy_rollback` 在执行任何命令**之前**先探测台账
（`ledgerWritable`：路径是目录、只读、权限不对都会在这里暴露），探测失败就写一条 **BLOCK** 并拒绝——没有台账行就没有
这次动作的记录。探测之后才发生的写入失败（竞态、磁盘写满）由**兜底**处理：行写不进去时立刻再写一条 **BLOCK**
（说明命令已经执行完、行没落盘），报告按“部分成功”如实说明——**绝不会留下一条没有台账行的 PASS**。

1. **门禁记录**（有 mission 时）：`store.recordGate(missionId, { source: 'dsh-deploy-gate', state, reason, results, scope, fingerprint })`
   → `.dsh/missions/<id>/gates/GATE-*.json`。`source` 精确等于 `dsh-deploy-gate`；`scope.full` 只在“这条流程声明的命令**全部**跑完且全部退出码 0”时为 `true`
   （canary 环境里，每一步命令**和该步自己的 `verifyCommands`** 都算在内；`scope.selected` 里的结果 id 每个调用一段前缀，
   因此重试与多步 canary 不会产生重复 id）。**go/no-go 不通过、审批被拒、没有审批通道**都会写一条 **BLOCK**（`results` 里每条
   未通过的检查一条 `check:<id>`），因为"最新一条同源门禁必须是 PASS"是编排器读的判据——不写就会让一条旧的 PASS
   继续有效。没有 mission 时不写门禁（**绝不编造 mission id**），报告里写明"无 mission：仅记台账，未写门禁记录"。
2. **台账**（永远写，除非 `dryRun`）：`appendLedgerRow(ledgerFile, row)`，一行一个 JSON 对象，只追加：

```json
{"at":1790566040427,"id":"DPL-20260928-132816-82098a","environment":"production","revision":"main@1a2b3c4d +0 changed (diff 8f2c1d…)","deployer":"session-44e474d4","approvedBy":"ou_zhangyong","approvalMessageId":"om_card_42","gateId":"GATE-20260928-132816-002","state":"deployed","plan":{"checks":15},"canary":{"steps":2}}
```

- `state` ∈ `deployed` / `failed` / `verified` / `verify-failed` / `rolled-back` / `rollback-failed` / **`refused`**
  （`refused` = 这次尝试**根本没碰环境**：go/no-go 不通过或审批被拒。它也要留痕——"有人试过、被拦下了、原因是什么"
  正是审计要问的）；
- `verify: {attempts, ok}` 在验证行上；`rollbackOf` 指向被撤销的部署 id；`note` 是调用方给的理由（例如事故号）；
- 读取**容忍被截断的末行**（崩溃时唯一可能损坏的就是最后一行）并**报告**跳过了几行，绝不静默丢弃；
- `summarize(rows)` 给出每个环境的 `{lastAt, revision, state, states 直方图, rollbackTarget}`。

**"当前上线的是哪个版本"是悲观推断**：一次 `deployed` 让台账认为它上线；`failed` / `rolled-back` / `rollback-failed`
之后台账**不知道**环境现在跑的是什么（返回"未知"而不是猜"上一条还在"）；一次 `refused` 什么都不改变。
`rollbackTargetOf` 因此是"台账知道的上线部署"，否则退化为"最后一次尝试"（失败的部署也仍然是要撤销的东西）。

## 与编排器的集成（推荐流水线）

`dsh-orchestrator` 侧已经加了两个阶段门禁（**本插件只描述，不改动那个包**）：

| 阶段 | 入口门禁 | 出口门禁 |
|---|---|---|
| `deploy-prepare` | — | `deploy-go`：`lastGate(missionId, { source: 'dsh-deploy-gate' })` 的**最新一条是 PASS**，且 `checkedAt` 严格晚于本阶段进入时间 |
| `deploy-run` | `deploy-go` | 同一条规则（`deploy_run` 自己写的那条 PASS） |
| `deploy-verify` | — | `deploy-verified`：同样是"最新一条 `dsh-deploy-gate` 是 PASS 且晚于阶段进入" |

这条规则之所以成立，靠的是三个约定：**同一个 `source`**、"**最新一条**算数"（先 PASS 后 BLOCK 必须重新关闭）、
以及 `recordGate` 用自己的时钟打 `checkedAt`（后发生的验证一定更新）。所以这个插件的每一个拒绝路径都写 BLOCK：
不写，"上一条 PASS"就会替一次失败背书。

## 审批接缝（`interaction` / `ctx.approval`）

需要人工批准的环境按这个顺序找人：

1. `ctx.get('interaction')` 提供 `ask(request)` 时用它（旧的单一方法形态）：请求形如
   `{ title, question, options: [{value: 'yes'|'no', label}], agent, toolName, signal }`，返回值被规范化为
   “同意 / 拒绝 / 不可用”——可识别的是 `'yes'|'no'` 与 `{decision|answer|value, by, messageId, source, at}`；
   **无法识别的形状一律 `unavailable`（= 拒绝）**，因为从看不懂的回复里猜出一个决定，正是“没人回答”变成“同意”的方式。
2. 否则，`ctx.get('interaction')` 暴露**通道注册表**（`dsh-interaction-gate` 就是这一种）时，直接走真实序列：
   `list()` / `describeAll()` 挑一个 `canAsk=true` 的通道 → `arm(questionId)` 登记新的**一次性令牌** →
   `send(通道, {kind: 'ask', title, body, questionId, buttons})` 发卡片 → `awaitAnswer(questionId, approvalTimeoutMs)`
   等答案；`answered` 的答案走与 `ask()` **同一个**规范化器与**同一个**审批人名单校验，`timeout` / `cancelled` /
   `unknown-token` / 读不出来的结果一律 **fail closed**（超时既不是拒绝也不是同意）。
   挂起提问通过 `pendingAsks()`（兼容 `pending()` / `listPending()`）读取，支持数组、`{asks: [...]}` 或一个数量；
   服务暴露 `ledgers()` 且其为空时，这一项按**无法核对**处理（`pending()` 只读本进程见过的台账，
   “`[]`”在那时**不等于**“没有人在等回答”）。
3. 否则用宿主审批通道 `ctx.get('approval')`（`normalizeApprovalReply`，与套件其它插件同一接缝，记录
   `by` / `messageId` / `source`）。
4. 都没有、或者通道都不可用 → **拒绝**并说明（把试过的东西原样列出来：注册了几个通道、各自为什么不能提问、
   令牌/发送失败的具体原因）。这是配置问题，模型要回报给人，而不是“再等等”。

人工**拒绝/取消** → 返回一份“未执行”的报告（正常结果）；**没有通道** → 报错（配置缺失）。
两者都会写一行 `refused` 台账（有 mission 时再写一条 BLOCK 门禁）。

**审批之后的复算（TOCTOU）**：go/no-go 与工作区指纹是在**发卡片之前**算的，而卡片打开期间工作区不会冻结。
所以批准之后、执行第一条命令之前，本插件会**重新观察**一次：指纹/revision 变了（HEAD 动了、多了一个未提交文件、
diff 摘要变了），或者某项 go/no-go 检查现在不通过了，都会**拒绝**并写 BLOCK，报告里同时给出“审批前”和“批准后”
两个观测值。审批针对的是审批当时的那个 revision——不是“从现在开始随便哪个 revision”。

## 与套件其它插件的分工

| 插件 | 关系 |
|---|---|
| `dsh-evidence-gate` | 它签发**回执**（交付），本插件要求回执并核对它绑定的 revision；`requireReceipt=false` 是宿主显式放弃这道绑定的开关 |
| `dsh-quality-gate` | 它的 **PASS** 是 go/no-go 的第 5–7 项（存在 / PASS / 不早于最新证据）；本插件不重跑测试 |
| `dsh-standards-gate` | 同一套审批接缝与 fail-closed 风格：缺少审批通道就拒绝，人工拒绝则返回报告 |
| `dsh-coverage-gate` | 命令模板与"无 shell"的实现同源（argv 直传、元字符拒绝、占位符白名单），本插件照它的做法实现自己的 `command.ts` |
| `dsh-orchestrator` | 上面那张表：阶段推进读的是本插件写的门禁记录 |
| `dsh-spec-gate` | 保护 `.dsh/**`：环境配置、审批人名单与台账都在信任根里，模型写不了 |

## 诚实的边界

- **它证明的是"声明的步骤跑了"，不是"环境真的好了"**：本插件执行宿主配置的命令并记录它们自己的输出。
  健康检查过了不等于线上没问题；回滚命令退出码 0 不等于流量真的切回去了；canary 的 `percent` 是**环境自己
  脚本的语义**，本插件只负责按顺序执行与等待。超出命令输出之外的任何结论，都需要环境自己的可观测性。
- **它看不见插件之外的操作**：如果有人直接在终端里部署，台账里不会有那一行。台账记录的是**经过本插件**的动作，
  不是环境的历史。
- **它不校验审批人是谁**：`by` / `messageId` 来自通道自报（IM 用户 id 由通道从平台 API 拿来）。`approversFile`
  能做的是"这个自报身份在名单里吗"——名单为空、文件不存在、身份为空一律拒绝；它不能证明"这张卡是本人点的"
  （那是一次性 token 与卡片过期时间的责任，在通道层）。
- **新鲜度是时间戳比较**：`gate-newer-than-evidence` 比的是毫秒。同毫秒按陈旧处理（fail closed），但它不能证明
  门禁真的覆盖了那份证据——它只是拒绝"无法证明覆盖了"的情况。
- **`requireReceipt=false` 是一道真的口子**：宿主显式声明后，工作区与回执不一致不再阻断（报告里标为未校验）。
  这是给"回执绑在脏工作树上、部署却发生在提交之后"这类流水线的逃生门，默认关着。
- **命令会原样进门禁记录与报告**：与质量门禁同一规则。**不要把口令/token 写进命令行**——用环境变量或凭据文件，
  让被调用的脚本自己去读。本插件不读取、不复制任何文件内容或环境变量值到工件里。
- **`autoRollbackOnFailure` 会自己执行命令**：默认 `false`；打开后，部署或验证失败时会立刻执行环境声明的回滚命令
  （不再问人——它本来就是"自动"回滚），并记一行 `rolled-back` / `rollback-failed` 与一条门禁。
  它只能跑**已经声明过**的回滚命令，不会发明步骤。
- **不知道的事就写"不知道"**：非 git 工作区没有 revision 可绑定、失败的部署之后线上是什么版本、通道查不到挂起提问
  ——这些都以"未校验 / 未知"出现在报告里，不会被写成一次通过的核对。`pending()` 型的服务只读**本进程见过的**台账，
  所以服务暴露 `ledgers()` 且为空时，这一项按“未校验”处理，绝不写成“确认没有提问”。
- **没有 mission 时 `deploy_verify` 是"冒烟测试"**：它仍会执行验证命令并只写台账（此时**不写门禁**，因此没有
  任何编排器会把它读成一次部署）。有 mission 时它必须先有一次成功、仍然上线、revision 一致的部署，否则拒绝。
