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
| `scan.ts` | `scanWorkspace`、`scanGaps` | 既有仓库的只读扫描：需求文档与候选条目、代码符号（函数/方法/类型/路由/CLI）、测试用例、构建文件与建议命令；再与当前 mission 工件对比得出缺口（详见下文） |
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

## 工作区扫描（scan）

`scanWorkspace({ cwd })` 对一个**已存在的仓库**做一次只读、有界、确定性的扫描，为「从既有文档/代码反推规格与
测试设计」提供证据；`scanGaps({ scan, spec, testDesign })` 再把扫描结果与当前 mission 工件对比，列出缺口。
不调用模型、不联网、不写任何文件（`.dsh/specs/*.md` 只读）。

| 检测项 | 内容 |
|---|---|
| 需求文档 | 根目录 `*.md`、任意 `README*.md`、`docs/**/*.md`（`kind` = `readme`/`docs`/`other`）以及 `.dsh/specs/*.md`（`kind` = `spec`）；ATX 标题带行号；`candidates` 取「需求/功能/要求/目标/验收/requirement/feature/goal/acceptance/must/should」类标题（祖先标题同样生效）下的列表项与短段落（≤400 字符）：去重、丢弃 <8 字符、每篇上限 200 条；整篇没有此类标题时退化为「所有列表项」 |
| 代码符号 | Go：`func`、`func (r *T) m`（接收者进 `detail`）、`type`、`func main`、`mux.HandleFunc("/x"`/`r.Get("/x"` 路由；TS/JS：`export function/const/class/interface/type/enum`、`app.get('/x'` 路由、`package.json` 的 scripts → `cli`；Python：顶层 `def`/`async def`/`class`、`@app.route('/x'` 装饰器路由 |
| 测试证据 | Go `_test.go` 的 `t.Run("…")` 与表驱动 `name: "…"`、TS/JS 的 `test/it/describe('…')`、Python 的 `def test_…`；空名与重名丢弃。Go 测试文件只贡献 cases、不进 `symbols`；它始终出现在 `tests` 里（只有裸 `func TestXxx` 时 `cases` 为空，说明「有测试但无可命名用例」） |
| 构建与命令 | 根目录构建文件清单；按 `scripts/project-config.sh` 的判定顺序给出 `{id,name,command,required,phase}`（测试必填 `gate`，lint 永不 required），可直接用于 `.dsh/quality-gate.json` |

边界与保证：默认跳过 `node_modules/.git/.dsh/dist/build/.tmp/vendor/.venv/__pycache__/target/.pnpm-store`
（`ignoreDirs` 可追加）；最多扫描 `maxFiles`（默认 4000）个文件，超出即停止并置 `stats.truncated`；
超过 `maxFileBytes`（默认 256 KiB）的文件只 `stat` 不读入内存；**不跟随目录符号链接**（成环不会挂死）；
断链、无权限、超大、乱码文件一律跳过并记 `debug` 日志——**任何情况下都返回结果**；
结果按 (path, line) 排序，同一工作区重复扫描逐字节一致。
不做的事：不解析表达式、不做类型推断与调用图；Go 路由要求「HTTP 动词选择器 + 以 `/` 开头的字面量路径」
（常量路径、`fmt.Sprintf` 拼出的路径不猜）；裸 `func TestXxx` 不算 case；`type`/`main` 符号不参与
`scanGaps.uncoveredSymbols` 统计；扫描是广度优先，深层数据目录（如 `testdata/` 大转储）不会挤掉浅层源码。

## 协作契约（不要改这些名字）

工件路径 `specs/<id>.md`、`missions/<id>/{mission.json,evidence.jsonl,gates/,receipts/,stages/}`、
`audit/<sessionId>.jsonl`、`state/sessions/<sessionId>.json`；
mission 字段 `spec` / `testDesign` / `stage` / `status`；
门禁三态 `PASS|WARN|BLOCK`。跨插件的工具名清单见 `docs/PLUGIN-CONVENTIONS.md` §7。

新增插件请从 `packages/dsh-spec-gate` 复制包结构。
