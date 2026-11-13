# dsh-suite-doctor

**套件自检的运行时那一半**：一个入口回答"**这个项目在哪、配了什么、缺什么**"。

十一个插件各自知道自己那一角，但没人回答整体问题——所以每次接入都要手工翻 `.dsh/*.json`。离线那一半已经有了：
`dsh-eng-core` 的 `checkWorkspace()` / `renderDoctor()`（配置形状、台账陷阱、footprint），以及没有宿主也能跑的
`scripts/doctor.sh`。这个插件补的是**离线脚本看不见的事实**，并把它和离线报告合成一份判定：

| 运行时事实 | 怎么得到 | 离线脚本为什么做不到 |
|---|---|---|
| 哪些插件**真的挂载了** | 探测签名工具（`ctx.tools.get`）与插件服务（`ctx.get`）——与 `dsh-orchestrator` 同一套机制，没有第三条路 | 插件是否在线只有在活的宿主里才存在 |
| 插件**挂载了但能力不完整** | 服务或同插件的其它工具在线，而签名工具没注册 → `partial` | 只看配置文件会把这种"半挂"当成没问题 |
| 当前 **mission**（id/状态/阶段/熔断/规格已审批/最近门禁） | mission store 自己的 API（`resolveForAgent` / `lastGate`），**不手读 `mission.json`** | 会话绑定只存在于运行时 |
| **能不能问到人**、有没有人正在等回答 | `interaction` 服务（`describeAll()` / `pending()` / `ledgers()` / `problems()`） | 通道是进程内注册的 |
| **现在有没有事需要人处理**（注意力队列 + `whyYou` + 过期理由） | `interaction` 服务的 `attentions()`（派生：还在等人的提问，最老在前） | 队列要读本进程观察到的台账与 mission 状态，离线脚本没有 |
| **这一版套件没实现的阶段** | 阶段 → 插件表 ∩ `expectedPlugins` | 需要知道本部署装载了哪些插件 |
| **可选能力有没有装载**（补全交互/部署/入口自检的三个 bundle） | 单独一条 `runtime.mounts-optional`（⚠️ 建议，不是阻塞） | 缺哪个、缺了会怎样，只有运行时知道 |
| **影子规则（`observe`）会拦下什么** | 读最近 20 个 mission 的 gate 记录，按 rule id 聚合 `observations` 的 `would`（`gate.observe`，⚠️ 建议） | 需要把散在许多 `gates/*.json` 里的影子记录汇总成一个可操作的数字 |

## 六个阶段与四种状态

| 阶段 | 本套件里的实现者 | 报告里出现什么 |
|---|---|---|
| 规划 | spec-gate、test-design-gate | 规格/测试设计配置、角色文件、当前 mission |
| 实现 | quality-gate、standards-gate、supply-chain-gate | 门禁命令、规范阈值与基线、依赖审计命令 |
| 测试 | coverage-gate、impact-gate | 覆盖率来源与阈值、最小回归集模板 |
| 交互 | role-guard（+ `interaction` 服务的通道，例如 interaction-gate） | 通道能不能问人、待回答提问、插件挂载 |
| 交付 | evidence-gate、audit-trail | 必填证据类型、台账是否被 git 忽略、审计配置 |
| 部署 | orchestrator（`deploy-go` / `deploy-verified`）、deploy-gate（若本部署装载） | 部署层配置与阶段覆盖 |

六个阶段在默认十一个插件下**都**有实现者，所以 `runtime.phases` 默认不出现；某个部署把 `expectedPlugins`
收窄到覆盖不了某个阶段时，该阶段会被如实报成 ❔（"这版套件对该阶段没有门禁能力"），而不是因为"没检查"显得 ✅。
补全交互/部署/入口自检的三个 bundle 缺失时，报的是 `runtime.mounts-optional`（建议），与"阶段没实现"是两件事。

每个条目只有四种状态，与 `dsh-eng-core` 的 doctor 完全一致：

| 状态 | 含义 |
|---|---|
| ✅ `ok` | 查到了，且就绪 |
| ⚠️ `partial` | 存在但不完整（阈值没有来源、插件挂载了却没注册签名工具、有提问在等人） |
| ❌ `missing` | 必需项缺失 |
| ❔ `unknown` | **读不到**：配置解析失败，或该事实只存在于运行时而运行时没有（没有 mission 绑定、没有 `interaction` 服务、某阶段本就不在这版套件里） |

> **`unknown` 不是通过。** 它表示"没读到"，不是"没问题"。**"没有 interaction 服务"也不等于"没有通道"**：
> 前者是读不到（`unknown`），后者是读到了零个通道——报告对这两件事给不同的结论。同一把尺子也用在待回答提问上：
> `pending()` 只读**本进程见过的**交互台账，所以"它返回 `[]`"在没有 `ledgers()` 佐证时同样是 `unknown`
> （`interaction_status` 先跑一次就会让台账变得可见），只有台账确实被读过且为空，才是"没人在等回答"。
> 通道的 `reason`（例如"未实现 wait()，只能推送不能收答案"）会单列一行：它比一个 `canAsk: false` 有用得多。

## 工具面（三个）

| 工具 | 作用 |
|---|---|
| `suite_status({ missionId?, json? })` | 跑离线自检 → 合并运行时事实（`withRuntime`）→ 按"需要我 / 健康 / 一致性 / 历史"的顺序输出中文报告（见下「操作者视图」）；`json: true` 给机器读（同一份判定）。`missionId` 不存在时**拒绝**（fail closed），而不是换一个任务报告。 |
| `suite_init({ apply?, force?, only? })` | 给**当前仓库**脚手架十份门禁配置（spec / test-design / quality / standards / evidence / coverage / impact / supply-chain / interaction / deploy）。**默认 dry-run**：逐份输出 `path / action(write\|skip\|overwrite) / bytes`，不写盘；只有 `apply: true` 才写。已存在的文件默认 `skip`（这些文件是信任根，脚手架不能撤销已评审的阈值），`force: true` 才覆盖。内容按检测到的生态生成且确定性，第二次 apply 一个字节都不改（幂等）。`only` 过滤，未知/空过滤在写任何文件之前就拒绝。 |

**支持的生态（11 种）与检测依据**：`ts / js / go / py / rust / java / kotlin / csharp / php / ruby / swift`。
检测按**固定优先级**查仓库根的 manifest，第一个命中者胜出：`tsconfig(.base).json` → ts、`go.mod` → go、
`Cargo.toml` → rust、`pom.xml`/`build.gradle` → java、`build.gradle.kts` → kotlin、`*.sln`/`*.csproj` → csharp、
`composer.json` → php、`Gemfile`/`*.gemspec` → ruby、`Package.swift` → swift、`pyproject/setup.py/requirements` → py、
`package.json` → js，都没有 → ts（并明确写"这是默认值，不是检测结果"）。计划里打印**检测依据**
（`语言判定：检测依据：命中 Cargo.toml`）：多生态仓库正是静默选错的地方，一句"检测为 rust"没有依据就无法核对。

**覆盖率只给能读的格式**：覆盖率门禁只解析 lcov / cobertura / go-cover / istanbul-json。Java/Kotlin（jacoco）与
PHP（clover）的 `coverageCommand`/`reportFile` **写成空字符串**（空值 = 未配置，门禁拒绝执行），并在 `suite_init`
输出与 `docs/ARCHITECTURE.md` §5.30.1 里写明原因与出路（先用能产出 lcov/cobertura 的工具）。指向一份解析器读不懂的
报告，只会让门禁看起来"配了"。每种生态的默认命令表与结构阈值见 §5.30.1。
| `suite_config({ plugin? })` | **只读**列出十份配置与来源（`repo` 仓库文件生效 / `profile` 有文件但没有可用键 / `default` 没有仓库文件），并逐条点名"文件 + 键"：JSON 不可解析、未知顶层键（拼写错、插件根本不读）、被禁止的项目级覆盖键、越出工作区的路径值。未知 `plugin` 过滤被拒绝。 |

**`suite_status` 与 `suite_config` 严格只读**：不写门禁记录、不落盘、不改 mission、不创建 `.dsh/`；也**不授予任何权限**。
`suite_init` 是**工具层**唯一会写文件的入口（默认还不写），命令层再补一个**人**的按键改动
（`/suite set|unset`，需要人敲，模型没有对应工具）。测试里有一条"工作区前后逐字节一致"（对整个 `.dsh` 树做内容哈希比对，
另加一条"没有台账的工作区不会长出 `.dsh/`"），并钉住"工具层不引用任何写模块"。

### `/suite` 命令（人直接敲，不经过模型）

宿主挂载了 `@deepseek-ai/dsh-commands` 时，同一个插件注册 `/suite`：

```
/suite init [--apply] [--force] [--only <id,…>]   # 同 suite_init，默认 dry-run
/suite show [plugin]                              # 同 suite_config
/suite set <plugin> <key> <json-value> [--dry-run] [--allow-unknown]   # 改一个顶层键：diff + 原子写
/suite unset <plugin> <key> [--dry-run] [--allow-unknown]              # 删一个顶层键：diff + 原子写
/suite edit [plugin]                              # 在当前界面打开配置文件（打不开就给绝对路径）
/suite doctor                                     # 配置级体检（逐份：在不在、能不能解析、规范/基线/关键路径）
/suite help
```

注册走 `ctx.get('commands')`（**可选服务**，不是 `inject`），与 nvim-tui 的扩展 API 无关，所以 TUI / desktop / web
三端用的是同一个注册面；宿主没挂载注册表时**不注册、也不报错**。handler 调用的是工具同一批函数
（`planSuiteInit` / `inspectSuiteConfig` / `runSuiteHealth`），人和模型的报告不会分叉。

**`set` / `unset` 是唯一的人写入口**（工具层没有这个能力：`suite_init` / `suite_config` 仍是脚手架/只读，
`tools-scaffold.ts` 不引用任何写模块）。四条性质：

- **键由插件契约判定**：复用 `inspect.ts` 的 `classifyKey`（`suite_config` 报告用的同一个判定）。未知顶层键默认
  拒绝，`--allow-unknown` 才按字面键名写入并给出警告；`enabled` / `askTimeoutMs` / `layout` 这类宿主键
  **一律拒绝**（`--allow-unknown` 不放行）——项目不能给自己放宽上限。
- **值是完整 JSON 片段**：`true` / `123` / `"x"` / `{...}` / `[...]`；解析失败直接拒绝。值按原始文本解析
  （不做 token 重拼），字符串里的空格不会被吞掉。键是**顶层键**：嵌套字段请设置整个顶层值。
- **先 diff 再写**：逐键打印 `- 旧值` / `+ 新值`；`--dry-run` 只打印、不写盘，也不留临时文件。
- **原子替换**：先写 `<file>.tmp-<random>` 再 `renameSync` 覆盖；任一步失败都删除临时文件、原文件字节不变，
  并把失败作为命令错误返回。坏 JSON 的文件不会被"尽力改写"，而是拒绝并让你先修正它。

**`edit` 是尽力而为的 UI 路由**：有 `nvim-tui` 服务时用它的公开入口
（`require("dsh_tui").open_file_tab(<绝对路径>)`，`/settings edit` 与 `gF` 用的同一个入口；只暴露
`luaExt.call` 的宿主走 `dsh_tui.open_file_tab`），在标签页打开；desktop / web / headless 或打开失败时**不报错**，
打印绝对路径 + "在你的编辑器里打开它"，命令仍算成功（配置没有被改动）。文件不存在时提示
`/suite init --apply --only <id>`。

### 操作者视图：四个问题，按顺序

文本输出回答的是操作者的顺序，`json: true` 仍然是同一份合并报告（机器读）：

1. **现在需要我做什么？**——注意力队列（`dsh-interaction-gate` 的 `attentions()` 派生：还在等人的提问），最老在前，
   最多 10 条，超出会写"另有 N 条（共 M 条）"；每行带 `whyYou`（`decision-required` / `result-usable`）、等待时长、
   以及**带理由**的过期标注（策略版本变了 / 等太久 / mission 已结束）。过期的提问仍然列出；队列**读不到**时写"未知"
   并给出下一步——那不是"没事"，也**不会**变成一条 blocker（一次探测失败是这份报告的缺口，不是工作区的问题）。
2. **系统是否健康？**——既有的全部检查，原样给出：全绿时**只占一行**，否则输出完整报告。
3. **一致性（这一项离规则允许的范围有多远）**——当前（或最新）mission 的一致性总览（`dsh-eng-core`
   的 `conformance`）：头行状态、五个维度各一行、有盲区时一行 `盲区：…`、以及下一步。
   详见下节。
4. **历史**——只给指路（`spec_status` / `audit_report` / `orchestrate({ action: "retro" })`），不在这里重复。

测试固定住的三条不变量：**表头数字 = 显示的行数 + 隐藏的行数**；**健康状态只占一行**；**截断必须说明还有多少条**。

## 一致性（第 3 节）

这一节回答的是"**这次交付离规则允许的范围有多远**"，**不**回答"能不能交付"——后者仍只由
门禁记录 + 回执决定（`mission_complete` 直接读它们；任何门禁都不读这一节）。

它读的是当前会话的 mission（没有绑定就是最新的一个；`missionId` 显式指定优先），五个维度全部由
现有台账确定性算出（不新增记录）：

| 维度 | 读什么 | 取值 |
|---|---|---|
| 授权 | `mission.mandate`（强度/范围/策略版本/撤回）、`legacy`、`spec.approvedAt` | `ok` / `stale` / `legacy` / `withdrawn` / `missing` |
| 证据 | 回执、`gate.scope.full`、交付要求的门禁来源与必填证据类型 | `full` / `partial` / `absent` |
| 门禁 | 每个 `source` 最新记录；`observations` 里的影子 `would` **只进明细，不进裁决** | `pass` / `warn` / `block` / `no-record` |
| 新鲜度 | `policyVersion` 与当前信任根、工作区指纹与最新门禁指纹、规范基线、知识库索引自述 | `fresh` / `stale` / `unknown` |
| 一致性 | 回执/证据引用的工件是否存在、`evidence.jsonl` 是否可解析、`mandate.at` 与 `spec.approvedAt`、部署/发布台账引用 | `consistent` / `divergent` / `unknown` |

- **头行 = 最差维度**（`conformant` / `partial` / `divergent` / `unknown`），且 **`unknown` 永远不优于
  `partial`**；全为未知才输出 `unknown`。
- 每行是"状态 token + 一句可读的原因"；`legacy` 授权作为**事实**呈现（按 explicit 兼容处理），
  不计入 `divergent`。
- **盲区行**在该写的时候一定出现：缺 `plan.jsonl`/`releases.jsonl`/`deployments.jsonl`、读不到的
  mission 工件、legacy 授权没有的策略版本、索引是否落后……都点名。
- **不做加权分数**：这里只有状态，没有"总分"。要跨 mission 比较用
  `orchestrate({ action: "metrics" })` 的一致性分布。
- **只读**：这一节不写门禁、不落盘、不改 mission；测试用 `.dsh` 前后内容哈希快照断言。

## 影子聚合（`gate.observe`）

`observe` 规则是「**先测量、不拦截**」：门禁照常执行它，把它本会给出的裁决记进
`.dsh/missions/<id>/gates/<gate-id>.json` 的 `observations`，但不让它影响门的 PASS/WARN/BLOCK。
要回答「现在切 enforce 会怎样」，人需要的是**跨多次运行的统计**，所以 `suite_status` 多一条
`gate.observe` 检查（area = 测试）：

- **窗口有界且写在报告里**：最近 **20 个 mission**（按 `updatedAt` 倒序，同刻按 id），读取它们的
  **全部** gate 记录。不用"最近 30 天"：时间窗口会让同一个仓库在不同日子给出不同数字，而规则并没有变；
- 报告 `影子记录 N 条，其中 would BLOCK M 条；按规则：<id>：n 条（would BLOCK/WARN/PASS …），当前连续 k 次零差异`；
- 状态：没有任何 observe 记录 → ✅ `ok` + `recommended`；有影子记录 → ⚠️ `partial` + `recommended`；
  **永远不会是 `required`，也永远不会进 `blockers`**——影子规则是进行中的测量，不是缺陷；
- 下一步是具体数字：同一规则**连续 5 次零差异（would=PASS）**后再切 `enforce`（删掉 `mode` 或改成
  `enforce`），然后重跑一次完整 `quality_gate_run` 确认裁决仍为 PASS；
- 旧记录没有 `observations` 字段 → 按「没有观察」读取（detail 里会数出「其中 X 条旧记录没有 observations
  字段」），**不是错误**；`observations` 里无法识别的条目也只被计数并忽略，不让一份手改坏的文件把自检弄崩。

读取面是结构化的（`MissionStore.list()` + `readGates()`），所以这条检查是纯函数、测试里可用合成台账驱动。

## 配置

profile（宿主上限）：

```yaml
- id: suite-doctor
  config:
    enabled: true
    logFile: '~/.dsh/suite-doctor.log'
    expectedPlugins: [role-guard, spec-gate, test-design-gate, quality-gate, evidence-gate, audit-trail,
                      orchestrator, standards-gate, impact-gate, coverage-gate, supply-chain-gate]  # 默认即这十一个
    probeTimeoutMs: 2000          # 只作用于 interaction 探测：通道插件卡住不能把自检拖住
    probeTimeoutMsMax: 10000      # 宿主上限（宿主专属）：宿主自己也只能在上限之内调，项目级更不可能抬高它
    layout: { rootDir: .dsh }
    prompt: { enabled: true, order: 605 }
```

项目级 `expectedPlugins` 会贡献给："哪些插件是我这个仓库依赖的"。  
`expectedPlugins` 与 `probeTimeoutMs` 是**项目级可覆盖键**，而 `enabled` / `logFile` / `logFileTemplate` / `layout` /
`probeTimeoutMsMax` / `prompt` 是**宿主键**：模型改不了 `.dsh/**`，而一个能关掉自检、搬走台账或**让自检无限期等待**
的项目文件等于自我豁免。

**探测预算有两层**：真正生效的是 `min(probeTimeoutMs ?? 2000, probeTimeoutMsMax ?? 10000)`——宿主自己的 `probeTimeoutMs`
也会被上限压住（可以调低，不能超过上限），项目级只能在这个上限之内收紧。项目文件写 `probeTimeoutMs: 86400000`（24 小时）
不会让 `suite_status` 挂一天：它被压到宿主上限，并且**记一条问题**（绝不静默）：

```
<repo>/.dsh/suite-doctor.json: 项目级 probeTimeoutMs=86400000ms 超过宿主上限 10000ms，已按上限使用
```

| 键 | 项目级规则 |
|---|---|
| `expectedPlugins` | **只能做并集（收紧）**：可以加一个自己依赖的插件（报告更宽），删掉宿主期望的插件会被拒绝并记一条问题——删掉等于隐藏一个缺失的能力 |
| `probeTimeoutMs` | 正数毫秒；**超过宿主 `probeTimeoutMsMax` 会被压到上限并记一条问题**；在上限之内按项目值使用（更短的预算只是更早返回）；负数 / 0 / 非数字 / 非有限值保留 profile 的值并记一条问题 |
| `probeTimeoutMsMax` | **宿主键**：项目级写了会被拒绝（否则项目自己决定自检能等多久） |

`deploy-gate` 与 `interaction-gate` **不在**默认的十一个里（本套件的默认装载不含它们），它们连同
`suite-doctor` 一起构成"**补全某个阶段的可选 bundle**"：缺失时只报一条
`runtime.mounts-optional`（⚠️ `recommended`），逐条给出"它会补全哪个阶段 + 缺了会怎样"（例如
"deploy-gate（补全"部署"阶段；未装载）：没有它，部署只能靠人敲命令，且不产生部署门禁记录"）。
**不需要该能力的仓库应当把它当建议看**——这正是自检要做的区分：必需项阻塞，能力缺口只提示。

谁把它们写进 `expectedPlugins`（profile，或项目级并集），谁就**把它升级为必需项**：
它会作为 `runtime.plugin.<id>`（`required`）被探测，缺失即阻塞——因为那是这个部署自己声明的契约。
（"没有探测器"的插件例外：那种情况仍是建议，因为要修的是探测器而不是安装。）

`interaction` 的**事实**始终走服务探测，与插件是否在期望列表里无关。

任何不可用的值都是"**保留 profile 的值 + 报告问题**"，绝不静默回落到插件默认值。

## 与 `scripts/doctor.sh`、CI 的关系

同一份判定，两个入口：

- `scripts/doctor.sh [--json] [<repo>]`：没有活宿主，只报**离线可判定**的部分（配置、台账、footprint）；
  `exit 0` = 必需项全部就绪，`1` = 有必需项未就绪 —— 直接可做 CI 的接入门禁；
- `suite_status`：在同一份离线判定上补运行时事实。CI 里没有插件、没有 mission、没有通道，
  所以**不要**把运行时结论塞进 CI 断言：CI 断言离线部分，人在会话里看运行时部分。

报告的阻塞语义与脚本一致（`blockers` = `severity: required` 且状态不是 `ok`），所以 `json: true` 的输出可以
和 `doctor.sh --json` 用同一套解析。

## 诚实的边界

- **不会因为"没探测到"就判定插件坏了**：`missing` 只说"这里探测不到它的签名工具"，可能是因为没装、
  也可能是因为本部署把工具换名了——`partial`（服务或同插件的其它工具在线）才是"装了但能力不可用"的证据。
- **`registeredTools` 不是完整清单**：工具注册表只有 `get(name)`，没有枚举，所以报告里列的是
  "自检知道名字、且确实在"的那些工具，不是宿主的全部工具。
- **它不判对错，也不放行**：不给交付发许可、不改门禁状态、不替任何门禁下结论。要交付许可是
  `mission_complete` 的事，本插件只描述现状。
- **阶段覆盖是声明而不是证明**：`runtime.phases` 只说"这版套件里没有该阶段的插件"，
  不代表该阶段的工作被跳过了。
- **`interaction` 服务不是本套件的插件**：它的形状在这里是**结构化探测**（`describeAll()`/`describe()`/
  `channels`/`list`，`pending()`/`pendingAsks()`/…，`attentions()`/`attentionQueue()`，`ledgers()`，以及可选的 `problems()`），
  所以它换个构建时这里会如实退化成 `unknown`，而不会假装"没有通道"或"没有待办的提问"。
- **注意力队列读不到 ≠ 没事**：`attentions()` 只读本进程观察到的台账，所以空列表在没有观察到任何台账时
  报 `unknown`；读失败（一次探测超时/网络错误）只让这一节写"未知 + 下一步"，**不会**变成 blocker 或检查项。
- **过期标注不是判定**：`stale` 的理由由 `dsh-interaction-gate` 计算（策略版本/年龄/mission 已结束），
  本插件只照抄渲染；它不重新推导，也不因为过期就下任何结论。

更多见 `docs/KNOWN-LIMITS.md`。
