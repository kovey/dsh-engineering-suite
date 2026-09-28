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
| `flaky_plan({ missionId?, report?, runs?, command? })` | 把不稳定数据变成**计划**（确定性）：每个用例恰好落一类——稳定 / 隔离 / 查根因 / 疑似仪器（失败输出匹配 `flaky.signatures`）。数据来源二选一：`report` 指向 `dsh-coverage-gate` 的 `flaky_check` 产出的报告文件（**不 import 那个包**，文件就是接口），或本插件自己重复运行宿主配置的 `fullTestCommand`（`command` 可临时覆盖，`runs` 默认 3、夹在 2–10；同时看到通过与失败就提前结束）。计划写到 `.dsh/missions/<id>/flaky/<stamp>-plan.json` 并追加一条 `artifact` 证据行；**隔离是借款**：必须有 `owner`（`flaky.owner`，没有就**拒绝**给出隔离命令）和到期时间（`flaky.quarantineMaxDays`，默认 14 天），过期的隔离是升级项。计划会渲染"写入隔离台账"的命令，但**本插件绝不执行它**。 |
| `flaky_status({ missionId? })` | 只读：当前隔离清单（`<rootDir>/flaky-quarantine.json`，只增行 `{at, test, owner, expiresAt, reason, evidencePath}`）、**已过期**的隔离、台账里无法使用的行，以及**被隔离后最近 N 次运行再没出现过**的用例（隔离后被删除 = 覆盖静默消失）。不写任何文件。 |
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

## 不稳定用例（flaky）

`dsh-coverage-gate` 的 `flaky_check` 回答"哪些用例不稳定"；它不回答"然后呢"，也不管**隔离之后**的事。本插件接住这两件事。

**分类（每个用例恰好一类，按固定顺序判定）**

| 分类 | 判定 | 建议 |
|---|---|---|
| `stable` | 观察窗口内没失败过 | 不用管（观察次数有限，重要交付可以再跑几轮） |
| `suspect-instrumentation` | 失败输出匹配 `flaky.signatures`（默认：超时 / 端口被占用 / 时钟时区 / 网络 / 资源耗尽） | 先查环境与仪器——一条健康的用例会因为"机器的问题"被误隔离 |
| `investigate` | 失败有花样：**每次运行都失败**（那不是 flaky，是 bug），或**只在第 1 次运行失败**（setup / 排序 / 残留状态），或证据不足（有些运行没点名用例） | 去查根因，或先补齐证据 |
| `quarantine` | 失败过、但从未稳定地失败（有通过也有失败） | 隔离（借款，见下） |

**隔离是向未来借的债，不是修复**

- 每条隔离必须有 `owner` 与 `expiresAt`（`quarantineMaxDays`，默认 14 天）。没有配置 `flaky.owner` 时，
  `flaky_plan` **拒绝**给出隔离命令（"谁都不管"不是隔离，是遗忘）。
- 台账是**只增行**的 JSONL：`.dsh/flaky-quarantine.json`，每行 `{at, test, owner, expiresAt, reason, evidencePath}`
  （`at`/`expiresAt` 是 epoch ms，读取时也接受 ISO-8601 字符串）。同一用例多行时**最新一行生效**。
  没有 owner、没有到期时间、或 JSON 坏掉的行**不算隔离**，会在 `flaky_status` 里被点名为"无法使用的行"。
- **过期的隔离是升级项**：`flaky_plan` 与 `flaky_status` 都会报"这条隔离已过期：要么修，要么删，不能继续挂着"。
- 计划里渲染的写入命令（`node -e … <base64 路径> <base64 行>`，把一行 JSON 追加进 `.dsh/flaky-quarantine.json`）
  **只能由宿主/人执行**——本插件没有 shell 执行能力，也不该替人决定"让哪条用例闭嘴"。命令里的路径与行都做了 base64 编码，
  因此用例名里带 `'`、路径里带空格也照样是**一条可以直接粘贴执行**的正确命令（旧版的 `printf '…' >> 路径` 在两种情况下都会拼坏，甚至可注入）。
- **覆盖静默消失**：被隔离的用例之后被删除/改名/跳过，测试套件依然全绿，而它覆盖的东西再也没人检查。
  `flaky_status` 用最新计划产物的逐次运行点名结果回答："最近 N 次运行都没出现过"（`unseenRunsBeforeWarn`，默认 3；
  运行次数不足阈值时明说"暂不判定"，不猜）。报告模式下每次运行只带退出码、没有逐用例点名，此时**用例计数就是"观察到"的证据**：
  计数量覆盖了观察窗口的隔离用例不会被指控"覆盖正在消失"，只有报告里**完全没有出现**（或只在部分运行里出现）的用例才会被点名，
  并且会同时渲染报告自身的"无法判定"说明——数据读不懂不等于用例消失了。

报告文件的形状：认 `flaky_check` 写出的 `{ flakyTests, stableTests, inconclusiveTests, runs }`（每项 `{name, passed, failed, opaque}`），
也认 `{ tests: [{ name, runs, failures, firstFailingRun?, output?, times? }] }`（`times` 可以是次数，也可以是逐次结果数组
`[true, false, true]`，`false`/`'fail'`/`0` 记失败）或一个用例数组。读不懂的报告 = **拒绝**，
绝不读成"没有不稳定用例"；报告不带失败输出时会明说"无法判定 suspect-instrumentation"。

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
    flaky:                         # 不稳定用例策略（flaky_plan / flaky_status）
      # owner: platform-team       # 隔离的负责人；不配则 flaky_plan 拒绝给出隔离命令
      quarantineMaxDays: 14        # 隔离的最长寿命
      unseenRunsBeforeWarn: 3      # 被隔离的用例连续多少次运行没出现就告警
      # quarantineFile: .dsh/flaky-quarantine.json
      # signatures:                # 不写则用内置 5 条（超时/端口/时钟/网络/资源）
      #   - { pattern: 'ORA-\\d+', label: 数据库, advice: 先看数据库 }
```

`testCommandTemplate` 的 `{files}` 会被替换成选中文件（空格连接）；模板里没有占位符时选中文件被**追加**在末尾
（`go test`、`npx vitest run` 都接受这种写法）。示例（**由宿主选一个**，插件不会替你选）：
`go test {files}`、`node --test {files}`、`npx vitest run {files}`、`pytest {files}`、`cargo test --test {files}`。

项目级可覆盖（`PROJECT_OVERRIDABLE_KEYS`）：`testCommandTemplate`、`fullTestCommand`、`defaultBase`、`maxDistance`、
`maxFiles`、`maxFileBytes`、`flaky`。

`flaky` 里的键可以逐项细化：`owner` 与 `quarantineFile` 是仓库事实（谁负责、台账放哪）；`signatures` **整体替换**内置签名
（一个仓库的失败词汇表是仓库知识，`[]` 表示"不做签名分类"）；`quarantineMaxDays` 与 `unseenRunsBeforeWarn` 是**政策**，
**只能收紧**（比 profile 更宽松的值会被忽略并记问题）——否则"项目里把隔离期限改成一年"就能悄悄绕开隔离的到期日。`quarantineFile`
还必须是**工作区内**的路径（`../`、绝对路径、指向外面的符号链接都会保留 profile 的值并报为问题）：台账是仓库的工件，
项目把它挪出去等于把隔离记录写进别人的目录。**拒绝并记日志**：`enabled`（项目不能把插件关掉）、`logFile`/`logFileTemplate`/`layout`、
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
- **本插件不执行隔离**：它只渲染写入台账的命令。台账文件在 `.dsh/**`（信任根）之外吗？不——`flaky-quarantine.json`
  默认就在 `.dsh/` 下，模型写不了；隔离条目应当由人提交、在 code review 里被看见。
- **重复运行有上限**：`runs` 夹在 2–10 之间，同时观察到通过与失败就提前结束——flaky 检测不能变成压力测试。
  报告模式复用别人已经付过代价的运行结果（也正因如此，它不会**重新**观察一遍）。
