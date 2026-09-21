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
| `scan.ts` | `scanWorkspace`、`scanGaps`、`walkWorkspace`、`readCapped`、`languageOf` | 既有仓库的只读扫描：需求文档与候选条目、代码符号（函数/方法/类型/路由/CLI）、测试用例、构建文件与建议命令；再与当前 mission 工件对比得出缺口（详见下文）。`walkWorkspace` 是本包**唯一**的工作区遍历，`scan` 与 `metrics` 共用同一套边界 |
| `metrics.ts` | `measureWorkspace`、`parseBaseline`、`compareToBaseline` | 代码度量的确定性一半：文件/函数规模、嵌套深度、`if`/`else` 块行数、参数个数、导出面、模块依赖方向与导入环；输出违规清单与基线对比（详见下文） |
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

## 代码度量（metrics）

`measureWorkspace({ cwd, standards, maxFiles?, maxFileBytes?, logger? })` 是 `dsh-standards-gate` 的**测量**一半：
仓库自己声明结构标准（文件/函数行数、嵌套、`if`/`else` 块行数、参数个数、导出面、分层依赖方向），本模块负责
**如实量出来**并给出违规清单。它不调用模型、不联网、不读时钟、**不写任何文件**（基线的 `frozenAt` 时间戳由
调用方写，本模块只解析与比较）。

```ts
import { measureWorkspace, parseBaseline, compareToBaseline } from 'dsh-eng-core'

const result = measureWorkspace({
    cwd,
    standards: {
        languages: { go: { maxFileLines: 400 }, default: { maxFileLines: 300 } },
        layers: [{ path: 'internal/domain', mayImport: [] }],
        forbidCycles: true,
        exempt: ['**/*_test.go', '**/testdata/**', '**/*.gen.go'],
    },
})
const { added, known, fixed } = compareToBaseline(result.violations, parseBaseline(text))
```

| 度量项 | Go | TS/JS | Python |
|---|---|---|---|
| `lines` | 全文行数（无尾换行的最后一行也算；空文件 0 行） | 同左 | 同左 |
| `functions` | `func Name(` 与 `func (r *T) m(`（名字为 `T.m`） | `function name`、类方法（`Class.method`）、`const/let/var name = (…) => …` / `= function (…)` | 顶层与嵌套 `def`/`async def`，名字带限定（`Class.method`、`outer.inner`），单行 `def f(): pass` 也计入 |
| `functions[].lines` | 声明行 → 函数体闭合 `}` | 块体同上；表达式体（`=> expr`）近似取语句结束行 | 声明行 → 缩进块最后一行 |
| `functions[].depth` | 函数体内达到的最大花括号深度（函数体本身算 1 层） | 同左 | 函数体内相对缩进层数（`def` 自身那层不算） |
| `functions[].params` | 顶层逗号计数：`(a, b string)`=2、`(opts)`=1、`()`=0、尾逗号不算 | 同上；`Map<string, number>` 这类泛型里的逗号不算 | 同上（`self` 计入） |
| `maxDepth` | 文件最大花括号嵌套（顶层函数体=1） | 同左 | 文件最大缩进层级 |
| `ifBlocks` | `if`/`else if`/`else` 各自一条，含起止行数；没有块的单行 `if` 不记 | 同左 | `if`/`elif` → `if`，`else` → `else`；`if x: return` 这类无块单行不记 |
| `exports` | 顶层 `func`/`type`/`var`/`const` 首字母大写者（方法也算，`var (`/`const (`/`type (` 分组逐个计） | `export` 声明：`export { a, b }` 计 2，`export const a = 1, b = 2` 计 2，`export *` 计 1，`export default` 计 1 | 顶层不带下划线前缀的名字；有 `__all__` 时**再加上**其中的条目数 |
| `imports` | `go.mod` 的 module 前缀命中的导入 → 工作区相对**目录** | 只解析 `./`、`../`，按 `.ts/.tsx/.js/.mjs/.cjs`、`/index.*` 依次试探 → 命中**文件** | `from .x import y`（按点数回退目录）与工作区内存在的顶层包 → 目录或 `.py` 文件 |
| `layers` | 某层文件导入了「不在本层、也不在任何 `mayImport` 前缀下」的工作区路径 → 每条导入一条违规 | 同左 | 同左 |
| `cycle` | `forbidCycles: true` 时按 SCC 枚举简单环：旋转到字典序最小的路径开头、去重、上限 200 个 | 同左（文件粒度） | 同左（目录会展开为该目录下所有被测 `.py`） |

规则解析：`standards.languages[语言]` 优先，缺失时用 `languages.default`，两者都没有则该文件只被测量、不产生违规
（**不做逐条合并**）。`maxFileLines`/`maxExports` 的文件级违规标签为 `(file)`，其余为符号名；`maxDepth` 报告最深处的行号。
违规按 `key = rule|path|label` 排序并保证唯一（同一函数里第二个超长 `if` 块的 key 会带 `#L<行号>`）——基线棘轮
绝不能「接受」一条它没见过的新违规。

边界与保证：遍历直接复用 `scan.ts` 的 `walkWorkspace`——同样的默认忽略目录、`maxFiles`（默认 4000）、
`maxFileBytes`（默认 256 KiB）、不跟随目录符号链接；超大/不可读文件跳过（不计入 `files`，但计入
`stats.filesScanned`），畸形文件**尽力测量、绝不抛异常**（参数列表未闭合的 `func`/`def` 直接不产出符号）。
`exempt` 命中「整条路径」（`**` 可跨目录，`*` 不跨；`vendor` 这种裸目录名不匹配任何文件，要写 `vendor/**`）：
这些文件计入 `stats.exempted`、保留 `lines`（报告仍能显示体积），但不产出函数、导入与违规。
输出确定性：文件按 path、函数按 line、违规按 key、环按规范化结果排序；同一输入两次运行结果深度相等；
`stats.languages` 只统计**实际被测**的文件数（豁免文件不进这里）。

不做的事（词法度量，不是编译器）：注释与字符串会被整体屏蔽（含 `//`、`/* */`、Go 反引号原始串、Python 三引号、
TS 模板串），TS/JS 的正则字面量按「`/` 出现在运算符/开括号/逗号之后」识别并整段屏蔽；但不解析表达式、
不做类型推断。因此：不计量泛型类型参数、装饰器、匿名函数/箭头（`export default () => {}`、`x => y` 无名字）、
对象字面量里的方法、Go 的匿名 `func` 字面量、Python 的 lambda；TS 的 `import { … }` 具名导入与对象字面量
会计入花括号深度；Python 的续行（括号未闭合或行尾 `\`）不参与嵌套层级计算，单行复合语句只算它自己那一层。

真仓库抽样（2026-09，`maxFileLines 400 / maxFunctionLines 80 / maxDepth 4 / maxIfBlockLines 20`）：
`~/workspace/golang/im` 测得 113 个 Go 文件（仓库另有 945 个 `.gocache/mod` 内的依赖 `.go`，被默认忽略目录挡掉）、
1639 个函数、3133 个 `if` 块，违规 maxFileLines 22 / maxFunctionLines 29 / maxDepth 13；
`~/workspace/golang/spider` 测得 17 个 Go 文件、171 个函数、567 个 `if` 块，违规 4 / 12 / 8 / 3。
抽查 `internal/spider/spider.go`（455 行、12 个函数）与 `Run`（69→153 行 = 85 行）逐一对得上。

## 协作契约（不要改这些名字）

工件路径 `specs/<id>.md`、`missions/<id>/{mission.json,evidence.jsonl,gates/,receipts/,stages/}`、
`audit/<sessionId>.jsonl`、`state/sessions/<sessionId>.json`；
mission 字段 `spec` / `testDesign` / `stage` / `status`；
门禁三态 `PASS|WARN|BLOCK`。跨插件的工具名清单见 `docs/PLUGIN-CONVENTIONS.md` §7。

新增插件请从 `packages/dsh-spec-gate` 复制包结构。
