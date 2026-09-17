# dsh-spec-gate

规格与计划门禁（`docs.md` §3.2）：**先有已审批的结构化规格，才允许动代码**。

## 职责

- `spec_create`：把任务写成结构化规格工件 —— 验收标准（`AC-00x`）、文件边界、负面约束、
  测试设计章节；落盘 `.dsh/specs/<mission-id>.md`，结构化记录写进
  `.dsh/missions/<mission-id>/mission.json`。
- `spec_approve`：请求**人工**审批（经 `ctx.approval` seam）；审批通过后 mission 变为
  `spec-approved`，写操作放行。
- `spec_status`：当前 mission / 规格 revision / 测试设计覆盖 / 最近门禁裁决 / 本会话拦截次数。
- **写操作前置拦截**：`ctx.tools.guard()` 注册单调守卫 —— 规格未审批时 `write` / `edit` 直接被拒绝，
  拒绝理由里带下一步该调用什么工具（理由写给模型看）。
- **提示注入**：把规格契约与表格格式（`SPEC_FORMAT_HINT`）写进系统提示。

## 项目级配置（同一个 dsh 进程服务多个仓库）

profile 是上限，每个仓库可以用 `.dsh/spec-gate.json` 决定**自己**被管多严：

```json
{ "enforce": false }                                  // 临时/试验仓库：不拦写，其余工具照旧可用
{ "enforceBoundaries": false, "shellPolicy": "strict" } // 边界放宽，但 shell 不可归属就拒绝
{ "writeTools": ["write", "edit", "multi_edit"] }       // 这个仓库的写类工具集
```

- 可覆盖键：`enforce`、`enforceBoundaries`、`writeTools`、`shellTools`、`shellPolicy`、`boundaryExemptPaths`、`requireTestDesign`、`approval`。
- **不可覆盖**：`enabled`、`logFile`、`rootDir`/`specsDir`/`missionsDir`（宿主决策），写了会被忽略并记日志。
- 文件本身在信任根里（`.dsh/**` 只允许派生的 `specs/*.md` 被写类工具改写），所以模型不能用 `write` 把自己的门禁关掉。
- `spec_status` 会显示 `配置来源：项目级 …/profile` 与 `enforce / 边界 / 审批模式`。

## 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `spec_create` | `title`(必填) `background` `requirements[]`(必填) `acceptanceCriteria[]`(必填) `fileBoundaries[]`(必填) `negativeConstraints[]`(必填) `testDesign` `missionId` | 新建或修订规格；缺项直接报错且**不写任何文件** |
| `spec_approve` | `missionId` `note` | 走审批 seam；被拒绝/通道缺失时 fail closed |
| `spec_status` | `missionId` | 只读汇总 |

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | |
| `logFile` | `~/.dsh/spec-gate.log` | 只写文件，绝不写 stdout |
| `enforce` | `true` | 是否拦截写类工具 |
| `enforceBoundaries` | `true` | 是否把写操作目标限制在规格的 `fileBoundaries` 内（支持 `src/**`、`*.json`、`docs` 这类写法） |
| `boundaryExemptPaths` | `[]` | 额外的放行模式（在规格边界之前判定） |
| `shellTools` | `['bash','pwsh']` | 会被分析写入目标的 shell 工具 |
| `shellPolicy` | `'targets'` | `targets`=能识别就查、查不到放行（记录盲区）；`strict`=不可归属即拒绝；`off`=不分析 shell |
| `writeTools` | `['write','edit']` | 被视为“写”的工具名 |
| `exemptTools` | `[]` | 永不检查的工具 |
| `requireTestDesign` | `'auto'` | `auto` = 只有挂了 `dsh-test-design-gate` 才要求测试设计已通过 |
| `approval` | `'seam'` | `seam` 走人工审批；`auto` 记录即通过（CI 用） |
| `rootDir` / `specsDir` / `missionsDir` | `.dsh` … | 工件布局 |
| `prompt.enabled` / `prompt.order` | `true` / `620` | 系统提示段 |

## 行为细节

- **信任根保护（审计后加固）**：`.dsh/` 下只有派生的规格工件 `specs/*.md` 允许被写类工具改写；
  `mission.json`、`state/**`、`roles/**`、`gates/`、`receipts/`、`stages/` 一律拒绝——
  一份能被被治理 Agent 改写的 `mission.json` 等于自审批。宿主需要放行时用 `boundaryExemptPaths` 显式声明。
- **mission 解析是严格的**：显式 `missionId` → 本会话绑定 → 委派父会话绑定；
  **没有**"工作区里最新的 mission"回退（否则未绑定会话会审批/汇报别人的 mission），
  绑定记录损坏时直接报错而不是另找一个。
- **工件与记录必须一致**：`spec_approve` 会重新哈希 `.dsh/specs/<id>.md` 并与 `mission.specDigest` 比对，
  在 spec_create 之外被改过的工件会拒绝审批。
- **测试设计不能静默缩水**：提交的表格行数与解析出的用例数不一致（列数不对、场景标题不识别、
  表头缺失被当数据…）时直接拒绝写入，保证人工审批的文档与提交内容一致。
- **文件边界是硬约束**：`enforceBoundaries` 打开时，边界外（含 `../` 与绝对路径逃逸）的写入被拒绝，
  拒绝理由会列出当前边界并指明"改规格 → 重新审批"的路径。边界写法：目录（`src`）、glob（`src/**`、`*.md`）、精确文件。
- **shell 写入也会被检查**：`bash`/`pwsh` 命令里的重定向（`>`/`>>`）、`tee`、`sed -i`、`rm`/`mv`/`cp`、
  `truncate`、`dd of=` 等可识别的写入目标，会与 `write`/`edit` 一样过信任根与文件边界。
  无法静态归属的命令（`git checkout`、`find -delete`、`python`/`node` 脚本…）由 `shellPolicy` 决定：
  默认 `targets` 放行但记录盲区，`strict` 直接拒绝（推荐在受控仓库里用），`off` 关闭分析。
- **负面约束的可执行子集**：`path:` / `tool:` / `cmd:` / `argv:` 四种前缀会被门禁强制
  （分别禁止路径、工具、shell 命令子串、任意工具参数正则），其余散文约束保持提示级并在
  `spec_status` 里单列（`可机器校验 N 条；仅提示级 M 条`）。
- **写类工具没有声明路径时**仍然 fail closed（拒绝），除非宿主把它放进 `exemptTools`。
- **修订即失效**：重新 `spec_create` 会把状态打回 `draft`，旧审批同时作废（人审批的是另一份文档）。
- **子 Agent 继承**：被派发的子会话通过 `session.header.parentSession` 继承父会话的 mission，
  所以实现者不会因为“没有规格”被误拒。
- **拒绝理由可执行**：理由文本直接给出下一步（`spec_create` → `test_design_review` → `spec_approve`）。

## 与其它插件的协作

- 上游：`dsh-test-design-gate` 通过 `mission.testDesign.passed` 决定能否审批。
- 下游：`dsh-quality-gate` / `dsh-evidence-gate` 读 `mission.spec` 与 `approvedAt` 做交付判定。
- 编排：`dsh-orchestrator` 的 `spec-clarify` / `spec-approve` 阶段由本插件提供能力。
