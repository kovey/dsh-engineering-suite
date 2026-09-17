# dsh-eng-core

工程套件的共享运行时（**库，不是 Cordis 插件**：没有 `apply()`，profile 的
`dsh.profile.bundles` 里也不该出现它）。

设计约束：**运行时不 import 任何 `@deepseek-ai/*`**，所以它可以在任意 harness 构建上加载；
harness 相关的东西一律走结构化类型（`AgentLike`、`SubprocessLike`）或由插件自己 `import`。

## API 地图

| 模块 | 导出 | 用途 |
|---|---|---|
| `mission.ts` | `MissionStore`、`MissionStoreRegistry` | mission 工件读写：`create/read/update/save/list/latest`、`bindSession/active/resolve/resolveForAgent`、`writeSpec/readSpec/setTestDesign`、`appendEvidence/readEvidence`、`recordGate/readGates/lastGate`、`issueReceipt/readReceipts`、`writeStageResult/listStageResults`。每次写入都是 read-modify-write + 原子替换，多插件多实例天然一致 |
| `paths.ts` | `resolveLayout`、`missionDir`、`specFile`、`auditFile`、`snapshotDir`、`isInside`、`expandHome`、`resolvePath` | `.dsh/` 下的工件布局（`Layout`） |
| `run.ts` | `runCommand`、`splitCommand`、`outputDigestOf`、`SubprocessLike` | 确定性命令执行：优先走 `ctx.subprocess`，回退 `node:child_process`；不经过 shell；返回 `{exitCode, signal, stdout, stderr, durationMs, timedOut, spawnError?}` |
| `git.ts` | `gitFingerprint`、`gitDiffSummary`、`describeFingerprint` | 证据绑定用的工作区指纹（非 git 仓库时返回 `isRepo:false`，不抛错） |
| `markdown.ts` | `parseSections`、`parseAcceptanceCriteria`、`parseTestDesign`、`renderSpecMarkdown`、`renderTestDesignBody`、`SPEC_FORMAT_HINT` | 规格工件格式（中英文标题都解析），是 spec-gate 与 test-design-gate 的共同真相 |
| `io.ts` | `readText/readJson/writeTextAtomic/writeJsonAtomic/appendJsonl/readJsonl/writeOnce` | 原子写 + 只追加账本 |
| `log.ts` | `createLogger`、`silentLogger` | 只写文件（或 `DSH_ENG_DEBUG=1` 时镜像 stderr），**绝不写 stdout** |
| `digest.ts` | `sha256`、`shortDigest`、`slugify`、`stamp`、`missionId`、`tail`、`head`、`formatTime` | 指纹与文本整形 |
| `session.ts` | `AgentLike`、`sessionIdOf`、`agentIdOf`、`sessionCwd`、`parentSessionIdOf`、`isSubagent` | 从 agent 上读会话事实（含子代理继承父 mission 的依据） |
| `types.ts` | `MissionRecord`、`SpecRecord`、`TestDesign`、`TestCase`、`EvidenceRecord`、`GateRecord`、`GateState`、`Receipt`、`StageResult`、`GitFingerprint` | 跨插件共享的值类型 |
| `testing.ts` | `createFakeHost`、`tempWorkspace`、`fakeAgent`、`runText` | 单元测试用的假宿主：`tools.register/guard/get`、`on`、`effect`、`systemPrompt.section`、`get()`、`approval.request`、`subagents.start`、`subprocess.spawn`，外加 `emit` / `waterfall`（数组 payload 会展开成多参）/ `runTool` / `sectionText` / `dispose` |

## 用法

```ts
import { MissionStoreRegistry, createLogger, expandHome, runCommand, sessionCwd } from 'dsh-eng-core'

const stores = new MissionStoreRegistry({ logger })
const store = stores.for(sessionCwd(exec.agent))     // 按工作区缓存
const mission = store.resolveForAgent(exec.agent, { explicitId: args.missionId })
store.recordGate(mission.id, { source: 'dsh-my-gate', state: 'PASS', reason, results: [] })
```

```ts
import { createFakeHost, runText } from 'dsh-eng-core/testing'

const fake = createFakeHost({ cwd: tempWorkspace(), approvalOutcome: 'allowed-once' })
apply(fake.ctx as never, { logFile: '/tmp/x.log' })
const run = await fake.runTool('my_tool', { a: 1 })
assert.match(runText(run), /ok/)
```

## 协作契约（不要改这些名字）

工件路径 `specs/<id>.md`、`missions/<id>/{mission.json,evidence.jsonl,gates/,receipts/,stages/}`、
`audit/<sessionId>.jsonl`、`state/sessions/<sessionId>.json`；
mission 字段 `spec` / `testDesign` / `stage` / `status`；
门禁三态 `PASS|WARN|BLOCK`。跨插件的工具名清单见 `docs/PLUGIN-CONVENTIONS.md` §7。

新增插件请从 `packages/dsh-spec-gate` 复制包结构。
