# dsh-quality-gate

确定性质量门禁（`docs.md` §3.4）：**在 Agent 声称完成的时刻，自动执行宿主配置的验证命令**。

## 职责

- 执行 `config.commands` 里声明的命令（宿主配置，模型无法替换/编造），产出三态裁决：
  - `PASS`：全部通过；
  - `WARN`：只有非必需命令失败（可带风险交付，但要在汇报里说明）；
  - `BLOCK`：有必需命令失败 —— 拒绝状态流转。
- **写后 lint 回路**：每次成功写文件后自动跑 `phase: lint` 的命令，失败时把工具结果改成
  带 findings 的错误（`tools/post-execute` 的 `block`），让模型在同一个 step 内修掉，
  而不是继续叠错误改动。
- **收尾门禁**：`agent/turn-stopping`（“agent 即将声称完成”的边界）跑全部命令；
  `BLOCK` 时用 `agent.steer()` 把失败输出推回，阻止本轮收尾。
- 每次裁决都以 gate 记录 + 证据行落到 mission 上，供 `dsh-evidence-gate` 消费；记录里带
  **覆盖范围 `scope`**（`{ selected, total, full }`），部分运行不会被当成完整证明。

## 触发规则（重要）

收尾门禁只在下面两种情况之一成立时才运行，其他情况的 `agent/turn-stopping` 是空操作：

1. **`pendingWrites` 触发**：本轮有过成功的写类工具调用（`writeTools`，默认 `write`/`edit`）——
   最快的信号，驱动写后 lint 回路与收尾门禁。
2. **指纹触发**：`pendingWrites === 0`，但工作区相对**最近一条本插件的 gate 记录**发生了变化
   （`gitFingerprint(cwd, { excludePaths: ['.dsh'] }).diffDigest` 与
   `store.lastGate(missionId).fingerprint.diffDigest` 不同）。这条兜底用于捕获**任何写工具
   看不到的改动**：`bash -c 'sed -i …'`、外部编辑器、`git checkout`、其他进程的写入……
   把 `bash` 加进 `writeTools` 会在每次 `ls` 之后跑 lint，所以这里用指纹比较而不是扩写工具表。
   - 该兜底**只在 git 工作区生效**：不是 git 仓库时没有 diff 指纹可比，自动跳过
     （此时只有 `pendingWrites` 触发；请显式调用 `quality_gate_run`）。
   - 没有任何基线（本 session 还没记过 gate，且没有 mission 记录）时按“已变化”处理，
     即第一次收尾会跑一次门禁，之后靠指纹收敛，不会每轮重跑。
   - 如果门禁命令**自己会改写工作区**（例如生成覆盖率报告），指纹会一直不同：此时每次
     收尾都会再跑一次（阻断次数仍受 `maxBlocksPerTurn` 限制）。把这类产物加进 `.gitignore`
     或 `git update-index --skip-worktree`，指纹就稳定了。
   - 记录 gate 时用的指纹与比较时的指纹同源（都排除 `.dsh/` 台账），否则台账自身的变化
     会让指纹永远“不同”。

会话没有声明 `header.cwd` 时，**自动触发一律不跑**（绝不在未知目录里执行宿主命令），
每会话只警告一次；显式调用 `quality_gate_run` 仍可用（回退到进程 cwd，并在报告里写明）。

被取消的轮次：`signal` 已经 abort 时两个钩子直接返回，不发命令、不记录、不 steer；
`runCommand` 对已 abort 的 signal 返回 `{ aborted: true }`，这种结果同样**不是裁决**——
不会写 gate 记录，也不会清零 `pendingWrites`。

## 项目级配置（同一个 dsh 进程服务多个仓库）

profile 配置是**上限**，每个仓库可以用自己的 `.dsh/quality-gate.json` 细化：

```json
{
  "commands": [
    { "id": "test", "name": "单元测试", "command": "cargo test", "required": true, "phase": "gate" },
    { "id": "clippy", "name": "clippy", "command": "cargo clippy", "required": false, "phase": "lint" }
  ],
  "budgets": [
    { "id": "bundle", "name": "发布包体积", "metric": "bytes", "command": "node scripts/size.mjs",
      "regex": "size=(\\d+)", "max": 200000, "maxRegressionPercent": 10 }
  ],
  "contracts": [
    { "id": "cli-help", "name": "CLI 冒烟", "kind": "cli", "command": "cargo run -- --help",
      "expect": { "exitCode": 0, "stdoutContains": ["USAGE"] } }
  ],
  "limits": { "maxChangedFiles": 30 },
  "turnStop": { "maxBlocksPerTurn": 3 }
}
```

- `commands` / `budgets` / `contracts` 各自**替换** profile 的同名列表（Rust 仓库不该跑 `pnpm test`，包体积口径也不一样）；
  `commands[].cwd` 相对**会话工作区**解析。
- 可覆盖键：`commands`、`budgets`、`contracts`、`limits`、`defaultTimeoutMs`、`maxOutputBytes`、`writeTools`、`turnStop`、`afterWrite`。
- **不可覆盖**：`enabled`、`logFile`、布局路径等宿主决策——写了也会被忽略并记日志（模型可能经 shell 改这个文件，所以它不能是"关掉门禁"的开关）。
- 文件损坏 → 回退 profile 配置并记日志；`commands: []` 是"这个仓库没有门禁命令"的显式决定 → 诚实 WARN 并指出文件路径。
- `quality_gate_run` / `quality_gate_status` 都会显示命令来源（profile 还是哪个项目文件）。

## 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `quality_gate_run` | `missionId` `only[]` `phase` `reason` | 跑命令并返回渲染后的裁决（含 `scope` 覆盖范围）；同时记录 gate + 证据 |
| `quality_gate_status` | `missionId` | 配置的命令表、最近裁决（含 scope 与工作区漂移）、本会话 pendingWrites / 阻断计数 |
| `budget_check` | `missionId` `only[]` | 跑**回归预算**：每个预算测一个数字（命令耗时，或按 `regex` 从输出里取的数），判绝对上下限与"相对历史最佳值"的回归；记录 gate（`scope.full` 恒为 false） |
| `contract_check` | `missionId` | 跑**契约冒烟**：逐条判定声明的期望（退出码 / stdout 含与不含 / JSON 路径），每条期望单独报告；记录 gate（`scope.full` 恒为 false） |

> `budget_check` / `contract_check` 的裁决**不构成交付依据**：它们跑的都不是宿主的门禁命令集，所以记录里 `scope.full` 恒为 `false`
> （`dsh-evidence-gate` 只认 `scope.full === true` 的 `PASS`）。它们也不会清零本会话的"待验证写"计数——交付前仍然必须跑一次
> 不带 `only`/`phase` 的完整 `quality_gate_run`。这样设计是刻意的：多一条能放行的通道，就等于少一层门禁。

### `scope` 契约（`quality_gate_run` / 收尾门禁都会写）

```jsonc
scope: {
  selected: ["test"],   // 真正执行过的【已配置】命令 id（合成检查项 limit-changed-files 不算）
  total: 2,             // config.commands 的总数
  full: false           // 仅当执行集合 == 配置集合（且非取消）时为 true
}
```

- `full === false` 的裁决**不构成交付依据**：`dsh-evidence-gate` 会拒绝只覆盖部分命令的 `PASS`。
- **只有 `full` 的运行才会清零 `pendingWrites`**（收尾门禁的“待验证写”计数）；部分运行
  （`only`/`phase`）保留计数，下一次收尾会再跑一次完整命令集。
- 旧记录没有 `scope` 字段：消费方必须当作“未知”，不得当作 `full`。

## 回归预算（`budget_check`）

"测试通过"回答不了团队真正会回归的东西：命令慢了三倍、包体积翻倍、迁移不可逆、某个计数悄悄涨了。这些都需要**数字的界限**：

```yaml
budgets:
  - id: test-duration
    name: 测试套件耗时
    metric: durationMs          # 命令的墙钟时间
    commandId: test             # 复用 hosts 的门禁命令（继承 cwd/超时/env）；也可直接写 command
    max: 120000                 # 绝对上限
    maxRegressionPercent: 20    # 相对"历史最佳值"允许的变差
  - id: bundle
    name: 发布包体积
    metric: bytes               # 数字从输出里按 regex 取（第一个捕获组）
    command: node scripts/size.mjs
    regex: "size=(\\d+)"
    unit: bytes
    max: 200000
```

规则（固定，不可配置）：

- **两种测量来源**：`metric: durationMs` 直接测命令耗时；`metric: number|bytes` 必须给 `regex`，取**第一个捕获组**并作为数字解析
  （`12.3kB`、`1,200`、`n/a` 都是**拒绝**，绝不退化成 `0`）。
- **绝对界限**：`max`（上界）/ `min`（下界）。同时声明 `max` 与 `min` 时，回归方向按 `max`（越小越好）。
- **回归对照"历史最佳值"**：`<rootDir>/budgets.json` 是**只增不改**的历史（每个预算 id 一条），对照的是
  **历史最优**（越小越好取最小，越大越好取最大），所以一次变慢不会被下一次更慢的记录冲淡。
  失败信息会点名**对照的是哪一次记录、值是多少、什么时候记的**。
- **第一次测量**：记录基线并明说"基线已记录，本次还没有可比的历史值"——那是"暂无数据"，不是通过。
- **只有被接受的测量才进基线**：越界的那次不写入（它从来没被接受过）。
- **命令没成功执行 ≠ 通过**：非零退出 / 超时 / 起不来 → 这条预算判 `BLOCK` 并记录，但**不写入基线**
  （从崩溃的运行里量出来的耗时说明不了任何事），其他预算照常判定。
- **测不到数字就是拒绝**：正则没匹配、捕获内容不是数字 → `budget_check` **整体拒绝执行**（列出已判定但未写入的预算供修复参考），
  既定的语义是"没有数据"而不是"通过"，也绝不退化成 `0`。基线文件损坏同样按 fail closed 拒绝（当成"没有历史"会让护栏悄悄消失）。
- 配置里的预算条目**不会被静默丢弃**：写错的条目会被保留并在 `budget_check` 时被拒绝（规则"消失"和"全部通过"看起来一模一样）。
- **并发写入不会丢测量**：追加是一条"读—改—写"，所以它在一个独占锁（`<基线文件>.lock`，`openSync(path, 'wx')`
  原子创建）下完成：两个会话（或一个会话加一个子代理）同时跑 `budget_check` 时**排队**，而不是互相覆盖；
  新文档仍然先写同目录临时文件再 `rename`，崩溃只会留下上一份**完整**的文档，不会留下截断的 JSON。
  拿不到锁时**大声拒绝**（不是跳过）：等 `baselineLockRetryMs`（默认 2000ms，上限 10000）仍拿不到 → 报出锁路径、
  占用者 pid/时间与锁的年龄，并给出"确认没有进程在写之后手动删除锁文件"的指令；锁存在时间超过 `baselineLockStaleMs`
  （默认 30000ms；例如持锁进程被杀死留下的孤儿锁）同样按"过期锁"点名拒绝——**不会自动删锁**（持有者可能只是慢），
  也**永远不会在没有锁的情况下继续写**。锁在成功、拒绝、文档不可用、写失败等每条路径上都会释放。

### 预算的第二个来源：mission 的规格（`来源：规格`）

非功能要求（"健康检查 p95 < 50ms"、"包体积 ≤ 200KiB"、"迁移必须在 2s 内跑完"）如果只写在宿主配置里，
就既不随规格审批、也无法追溯到需求编号。所以 `dsh-spec-gate` 让它们成为规格的一部分
（`spec_create` / `spec_amend` 的 `budgets` 参数，渲染成规格工件的 `## 非功能预算` 表），
`budget_check` 读**本 mission 的规格**作为第二来源：

- **规格声明的预算照常执行**：宿主配置里没有同 id 时直接采用，报告与门禁行里标 `来源：规格`；
- **同 id 时宿主配置优先**（它是部署上限：机器、工具链、超时都是宿主的），但阈值不一致会作为
  **冲突**列出来——两个值都写、并说明本次用了哪个，绝不静默取其一；
- 裁决的 `reason` 与门禁行里带上该预算关联的需求编号（`关联需求：AC-003`），
  于是 `plan_status` 能回答"哪些要求是预算、验证过没有"（未验证 ≠ 通过）；
- **规格预算和宿主预算一样严格**：命令切不出 argv、`regex` 没匹配到数字、声明没有界限 / 没有捕获组 /
  用了已作废的 id，都是**整次拒绝**（不跑命令、不写基线、不记门禁）；
- `requireSpecBudgets: true`（宿主 opt-in，默认 `false`）时，规格声明了预算而本次运行**一条都没覆盖** → 拒绝：
  一条已声明、已审批的非功能要求不该在没人验证的情况下悄悄进入交付。默认关闭，所以既有行为不变。

```yaml
# 规格侧（spec_create / spec_amend 的 budgets 参数，写进规格、随规格审批）
budgets:
  - id: p95-health
    name: 健康检查 p95
    metric: durationMs            # durationMs | number | bytes
    command: node scripts/p95.mjs
    threshold: { max: 50, maxRegressionPercent: 10 }
    requirementIds: [AC-003]      # 必须存在于同一份规格（写错即拒绝）
```

## 契约冒烟（`contract_check`）

```yaml
contracts:
  - id: api-smoke
    name: 接口冒烟
    kind: http                  # cli | http | schema | command（声明接口类别，写错即拒绝）
    command: node scripts/smoke.mjs
    expect:
      exitCode: 0
      stdoutContains: ["ok"]
      stdoutNotContains: ["stack trace"]
      jsonPaths:
        - { path: data.items[0].id, type: number }
        - { path: data.total, equals: 1 }
```

- 这是**冒烟**契约门禁，不是 mock 框架：它跑宿主声明的**真实命令**，不拦截、不替身、不重写被测系统。
  它证明的是"声明的接口仍然按声明的方式行为"，**不是**"接口是正确的"。
- **每条期望单独判定**（一份带名字的清单，不是一个布尔）：`exitCode`、每条 `stdoutContains` / `stdoutNotContains`、
  每条 `jsonPaths` 各自一行，附实际值。
- `jsonPaths` 用点号 + `[n]` 下标（`data.items[0].id`）；**路径不存在 = 失败并点名该路径**，绝不是"跳过"；
  stdout 不是合法 JSON 时，`jsonPaths` 里每条路径都判失败（外加一条 `stdout 是合法 JSON` 失败）。
- 没声明 `expect.exitCode` 时退出码**不判定**，报告里明确写 `[未断言]`——契约只对它写下的东西负责。
- **无法判定的期望一律拒绝**（并给出改法）：未知 `kind`、空 `command`、`expect` 里不认识的键、没有任何可判定期望的 `expect`、
  非法 `jsonPaths` 路径、未知的 `type`。拒绝时不跑任何命令、不记录门禁。

## 配置

```yaml
- id: quality-gate
  config:
    logFile: '~/.dsh/quality-gate.log'
    defaultTimeoutMs: 300000
    baselineLockRetryMs: 2000      # 追加基线的独占锁最多等多久（上限 10000）；等不到就拒绝这次运行
    baselineLockStaleMs: 30000     # 超过这个年龄的锁文件按孤儿锁点名拒绝（人工确认后删除）
    writeTools: ['write', 'edit']
    commands:
      - id: test
        name: 单元测试
        command: pnpm test        # 不经过 shell：按 shell-word 规则切分成 argv
        required: true            # 失败 → BLOCK
        phase: gate               # 只在收尾时跑
        timeoutMs: 600000
      - id: lint
        name: ESLint
        command: pnpm run lint
        required: false           # 失败 → WARN
        phase: lint               # 写文件后也跑
    trigger:
      turnStop:  { enabled: true, maxBlocksPerTurn: 2 }
      afterWrite: { enabled: true, blockOnFailure: true, maxPerTurn: 2 }
    prompt: { enabled: true, order: 640 }
```

| 键 | 默认 | 说明 |
|---|---|---|
| `commands[]` | `[]` | 命令表；`phase: gate` 默认必需，`phase: lint` 默认非必需 |
| `commands[].cwd` | 会话工作区 | 子目录里跑命令 |
| `commands[].env` | — | 追加环境变量 |
| `budgets[]` | `[]` | 回归预算表；`id`/`name`/`metric`（`durationMs`/`number`/`bytes`）+ `command` 或 `commandId` + `regex`（非 durationMs 必填）+ `max`/`min`/`maxRegressionPercent` + `unit`/`baselineFile`。**与规格里声明的预算同 id 时，这里的定义生效**（部署上限），差别会作为冲突报出来 |
| `requireSpecBudgets` | `false` | 宿主 opt-in：`true` 时，规格声明了非功能预算而本次 `budget_check` 一条都没覆盖 → **拒绝执行**。它是**宿主键**（不可被项目级配置覆盖），因为项目可以声明自己的预算，但不能把宿主的合规要求关掉 |
| `budgets[].baselineFile` | `<rootDir>/budgets.json` | 该预算的基线历史文件（相对路径按会话工作区解析；默认文件是所有预算共享的一份，每个 id 一条历史）。项目级配置里的取值**必须落在工作区内**（`../`、绝对路径、指向外面的符号链接都会被拒绝并报为问题，这条预算回落到默认文件）；文件存在但不是 `{ "version": 1, "budgets": { … } }` 形状时**拒绝判定**（不当作"没有历史"，也绝不覆盖它） |
| `contracts[]` | `[]` | 契约表；`id`/`name`/`kind`（`cli`/`http`/`schema`/`command`）+ `command` + `expect`（`exitCode`/`stdoutContains`/`stdoutNotContains`/`jsonPaths`） |
| `defaultTimeoutMs` | `300000` | 未声明 `timeoutMs` 时的超时（超时按失败处理） |
| `maxOutputBytes` | `64000` | 单命令输出上限（保留尾部） |
| `baselineLockRetryMs` | `2000` | **宿主键**：追加基线时等独占锁的上限（毫秒，上限 `10000`，超限收敛到上限）。等不到就**拒绝**这次 `budget_check`（不是跳过测量），错误里报出锁路径、占用者与年龄。不是合法值时**保留宿主的值并报告** |
| `baselineLockStaleMs` | `30000` | **宿主键**：锁文件存在超过这个年龄（毫秒）就按"过期/孤儿锁"**点名拒绝**，并在指令里要求人工确认后删除该锁——不会自动删、也不会绕过锁继续写 |
| `limits.maxChangedFiles` | `0`（关闭） | 一次任务的改动文件数上限（docs.md §9）；超限 → `BLOCK`。计数来自 `git status --porcelain`，**排除 `.dsh/` 工程台账自身**（否则任务自己的工件会吃掉预算）；不是 git 仓库时按 fail closed 阻断 |
| `writeTools` | `['write','edit']` | 触发写后 lint 与 pendingWrites 计数的工具（shell 改动靠收尾时的指纹兜底，不要加 `bash`） |
| `turnStop.enabled` | `true` | 收尾门禁开关（长测试套件可关掉，改用 `quality_gate_run`） |
| `turnStop.maxBlocksPerTurn` | `2` | 每轮最多纠正几次（防死循环）。`0` = **照跑照记，但不 steer**；负数 = 完全停用收尾门禁（连记录都不做） |
| `afterWrite.enabled` | `true` | 写后 lint 开关 |
| `afterWrite.blockOnFailure` | `true` | 失败时阻断工具结果 |
| `afterWrite.maxPerTurn` | `2` | 每轮最多阻断几次 |

## 防死循环设计（重要）

1. **只有真的变过才跑门禁**：写类工具调用累加 `pendingWrites`；工作区指纹变化触发兜底
   （见「触发规则」）。两者都不成立时收尾门禁是空操作。
2. **同一失败只反馈一次**：`failureSignature = state:命令@输出摘要`，相同签名不重复阻断/纠正。
3. **每轮有上限**：`maxBlocksPerTurn` / `maxPerTurn`，到顶后只记录不再打断。
4. **换轮重置**：`agent/turn-stopping` 观察到新 turn 时重置每轮计数（给模型新的修复机会）。
5. **计数按 (session, mission) 分组**：一个会话可以先后承载多个 mission，阻断次数与
   失败签名不会从一个 mission 泄漏到另一个；`agent/disposed` 与插件卸载时全部清理。
6. **取消即放弃**：`signal` 已 abort 时两个钩子直接返回；abort 后产生的命令结果不构成裁决，
   不记录、不清零 `pendingWrites`、不 steer。

## 安全边界

- 命令**不经过 shell**：`pnpm test && rm -rf /` 会被切成 argv 交给 `spawn`，`&&` 只是一个参数。
  需要 shell 语义时请显式写 `sh -c '…'`，并在 code review 里审这条配置。
- 优先走 `ctx.subprocess`（harness 的受管进程 seam，带沙箱与 spill），缺失时回退
  `node:child_process`；两条路径返回同一形状的结果。
- 非零退出**不是**工具错误：它是一条裁决数据（`exitCode` 进 gate 记录与证据账本）。
- 预算与契约的命令同样**不经过 shell**（`splitCommand` → argv），走同一个 `ctx.subprocess`/`child_process` 双通道；
  预算的 `commandId` 复用门禁命令的 `cwd`/超时/env，**不会**用调用参数去改写宿主设定的界限。

## 与其它插件的协作

- `dsh-spec-gate`：规格的验收标准是门禁要证明的东西；未审批规格下写操作根本不会发生。
  **规格也是预算的第二个来源**：本插件不 import 它，而是从 mission 记录里**结构性读取**它附加在
  `mission.spec` 上的 `budgets` / `retiredBudgets`（core 的 `SpecRecord` 里没有这两个字段，见下），
  并对自己用到的每个字段**重新校验一遍**（fail closed）。
- `dsh-evidence-gate`：`mission_complete` 要求存在一条 `source: dsh-quality-gate`、`state: PASS`
  且**覆盖完整**（`scope.full === true`）的门禁记录，并且必须晚于最新的 `command`/`test` 证据
  （否则算“证据陈旧”并阻断）。因此正确顺序是 `evidence_record` → `quality_gate_run`（不带
  `only`/`phase`）→ `mission_complete`；若在门禁之后又登记了命令/测试证据，重跑一次
  `quality_gate_run` 即可自愈。
- `dsh-orchestrator`：`quality-verify` 阶段的出口门禁就是本插件写下的那条 `PASS`。
- **预算 / 契约裁决不是交付依据**：它们以 `source: dsh-quality-gate`、`scope.full=false` 记录（理由写在 `reason` 里），
  `dsh-evidence-gate` 的 `gate-scope` 检查会因此拒绝只拿它们放行。预算/契约失败时修代码；要交付仍然要跑完整的
  `quality_gate_run`。

### 诚实的边界（规格预算）

- **规格预算不在 core 的共享类型里**：`dsh-spec-gate` 把 `budgets` / `retiredBudgets` / `budgetChanges`
  附加在 `mission.spec` 上（插件不改 `dsh-eng-core` 的 `SpecRecord`）。本插件因此**结构性读取**它，
  读不出来（字段不是数组、条目缺字段、用了已作废的 id）就是**拒绝**，不会当作"这条 mission 没有预算"。
- **`plan_status` 的"已验证"靠两个字符串对齐**：`budget_check` 写进 gate 行的 `预算裁决`（在 `reason` 里）
  与 `来源：规格`（在预算行里）。这两处是本插件与 `dsh-spec-gate` 之间唯一的连接键（两个插件不互相 import）；
  任何一边改了措辞，`plan_status` 只会退化成"未验证"（少一次声明），不会出现假的"已验证"。
- **读的是当前规格修订，不看审批状态**：`budget_check` 会执行当前规格里声明的预算，并在报告里标出
  `已审批 / 尚未审批`。真正的交付闸门在别处（`dsh-evidence-gate` 要求已审批的规格），这里只是如实报告。
- **宿主与规格冲突只报告、不阻断**：宿主配置生效（部署上限），冲突写在报告与裁决 reason 里。要改口径就改规格
  （`spec_amend`，会撤销审批、需要重新审批）；本插件不会替任何人"合并"两个阈值。
