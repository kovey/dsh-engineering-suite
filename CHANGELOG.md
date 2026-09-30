# 变更记录

本文件的格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；
版本号遵循语义化版本。**harness 版本与套件版本是两个数字**：本版本声明并验证于 `@deepseek-ai/dsh-*` **0.2.0-rc.1**（cordis `~4.0.4`）。

## [0.2.2] — 2026-09-30

**已在 harness `0.2.0-rc.2` 上完成全量验证：零代码改动。** 这一版是"验证 + 文档"的发布，理由值得写清楚：
同一 0.2.0 线的 peer 范围 `>=0.2.0-rc.1 <0.2.1-0` **本来就匹配 rc.2**（同时匹配 0.2.0 正式版），
所以宿主升 rc 不需要重发插件——这是放弃精确锁版换来的，也应当被记录成一次"无需改动"的证据。

### 验证

- 15 个包在 rc.2 上类型编译 **0 错误**；`bash scripts/verify.sh` **830 测试 / 829 通过 / 0 失败 / 1 如实跳过**
  （含 OPS SELFTEST GREEN）；`scripts/e2e-mission.sh` 在**真机安装的 rc.2** 上 **E2E GREEN**，14/14 插件挂载并跑完一条 mission。
- 依赖的契约逐条复核（非假设）：`ApprovalOutcome` 仍四个字符串；"每个生产者声明自己的 kind、无 `plugin` 兜底"仍在；
  单调守卫语义（"no guard can force-allow"）仍在；`run_code` 仍由 `dsh-tools` 的 `config.mode` 门控（默认 `native`）；
  PTC 仍走 `prepareScheduledExecution → prepareExecution`（我们的守卫仍在链上）。

### 文档 · 官方能力缺席时的行为

- **实测降级**：真机 profile 是 **250 包的基础安装**，不含 `dsh-workspace-changes` / `dsh-experimental-agent-team` /
  `dsh-experimental-auto-review` / `dsh-ptc-runtime(-node)` / `dsh-workflow-ptc`（完整安装为 289 包）。
  两个新集成按设计显式退化并说明原因：`impact_analyze` 报
  `变更来源：git（回退：宿主没有挂载 workspaceChanges 服务…）`，`role-guard` 记 `agentTeams=absent`；
  不报错、不静默改变语义。
- `docs/VERIFICATION.md` 基线 → rc.2，并新增本次适配记录（含上面的实测数据与 250/289 对比）；
- `UPGRADE §1.8` 说明"升到 rc.2 不需要改任何声明"，以及**官方能力是可选包**——要用需显式装进 profile
  （`dsh-base` 的 patch 声明了 PTC 两行，但缺包不会自动补）。

## [0.2.1] — 2026-09-29

### 兼容与组合（官方 0.2.0 能力的采纳边界）

- **采纳**：`impact-gate` 的变更事实改用官方 `workspaceChanges`（`changeSource: 'auto' | 'workspaceChanges' | 'git'`，宿主键）。
  语义是**按轮**的：靠 `workspace/changes` 事件的 `seq` 定位、无变更的轮不产生事件、记录随会话消失。输出与工件**处处标注来源**
  （`workspaceChanges（会话 … 第 N 轮）` / `git` / `git（回退：<原因>）`）；不可用一律回退 git 并说明原因；
  与 `git diff <base>` 不一致时打印 ⚠️ 交叉核对（报告，不作为裁决）；二进制/超大文件只有路径与计数、重命名的旧路径
  无法从该服务恢复——都作为**明写的限制**而不是补出来的假数据。
- **互补（官方 spawn 对我们不可用，实测）**：官方 Agent Teams 的 `SpawnTeammateRequest` 只有
  `{name,description,prompt,context,provider,signal}`，无法表达 persona 影子段 / 工具白名单 / 模型路由 / 深度上限；
  而每个可加载角色都必须有 persona ⇒ 官方路径表达不了任何角色的策略。`role-guard` 因此**点名拒绝** `dispatch: 'team'`、
  回落自研 `subagents` 路径，并把官方创建出的 teammate 记为 **ungoverned**（`.dsh/state/teammates/<id>.json`）——
  刻意**不**声称"已阻止"：工具守卫只覆盖模型面的 `spawn_teammate`，插件直接调服务即可绕过。新增宿主键
  `composeWithAgentTeams: 'auto' | 'off'`（`off` 逐字段等于旧行为）。
- **不采纳**：官方 `auto-review` 不得接管授权。代码级核实它只返回 `deny` / `ask` / `cancel`，**从不 `allow`**；
  我们的强制拦截又是**单调守卫**（"任何守卫都可以拒绝，但没有任何守卫能强制放行"）。挂上它的后果是更严 + 更多问人 +
  更多 LLM 调用，不是绕过门禁——但它仍**不是**授权依据。
- **PTC 真机验证 + 量化**：`run_code` 只在 `dsh-tools` 的 `config.mode: 'ptc'` 下可见（默认 `native`）。打开后，
  PTC 程序里的 `await tools.write({...})` 被 spec-gate 拒绝（审计留下**子调用自己的两行**，拒绝原文与下一步提示都在），
  文件未被创建，拒绝作为程序错误传回。代价：1 次 `run_code` + 1 个子调用 = 4 行审计——治理预算要预期这个放大系数。
- **文档**：`ARCHITECTURE §5.16`（官方 vs 自研的采纳边界与守卫机制）、`UPGRADE` 的"采纳 / 不采纳"清单。

### 验证

- `bash scripts/verify.sh`：**830 测试 / 829 通过 / 0 失败 / 1 如实跳过**（含 OPS SELFTEST GREEN）。
- `scripts/e2e-mission.sh`：**E2E GREEN**，14/14 插件在 `@deepseek-ai/dsh-*` **0.2.0-rc.1** 上完成一条真实 mission。

## [0.2.0] — 2026-09-29

### 兼容基线

声明并验证于 `@deepseek-ai/dsh-*` **0.2.0-rc.1**（cordis `~4.0.4`）；peer 用同一 0.2.0 线的范围
`>=0.2.0-rc.1 <0.2.1-0`。相比 0.1.7-rc.2，本轮**只有 peer 范围必须改**：15 个包零编译错误，审批四词契约、
消息来源 kind 规则、委派策略捕获与 Messages 协议都未变（详见 UPGRADE §1.6）。

### 内容

按 **六阶段（规划 / 实现 / 测试 / 交互 / 交付 / 部署）** 补齐套件：v0.1.0 覆盖了前四段中的三段半，
这一轮把**交互**与**部署**两段补上，并把"还缺什么"做成一个可回答的问题。

### 新增 · 插件（3）

| 插件 | 阶段 | 职责 | 工具 |
|---|---|---|---|
| `dsh-interaction-gate` | 交互 | 统一 ask / notify / progress；**通道可插拔**（IM 插件注册一个 channel 即可）；一次性 token；项目级审批人名单；决定台账；超时 fail-closed | `interaction_ask`、`interaction_notify`、`interaction_progress`、`interaction_status` |
| `dsh-suite-doctor` | 入口 | 一个工具回答"我们在哪、缺什么"：18 项配置/台账检查 + 运行时事实（插件挂载、阶段、待审批、通道能力）；每条发现带下一步命令 | `suite_status` |
| `dsh-deploy-gate` | 部署 | 环境清单 → go/no-go → 人工批准（生产默认要）→ argv 执行 → 上线后验证（有限重试）→ 回滚；部署台账记 revision/审批人/门禁 | `deploy_plan`、`deploy_run`、`deploy_verify`、`deploy_rollback`、`deploy_status` |

### 新增 · 机制

- **自检引擎**（`dsh-eng-core` 的 `checkWorkspace`/`renderDoctor` + `scripts/doctor.sh`）：离线可判定的部分（配置、台账、指纹陷阱、规模）与运行时事实合并成一份报告；**读不到就说 `unknown`，绝不算通过**；每条发现都给确切命令。
- **部署门禁**：编排器新增 `deploy-go` / `deploy-verified` 两种门禁种类（同一来源、最新一条必须 PASS、不早于阶段进入——与规范门禁同一套 fail-closed 规则）。**不进默认流水线**：多数 mission 不部署。
- **台账归档**（`archiveMissions` + `scripts/archive-missions.sh`）：把旧的**已交付** mission 移到 `.dsh/archive/<年-月>/`，写索引，仍可反查；未交付默认不动；只搬不删；目标冲突拒绝合并。
- **粒度忽略规则**：运行时（missions/audit/state/specs、已存在的根级 `*.jsonl`）必须被 git 忽略，配置类文件（`.dsh/*.json`、`roles/`）**不能**——否则 `requireCleanTree` 会把"每次门禁都改动工作区"报成两个不同的 diff 摘要。脚手架会自动补上正确的行，且幂等。
- **部署/交互的配置骨架**：`project-config.sh --interaction on --deploy on`；deploy 骨架默认 `environments: []`（未声明就拒绝部署）。

### 新增 · 测试有效性（P4）

- **变异测试**（`coverage-gate` 的 `mutation_check`）：16 个词法操作符，逐个变异 → 跑测试 → **按字节还原**；
  killed / survived / **run-error** 三分类，run-error 绝不算 killed 也不进分母；得分公式与两个数字一起打印；
  预算与抽样截断时如实标注"部分结果"，绝不分外推。
- **指标预算**（`quality-gate` 的 `budget_check`）：命令耗时或正则提取的数字；绝对上下限 + `maxRegressionPercent`
  对比历史最好值（点名那个值与时间）；首次运行只记录基线并如实说明"还没有数据"。
- **契约冒烟**（`quality-gate` 的 `contract_check`）：逐条断言退出码/stdout/JSON 路径（路径缺失 = 失败，不是跳过）。
- **flaky 隔离计划**（`impact-gate` 的 `flaky_plan`/`flaky_status`）：分类 + 必须有 owner 与到期时间 + 过期升级 +
  "隔离后长期未出现"提醒。
- **非功能预算进规格**：`spec_create`/`spec_amend` 接受 `budgets[]`（p95/包体积/迁移耗时…），
  随规格一起**审批**、渲染进 `## 非功能预算` 表、可关联 `requirementIds`；`spec_amend` 支持整组重声明与
  单条增改（删除作废、编号不复用）；`plan_status`/`spec_status` 显示"已验证/未验证"。
  宿主配置与规格同 id 时**宿主生效但差异被报告**（两个值都写出来）；`requireSpecBudgets`（宿主键，默认关）
  让"声明了却没验证"的预算拦住交付。
- **自检同步**：`suite_status`/`doctor.sh` 新增五项配置检查（变异/预算/契约/flaky/规格预算），未配置时如实说明"可选"。

### 修复

- **辅助裁决不得授权交付**：`budget_check`/`contract_check` 记录门禁时用 `scope.full=false`、不清 `pendingWrites`、
  reason 带前缀——否则"source 撞车 + full=true"能在没跑过宿主命令集的情况下授权交付（P4 实现时发现并固化）。
- `scripts/doctor.mjs` 的参数解析：`--json <path>` 时路径被忽略、结果报的是当前目录（看起来像"目标仓库是空的"）。
- 目录型忽略规则必须用尾斜杠查询，文件则不能带尾斜杠（两个 bug 都是在真实仓库上抓到的，不是测试里）。
- `.dsh/media/` 等只在对应插件被使用后才存在的运行时目录，改为"存在才要求忽略"（避免给每个仓库塞无效规则）。

## [0.1.0] — 2026-09-28

首个发布（v0.1.0）：11 个插件 + 1 个共享库，`verify.sh` 全绿、真机 harness 端到端可复现（11 个插件全部挂载）。
每条能力与修复都有对应的回归测试。

### 新增 · 插件（11）

| 插件 | 职责 | 主要工具 |
|---|---|---|
| `dsh-eng-core`（库） | mission 工件、确定性命令执行、git 指纹、审计 JSONL、日志、扫描器、指标、变更影响、审批契约、fake host | — |
| `dsh-role-guard` | 角色文件（persona/模型/工具/技能白名单）、最小权限派发、结构化评审服务 | `team_delegate`、`role_list` |
| `dsh-spec-gate` | 结构化规格 + 人工审批 + 写操作前置拦截 + **需求增改删** + 存量仓库规格接入 | `spec_create`、`spec_approve`、`spec_amend`、`spec_status`、`spec_bootstrap` |
| `dsh-test-design-gate` | 测试设计评审（覆盖度/三类场景/可执行性/悬挂用例） | `test_design_review`、`test_design_template` |
| `dsh-quality-gate` | 宿主配置命令的三态门禁、覆盖范围、写后 lint 回路、收尾阻断 | `quality_gate_run`、`quality_gate_status` |
| `dsh-evidence-gate` | Mission → Evidence → Gate → Receipt、fail-closed 交付清单、伪造检测 | `evidence_record`、`evidence_status`、`mission_complete` |
| `dsh-audit-trail` | 全量工具调用 JSONL、写前快照、按轮次回滚、符号链接与"回滚点后被改"保护 | `audit_report`、`audit_rewind` |
| `dsh-orchestrator` | 阶段流水线、入口/出口门禁、回退、熔断、断点恢复、**按难度选模型**、**阶段自主派发** | `orchestrate` |
| `dsh-standards-gate` | 代码规范门禁：仓库自有阈值、**基线棘轮**、度量明细、只读结构评审 | `standards_check`、`standards_bootstrap`、`standards_review`、`standards_status` |
| `dsh-impact-gate` | 变更影响分析：反向依赖闭包、最小回归测试集、风险分级 | `impact_analyze`、`impact_tests`、`impact_status` |
| `dsh-coverage-gate` | 测试有效性：四种覆盖率格式、**增量覆盖率**、flaky 检测 | `coverage_check`、`flaky_check`、`coverage_status` |
| `dsh-supply-chain-gate` | 密钥扫描（分级 + 脱敏）、新增依赖人工审批、依赖审计 | `secret_scan`、`dependency_audit`、`supply_chain_status` |

### 新增 · 机制

- **审批接缝**：所有"需要人点头"的动作走同一个 `ctx.get('approval').request(...)`；套件侧的规范化
  函数接受"四个字符串"与可选溯源对象，无法识别一律 `unavailable`（fail closed）。理由里可嵌
  ```approval-context``` 块供 IM/卡片渲染字段。
- **交付人工审批**（opt-in `requireDeliveryApproval`，默认关）：确定性清单全绿之后才问人，
  回执里带审批人与来源（进摘要，不能换人重签）。
- **规范棘轮**：基线记录"接受时有多大"，同一条违规变大即失败；已消除的自动收紧；
  放宽必须人工批准（`.dsh/**` 在信任根内）。
- **变更影响**：Go 的包目录 import、TS 相对路径、Python 包都会被解析成图；重命名同时跟随旧路径；
  判不出来的一律写明（接口分派、DI、反射、字符串查表）。
- **门禁证据**：门禁记录带 `scope`、工作区指纹；交付要求"最新一条 PASS 且不早于最新 command/test 证据"，
  手写 `gates/*.json` 视为伪造。

### 修复（对抗式审计与真机发现的真缺陷）

- **信任根是词法判定** → 工作区里的符号链接可绕过 `.dsh/**` 保护：改为按 `realpath` 判定。
- **`standards-pass` 取"最新 PASS"** → 先 PASS 后 BLOCK 仍放行；同毫秒判为新鲜：改为"最新一条必须是 PASS"，
  同毫秒按陈旧处理（与 `quality-pass` 一致）。
- **伪造的规范门禁**能被交付接受：补台账行（`kind: 'gate'` + `data.gateId`）校验。
- **度量：无花括号的单行 `if` 吞掉后面的块**（本仓库凭空报出 349 行的 `if` 块；50 条违规里 20 条是幻觉）、
  真块被首字符过滤与 300 字符窗口漏掉、Go 导出面漏统计、TS 泛型函数整体消失、括号包裹箭头幻影参数：
  按语言解析 + 用 `go/ast` 与 TypeScript 编译器 API 对账（修后与 oracle 完全一致）。
- **棘轮不带量级、已消除的 key 永久保留、账本与文字不一致**（`accept` 打印 PASS 却不写记录、
  `enforce: warn` 记 BLOCK）：全部修正并补回归。
- **项目级覆盖会重置未列字段**（把宿主 60s 超时放大成 600s）：改为逐键覆盖 + 校验。
- **密钥扫描噪声**（真实仓库 120 文件 461 条命中，多为文档 base64）：按 severity 分级，
  只有已知凭据形状阻断；熵检测按上下文降为建议级（复测阻断级 0 命中）。
- 多个 flaky（时间容差、门禁新鲜度同毫秒、`isError` 与文本拒绝混用等）修正并补测试。

### 变更 · 兼容基线（harness `>=0.1.7-rc.2 <0.1.8-0`）

- `peerDependencies` 从 `^0.1.5-rc.2` 改为**精确锁版** `0.1.7-rc.1`（cordis `~4.0.4`）：semver 规定带预发布的
  `^0.1.x-rc.y` 不匹配 `0.1.7-rc.1`，用范围会导致 `dsh plugin add` 报 peer 不满足。
- **消息来源 kind**：0.1.7 移除了共享的 `plugin` kind（每个生产者声明自己的）→ 新增
  `dsh-orchestrator/src/sources.ts`、`dsh-quality-gate/src/sources.ts`。
- **DeepSeek provider 换成 Messages 协议**（`POST /messages`、帧带 `type`、无 `[DONE]`）→
  `scripts/stub-llm.mjs` 按新协议重写，端到端验证重新可用。
- **0.1.7-rc.2：peer 版本在加载时被强制校验**（`dsh-app-boot`），锁 `0.1.7-rc.1` 的插件会被整包跳过
  （真机：11 个插件 0 挂载、工具变 `unknown tool`、端到端全红）。声明改为同一 0.1.7 线的范围
  `>=0.1.7-rc.2 <0.1.8-0`（实测真值表见 UPGRADE），同线 rc 增量自动跟随、跨 minor 必须重新验证。
- `scripts/stub-llm.mjs` 新增 `STUB_DUMP_DIR`：把每个请求体落盘，协议漂移时以原始 body 为准排查。
- 详见 [UPGRADE.md](./UPGRADE.md)。

### 验证

- `bash scripts/verify.sh`：**498 个测试 / 497 通过 / 0 失败 / 1 如实跳过**（12 个包 + 跨包集成）。
- `bash scripts/e2e-mission.sh`：**E2E GREEN**，11 个插件在真实 harness 里全部 `applied` 并跑完一条 mission。
- 真机额外校准：`golang/im`（113 个 Go 文件、1522 条导入边）与 `golang/spider` 上验证影响分析、
  目标阈值下的规范违规量、真实 `go test -coverprofile` 的覆盖率解析与增量判定。

[0.1.0]: https://github.com/kovey/dsh-engineering-suite/releases/tag/v0.1.0
