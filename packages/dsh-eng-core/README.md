# dsh-eng-core

工程套件的共享运行时（**库，不是 Cordis 插件**：profile 的 `dsh.profile.bundles` 里不该出现它）。

唯一的例外是 `scope.ts`：它是一个**子作用域插件模块**（子路径导出 `dsh-eng-core/scope`，有 `apply()`），
由 preset 行在**子代理的 scope 里**挂载，所以它不是一个 bundle，也不是本包的入口。放在这里是因为
`dsh-role-guard`（`role:<roleId>` preset）与 `dsh-orchestrator`（`orchestrator:<role>` preset）挂的是**同一个实现**：
复制一份会让两处可以各自漂移，而漂移的后果是某个子代理带着父 Agent 的全部工具在跑。

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
| `types.ts` | `MissionRecord`、`SpecRecord`、`TestDesign`、`TestCase`、`EvidenceRecord`、`GateRecord`、`GateState`、`GateObservation`、`RuleMode`、`Receipt`、`StageResult`、`GitFingerprint` | 跨插件共享的值类型 |
| `writers.ts` | `WRITERS`、`KNOWN_GATE_IDS`、`KNOWN_EVIDENCE_WRITERS`、`MISSION_KEYS`、`KNOWN_STATE_DIRS`、`renderWriterTable` | **写入者表**：`.dsh/` 下每种状态的唯一写入者（见下文「写入者纪律」）；文档与检查读同一份真相 |
| `writer-check.ts` | `scanTrailWriters`、`writersCheck`、`WriterFinding`、`sortFindings` | `ledger.writers` 医生检查：只读扫描门禁/回执/证据/mission 形状/mandate 位置/指纹快照与未知目录，finding 按 state→path 稳定排序 |
| `rule-mode.ts` | `applyRuleModes`、`parseRuleMode`、`RULE_MODES` | 门禁规则的**模式**（`observe` / `enforce`）：observe 规则照常评估一次、把 would-be 裁决记进 `observations`，但不参与门的有效裁决；未知 mode 是配置问题并保持 enforce |
| `scan.ts` | `scanWorkspace`、`scanGaps`、`walkWorkspace`、`readCapped`、`languageOf` | 既有仓库的只读扫描：需求文档与候选条目、代码符号（函数/方法/类型/路由/CLI）、测试用例、构建文件与建议命令；再与当前 mission 工件对比得出缺口（详见下文）。`walkWorkspace` 是本包**唯一**的工作区遍历，`scan` 与 `metrics` 共用同一套边界 |
| `metrics.ts` | `measureWorkspace`、`parseBaseline`、`compareToBaseline` | 代码度量的确定性一半：文件/函数规模、嵌套深度、`if`/`else` 块行数、参数个数、导出面、模块依赖方向与导入环；输出违规清单与基线对比（详见下文）。屏蔽层、花括号结构与函数边界各自独立成一个内部模块（`metrics-text.ts` / `metrics-braces.ts` / `metrics-bodies.ts`），本文件只做语言分析与汇总 |
| `conformance.ts` | `missionConformance`、`conformanceRollup`、`conformanceOverview`、`buildConformanceContext`、`conformanceHeadline`、`HEADLINE_RANK`、`CONFORMANCE_DIMENSIONS` | **一致性总览**：一个 mission 的五个维度（授权/证据/门禁/新鲜度/一致性）+ 仓库级分布；头行 = 最差维度，`unknown` 不优于 `partial`；只读、派生、零权力（详见下文） |
| `testing.ts` | `createFakeHost`、`tempWorkspace`、`fakeAgent`、`runText` | 单元测试用的假宿主：`tools.register/guard/get`、`on`、`effect`、`systemPrompt.section`、`get()`、`approval.request`、`subagents.start`、`subprocess.spawn`，外加 `emit` / `waterfall`（数组 payload 会展开成多参）/ `runTool` / `sectionText` / `dispose` |
| `scope.ts`（子路径 `dsh-eng-core/scope`） | `apply`、`name`、`resolveScopeConfig`、`PERSONA_SECTION`、`PERSONA_ORDER`、`ScopeContextLike` | 子代理 scope 里的唯一强制点：先 `ctx.tools.restrict({allow, deny})`（宿主强制，白名单外的工具对子代理不可见）再写 persona section；能力缺失只告警、`restrict` 被拒必须抛（子代理启动失败），空白名单 `allow: []` 拒绝挂载。被 role-guard 与 orchestrator 的 preset 行**按同名挂载** |

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

## 门禁规则的模式（observe / enforce）

一条门禁规则要么通过、要么阻断，回答不了「如果我现在打开它，会拦下什么」。`rule-mode.ts` 给出
唯一的降级实现（`applyRuleModes`），规则条目因此可以带 `mode`：

- `mode` 缺省 = `enforce`：**既有行为逐字节不变**（记录里不会多出空数组）；
- `mode: 'observe'`：规则仍然**评估且只评估一次**（匹配与否都算），结果以
  `{ rule, mode: 'observe', would: 'PASS'|'WARN'|'BLOCK', reason }` 记入 `GateRecord.observations`
  （按 rule id 排序），但**不计入**门（gate）的有效裁决；它永远不会让门通过，也永远不会让门阻断；
- 未知值 = 配置问题：**保持 `enforce`**、报出可接受值，绝不静默当成 observe（否则一个拼写错误就能把门禁降级成测量）。

```ts
import { applyRuleModes } from 'dsh-eng-core'

const outcome = applyRuleModes(
    [{ id: 'shadow-test', mode: 'observe' }, { id: 'host-test' }], // 配置里的 rules
    [
        { rule: 'shadow-test', state: 'BLOCK', reason: '必需命令失败（exit=2）' },
        { rule: 'host-test', state: 'PASS', reason: '通过（exit=0）' },
    ],
)
outcome.effective.state            // 'PASS' —— 只由 enforce 规则折叠
outcome.effective.rules            // [{ rule: 'host-test', … }] —— 可以点名是谁在阻断
outcome.observations               // 影子记录（would: 'BLOCK'），按 rule id 排序
```

`effective.rules` 是**参与裁决的**规则（含没有配置条目的合成检查，例如改动文件数上限——只有被宿主
标记的规则才可能是影子）。调用方必须先把每条选中的规则都评估一次，再把裁决交给本函数：helper 不会
替任何人执行规则，因此「observe 仍然评估一次」不会被降级逻辑破坏。

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
| `functions` | `func Name(` 与 `func (r *T) m(`（名字为 `T.m`） | `function name`、类方法（`Class.method`）、`const/let/var name = (…) => …` / `= function (…)`；名字与 `(` 之间的 `<T,>` 类型参数列表允许存在，被括号或类型断言包一层的箭头（`const f = ((a, b) => c) as T`）按内层参数列表算 | 顶层与嵌套 `def`/`async def`，名字带限定（`Class.method`、`outer.inner`），单行 `def f(): pass` 也计入 |
| `functions[].lines` | 声明行 → 函数体闭合 `}` | 声明行 → **配对**的函数体闭合 `}`：返回类型（`): Promise<T> {`、`): { ok: boolean } {`、`): value is { error: string } {`）会被跳过，不会被当成函数体；表达式体（`=> expr`）取括号配平回到 0 的那一行。花括号/括号配不上的函数**不产出长度**，计入 `skippedFunctions`（见下） | 声明行 → 缩进块最后一行 |
| `functions[].depth` | 函数体内达到的最大花括号深度（函数体本身算 1 层） | 同左 | 函数体内相对缩进层数（`def` 自身那层不算） |
| `functions[].params` | 顶层逗号计数：`(a, b string)`=2、`(opts)`=1、`()`=0、尾逗号不算 | 同上；`Map<string, number>` 这类泛型里的逗号不算 | 同上（`self` 计入） |
| `maxDepth` | 文件最大花括号嵌套（顶层函数体=1） | 同左 | 文件最大缩进层级 |
| `ifBlocks` | `if`/`else if`/`else` 各自一条，含起止行数；**表头是解析出来的，不是猜的**：TS/JS 要求括号条件，取配对的 `)` 之后第一个非空字符，只有 `{` 才算块；Go 无需括号，取同一逻辑行上括号深度 0 的 `{`（`if *flag {`、`if &x != nil {`、`if 1 < 2 {`、`if v := []T{1}; ok {`、`if a &&\n b {` 都能认出），条件里 init 语句的复合字面量不算块。**没有块的单语句 `if` 一行都不记**，所以它绝不会把后面某个无关的 `{` 当成自己的块。单个表头的扫描上界为 **20 行**（真实表头最长的也只有 2–3 行，含换行的复合字面量也够） | 同左 | `if`/`elif` → `if`，`else` → `else`；`if x: return` 这类无块单行不记 |
| `exports` | 顶层 `func`/`type`/`var`/`const` 首字母大写者（方法也算，`var (`/`const (`/`type (` 分组逐个计） | `export` 声明：`export { a, b }` 计 2，`export const a = 1, b = 2` 计 2，`export *` 计 1，`export default` 计 1 | 顶层不带下划线前缀的名字；有 `__all__` 时**再加上**其中的条目数 |
| `imports` | `go.mod` 的 module 前缀命中的导入 → 工作区相对**目录** | 只解析 `./`、`../`，按 `.ts/.tsx/.js/.mjs/.cjs`、`/index.*` 依次试探 → 命中**文件** | `from .x import y`（按点数回退目录）与工作区内存在的顶层包 → 目录或 `.py` 文件 |
| `layers` | 某层文件导入了「不在本层、也不在任何 `mayImport` 前缀下」的工作区路径 → 每条导入一条违规 | 同左 | 同左 |
| `cycle` | `forbidCycles: true` 时按 SCC 枚举简单环：旋转到字典序最小的路径开头、去重、上限 200 个 | 同左（文件粒度） | 同左（目录会展开为该目录下所有被测 `.py`） |

规则解析：`standards.languages[语言]` 优先，缺失时用 `languages.default`，两者都没有则该文件只被测量、不产生违规
（**不做逐条合并**）。`maxFileLines`/`maxExports` 的文件级违规标签为 `(file)`，其余为符号名；`maxDepth` 报告最深处的行号。
违规按 `key = rule|path|label` 排序并保证唯一（同一函数里第二个超长 `if` 块的 key 会带 `#L<行号>`）——基线棘轮
绝不能「接受」一条它没见过的新违规。

边界与保证：遍历直接复用 `scan.ts` 的 `walkWorkspace`，忽略目录分两类——
`node_modules`、`.git`、`.dsh`、`.gocache`、`.cache`、`__pycache__`、`.venv`、`.pnpm-store`、`.gradle`、`.m2`、
`.next`、`.nuxt`、`.turbo`、`.parcel-cache`、`.pytest_cache`、`.mypy_cache`、`.ruff_cache`、`.tmp`
这些**工具链 / VCS / 缓存目录在任何深度都忽略**（`.gocache/mod/…` 里那份仓库内 module cache 就是这样挡掉的）；
而 `dist`、`build`、`coverage`、`target`、`vendor` 这类**「可能是产物、也可能是真源码」的名字只在工作区根目录（深度 1）忽略**：
`src/build/render.go`、`pkg/coverage/report.go`、`deep/target/gen.go` 都照常被测、也照常出现在 `stats` 里（以前它们被静默跳过，
项目因此只被查了一半）。代价同样写清楚：monorepo 里 `packages/*/dist/` 这类**每包产物目录会重新被测量**，
这种仓库应在自己的 standards 里写 `exempt: ['**/dist/**']`。其余边界：`maxFiles`（默认 4000）、
`maxFileBytes`（默认 256 KiB）、不跟随目录符号链接；超大/不可读文件跳过（不计入 `files`，但计入
`stats.filesScanned`），畸形文件**尽力测量、绝不抛异常**（参数列表未闭合的 `func`/`def` 直接不产出符号）。
**长度不可知的函数不产出长度**：函数体的花括号（或参数列表）配不上时，该函数被跳过并在 `FileMetrics.skippedFunctions`
里计数——绝不把「文件剩下的部分」当成它的长度。这条规则是一次真实 bug 的结论：一段模板字符串里的 `\`` 被读成
字符串结束，紧跟其后的 `/**` 被当成块注释、把函数真正的闭合 `}` 一起屏蔽掉，于是 346 行的函数报成了 1803 行
（文件末行 − 起始行 + 1）。屏蔽层现在按「转义反引号 / `${…}` 洞 / 洞里的嵌套模板 / 正则 / 引号 / 注释」逐段跳过，
函数边界一律取配对的花括号。
`exempt` 命中「整条路径」（`**` 可跨目录，`*` 不跨；`vendor` 这种裸目录名不匹配任何文件，要写 `vendor/**`）：
这些文件计入 `stats.exempted`、保留 `lines`（报告仍能显示体积），但不产出函数、导入与违规。
输出确定性：文件按 path、函数按 line、违规按 key、环按规范化结果排序；同一输入两次运行结果深度相等；
`stats.languages` 只统计**实际被测**的文件数（豁免文件不进这里）。

不做的事（词法度量，不是编译器）：注释与字符串会被整体屏蔽（含 `//`、`/* */`、Go 反引号原始串、Python 三引号、
TS 模板串），TS/JS 的正则字面量按「`/` 出现在运算符/开括号/逗号之后」识别并整段屏蔽；但不解析表达式、
不做类型推断。因此：不把泛型类型参数计成**值**参数（`function id<T>(v: T)` 是 1 个参数，函数本身照常计入）、
不计量装饰器、匿名函数/箭头（`export default () => {}`、`x => y` 无名字）、
对象字面量里的方法、Go 的匿名 `func` 字面量、Python 的 lambda；TS 的 `import { … }` 具名导入与对象字面量
会计入花括号深度；Python 的续行（括号未闭合或行尾 `\`）不参与嵌套层级计算，单行复合语句只算它自己那一层。

真仓库抽样（2026-09，`maxFileLines 400 / maxFunctionLines 80 / maxDepth 4 / maxIfBlockLines 20`）：
`~/workspace/golang/im` 测得 113 个 Go 文件（仓库另有 945 个 `.gocache/mod` 内的依赖 `.go`，被默认忽略目录挡掉）、
1639 个函数、3138 个 `if` 块、1810 个导出，违规 maxFileLines 22 / maxFunctionLines 29 / maxDepth 13；
`~/workspace/golang/spider` 测得 17 个 Go 文件、171 个函数、571 个 `if` 块、121 个导出，违规 4 / 12 / 8 / 3。
抽查 `internal/spider/spider.go`（455 行、12 个函数）与 `Run`（69→153 行 = 85 行）逐一对得上。
这三个数（`if` 块、导出、函数）都用独立预言机核对过：`go/ast` 逐块比对两个 Go 仓库（571/571 与 3138/3138 完全一致，
超 20 行的块 3/3 一致），TypeScript 编译器 API 逐符号比对本仓库的 TS 文件。

## 一致性总览（conformance）

它回答的是**"这一次交付离规则允许的范围有多远，且能与别的 mission 比较"**——**不**回答
"能不能交付"（那个问题由门禁记录 + 回执回答，`mission_complete` 直接读它们）。

```ts
import { resolveLayout } from 'dsh-eng-core'
import { conformanceOverview, conformanceRollup, missionConformance, buildConformanceContext } from 'dsh-eng-core'

const view = conformanceOverview({ layout: resolveLayout(cwd), now: Date.now() })
view.mission    // 当前/最新 mission 的五维结论（headline + headlineReason + 每维 state/detail/facts/blind）
view.rollup     // 最新 20 个 mission 的分布（头行计数 + 每维状态计数 + trend + blind）

const context = buildConformanceContext({ layout, now })   // 只读一次：policy / 指纹 / 仓库级台账
missionConformance(context, 'M-1')                          // 单个 mission（批量时复用 context）
conformanceRollup(context, 20)                              // 分布（不传 limit 时默认 20）
```

五个维度全部由现有台账确定性算出（**不新增任何记录**）：

| 维度 | 读什么 | 取值 |
|---|---|---|
| 授权 | `mission.mandate`（强度/范围/`policyVersion`/撤回）、`legacy`、`spec.approvedAt` | `ok` / `stale:<原因>` / `legacy` / `withdrawn` / `missing` |
| 证据 | 回执、`gate.scope.full`、交付要求的门禁来源与必填证据类型 | `full` / `partial` / `absent` |
| 门禁 | `gates/*.json` 每个 `source` 的最新记录（含 `observations` 影子项） | `pass` / `warn` / `block` / `no-record` |
| 新鲜度 | `policyVersion` 与当前信任根、工作区指纹与最新门禁指纹、规范基线、知识库索引自述 | `fresh` / `stale:<原因>` / `unknown` |
| 一致性 | 回执/证据引用的工件是否存在、`evidence.jsonl` 是否可解析、`mandate.at` 与 `spec.approvedAt`、部署/发布台账引用 | `consistent` / `divergent:<原因>` / `unknown` |

**头行状态 = 最差维度**，只有四个取值：`conformant` / `partial` / `divergent` / `unknown`。
排序只写在 `HEADLINE_RANK` 一处：`divergent` < `partial` < `conformant`，并且
**`unknown` 永远不优于 `partial`**（全为未知时才输出 `unknown`）。**不做加权分数**：要比较就给
同一组维度的分布，要趋势用既有的 `metrics`。

三条边界：

1. **只读、派生、可复现**：不写任何文件；时钟由调用方注入；同一份台账 → 同一份输出（含维度顺序）；
2. **零权力**：任何门禁都不得读它（测试机械检查 `packages/*/src`：只有 eng-core / suite-doctor /
   orchestrator 出现这个名字）；`mission_complete` 的裁决不受它影响；
3. **盲区必须说出来**：每维的 `blind` 点名"没核对到什么"（未记录的 mission、legacy 授权、缺失的
   台账、读不到的索引），报告里渲染成一行 `盲区：…`；`unknown` 必须带原因，绝不输出"看起来健康"。

`stale` 的细节：授权 stale 会点名改动的信任根文件（读审批时的 `policy-fingerprint.json` 快照）；
新鲜度 stale 会点名 HEAD/分支/diff/改动数的变化、缺基线的规范阈值、或索引自述的不完整。

## 写入者纪律：每种状态只有一个写入者（`ledger.writers`）

`.dsh/` 下的每一类状态**只有一个**写入者；其他人只读，或者去求那个写入者。这条纪律一直成立，
但从来没有被写下来、也没有被检查过——而它正是整个审计故事的地基：如果任何插件（或一次手工编辑）
都能往 `gates/` 里追加一条 PASS，"这条门禁 PASS 过"就什么也不证明了。

**表就是代码**：`src/writers.ts` 的 `WRITERS`（冻结列表，`{ state, pattern, writer, checkable }`），
下面这张表由 `renderWriterTable()` 渲染，README 与检查读的是同一份真相（测试会逐行比对，文档漂移会红）。

| 状态 | 路径（相对 `.dsh/`） | 唯一写入者 | 只读可查 | 检查什么 |
|---|---|---|---|---|
| `mission` | `missions/*/mission.json` | MissionStore（dsh-eng-core，经 spec-gate / orchestrator / evidence-gate 的工具） | ✅ | 顶层键必须都在文档化的 mission 形状里；mandate 只允许出现在这里 |
| `stages` | `missions/*/stages/*.json` | dsh-orchestrator（stage 进入与结算） | — | 不查：StageResult 里没有任何写入者字段（stageId/attempt/state/route），只读扫描没有任何可以比对的 provenance：多写一次与正常结算在字节上无法区分 |
| `gates` | `missions/*/gates/*.json` | 产生这条记录的门禁本身（source 必须是该门禁的 id） | ✅ | source 必须非空，且必须是本套件真实存在的门禁 id |
| `receipts` | `missions/*/receipts/*.json` | 只有 dsh-evidence-gate（issuedBy） | ✅ | issuedBy 必须等于 dsh-evidence-gate |
| `evidence` | `missions/*/evidence.jsonl` | 记录这条证据的插件（recordedBy），只追加 | ✅ | 每行都有 recordedBy；dsh-* 形状的值必须是已知写入者（agent 身份是文档化的第二种值） |
| `impact` | `missions/*/impact/*.json` | dsh-impact-gate | — | 不查：本轮检查不覆盖——产物里其实带 plugin 字段，但约定的六条规则只覆盖 gates/receipts/evidence，检查不假装查了它 |
| `policy-fingerprint` | `missions/*/policy-fingerprint.json` | dsh-spec-gate（写一次，在 mandate 之前） | ✅ | 记录的 version/at 必须与 mandate 一致：比 mandate 新就是写了第二次 |
| `plan` | `plan.jsonl` | dsh-spec-gate | — | 不查：计划行里没有写入者字段（by 是发起的人/会话，不是插件）：只读扫描分不出是谁追加的 |
| `releases` | `releases.jsonl` | dsh-evidence-gate | — | 不查：发布行记录的是发布本身（版本/tag/mission），没有插件 id 字段：无法判定追加者 |
| `deployments` | `deployments.jsonl` | dsh-deploy-gate | — | 不查：部署行没有写入者字段：无法判定追加者 |
| `interaction` | `interaction/*.jsonl` | dsh-interaction-gate | — | 不查：提问/注意力行没有写入者字段：无法判定追加者 |
| `kb` | `kb/**` | dsh-knowledge-base | — | 不查：索引是构建产物（chunks/postings/manifest），形状里没有写入者字段：重建一次与写坏一次无法区分 |
| `trust-root` | `*.json（信任根配置）、roles/**` | 只有人（信任根；agent 的写工具一律拒绝） | — | 不查：只读扫描无法区分"人评审后写的"与"代理偷偷写的"：没有第二个记录者可以比对——这一条只能靠写工具的拒绝（guard）来保证 |

### 检查（`ledger.writers`，area `deliver`）

只读扫描，只查它能看见的部分，并且**说出来**它查的是什么：

1. 每条 `gates/*.json` 的 `source` 非空，且是本套件真实存在的门禁 id（`KNOWN_GATE_IDS`，从包里读出来的五个：
   `dsh-quality-gate` / `dsh-standards-gate` / `dsh-coverage-gate` / `dsh-supply-chain-gate` / `dsh-deploy-gate`）；
2. 每个 `receipts/*.json` 的 `issuedBy === 'dsh-evidence-gate'`；
3. 每行 `evidence.jsonl` 都有 `recordedBy`；`dsh-*` 形状的值必须是已知写入插件（`agent`/`session` 身份是
   `evidence_record` 记录"谁跑的这个工具"的第二种文档化取值，不是违规）；`kind: gate` 的行只有一个写入者
   （`MissionStore.recordGate`，它把 `recordedBy` 盖成 `source`），所以这一行的 `recordedBy` 必须是已知门禁 id，
   写成一个 agent 身份就是外来写入；
4. `mission.json` 没有文档化形状之外的顶层键（"有人在这里写了不该写的状态"的信号）；
5. `mandate` 只出现在 `mission.json` 里（没有复制进 `gates/`），且 `policy-fingerprint.json` 没有在首次写入之后
   被重写（它记录的 `at`/`version` 必须与 mandate 的 `at`/`policyVersion` 一致——比 mandate 新就是写了第二次）；
6. `.dsh/` 下不属于表、也不属于已知运行时清单的目录：报成**观察**（`recommended`），永远不是阻断项。

严重度与设计一致：**(1)-(3) 是 `required`**（门禁/回执/证据行是本套件的证据，外来写入让"这条门禁 PASS 过"失去意义），
**(4)-(6) 是 `recommended`**（可疑形状，不是已证实的外来写入）。一处刻意的加严：`mandate` 被复制进 `gates/` 是
`required`——mission 状态出现在门禁文件里，本来就是"有人往 `gates/` 里写了不该写的"，属于 (1) 的同一族。

**legacy 与违规怎么区分**（不是按时间猜，而是按"这个字段是不是该记录形状的一部分"）：

- `source`、`issuedBy`、`recordedBy` 从本套件第一次提交起就是每个写入者都会写的字段（`git log -S` 在 `types.ts`
  上可查：`6f19aed` 即有），所以"缺失"不可能是老记录 → 违规；
- `policy-fingerprint.json` 从来没有 `at` 字段（`PolicyFingerprint` 就是 `{ version, files }`），所以"没有 `at`"
  是 legacy 形状而不是缺陷：检查降级到用 `version` 与 mandate 比对，并在 detail 里说明用的是哪一种证据；
- 有 mandate 但没有快照、或有快照但没有 mandate（mandate 之前的历史审批）：没有可比对象 → 记为 `legacy` **事实**，
  绝不算违规，也绝不进 `blockers`；
- 证据行里非 `dsh-*` 的 `recordedBy`：文档化的第二种取值（跑 `evidence_record` 的 agent/session），不是 legacy 也不是违规。

`unknown`（而不是 `ok`）用在"没有任何可判断的写入"时，并一定给出原因——"还没有台账"不等于"写入纪律成立"。
finding 的顺序是确定的（先按 state：`missing` → `partial` → `unknown` → `ok`，再按 path），同一棵树两次扫描逐字节一致；
检查**只读**（测试对 `.dsh` 做前后字节快照）。

### 诚实的边界（不要弱化它）

只读扫描能抓到：**外来写入者**（不合法的 `source` / `issuedBy` / `recordedBy`）、**缺失字段**、**被复制的状态**
（mandate 出现在 `gates/`）、**被重写的写一次文件**（指纹快照比 mandate 新）、**意外的文件**（未知目录）。

它抓不到的是：**谁写了这个文件**。一条形状完全合法、但由别人写下的记录（一个"合法的谎"）在只读扫描下不可见——
这正是那些字段存在的原因：把 provenance 写进产物本身，是写入者的责任，不是扫描的责任。这一条只能靠写入者自己
记录来关闭，所以本检查的 `ok` 只意味着"没有明显的第二个写入者"，不意味着"写的人就是它声称的人"。

### 为什么不用 mtime 判断"写过两次"

文件 mtime 在 `git clone` / `cp -r` / 检出之后会被整体重置，用 mtime 判"重写"会把每个仓库都报一遍。
检查因此只用**内容**证据：快照记录的 `at`（如果有，比 mandate 新就是第二次写入）与 `version`（与 mandate 的
`policyVersion` 不一致说明它是在另一次策略指纹下重算的）。形状里没有 `at` 时（今天的形状），降级到 `version`
并在报告里说明——降级是写出来的，不是悄悄发生的。

## 协作契约（不要改这些名字）

工件路径 `specs/<id>.md`、`missions/<id>/{mission.json,evidence.jsonl,gates/,receipts/,stages/}`、
`audit/<sessionId>.jsonl`、`state/sessions/<sessionId>.json`；
mission 字段 `spec` / `testDesign` / `stage` / `status`；
门禁三态 `PASS|WARN|BLOCK`。跨插件的工具名清单见 `docs/PLUGIN-CONVENTIONS.md` §7。

新增插件请从 `packages/dsh-spec-gate` 复制包结构。
