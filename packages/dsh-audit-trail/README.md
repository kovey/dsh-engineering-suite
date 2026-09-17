## 轮次归属与按时间回滚

- 轮次（turn）来自三个事件：`agent/pre-step`（首选）、`agent/inbox/claimed`、`agent/turn-stopping`。
  只要其中一个出现过，快照就能按轮次回滚——SDK 嵌入等不发 `pre-step` 的会话也能被回滚。
- 三者都没出现时，用时间选择器回滚：`audit_rewind({ since: '2026-09-17T07:30:00Z' })` 或
  `audit_rewind({ sinceMinutes: 30 })`。时间选择不依赖轮次，会把窗口内的全部快照纳入回放。
- `turn` 与 `since`/`sinceMinutes` 至少给一个，否则工具报错（不会“默认回滚一切”）。
- 报告会如实说明有多少条快照缺少轮次信息，以及改用时间选择器是否能把它们纳入。

# dsh-audit-trail

审计与追溯层（`docs.md` §3.6）。它是一个**旁路观察者**：只订阅宿主事件，其他插件从不调用它；
审计路径里的任何失败都不会影响工具调用本身（`tools/pre-execute` 永远原样返回 `next()` 的决定）。

## 职责

1. 记录每次工具调用的完整链路（agent / 会话 / 轮次 / 决定 / 结果 / 耗时 / digest），事后可回放、可审计。
2. 对写类工具建立 **前状态快照 → 执行 → 补偿** 链路，支持按轮次回滚工作区。
3. 提供 `audit_report` / `audit_rewind` 两个模型面工具。

**钩子契约**：本插件只观察，不裁决——`tools/pre-execute` 永远原样返回 `next()` 的决定（`allow` / `deny` / `ask` 都不改，
也不附加内容），任何内部失败都只写日志与记录，**绝不向管道抛异常**；快照失败也不例外（记 `reason:"error"`，调用照常进行）。

## 事件订阅

| 事件 | 模式 | 用途 | 落盘 |
|---|---|---|---|
| `tools/pre-execute` | waterfall | 记录调用意图 + 返回的决定；写前取快照 | `phase:"pre"` 行 |
| `tools/result` | emit | 记录结果、耗时、结果 digest/尾巴 | `phase:"result"` 行 |
| `agent/pre-step` | waterfall | 学习会话当前轮次（`ToolExecution` 本身不带 turn） | 不落盘 |
| `session/disposed` | emit（防御式订阅） | 丢弃该会话的内存态（待配对调用、轮次、快照计数） | 不落盘 |

`ctx.effect(() => cleanup)` 在插件卸载时释放全部监听、工具与内存态。

## 工具

| 工具 | 参数 | 语义 |
|---|---|---|
| `audit_report` | `missionId?` `sessionId?` `tool?` `sinceMinutes?` `limit?=20` | 中文报告：总行数、按工具计数、失败调用、写调用快照可用性、最近 `limit` 行表格（时间/工具/轮次/结果/参数摘要）。省略 `sessionId` 用调用方会话；无法确定时列出有审计文件的会话。`missionId` 通过 mission 记录解析到其绑定会话。 |
| `audit_rewind` | `turn`（必填） `sessionId?` `dryRun?=true` `confirm?` `force?=false` | 回滚到 `turn` 之前：收集 `turn >= 请求值` 的快照记录（新→旧），逐个补偿。命中不到的轮次只报告不报错。`force` 只放宽"创建补偿"的那一条守卫（见下）。 |

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉则完全不装配 |
| `logFile` | `~/.dsh/audit-trail.log` | 插件日志（绝不写 stdout） |
| `layout.rootDir` / `auditDir` / `stateDir` | `.dsh` / `<root>/audit` / `<root>/state` | 也接受扁平键 `rootDir`/`auditDir`/`stateDir` |
| `trackTools` | `[]` | 要记录的工具；空 = 全部 |
| `ignoreTools` | `[]` | 永不记录的工具 |
| `writeTools` | `['write','edit']` | 需要写前快照的工具 |
| `maxArgsSummary` | `200` | 参数摘要上限（字符） |
| `maxResultTail` | `600` | 结果尾巴上限（字符，`tail` 语义） |
| `redactArgs` | `true` | 见下 |
| `snapshot.enabled` | `true` | 写前快照开关（关掉后 `audit_rewind` 无内容可回滚） |
| `snapshot.maxFileBytes` | `1048576` | 超过则跳过（`reason:"oversize"`） |
| `snapshot.maxFilesPerTurn` | `50` | 每会话+轮次快照上限（超出 `reason:"quota"`） |
| `prompt.enabled` / `prompt.order` | `false` / `670` | 可选的系统提示词小节 `eng:audit-trail` |

## 项目级配置

一个 dsh profile 同时服务多个仓库，所以"快照多大算大""哪个工具不值得记录"这类设置不可能对每个工作区都合适。
每个工作区可以用自己的一份文件细化本仓库的审计行为：

```
<workspace>/.dsh/audit-trail.json
```

```json
{
  "snapshot": { "enabled": true, "maxFileBytes": 262144, "maxFilesPerTurn": 20 },
  "ignoreTools": ["read", "grep"],
  "writeTools": ["write", "edit", "bash"],
  "maxResultTail": 200,
  "redactArgs": true
}
```

**profile 是上限**：项目文件只能细化行为，不能把审计轨迹搬走，也不能把自己关掉。未命中的键一律**忽略并记录问题**（插件日志里逐键给出原因）。

可覆盖键（与 profile 同名键浅合并，未写的键继续用 profile 的值）：

| 键 | 类型 | 作用 |
|---|---|---|
| `snapshot.enabled` | bool | 本工作区的写前快照开关（关掉后本仓库 `audit_rewind` 无内容可回滚） |
| `snapshot.maxFileBytes` | 正整数 | 本工作区的单文件快照上限（超出记 `reason:"oversize"`） |
| `snapshot.maxFilesPerTurn` | 正整数 | 本工作区每会话+轮次的快照条数上限（超出记 `reason:"quota"`） |
| `writeTools` | string[] | 本工作区哪些工具需要写前快照 |
| `trackTools` | string[] | 本工作区记录哪些工具（空数组 = 全部） |
| `ignoreTools` | string[] | 本工作区永不记录的工具 |
| `maxArgsSummary` | 正整数 | 参数摘要上限（字符） |
| `maxResultTail` | 正整数 | 结果尾巴上限（字符） |
| `redactArgs` | bool | 本工作区是否脱敏文件正文 |

**只能由 profile 决定**（写了也会被拒绝，并逐条记录原因；理由见下）：

| 键 | 拒绝理由 |
|---|---|
| `enabled` | 插件开关是部署决定：项目不能关掉对自己工作区的审计 |
| `logFile` | 插件日志落点是部署决定：审计证据不能被项目改写或丢弃 |
| `rootDir` / `auditDir` / `stateDir` / `layout` | 审计工件位置是部署决定：审计轨迹不能自己搬家 |
| `prompt` | 系统提示词小节由 profile 决定 |

**信任根**：`.dsh/**` 被 `dsh-spec-gate` 的 guard 对写工具关闭，所以模型无法用 `write` / `edit` 改写自己的审计设置——
**能改这个文件的只有人**。注意：这个保护覆盖的是写类**工具**；用 `bash`（`echo >`、`sed -i` 等）改它只在
`dsh-spec-gate` 的 `shellPolicy: strict` 下才被拦下。

**失败绝不放行**：文件不存在 / 不是合法 JSON / 顶层不是对象 / 某个值类型不对时，回退到 profile 配置并记录问题
（逐键回退，不做类型强转），审计**照常记录**——坏掉的项目配置永远不会变成"没有审计"。

**生效范围**：配置按调用方会话的 `header.cwd` **逐次调用解析**（读者按 mtime+size 缓存，热路径每次调用只多一次 `stat`）；
未声明 `header.cwd` 的会话直接用 profile 配置（绝不从没人指定的 `process.cwd()` 里读配置）。
`audit_report` / `audit_rewind` 都会打印 `配置来源：项目级 <路径>` 或 `配置来源：profile`，以及本工作区**实际生效**的快照策略。

## 审计日志字段

路径 `<root>/audit/<sessionId>.jsonl`（会话不可得时用 `unknown`），每行一个 JSON，UTF-8、可 commit、可 diff。

- 公共：`phase` `ts`(ISO-8601 UTC) `sessionId` `agentId?` `turn?` `callId` `rootCallId?` `tool` `note?`（异常标记）。
- `pre` 行：`argsDigest`（原始参数无损 JSON 的 sha256；无法序列化时为 `""`）、`argsSummary`（脱敏+单行+截断）、
  `decision`（`allow` / `deny` / `ask`，pre-execute 链自身抛错时为 `error`）、`snapshot?`（仅写类调用）。
- `result` 行：`isError`、`durationMs`（pre 行在建的内存记录到本行的墙钟耗时，缺失时 `0`）、
  `resultDigest = sha256(JSON.stringify(result.content ?? ''))`、`resultTail = tail(渲染后的文本, maxResultTail)`。
- `snapshot` 记录：`path`(绝对) `relPath` `snapshotPath`(**有 `reason` 时为空串**) `existed` `digest`(写前内容的 sha256) `bytes`
  `mode?`(写前权限位 `st.mode & 0o7777`，旧记录可能没有) `reason?` `error?`（仅 `reason:"error"` 时给出失败原因）。
- 快照失败不会被吞掉：捕获自身抛错时写 `reason:"error"` + `error:"<消息>"`，`audit_report` 与 `audit_rewind` 都渲染为
  **"快照失败（不可回滚）"**（而不是把它当成"未定位到文件参数"）。

## 快照与 rewind 语义

- 取快照时机：`tools/pre-execute` 里、`await next()` **之前**，因此它一定是"管道与工具动手之前"的状态。
- 路径：`<root>/audit/snapshots/<sessionId>/turn-<turn>/<n>-<shortDigest(path,12)>.snap`（轮次未知用 `turn-unknown`）。
- 四条硬限制（全部来自 config，不由模型决定）：只在会话工作区内；绝不落在 layout 自己的 `rootDir` 内（审计不会遮住自己）；
  不超 `maxFileBytes`；每会话+轮次不超 `maxFilesPerTurn`。跳过时**不阻塞调用**，只在记录里写 `reason`。
- 补偿：`existed:true` → 用快照字节还原（原子替换，二进制逐字节一致）+ 还原记录里的 `mode`（因此 `0755` 不会变成 `0644`；
  旧快照没有 `mode` 时只还原内容）；`existed:false` → 删除文件（补偿创建）。
  带 `reason` 的记录**不可回滚**，`audit_rewind` 只统计不触碰（报告里明确写"不可回滚"）。
- `audit_rewind` 默认 dry-run；只有 `dryRun:false` **且** `confirm:true` 才写盘，否则明确拒绝。工作区外的路径一律拒绝。
- **回滚安全契约**（每一项都显式报告，绝不静默）：
  1. **符号链接一律拒绝**：用 `lstat`（而不是 `stat`）判断，目标现在是符号链接时跳过该条并报告
     "`<path>` 是符号链接，跳过（避免写到链接目标）"，**不计入成功**；既不会写到链接目标，也不会把链接替换成普通文件。
     `force` 也不能覆盖这一条。目标不是普通文件（目录等）同样拒绝。
  2. **创建补偿有改动守卫**：`existed:false` 只表示"这次写创建了它"，所以删除前先确认它仍像那次写的产物——
     比较 mtime 与轮次里该路径最后一条日志行的时间戳，并在有写后 digest 记录时比较内容 digest；两者都取自
     **本次回滚第一次补偿之前**的状态（否则前一步的还原会掩盖后一步看到的改动）。
     判定为"又被修改"时跳过并报告 "`<path>` 在回滚点之后又被修改，跳过删除（需要 force 才删除）"。
  3. **`force?: boolean`（默认 `false`）只放宽第 2 条**：`force=true` 时即使文件在回滚点之后被改过也删除它。
     它不改变符号链接拒绝，也不改变"工作区外/审计目录内"的拒绝。
  4. 跳过删除只保护"文件不被删掉"：同一文件若还有更新的快照被重放，其内容仍可能被那份快照覆盖，报告会就此提示。
- 回滚按"新→旧"重放，同一文件多轮次快照最终落在最早的那份（即该轮次之前的状态）。
- **诚实计数**：没有可执行项时不打印"0/0 项成功"，而是打印"**没有可回滚项**"并给出原因（无可用快照 / 全部被跳过 /
  该轮次之后没有写操作）；全部被跳过时也不打印"成功"。
- **轮次未知的限制**：turn 只能从 `agent/pre-step` 学到（`ToolExecution` 自身不带 turn）。会话从未发出该事件时，
  快照落在 `turn-unknown`，报告会说"另有 N 条快照记录缺少轮次信息"并说明**如何变得可回滚**（让会话发出
  `agent/pre-step` 后重新执行写操作，或改用其他恢复手段如 git）；这些记录无法按轮次选中。
- **这是工作区文件回滚**：不修改 git 历史、不执行 git 命令，也不回滚快照覆盖不到的副作用（如 `bash` 命令）。

## `redactArgs` 规则

`redactArgs: true`（默认）时，参数以"digest + 摘要"入库，**绝不存文件正文**：名为
`content` / `old_string` / `new_string` 的参数值（`write`、`edit` 的正文字段）被替换为
`<sha256前12位>/<N> chars>`（非字符串值用其 JSON 形式的字节数）。`argsDigest` 仍是原始参数无损 JSON 的 sha256，
因此正文可被验证但不可被读出。为安全起见该规则作用于**所有工具**的参数（而非仅 `write`/`edit`）；
`redactArgs: false` 时才按原值写摘要（不建议）。
