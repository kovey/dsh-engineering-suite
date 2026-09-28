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
| **这一版套件没实现的阶段** | 阶段 → 插件表 ∩ `expectedPlugins` | 需要知道本部署装载了哪些插件 |
| **可选能力有没有装载**（补全交互/部署/入口自检的三个 bundle） | 单独一条 `runtime.mounts-optional`（⚠️ 建议，不是阻塞） | 缺哪个、缺了会怎样，只有运行时知道 |

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

## 工具面（只有一个）

| 工具 | 作用 |
|---|---|
| `suite_status({ missionId?, json? })` | 跑离线自检 → 合并运行时事实（`withRuntime`）→ 输出中文报告；`json: true` 给机器读（同一份判定）。`missionId` 不存在时**拒绝**（fail closed），而不是换一个任务报告。 |

**严格只读**：不写门禁记录、不落盘、不改 mission、不创建 `.dsh/`；也**不授予任何权限**。测试里有一条
"工作区前后逐字节一致"（对整个 `.dsh` 树做内容哈希比对，另加一条"没有台账的工作区不会长出 `.dsh/`"）。

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
    layout: { rootDir: .dsh }
    prompt: { enabled: true, order: 605 }
```

项目级 `expectedPlugins` 会贡献给："哪些插件是我这个仓库依赖的"。  
`expectedPlugins` 与 `probeTimeoutMs` 是**项目级可覆盖键**，而 `enabled` / `logFile` / `logFileTemplate` / `layout` /
`prompt` 是**宿主键**：模型改不了 `.dsh/**`，而一个能关掉自检或搬走台账的项目文件等于自我豁免。

`deploy-gate` 与 `interaction-gate` **不在**默认的十一个里（本套件的默认装载不含它们），它们连同
`suite-doctor` 一起构成"**补全某个阶段的可选 bundle**"：缺失时只报一条
`runtime.mounts-optional`（⚠️ `recommended`），逐条给出"它会补全哪个阶段 + 缺了会怎样"（例如
"deploy-gate（补全"部署"阶段；未装载）：没有它，部署只能靠人敲命令，且不产生部署门禁记录"）。
**不需要该能力的仓库应当把它当建议看**——这正是自检要做的区分：必需项阻塞，能力缺口只提示。

谁把它们写进 `expectedPlugins`（profile，或项目级并集），谁就**把它升级为必需项**：
它会作为 `runtime.plugin.<id>`（`required`）被探测，缺失即阻塞——因为那是这个部署自己声明的契约。
（"没有探测器"的插件例外：那种情况仍是建议，因为要修的是探测器而不是安装。）

`interaction` 的**事实**始终走服务探测，与插件是否在期望列表里无关。

| 键 | 项目级规则 |
|---|---|
| `expectedPlugins` | **只能做并集（收紧）**：可以加一个自己依赖的插件（报告更宽），删掉宿主期望的插件会被拒绝并记一条问题——删掉等于隐藏一个缺失的能力 |
| `probeTimeoutMs` | 正数毫秒；不可用的值保留 profile 的值并记一条问题 |

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
  `channels`/`list`，`pending()`/`pendingAsks()`/…，`ledgers()`，以及可选的 `problems()`），
  所以它换个构建时这里会如实退化成 `unknown`，而不会假装"没有通道"。

更多见 `docs/KNOWN-LIMITS.md`。
