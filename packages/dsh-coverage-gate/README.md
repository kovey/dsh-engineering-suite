# dsh-coverage-gate

**测试有效性门禁**：把"测试到底测没测到"从一句自述变成**确定性门禁**。

其它门禁问的是"测试过不过"（`dsh-quality-gate`）、"做的是不是对的"（`dsh-spec-gate`/`dsh-test-design-gate`）、
"还可维护吗"（`dsh-standards-gate`）、"能不能证明"（`dsh-evidence-gate`）；这个插件问的是
**"这些测试在干活吗"**——覆盖率、**本次改动新增行**的覆盖率、以及有没有 flaky 用例。

| 问题 | 数据来源 | 判定 |
|---|---|---|
| 整体覆盖率够不够 | 宿主配置的覆盖率命令，或它产出的报告（lcov / cobertura / go-cover / istanbul-json） | `thresholds.total` |
| **这次改动的新增行**被测到了吗 | `dsh-eng-core` 的 `changedRanges()`（git diff 的新增行区间）× 报告里被插桩的行 | `thresholds.changed` |
| 有没有文件在拖后腿 | 报告里每个被插桩的文件 | `thresholds.perFile` |
| 测试稳不稳 | 同一条命令重复运行 N 次（默认 3，上限 10），按用例名比较 | `flakyPolicy` |

## 三个工具

| 工具 | 作用 |
|---|---|
| `coverage_check` | 取得报告（跑 `coverageCommand`，或读 `reportFile`）→ 解析 → 算总覆盖率 + 增量覆盖率 + 最差文件 → 与阈值比较 → 写一条 `PASS`/`BLOCK` 门禁记录（`source: dsh-coverage-gate`，带 `scope` 与 git 指纹），并把解析出的数字落成 mission 工件（`artifacts/coverage.json`）。**没有阈值、没有报告来源、报告读不到 → 直接拒绝并给出下一步**；报告解析失败 → `BLOCK` 并带上解析器的原话。 |
| `flaky_check` | 把命令重复运行 N 次（受配置上限约束），**一旦同时看到通过与失败就提前结束，并说明提前结束**；能拿到用例名就定位到用例，拿不到就诚实地说"运行器没有给出测试名，只能判定运行级不稳定"。按 `flakyPolicy` 记 `BLOCK`/`WARN`，`off` 时只报告不记录。 |
| `coverage_status` | 只读：当前生效阈值及其来源、有没有配置命令/报告、本 mission 最近一条 coverage/flaky 门禁与它的数字（并读回工件）。 |

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
    prompt: { enabled: true, order: 645 }
```

项目级可覆盖：`thresholds`、`coverageCommand`、`reportFile`、`reportFormat`、`flakyRepeats`、`flakyCommand`、
`commandTimeoutMs`、`maxOutputBytes`（这三个命令相关的键写成**显式 `null`** 表示"本仓库没有"）。
`enabled`、`logFile`、`logFileTemplate`、`layout`、`prompt`、`flakyPolicy` 是**宿主专属**：
一个仓库不能给自己关掉门禁，也不能把"flaky 仍可交付"的豁免权发给自己。

- **百分比不是数字就拒绝**：`total: 150`、`changed: "80"`、`perFile: -1` 都是带消息地丢弃该阈值，
  **绝不用默认值替代**——被静默默认化的阈值等于被静默放宽的门禁；
- 误配不会让门禁消失：项目文件不是合法 JSON、或键全被拒 → 回退 profile 配置并报告问题（来源仍写 profile）；
- **无 shell**：`coverageCommand`/`flakyCommand` 是模板，先按引号规则切成 argv（`dsh-eng-core` 的 `splitCommand`），
  再按 token 替换占位符（所以带空格的路径仍是一个 argv 元素）。`; | & $ > < \`` 与换行**一律拒绝并解释原因**：
  不经 shell 执行时它们只会被当成普通文本传给程序，与你写的命令不是一回事。占位符：
  `{reportFile}`、`{workspace}`、`{base}`、`{run}`、`{run0}`；写错的占位符会列出可用集合，不会原样传给程序。

## 门禁记录与交付

每次 `coverage_check` / `flaky_check`（`flakyPolicy ≠ off`）都会写一条 `GateRecord`
（`source: dsh-coverage-gate`，含 `scope` 与工作区指纹），因此交付侧可以要求它：

```ts
store.lastGate(missionId, { source: 'dsh-coverage-gate' })
```

读取失败、解析失败、覆盖率命令失败这类"ERROR"一律记成 **`BLOCK`**：本套件的 `GateState` 只有 `PASS`/`WARN`/`BLOCK`，
fail closed 就是 `BLOCK`——绝不出现"跑不起来所以放行"。

`scope.full` 是**能否作为交付依据**的分界线。以下任何一条成立，`scope.full=false`（裁决仍然写入、仍然能阻断，
只是不能拿来放行）：有阈值没能判定（例如没有 git 仓库算不了增量）、阈值或报告来自调用参数而非宿主配置、
`flaky_check` 提前结束或命令由调用参数提供。这条规则防的是"模型自己写一份更好看的报告/临时放宽阈值让门禁变绿"。

## 与套件其它插件的分工

| 插件 | 关系 |
|---|---|
| `dsh-quality-gate` | 两个方向：把覆盖率检查当普通门禁命令（`coverageCommand` 之外的粗粒度开关），或让本插件自己写门禁记录（更强，因为记录里带增量覆盖率与 flaky 归因） |
| `dsh-orchestrator` | 阶段离开门禁可以要求"最新一条 coverage 门禁是 PASS 且晚于本阶段进入时间"，等于把"测试有效性"纳入流水线（`scope.full=true` 才认） |
| `dsh-evidence-gate` | 交付不变式可以要求最新 coverage 门禁 PASS（与本插件记录的 `source` 对齐），缺失即 fail closed |
| `dsh-test-design-gate` | 它管"该写哪些用例"（设计覆盖度），本插件管"写了的用例到底跑到没有"（执行覆盖度）；两者都不能替代对方 |
| `dsh-standards-gate` | 都读宿主/仓库配置；它管结构，本插件管测试有效性 |
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
- 门禁只读业务代码：唯一的副作用是 mission 工件（`artifacts/coverage.json`、`artifacts/flaky.json`）与门禁记录，
  `.dsh/**` 之外一个字节都不写。
