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
  "limits": { "maxChangedFiles": 30 },
  "turnStop": { "maxBlocksPerTurn": 3 }
}
```

- `commands` **替换** profile 的命令集（Rust 仓库不该跑 `pnpm test`）；`commands[].cwd` 相对**会话工作区**解析。
- 可覆盖键：`commands`、`limits`、`defaultTimeoutMs`、`maxOutputBytes`、`writeTools`、`turnStop`、`afterWrite`。
- **不可覆盖**：`enabled`、`logFile`、布局路径等宿主决策——写了也会被忽略并记日志（模型可能经 shell 改这个文件，所以它不能是"关掉门禁"的开关）。
- 文件损坏 → 回退 profile 配置并记日志；`commands: []` 是"这个仓库没有门禁命令"的显式决定 → 诚实 WARN 并指出文件路径。
- `quality_gate_run` / `quality_gate_status` 都会显示命令来源（profile 还是哪个项目文件）。

## 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `quality_gate_run` | `missionId` `only[]` `phase` `reason` | 跑命令并返回渲染后的裁决（含 `scope` 覆盖范围）；同时记录 gate + 证据 |
| `quality_gate_status` | `missionId` | 配置的命令表、最近裁决（含 scope 与工作区漂移）、本会话 pendingWrites / 阻断计数 |

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

## 配置

```yaml
- id: quality-gate
  config:
    logFile: '~/.dsh/quality-gate.log'
    defaultTimeoutMs: 300000
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
| `defaultTimeoutMs` | `300000` | 未声明 `timeoutMs` 时的超时（超时按失败处理） |
| `maxOutputBytes` | `64000` | 单命令输出上限（保留尾部） |
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

## 与其它插件的协作

- `dsh-spec-gate`：规格的验收标准是门禁要证明的东西；未审批规格下写操作根本不会发生。
- `dsh-evidence-gate`：`mission_complete` 要求存在一条 `source: dsh-quality-gate`、`state: PASS`
  且**覆盖完整**（`scope.full === true`）的门禁记录，并且必须晚于最新的 `command`/`test` 证据
  （否则算“证据陈旧”并阻断）。因此正确顺序是 `evidence_record` → `quality_gate_run`（不带
  `only`/`phase`）→ `mission_complete`；若在门禁之后又登记了命令/测试证据，重跑一次
  `quality_gate_run` 即可自愈。
- `dsh-orchestrator`：`quality-verify` 阶段的出口门禁就是本插件写下的那条 `PASS`。
