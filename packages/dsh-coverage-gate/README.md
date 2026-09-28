# dsh-coverage-gate

**测试有效性门禁**：把"测试到底测没测到"从一句自述变成**确定性门禁**。

其它门禁问的是"测试过不过"（`dsh-quality-gate`）、"做的是不是对的"（`dsh-spec-gate`/`dsh-test-design-gate`）、
"还可维护吗"（`dsh-standards-gate`）、"能不能证明"（`dsh-evidence-gate`）；这个插件问的是
**"这些测试在干活吗"**——覆盖率、**本次改动新增行**的覆盖率、有没有 flaky 用例，以及（可选）**改坏代码，看看有没有断言会喊**。

| 问题 | 数据来源 | 判定 |
|---|---|---|
| 整体覆盖率够不够 | 宿主配置的覆盖率命令，或它产出的报告（lcov / cobertura / go-cover / istanbul-json） | `thresholds.total` |
| **这次改动的新增行**被测到了吗 | `dsh-eng-core` 的 `changedRanges()`（git diff 的新增行区间）× 报告里被插桩的行 | `thresholds.changed` |
| 有没有文件在拖后腿 | 报告里每个被插桩的文件 | `thresholds.perFile` |
| 测试稳不稳 | 同一条命令重复运行 N 次（默认 3，上限 10），按用例名比较 | `flakyPolicy` |
| **测试真的在断言吗** | 每个变异体：改坏源码 → 跑一遍测试命令 → 按字节还原 | `mutation.thresholds` |

## 四个工具

| 工具 | 作用 |
|---|---|
| `coverage_check` | 取得报告（跑 `coverageCommand`，或读 `reportFile`）→ 解析 → 算总覆盖率 + 增量覆盖率 + 最差文件 → 与阈值比较 → 写一条 `PASS`/`BLOCK` 门禁记录（`source: dsh-coverage-gate`，带 `scope` 与 git 指纹），并把解析出的数字落成 mission 工件（`artifacts/coverage.json`）。**没有阈值、没有报告来源、报告读不到 → 直接拒绝并给出下一步**；报告解析失败 → `BLOCK` 并带上解析器的原话。 |
| `flaky_check` | 把命令重复运行 N 次（受配置上限约束），**一旦同时看到通过与失败就提前结束，并说明提前结束**；能拿到用例名就定位到用例，拿不到就诚实地说"运行器没有给出测试名，只能判定运行级不稳定"。按 `flakyPolicy` 记 `BLOCK`/`WARN`，`off` 时只报告不记录。 |
| `mutation_check` | **覆盖率说"这行跑到了"，它说"改坏它有没有断言会喊"**：在源码上生成小变异 → 写回 → 跑一次测试命令 → **按字节还原** → 判定 killed / survived / run-error，给出 `killed ÷ (killed + survived)` 与**存活变异体清单**（每一条都是一行"被执行但没被断言"的代码）。默认关闭、有上限、绝不外推。 |
| `coverage_status` | 只读：当前生效阈值及其来源、有没有配置命令/报告/flaky/mutation、本 mission 最近一条 coverage/flaky/mutation 门禁与它的数字（并读回工件）。 |

## 变异测试：覆盖率看不见的那一半

`coverage_check` 回答"这行执行过吗"。一个把每一行都跑一遍、却什么也不断言的测试套件，覆盖率可以是 100%。
变异测试用唯一机械化的方式回答另一半问题：**故意改坏源码，看测试会不会失败**。

一次 `mutation_check` 的过程（对每个变异体重复）：

```
计划 → 取源文件 → 应用一个变异（写回源码）→ 跑一次 mutation.testCommand → 按运行前的字节快照还原 → 判定
```

| 判定 | 条件 | 含义 |
|---|---|---|
| **killed** | 测试命令以非 0 退出 | 测试套件发现了这处改动（得分分子） |
| **survived** | 测试命令通过 | 没有任何断言发现它——**这就是交付物**（得分分母的另一半） |
| **run-error** | 起不来（spawn 失败）、超时、无退出码、被取消 | **未知**：既不是 kill 也不是 pass，**不计入得分**，单独列出 |

> **run-error 不是 kill**。命令没跑起来、测试套件挂死，都不构成"测试发现了问题"的证据。把它们算成
> killed 会让得分虚高到毫无意义——所以它们被单独报告，并且得分只覆盖真正跑出结论的变异体。

**得分与公式**（两个数字都打印出来）：

```
score = killed ÷ (killed + survived) = 8 ÷ (8 + 2) = 80%
run-error 3 个不计入分母（未跑到的变异体是未知，既不算杀死也不算存活）
```

### 操作符（词法替换，不是解析器）

| 组 | 操作符 id | 替换 |
|---|---|---|
| 边界/关系 | `REL_LT_TO_LE` / `REL_LE_TO_LT` / `REL_GT_TO_GE` / `REL_GE_TO_GT` | `<`↔`<=`、`>`↔`>=` |
| 等值 | `EQ_TO_NE` / `NE_TO_EQ` | `==`↔`!=` |
| 布尔 | `AND_TO_OR` / `OR_TO_AND` / `TRUE_TO_FALSE` / `FALSE_TO_TRUE` | `&&`↔`||`、`true`↔`false` |
| 算术 | `PLUS_TO_MINUS` / `MINUS_TO_PLUS` / `MUL_TO_DIV` / `DIV_TO_MUL` | `+`↔`-`、`*`↔`/` |
| 整数字面量 | `INT_INC` / `INT_DEC` | 裸整数 `n` → `n+1` / `n-1` |

- **词法，不是解析器**：每行做一次极小的字符串/注释状态机（状态跨行：块注释、多行字符串、Python 的
  `"""docstring"""` 与 `#` 注释都算），命中的字符被等长替换成空格，因此**列号与偏移量始终有效**。
  于是 `// "true"` 在注释里不会被改，`"a == b"` 在字符串里不会被改，模板字符串整体跳过。
- 但它**不理解语法**：`Array<string>` 里的 `<`、JSX 里的 `<`、Rust 的生命周期 `'a` 都只是一个字符。
  为了减少明显错误的变异，标点操作符要求左右不是更大的操作符（`+=`、`->`、`<<`、`===`、`//` 都不动），
  `true`/`false` 要求标识符边界且不是属性名（`obj.true` 不动），`n±1` 只在**裸十进制整数**上生效
  （`1.5`、`0x1f`、`x1`、`007`、16 位以上长数字都不动）。
- 每个变异体的 id 是稳定的：`<文件>:<行>:<列>:<操作符>`，例如 `src/a.ts:12:5:REL_LT_TO_LE`——评审引用
  的那一个，就是跑过的那一个。

### 哪些文件会被改

| 规则 | 说明 |
|---|---|
| `mutation.sourceGlobs` | 未配置时**按工作区实际语言探测**（复用 `dsh-eng-core` 的语言识别：ts/js/go/python），只扫真实存在的语言 |
| `changed: true` | 只变异**本次改动**的文件（`changedRanges()`，与 `coverage_check` 的增量覆盖率同一个 diff） |
| 测试文件 | **永远不参与**变异（变异测试文件等于测试"测试自己"） |
| 内置排除 | `.dsh/**`（信任根）、`.git/**`、`node_modules/**`、`vendor/**`、`dist|build|out|target|.venv|coverage/**`、`*.min.js`、`*.d.ts`、`*.pb.go`、`*_generated.go`、`*.gen.ts`、`*.generated.*` |
| `mutation.excludeGlobs` | 在上面基础上追加（项目级可覆盖） |
| 其他 | 非 UTF-8 文件、超过 `maxFileBytes` 的文件直接跳过并说明原因（文本变异会破坏字节、无法保证还原） |

### 什么时候拒绝（每次都说清下一步）

- `mutation.enabled` 不是 `true`（默认关闭：每个变异体都要跑一遍完整测试，代价是真实的）；
- 没有任何生效的变异阈值（没有阈值就没有门禁，绝不用默认值静默放行）；
- 没有测试命令：`mutation.testCommand` 未配置时，依次尝试 `flakyCommand`（宿主已经声明它是"跑测试"）
  和 `coverageCommand` **去掉覆盖率参数**（`npx vitest run --coverage` → `npx vitest run`）；两条路都不成立
  （例如 coverage 命令里没有可识别的覆盖率参数、或它用了 `{reportFile}` 这类占位符）就**拒绝并点名要配哪个键**
  ——猜"哪一部分是跑测试"等于拿一个不相干的命令当测试跑；
- 没有任何源文件匹配、或选中的文件里没有任何可应用的变异；
- `changed: true` 但工作区不是 git 仓库 / `baseRef` 读不到 diff；
- **工作区没有还原**：任何一个被改写的文件在运行后与运行前的字节快照不一致 → 抛错（`MutationRestoreError`）
  并给出恢复命令，**不给任何裁决**。

### 还原是硬性要求

本门禁会改写源码文件，因此写之前先按字节快照（`Buffer`，BOM/CRLF 一起），写入与运行都包在 `try` 里，
**`finally` 里还原**——超时、失败、取消、抛错一律还原；运行结束后再逐字节比对一次。
另外两种情况会**拒绝而不是硬还原**：文件在变异体运行期间被外部改动（既不是本工具写下的内容，也不是运行前的快照），
以及还原后仍与快照不一致。运行前就存在的未提交改动是允许的（那就是"当前这次工作"，
报告里会点名，并按快照还原）。

### 上限与"不外推"

- `mutation.maxMutants`（默认 20，硬上限 200）：可用变异体多于上限时**按文件轮转抽样**（顺序确定、不是随机，
  不会只变异字母序最靠前的文件），报告里明说"这是抽样"；
- `mutation.timeBudgetMs`（默认 10 分钟）：预算用尽就停下并报**部分结果**——"跑过 N 个、计划 M 个"；
- 得分**只覆盖实际跑过的变异体**，绝不外推；抽样、run-error、预算用尽都会让 `scope.full=false`（裁决仍写入、
  仍能阻断，只是不能作为交付依据）。

## 支持的报告格式

`reportFormat` 默认 `auto`（按内容识别），也可以显式指定：

| 格式 | 认什么 | 覆盖率单位 |
|---|---|---|
| `lcov` | `SF:` / `DA:` / `LF:` / `LH:`（同一路径的多条记录合并，`DA` 重复取最大命中） | 行 |
| `cobertura` | `<class filename=…>` 里的 `<line number=… hits=…>` | 行 |
| `go-cover` | `mode: set\|count\|atomic` + `path:startLine.startCol,endLine.endCol numStmt count` | **语句块**（`numStmt` 求和） |
| `istanbul-json` | `{"/abs/path": {statementMap, s}}`（只有 `l` 行命中表的报告也接受） | **语句** |

两点是刻意的：

- **`auto` 认不出来就是拒绝**，不是"0 个文件"：坏报告、被截断的报告、别的工具的摘要文本都以明确的 problem 收场。
  `0 个文件` 与 `0% 覆盖` 必须不是同一个裁决。
- **单位写进报告**：go-cover/istanbul 插桩的是语句块/语句，不是行；它们的数字与 lcov/cobertura 不可直接比较，
  报告与工件里都标了 `metric`。

## 增量覆盖率：只判定被插桩的行

`changedRanges()` 给新增行区间，报告给被插桩的行；两者相交的部分才能判定：

```
增量（本次改动新增行）：插桩 3 行、命中 1 行、未命中 2 行 → 33.3%
  另有 4 个新增行没有被报告插桩：不计入上面的比例，也无法判定（既不是 0% 也不是 100%）
  - src/a.js：新增 3，插桩 3，命中 1/未命中 2；未命中行 5,6
  - src/new.ts：新增 2，插桩 0，未插桩 1-2；⚠️ 报告里没有这个文件：它的新增行没有被插桩，无法判定
```

- 分母是**被插桩的新增行**，不是全部新增行：把注释、文档、未插桩分支算成 0%（或算成 100%）都是错的；
- 报告里没有的文件、只有汇总数字（`LF`/`LH`、没有逐行明细）的文件、路径匹配有歧义的文件 → 标成"无法判定"，
  并让整体判定变成 `partial`（`scope.full=false`）；
- Go 报告用 import path 命名文件（`example.com/mod/internal/a.go`），diff 用仓库相对路径（`internal/a.go`）：
  先精确匹配，再尝试**唯一的后缀匹配**，并且把这一步写进报告的说明里；有歧义就报出来，绝不猜；
- 已删除的文件不参与判定（删除由 diff/评审看），`.dsh/**` 台账、报告文件自身、日志文件不计入改动集
  （与 `dsh-quality-gate` 的改动预算同一规则：工程台账不该消耗门禁的注意力）。

## flaky：两个层级，说清是哪一个

| 层级 | 条件 | 结论 |
|---|---|---|
| 用例级 | 运行器给了用例名（`--- FAIL: TestX`、`✖ name`、`FAILED tests/x.py::test_y`、`× name`、TAP `not ok`） | 同一用例既有通过又有失败 = flaky；**每次都失败 = 稳定失败（真 bug，不是 flaky）** |
| 运行级 | 运行器只有退出码 | 有通过也有失败 = 运行级不稳定；报告会明说"运行器没有给出测试名，无法定位到具体用例"并给出让运行器输出用例名的下一步 |

- **只跑了 1 次不算结论**：单次结果无论通过还是失败都说明不了稳定性，记录为 `WARN` 且 `scope.full=false`；
- 有运行**没给出任何用例名**（编译失败、非 verbose 运行器）时，在其中失败的用例只能在"缺少对照"里
  （inconclusive）——没有被观察到通过 ≠ 通过；
- 超时按"未通过"计入，但报告里单独标出来：超时可能是慢，不能当作 flaky 的证据；
- **提前结束**：一旦同时观察到通过与失败就停止并说明（"原计划 N 次，第 k 次后提前结束"），
  门禁记录的 `scope.full=false`（提前结束不是完整运行）。

## 配置

profile（宿主上限）与 `<repo>/.dsh/coverage-gate.json`（项目级细化）：

```yaml
- id: coverage-gate
  config:
    enabled: true
    logFile: '~/.dsh/coverage-gate.log'
    logFileTemplate: '~/.dsh/logs/{project}/coverage-gate.log'   # 可选：一个进程服务多个仓库时按仓库分文件
    thresholds:
      total: 80            # 0–100 的百分比；没配置 = coverage_check 拒绝执行
      changed: 85          # 本次改动新增行
      perFile: 50          # 每个被插桩的文件
    coverageCommand: 'npx vitest run --coverage --coverage.reporter=lcov'   # 宿主命令，argv 直传（无 shell）
    reportFile: coverage/lcov.info
    reportFormat: auto     # auto | lcov | cobertura | go-cover | istanbul-json
    flakyPolicy: block     # block | warn | off
    flakyRepeats: 3        # 1–10
    flakyCommand: 'node --test test/*.test.ts'
    commandTimeoutMs: 300000
    maxOutputBytes: 64000
    mutation:                     # 默认关闭：每个变异体都要跑一遍完整测试
      enabled: false              # true 才进入门禁（仓库可以给自己打开，不能给自己关掉）
      testCommand: 'node --test test/*.test.ts'   # 未配置时见上文"什么时候拒绝"
      sourceGlobs: ['src/**/*.ts']                # 未配置时按工作区语言探测
      excludeGlobs: ['**/*.fixture.ts']           # 追加在内置排除清单之上
      operators: [relational, boolean]            # 操作符 id 或组名；留空 = 全部
      maxMutants: 20              # 1–200
      timeBudgetMs: 600000        # 一次运行的墙钟预算（下限 1000）
      baseRef: HEAD               # changed=true 时的 diff 基准
      thresholds:
        mutationScore: 60         # 变异得分下限，0–100；没配置 = mutation_check 拒绝执行
        changedMutationScore: 60  # changed=true 时优先用它（未配置则回退 mutationScore）
        maxSurvived: 5            # 存活变异体数量上限
    prompt: { enabled: true, order: 645 }
```

项目级可覆盖：`thresholds`、`coverageCommand`、`reportFile`、`reportFormat`、`flakyRepeats`、`flakyCommand`、
`commandTimeoutMs`、`maxOutputBytes`、`mutation`（这三个命令相关的键写成**显式 `null`** 表示"本仓库没有"；
`mutation.enabled` 只能**打开**：宿主已启用时项目级写 `false` 会被拒绝并保持 `true`）。
`enabled`、`logFile`、`logFileTemplate`、`layout`、`prompt`、`flakyPolicy` 是**宿主专属**：
一个仓库不能给自己关掉门禁，也不能把"flaky 仍可交付"的豁免权发给自己。

- **百分比不是数字就拒绝**：`total: 150`、`changed: "80"`、`perFile: -1`、`mutationScore: 500` 都是带消息地丢弃该阈值，
  **绝不用默认值替代**——被静默默认化的阈值等于被静默放宽的门禁；写错一个操作符名字则**整个 `operators` 被忽略**
  （只丢掉写错的那个等于静默改变门禁口径）；
- 误配不会让门禁消失：项目文件不是合法 JSON、或键全被拒 → 回退 profile 配置并报告问题（来源仍写 profile）；
- **无 shell**：`coverageCommand`/`flakyCommand`/`mutation.testCommand` 是模板，先按引号规则切成 argv（`dsh-eng-core` 的 `splitCommand`），
  再按 token 替换占位符（所以带空格的路径仍是一个 argv 元素）。`; | & $ > < \`` 与换行**一律拒绝并解释原因**：
  不经 shell 执行时它们只会被当成普通文本传给程序，与你写的命令不是一回事。占位符：
  `{reportFile}`、`{workspace}`、`{base}`、`{run}`、`{run0}`；写错的占位符会列出可用集合，不会原样传给程序。

## 门禁记录与交付

每次 `coverage_check` / `flaky_check`（`flakyPolicy ≠ off`）/ `mutation_check` 都会写一条 `GateRecord`
（`source: dsh-coverage-gate`，含 `scope` 与工作区指纹），因此交付侧可以要求它：

```ts
store.lastGate(missionId, { source: 'dsh-coverage-gate' })
```

读取失败、解析失败、覆盖率命令失败这类"ERROR"一律记成 **`BLOCK`**：本套件的 `GateState` 只有 `PASS`/`WARN`/`BLOCK`，
fail closed 就是 `BLOCK`——绝不出现"跑不起来所以放行"。

`mutation_check` 的三种状态（与其他门禁同一套词汇）：

| 状态 | 条件 |
|---|---|
| `PASS` | 配置的阈值全部达标，且每个计划中的变异体都跑出了结论 |
| `WARN` | 阈值达标，但这次**跑得不完整**：有 run-error，或时间预算用尽（得分只覆盖跑过的部分） |
| `BLOCK` | 有阈值不达标，或**什么都判定不了**（全部 run-error / 分母为 0）：不可判定就是不可判定，不能当通过 |

`scope` 记的是**真正被变异过的文件**（`selected` 是文件路径，`total` 是计划里的源文件数）。
`scope.full` 是**能否作为交付依据**的分界线。以下任何一条成立，`scope.full=false`（裁决仍然写入、仍然能阻断，
只是不能拿来放行）：有阈值没能判定（例如没有 git 仓库算不了增量）、阈值或报告来自调用参数而非宿主配置、
`flaky_check` 提前结束或命令由调用参数提供、**`mutation_check` 的变异体被上限抽样 / 预算截断 / 有 run-error /
操作符或上限由调用参数提供**。这条规则防的是"模型自己写一份更好看的报告/临时放宽阈值让门禁变绿"。

## 与套件其它插件的分工

| 插件 | 关系 |
|---|---|
| `dsh-quality-gate` | 两个方向：把覆盖率检查当普通门禁命令（`coverageCommand` 之外的粗粒度开关），或让本插件自己写门禁记录（更强，因为记录里带增量覆盖率与 flaky 归因） |
| `dsh-orchestrator` | 阶段离开门禁可以要求"最新一条 coverage 门禁是 PASS 且晚于本阶段进入时间"，等于把"测试有效性"纳入流水线（`scope.full=true` 才认） |
| `dsh-evidence-gate` | 交付不变式可以要求最新 coverage 门禁 PASS（与本插件记录的 `source` 对齐），缺失即 fail closed |
| `dsh-test-design-gate` | 它管"该写哪些用例"（设计覆盖度），本插件管"写了的用例到底跑到没有"（执行覆盖度），`mutation_check` 再往前一步问"跑到了，可断言了吗"；三者都不能替代对方 |
| `dsh-standards-gate` | 都读宿主/仓库配置；它管结构，本插件管测试有效性 |
| `dsh-impact-gate` | 都用 `changedRanges()` 算"这次改动碰了哪些文件"：它据此选要跑的测试，本插件据此选要变异的源码 |
| `dsh-spec-gate` | 保护 `.dsh/**`：阈值与项目配置在信任根里，模型写不了 |

## 诚实的边界

- **覆盖率数字不是正确性**：行被执行过 ≠ 行为正确；100% 覆盖的代码一样可以是错的。本插件只回答"这些行被测到没有"，
  正确性由质量门禁、测试设计与评审负责。
- **没有被插桩的行不能判定**：报告没有逐行明细、报告里没有这个文件、新增的注释/文档行，都标成"无法判定"，
  既不算 0% 也不算 100%。反过来，`perFile` 只对**被插桩**的文件生效（`linesFound > 0`）。
- **单位不同不可比**：go-cover 的语句块覆盖率与 lcov 的行覆盖率不是一个东西，跨语言/跨工具比较没有意义。
- **重复次数有限**：跑 3 次没观察到不稳定，不等于没有 flaky；重要的交付可以提高 `flakyRepeats`（上限 10，
  重复运行不能变成压力测试）。
- **flaky 是测试套件的缺陷**，不是产品的：不要重跑到达标、不要删掉或跳过不稳定的用例；要修它
  （隔离共享状态、注入时钟、固定随机种子、显式等待）。
- **变异得分是"套件弱点"的下界，不是质量分**：
  - **等价变异体不会被发现**（改完语义不变，例如把 `x < 0` 改成 `x <= 0` 而调用方只传正数），
    它们会被算成 survived，于是得分偏低——这是本方法的固有偏差，不是缺陷；
  - **操作符是词法的**，不是解析器：模板字符串里的 `${}` 插值整体被跳过、正则字面量可能被当成除法、
    JSX/泛型里的 `<` 只是一个字符；**语法被改坏的变异体会因为构建/编译失败而算作 killed**，于是得分偏高；
  - **跑不起来的变异体不计分**（run-error），所以覆盖率低的时候分数看着高是可能的：先看 run-error 有几个；
  - **抽样不是全量**：`maxMutants` 上限下的分数只说明那几个变异体；
  - 因此：**不要把 mutationScore 当 KPI**，要把它当成"哪里没有断言"的探针——存活变异体清单才是交付物。
- 门禁只读业务代码，唯一的例外是 `mutation_check`：它会**临时改写**源码文件，并在任何退出路径（失败/超时/取消/抛错）
  按运行前的字节快照还原，运行后再逐字节校验一次；校验不过就拒绝并给出恢复命令，**不给裁决**。
  其他副作用只有 mission 工件（`artifacts/coverage.json`、`artifacts/flaky.json`、`mutation/mutants.json`）与门禁记录。
