# dsh-impact-gate

**变更影响插件**：把"这次改动会影响什么、因此必须跑哪些测试"从模型的阅读变成**事实**。

其他插件回答"能不能跑"（`dsh-quality-gate`）、"做的是不是对的"（`dsh-spec-gate` / `dsh-test-design-gate`）、
"能不能证明"（`dsh-evidence-gate`）、"还可维护吗"（`dsh-standards-gate`）；这个插件回答两个**本来就可判定**的问题：

| 问题 | 判定依据（全部来自 `dsh-eng-core`，没有模型判断） |
|---|---|
| 这次改动碰到了什么？ | `changedRanges`（git diff `-U0`，带每处新增行区间）+ `analyzeImpact` 的**反向导入闭包**（谁会被波及，带距离与"经由谁"） |
| 因此必须跑哪些测试？ | 三类证据选出的测试文件：**import 了改动文件**（带距离）、**与改动文件同目录**、**与改动文件同名** |
| 用什么命令跑？ | 宿主配置的 `testCommandTemplate`（`renderTestCommand` 渲染），**插件不猜 runner** |

## 三个工具

| 工具 | 作用 |
|---|---|
| `impact_analyze({ base?, paths?, missionId? })` | 跑分析并渲染评审者会读的报告：风险等级 + 判定理由、改动文件与新增行区间、按导入距离分组的影响面、选中的测试与选中理由、以及**这次选择看不见什么**。有 mission 时把 JSON 产物写到 `.dsh/missions/<id>/impact/<stamp>.json`，并追加一条 `kind: artifact` 的证据行（`store.writeArtifact` + `store.appendEvidence`）。没有 mission 时分析照做，报告明说**没有落盘、没有记证据**。 |
| `impact_tests({ base?, paths?, template?, missionId? })` | 给出**最小回归命令**（`renderTestCommand(模板, 选中集)`）。**没配模板就拒绝执行**并给出下一步，绝不猜 runner。同时列出选中的文件与选中理由；宿主配了 `fullTestCommand` 时给出"少跑几个测试文件"的对照。 |
| `impact_status({ missionId? })` | 只读：当前生效配置（基线、`maxDistance`/`maxFiles`/`maxFileBytes`、模板是否配置、`reviewDispatch` 状态、配置来源与问题条数）、`RISK_RULES` 阈值表、以及该 mission **最新**一次分析的产物（风险、四项计数、生成时间、当时的基线）。 |

`paths` 参数声明为 `type: 'json'`：`paths: "src/a.ts"`（单字符串）、数组、以及写错类型都会到达工具本身，得到一句
可执行的中文答复，而不是被 schema 直接拒掉。显式 paths 模式**没有 diff**，因此新增行区间不可用；其中**当前不存在**
的路径会被单独列出（"计划新增"与"拼写错误"在 core 那里长得一模一样，报告必须把两者分开）。

报告与错误信息全中文、以「下一步：…」结尾并点名下一个工具调用。

## 风险阈值（`RISK_RULES`，来自 `dsh-eng-core`）

| 条件 | 等级 |
|---|---|
| 单个改动文件被 **≥ 8** 处依赖（扇入） | high |
| 影响面 **≥ 25** 个文件 | high |
| 导出面 **≥ 15** 个符号 | high |
| **没有任何测试文件**覆盖这些改动（三类证据都找不到） | high |
| 影响面 **≥ 5** 个文件 | medium |
| 导出面 **≥ 6** 个符号 | medium |
| 以上都不满足 | low |

阈值是**口径**不是配置项：改它等于改门禁口径，属于 `RISK_RULES` 的代码改动，需要 review。
风险等级是阈值判定，不是"这次改动危不危险"的判断——后者只有人能回答。

## 配置

profile（宿主上限）与 `<repo>/.dsh/impact-gate.json`（项目只能细化下列键）：

```yaml
- id: impact-gate
  config:
    enabled: true
    logFile: '~/.dsh/impact-gate.log'
    layout: { rootDir: .dsh }
    prompt: { enabled: true, order: 670 }
    maxDistance: 6                 # 反向可达的最大距离
    maxFiles: 4000                 # 一次分析的扫描上限（与规范门禁同一次走查）
    maxFileBytes: 262144
    testCommandTemplate: ''        # 默认空 = 宿主还没配；impact_tests 会拒绝执行
    # fullTestCommand: 'go test ./...'   # 可选：只用于"少跑多少"的对照
    defaultBase: HEAD              # 调用方没给 base 时用它
    reviewDispatch:                # 可选的意见层，默认关闭
      enabled: false
      provider: spawn
      # model: deepseek-chat
      timeoutMs: 600000
      maxDepth: 1
      targets: 5
```

`testCommandTemplate` 的 `{files}` 会被替换成选中文件（空格连接）；模板里没有占位符时选中文件被**追加**在末尾
（`go test`、`npx vitest run` 都接受这种写法）。示例（**由宿主选一个**，插件不会替你选）：
`go test {files}`、`node --test {files}`、`npx vitest run {files}`、`pytest {files}`、`cargo test --test {files}`。

项目级可覆盖（`PROJECT_OVERRIDABLE_KEYS`）：`testCommandTemplate`、`fullTestCommand`、`defaultBase`、`maxDistance`、
`maxFiles`、`maxFileBytes`。**拒绝并记日志**：`enabled`（项目不能把插件关掉）、`logFile`/`logFileTemplate`/`layout`、
`prompt`、`reviewDispatch`（开它会花子代理与模型调用，属**升级**，只有宿主能决定）。
值不做猜测：类型不对的键逐条记问题并**保留 profile 的值**（不是回落到插件默认值——那会悄悄放宽宿主设定的预算）。

`.dsh/**` 在 `dsh-spec-gate` 的信任根里：模板与预算由**人**提交在仓库里，模型写不了。

## 事实从哪来

```
git diff -U0 <base>            → 改动文件 + 每处新增行区间（core: changedRanges）
反向依赖图（imports）         → 传递闭包：谁会被波及，距离几跳、经由谁（core: analyzeImpact）
三类测试证据                  → imports-changed > same-package > name-match（core 的排序即优先级）
renderTestCommand(模板, 选中)  → 最小回归命令（core）
```

没有 mission 也能用（`dsh-spec-gate` 没挂载、或只是想先看一眼），只是不留痕。

## 集成点

| 插件 | 关系 |
|---|---|
| `dsh-quality-gate` | 门禁执行的是**宿主配置的固定命令集**；本插件给的是"先跑哪些"和"少跑多少的对照"。要让门禁真的只跑选中集，前提是宿主配置了 `fullTestCommand` 对照；否则门禁照旧跑全量。 |
| `dsh-spec-gate` | `.dsh/impact-gate.json` 在信任根内（模型改不了模板与预算）；本插件给出的改动集 `changed` 正是"spec 声明的文件边界有没有被越过"所需的事实，边界判定本身由 spec-gate 做。 |
| `dsh-orchestrator` | `implement` 阶段：动手前 `impact_tests`、动手后 `impact_analyze`；`quality-verify` 阶段的离开门禁仍然由质量门禁裁决，本插件不改任何阶段状态。 |
| `dsh-evidence-gate` | 每次分析追加一条 `kind: artifact` 的证据行（`artifactPath` 指向产物），交付侧可读；产物本身是 UTF-8 JSON，可 commit、可 diff。 |
| `dsh-audit-trail` | 产物落盘在 mission 目录（`.dsh/missions/<id>/impact/`），`impact_status` 只读回看；工具调用本身在审计里。 |
| `dsh-role-guard` / reviewer | `reviewDispatch`（默认关闭）派一个**只读**子代理（`allow: [read, glob, grep]`、`deny: [orchestrate]`、`maxDepth: 1`）按 rubric 回答"import 图看不见的引用方在哪里"，结论是**意见**，不改风险等级、不写门禁记录。 |
| `dsh-standards-gate` | 同一次 `maxFiles`/`maxFileBytes` 走查、同一套 `dsh-eng-core`；规范门禁看结构，本插件看影响面。 |

## 诚实的边界

- **这是文件级导入可达性，不是调用图。** 接口分派与依赖注入、反射与元编程、字符串查表（路由/事件名/配置键/迁移名）、
  动态 import 与代码生成、跨进程边界（HTTP/队列/DB schema）、模板与静态资源、非源码文件（SQL/proto/YAML）——
  这些**不产生 import 边**，报告里逐条写出，不假装覆盖。
- **`same-package` / `name-match` 是启发式兜底**，不是证据：它们服务的是"测试不 import 被测代码"的生态（Go 同包测试、
  独立集成测试）。因此选中的集合是**必要**不是**充分**；默认用途是"先跑这些"，不是"其余可以跳过"。
  跳过其余只能是宿主用 `fullTestCommand` 显式对照之后的决定，而且必须由人来拍板。
- **非 git 工作区 / 失效的 base**：core 的 `analyzeImpact` 会丢掉 `changedRanges` 的 `problem` 字段，把"diff 读不到"
  报成"没有任何测试覆盖这些改动"（一条看起来像代码问题的 high）。本插件在分析前**额外读一次 diff**，把"无法读取 diff"
  单独成节并给出 `风险：无法判定`——这是对 core 的补偿，不是 core 的行为。
- **删除的文件**不参与反向可达性（core 只从未删除文件出发）：谁引用了被删掉的文件需要人工确认，报告会点出来。
- **显式 paths 模式**没有 diff，"计划新增"与"拼写错误"在 core 眼里一样；报告会列出不存在的路径，但无法替你判断是哪一种。
- `impact_status` 读的是**产物**（`impact/<stamp>.json`）；产物是一次运行的记录，改动集变了就必须重跑，
  它不会自动失效或自动关联到最新代码指纹。
