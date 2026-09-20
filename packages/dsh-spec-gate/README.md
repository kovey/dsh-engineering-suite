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

## 存量项目接入：`spec_bootstrap`（**模型读代码**，插件给契约与校验）

已有代码、没有规格的仓库进不了门禁（没有可审批的东西、也没有可验证的依据）。
这里**不把仓库嚼成摘要**再喂模型——智能在模型侧：它用 `read`/`grep`/`glob` 真去读代码；
插件只负责三件模型不该被托付的事：**契约、校验、边界**。

| 动作 | 做什么 |
|---|---|
| `{ action: "brief" }` | 把**写作契约**交给当前 agent：验收标准表 + 测试设计三场景五列表（前置条件 / **操作步骤** / 预期结果）+ 写法要求（必须真读代码、禁止发明、推断要标 `[推断]`、不确定标 `[待确认]`），外加**只读索引**（需求文档、已有测试、构建文件、已识别的验证命令）与已知缺口。索引只是"从哪看起"，结论必须来自模型自己读到的代码。 |
| `{ action: "draft" }` | 把同一份任务派给**只读子代理**（`toolFilter.allow = ['read','grep','glob']`，**没有 write/edit/bash**；带只读 persona 与超时），由它读代码写出草稿；父侧用与手写草稿**完全相同**的规则解析与校验，落盘 `.dsh/bootstrap/<时间戳>/spec-draft.md`。 |
| `{ action: "check" }` | 提交前自查任意草稿：行无法解析 / 行数与用例数不一致、**有 AC 没有被任何用例覆盖**、用例覆盖了不存在的 AC、**操作步骤或预期结果过短**、仍留 `[待确认]` 占位、标准没写成 `AC-001 …` 形状。 |

- 草稿落到 `.dsh/bootstrap/<时间戳>/spec-draft.md`（+ `.json`）：**不是规格**——没有 digest、不建 mission、不参与任何门禁、**零审批效力**；
- 子代理输出不可用（比如只说了几句感想）→ **如实报错并附原始输出，不写文件、不退化成脚手架**（草稿必须由读代码得出，不能由插件猜）；
- 无子代理服务 / `enabled:false` → 给出可执行的下一步（改用 `brief` 自己写）；
- 下一步固定：`spec_create` → `test_design_review` → `spec_approve`。

配置（profile 或 `<repo>/.dsh/spec-gate.json`）：

```yaml
- id: spec-gate
  config:
    bootstrap: { enabled: true, provider: spawn, readTools: [read, grep, glob],
                 timeoutMs: 600000, maxIndexEntries: 40, maxCases: 80, minTextLength: 12 }
```

## 审批是回路：先看工件，再决定

`spec_approve` 送到审批 UI 的是一份**可核对清单**（`renderApprovalPrompt()`），不是一行摘要：

```
规格审批（第 2 次送审）：<标题>
mission <id> · rev <n> · 摘要 <digest>

需求文档目录: .dsh/specs/
需求文档: .dsh/specs/<id>.md（验收标准 N 条）
  · AC-001 …
测试用例目录: .dsh/missions/<id>/
测试用例: .dsh/missions/<id>/test-design-review.md（用例 M 条，未覆盖 K）
  · TC-001 → AC-001：…
```

人工拒绝（或取消）时：

1. 记 `mission.approval = { state:'rejected', round, by, note }`，**并清空 `spec.approvedAt`**——旧审批作废；
2. 宿主装配了 `ctx.userQuestions` 时，自动问「要改什么？」（多选：验收标准 / 测试用例 / 边界与约束 / 方案 / 暂不批，可自由文本）；
3. `spec_approve` 返回人工意见与三步回路：`spec_create` 修订 → `test_design_review` → 再 `spec_approve`（第 N+1 次）；
   返回**不是错误**（拒绝是正常结果），但 mission 仍未审批，写操作保持关闭；
4. `spec_status` 显示两份工件路径与 `审批记录`（第几次、通过/打回、时间、人工意见）。

### 评审通道（`reviewChannel`）

| 值 | 行为 |
|---|---|
| `auto`（默认） | 宿主提供 nvim-tui 扩展 API（`ctx.get('nvim-tui')`）时用**评审卡片**，否则回退通用审批 seam |
| `tui` | 必须走卡片；服务缺失时**报错**而不是静默降级（"要么在 TUI 里评审，要么改配置"） |
| `approval` | 始终走通用 seam（headless / web / CI） |

**评审用的全是 nvim-tui 的公开扩展 API**（`src/review.ts`，不需要改 TUI），并且区分"记录"与"决策"：

- **决策在弹窗里**（`ui.picker` = TUI 自己的浮窗选择器，`<CR>` 确认 / `j k` 移动 / `Esc` 取消），菜单项：

  ```
  规格审批（第 N 次送审）：<标题>
    ▸ 查看需求文档（只读预览，q 关闭） — .dsh/specs/<id>.md
    ▸ 查看测试用例（只读预览，q 关闭） — .dsh/missions/<id>/test-design-review.md
    ▸ 浏览需求文档目录 — .dsh/specs/
    ▸ 浏览测试用例目录 — .dsh/missions/<id>/
    ▸ ✅ 通过并放行（之后的写操作放行）
    ▸ 🛑 打回重写（说明要改什么）
    ▸ 取消（保持未审批，稍后再审）
  ```

  **预览用的是 nvim-tui 自己的只读浮窗**（`require('dsh_tui').show_lines_float(title, lines, path)`，
  和它的设置/工作流查看器同一个表面）：nvim 原生滚动（`j/k/G/C-d`）、**`q`/`Esc` 关闭即回到原窗口**、
  `i`/`o` 可直接打开该文件编辑。**插件的评审菜单会等这个浮窗关闭后再弹**——两个浮窗叠在一起会把文档挡住；
  等不到就按 `reviewTimeoutMs` 收尾并自动关闭它。浮窗里的 `i`/`o` 会把工件**在新标签页打开**——
  这时评审菜单**不会**跟过去抢焦点，而是等你回到评审所在的标签页再出现（真机反馈：菜单立刻弹出会盖住刚打开的 buffer）。宿主没有该入口时依次退化到 `ui.panel` → `ui.float` →
  `nvim.ex('tabedit …')`（列表里不再单列"在新标签页打开"：真机确认那种打开方式会被 TUI 收回焦点而看不见）。

  **为什么不能只靠新标签页**：nvim-tui 会把插件打开的 buffer 搬进新标签页，随后把焦点收回到自己的窗口
  （输入框在主标签页），结果是"文件开了但屏幕上看不到"。这是真机踩到的坑（见
  `docs/nvim-tui-approval-review.md`）。需要正经编辑时用预览浮窗里的 `[i/o]`（`editPath` 就是工件路径）。
  选前四项只是**打开/浏览**：打开依次尝试 ①TUI 自己的公开入口 `require('dsh_tui').open_file_tab`
  （`gF` 用的就是它，在 nvim 内部执行，最可靠）②`nvim.call('fnameescape')` + `nvim.ex('tabedit …')`
  ③本地转义 + `nvim.ex`，每条 4s 超时；**成功/失败都会用 `ui.notice` 明确告知**（"已打开：<路径>" / "⚠ 打开失败：<原因>"），
  目录用 picker 列出来、
  看完菜单会再弹一次；只有"通过/打回/取消"结束等待。
- **打回**会再弹一个 picker 问原因（验收标准 / 测试用例 / 边界约束 / 方案 + 「其它」+ 「↩︎ 返回评审菜单」）；
  选"其它"则把输入框预填 `打回原因：`，让你直接在对话里说；原因会记进 `mission.approval.note`。
  **二级弹窗永远不是死路**：`Esc`/`q` 与末项「↩︎ 返回」等价——回到上级菜单且**什么都不决定**
  （早期版本里 `Esc` 会变成"无理由打回"，已修）。目录浏览同样是一个可回退的栈：
  进入子目录后 `Esc` 回到上一级目录，顶层 `Esc` 才回到评审菜单。
- **卡片只当记录**（`ui.card` 渲染在会话 feed 里）：正文是上面那份清单，动作固定 **4 个且全是"查看"**——
  nvim-tui 的卡片底部只渲染前 4 个动作（`feed.ts: actions.slice(0,4)`），把裁决放在第 5、6 位会**根本看不见**。
- 等待上限 `reviewTimeoutMs`（默认 15 分钟）；超时/取消/`Esc` = **不通过**（卡片标注"未决定/已超时"），
  并提示重新调用 `spec_approve` 即可再评审。

两个键都是 host-only 之外的可覆盖项：`<repo>/.dsh/spec-gate.json` 可以写 `reviewChannel` / `reviewTimeoutMs`。

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
