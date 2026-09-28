# dsh-spec-gate

规格与计划门禁（`docs.md` §3.2）：**先有已审批的结构化规格，才允许动代码**。

## 职责

- `spec_create`：把任务写成结构化规格工件 —— 验收标准（`AC-00x`）、文件边界、负面约束、
  测试设计章节；落盘 `.dsh/specs/<mission-id>.md`，结构化记录写进
  `.dsh/missions/<mission-id>/mission.json`。
- `spec_approve`：请求**人工**审批（经 `ctx.approval` seam）；审批通过后 mission 变为
  `spec-approved`，写操作放行。
- `spec_status`：当前 mission / 规格 revision / 里程碑 / 测试设计覆盖 / 最近门禁裁决 / 本会话拦截次数。
- **跨 mission 追溯**：`.dsh/plan.jsonl` 规划台账（append-only 索引）+ 只读的 `plan_status`
  （按里程碑分组的全部编号、未交付、已作废、编号 → mission 反查与冲突）。
- **架构决策记录（ADR）**：`adr_record` / `adr_list` —— `.dsh/adr/<NNNN>-<slug>.md`，编号只增不改，`supersedes` 取代。
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
                 model: deepseek-official/deepseek-v4-flash, reasoningEffort: low,
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

## 跨 mission 追溯：规划台账（`plan_status`）

规格编号只在**一个 mission 内**稳定。仓库里出现第二个 mission 之后，"这条需求在哪次改动里、
属于哪个里程碑、交了没有"就没有答案了 —— 台账补上这一层。

- **台账**：`<rootDir>/plan.jsonl`（默认 `.dsh/plan.jsonl`，append-only JSONL；键 `planFile`）。
  `spec_create` / `spec_approve` / `spec_amend` 各追加**实际发生**的转换行：

  | kind | 何时写 |
  |---|---|
  | `spec-created` | `spec_create` 写入规格（新建或整篇重写） |
  | `spec-approved` | 人工审批通过（带 `approvedBy` / 来源） |
  | `spec-amended` | `spec_amend` 成功改动一条需求或验收标准 |
  | `requirement-retired` | 该次改动**删除**了条目（`retiredRequirementIds`，编号不复用） |
  | `milestone-changed` | 里程碑发生实际变化（含 `spec_create` 首次设置） |

  行形状：`{at, kind, missionId, specId, title, milestone?, requirementIds[], criteriaIds[], retiredRequirementIds?, approvedBy?, summary}`。
  `specId` 目前等于 `missionId`（本套件的规格工件按 mission 命名），单列是为了将来解耦时不用重写台账。

- **台账写失败绝不阻断规格操作**：日志记一条，工具输出里追加
  `⚠️ 规划台账写入失败（…，已写入 i/n 行）` + "规格本身已保存"。**规格是权威，台账只是索引**
  （可以从 `.dsh/specs/*.md` 与 `mission.json` 重建）。
- **同一编号出现在多行时，最新的行胜出**（先比 `at`，同毫秒比行序）；每行都带该 revision 的
  **完整编号列表**，所以后面的 `milestone-changed` 不会丢掉前面 `spec-created` 记下的需求。
- **读取容忍截断尾行**：崩溃留下的半行会跳过并在报告里计数（`另有 N 行无法解析`）。

`plan_status({ milestone?, missionId?, json? })` 只读，把台账与 mission 存储 join 起来回答：

- 需求按**里程碑**分组（另有显式的 `无里程碑` 组），每条带 owner mission、规格状态（draft/approved）、
  交付状态（该 mission 有回执 = 已交付，回执由 `dsh-evidence-gate` 签发）；
- 显式的 **未交付** 与 **已作废** 列表；
- **编号 → mission 反查**；同一个编号被两个 mission 使用时进 **冲突** 区：**只报告，不合并**
  （编号在每个 mission 都从 `R-001`/`AC-001` 开始，所以仓库里有两个 mission 后重号是常态 ——
  这正是"引用编号必须带 mission"的原因）；
- 台账不存在时直接回答 `本仓库还没有规划台账（第一条 spec_create 会创建）`，不会假装一切正常。
- 身份是 `(mission, 编号)`：两个 mission 的 `AC-001` 是**两条需求**，不会被算成一条；
  一个 mission 内"创建 → 修改 → 换里程碑"才按"最新行胜出"折叠成一条。

### 里程碑（`milestone`）

`spec_create` / `spec_amend` 可以带 `milestone`（≤64 字符、无控制字符；`milestoneRequired: true` 时
`spec_create` 不带就直接拒绝并给出下一步）。里程碑存在 mission 的 label `milestone:<名称>` 上 ——
`MissionRecord` 是套件的共享契约，本包不扩展它 —— `spec_status` 显示当前值，`plan_status` 用它分组。

## 非功能预算：把"p95 < 50ms""包体积 ≤ 200KiB"写进规格

非功能要求以前只能写在宿主 quality-gate 的配置里：于是它不随规格审批、无法追溯到需求编号，也没人
能回答"我们哪些要求是预算、验证过没有"。`spec_create` / `spec_amend` 现在接受 `budgets`，
把它们变成规格的一部分：

```jsonc
// spec_create({ …, budgets: [ … ] })
{
  "id": "p95-health",                    // 稳定编号（同时是 quality-gate 基线历史的键），永不复用
  "name": "健康检查 p95",
  "metric": "durationMs",                // durationMs | number | bytes
  "command": "node scripts/p95.mjs",     // 不经 shell，按 argv 切分
  "regex": "p95=(\\d+)",                 // number/bytes 必填（第一个捕获组是数字）；durationMs 禁止
  "unit": "ms",
  "threshold": { "max": 50, "maxRegressionPercent": 10 },   // 至少一种界限
  "requirementIds": ["AC-003"]           // 必须存在于同一份规格；未知编号直接拒绝
}
```

- **渲染进工件**：规格 Markdown 多一节 `## 非功能预算`（表头固定：编号 / 名称 / 指标 / 阈值 / 命令 / 关联需求）。
  **没有声明就不渲染这一节**（空表格看起来像"声明过但一条都没有"）；审批提示里也会列出预算，人审批的就是这份文档。
- **fail closed，且每条拒绝都带修法**：id 不合法 / 同一份声明里重复 / 复用已作废编号 / name、command 缺失 /
  `metric` 不认识 / `number|bytes` 缺 `regex`（或 `durationMs` 带 `regex`）/ 正则无捕获组或不可编译 /
  `threshold` 一个界限都没有 / 未知字段 / `requirementIds` 指向不存在的编号 —— 任一问题都**整份拒绝**，
  且在写任何文件之前（不会留下空 mission）。`requirementIds` 可以指向需求（`R-00n`）或验收标准（`AC-00n`）。
- **编号与需求同等严格**：`spec_amend({ part: "budget", action: … })` 改 / 删单条；删除会作废编号
  （`retiredBudgets`），之后任何一次声明再用这个 id 都被拒绝（基线历史按 id 存，复用等于让旧历史冒充新预算）；
  `spec_amend({ budgets: [...] })` 是**整组重声明**（声明即现状：没列出的活预算会被删除并作废；`[]` = 全部删除；
  省略 `budgets` = 不改动）。每次改动都记进 `budgetChanges`（who/when/before→after）并**撤销审批**。
- **台账带着预算走**：每一行台账都记下那一版的 `budgetIds`（还有 `retiredBudgetIds`），
  所以"最新行胜出"不会丢掉声明；`plan_status` 按 mission 报出预算 id 与**验证状态**
  （有记录在案的预算裁决覆盖 = 已验证并给出状态/时间/来源；没有 = `未验证`）。
- **只报告，不判定**：本包不跑预算命令。真正的测量在 `dsh-quality-gate` 的 `budget_check`，
  它读本 mission 的规格、标注 `来源：规格`，并在裁决的 reason 与行里带上关联需求编号。

## 架构决策记录（`adr_record` / `adr_list`）

"选了 X 而不是 Y，因为 Z"以前只活在对话里，会话一结束就丢了。ADR 把它落成工件：

- `adr_record({ title, decision, alternatives?, consequences?, missionId?, supersedes? })`
  写 `<rootDir>/adr/<NNNN>-<slug>.md`：
  - 编号 = 现有最大编号 + 1（首条 `0001`；**不填空号、不复用**），目标路径已存在就**拒绝**
    （`writeOnce`：绝不覆盖一份已有记录）；
  - slug 取标题里的 ASCII 字母/数字/连字符（≤48），标题没有可用字符时（**CJK 标题是常态**）
    退化成 `adr-<8 位短哈希>`；
  - 正文是 Markdown，六章固定：`状态` / `背景` / `决定` / `备选方案与为什么不选` / `后果` / `证据链接`；
    文件头是一个 **fenced JSON 块**（`number` / `slug` / `title` / `recordedAt` / `missionId?` / `supersedes?`）；
  - 同时向 `<rootDir>/adr/index.jsonl` 追加一行 `{at, number, slug, path, title, missionId?, supersedes?}`。
- `supersedes` 必须指向**已存在**的编号（否则拒绝并列出已有编号）。被取代的一方**不改写**：
  只追加一行 `{…原记录的 number/slug/path/title…, supersededBy: 新编号}`。
  `adr_list` 同时读 index 的 `supersededBy` 行**和**取代方的 `supersedes` 字段，索引丢了也能从文件恢复取代关系。
- `adr_list({ query?, missionId? })` 只读，最新编号在前；`query` 大小写不敏感地匹配**标题与「决定」正文**。
- ADR **不是门禁**：不改变任何放行判定（规格才是权威）；也不是日记 —— 没有备选、以后不会有人再问的
  琐碎选择不要记。索引写失败只告警（决策文件是记录，index 只是索引）。

## 运行时（请忽略）与受评审（请提交）

`dsh-eng-core` 的 doctor 有一条 `ledger.gitignore` 检查：**运行时**目录/台账必须被 git 忽略，
否则每次运行都会弄脏工作区，交付时 `requireCleanTree` 会报"与门禁观测的指纹不一致"。

| 路径 | 性质 | 建议 |
|---|---|---|
| `.dsh/plan.jsonl` | **运行时**：每次规格转换都追加 | 加进 `.gitignore`（doctor 检查**根级**已存在的 `*.jsonl`） |
| `.dsh/missions/**`、`.dsh/state/**`、`.dsh/specs/**`、`.dsh/audit/**` | 运行时（既有约定） | 忽略 |
| `.dsh/adr/*.md` | **受评审记录**：写下就不再修改 | **提交**并评审 —— 它就是要给人看的 |
| `.dsh/adr/index.jsonl` | 索引，可从 `adr/*.md` 重建 | 提交或忽略都可以（doctor 只检查根级 `*.jsonl`）；写失败只告警 |
| `.dsh/spec-gate.json` | 信任根配置 | **提交**（doctor 的 `ledger.config-tracked` 检查） |

`.dsh/adr/` 与 `.dsh/plan.jsonl` 都在信任根里：**写类工具改不了它们**（guard 拒绝 `.dsh/**`），
只有 `adr_record` 与规格转换（插件自己，通过 store / fs）能写 —— 模型无法用 `write` 伪造一条决策记录，
也无法用 `write` 抹掉一条作废记录。ADR 与台账都不是门禁裁决，改它们不影响任何放行判定。

### 诚实边界

- 台账是**索引**，不是权威：写失败只告警、不阻断（`plan_status` 因此会少一次变更，工具输出里已说明）。
- 冲突**只报告、不自动解决**：编号在 mission 内稳定、跨 mission 不唯一，台账不会替你合并两条同名编号，
  也不会猜哪个是权威。
- "已交付"＝该 mission 有回执，不等于"每条验收标准都被验证过"；具体证据要读 mission 的
  `evidence.jsonl` 与回执。
- ADR 的 `状态` 章写的是**记录时**的状态；被取代后不回写旧文件（只增不改），
  是否被取代以 `adr_list` / index 的 `supersededBy` 为准。
- `plan_status` / `adr_list` 只读且不落盘（测试用 `.dsh` 的前后快照守住这一点）。
- **非功能预算不在 core 的共享类型里**：`budgets` / `retiredBudgets` / `budgetChanges` 是附加在
  `mission.spec` 上的字段（本包不改 `dsh-eng-core` 的 `SpecRecord`）。读的一方必须结构性地读取，
  并在读不出来时 fail closed；规格 Markdown 里的 `## 非功能预算` 表是**渲染结果**，权威是 mission 记录。
- **`plan_status` 的"已验证"是 join 出来的**：它靠 `dsh-quality-gate` 写进 gate 行的两个字符串
  （reason 里的 `预算裁决`、预算行里的 `来源：规格`）判断"这条预算被测量过没有"。措辞变了只会退化成
  `未验证`（少一次声明），不会出现假的"已验证"；本包**不判断**预算是否达标 —— 那是测量的事。
- **预算的"验证"与"达标"是两件事**：`已验证：BLOCK` 表示测过且没过，`未验证` 表示没人测过。

## 项目级配置（同一个 dsh 进程服务多个仓库）

profile 是上限，每个仓库可以用 `.dsh/spec-gate.json` 决定**自己**被管多严：

```json
{ "enforce": false }                                  // 临时/试验仓库：不拦写，其余工具照旧可用
{ "enforceBoundaries": false, "shellPolicy": "strict" } // 边界放宽，但 shell 不可归属就拒绝
{ "writeTools": ["write", "edit", "multi_edit"] }       // 这个仓库的写类工具集
```

- 可覆盖键：`enforce`、`enforceBoundaries`、`writeTools`、`shellTools`、`shellPolicy`、`boundaryExemptPaths`、`requireTestDesign`、`approval`、`reviewChannel`、`reviewTimeoutMs`、`bootstrap`、`planFile`、`adrDir`、`adrIndexFile`、`milestoneRequired`。
- **不可覆盖**：`enabled`、`logFile`、`rootDir`/`specsDir`/`missionsDir`（宿主决策），写了会被忽略并记日志。
- 文件本身在信任根里（`.dsh/**` 只允许派生的 `specs/*.md` 被写类工具改写），所以模型不能用 `write` 把自己的门禁关掉。
- `spec_status` 会显示 `配置来源：项目级 …/profile` 与 `enforce / 边界 / 审批模式`。

## 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `spec_create` | `title`(必填) `background` `requirements[]`(必填) `acceptanceCriteria[]`(必填) `fileBoundaries[]`(必填) `negativeConstraints[]`(必填) `testDesign` `milestone` `budgets[]` `note` `missionId` | 新建或修订规格；缺项直接报错且**不写任何文件**；`milestoneRequired` 时缺 `milestone` 同样拒绝；`budgets` 是非功能预算（省略 = 不改动已有声明，`[]` = 全部删除并作废编号） |
| `spec_approve` | `missionId` `note` | 走审批 seam；被拒绝/通道缺失时 fail closed；审批提示里列出验收标准、测试用例与**非功能预算** |
| `spec_status` | `missionId` | 只读汇总（含里程碑、台账路径、**非功能预算及其验证状态**） |
| `spec_amend` | **增 / 改 / 删单条需求、验收标准或非功能预算**（`part`+`action`），或 **`budgets[]` 整组重声明**：编号稳定（改写不改号、插入不打乱、删除后作废不复用）、删除被用例引用的验收标准会被拒绝（除非 `cascade: true` 连同用例移除）、变更记入历史并渲染进审批文档、**修订即撤销审批**（回到 test_design_review → spec_approve 的标准流程）；可选 `milestone` 同时改里程碑。`part`/`action` 与 `budgets` 不能同时给（一次只做一件事） |
| `plan_status` | `milestone`（`无里程碑` 表示空里程碑组） `missionId` `json` | **只读**跨 mission 规划视图：按里程碑分组的编号（owner mission / 规格状态 / 交付状态）、未交付、已作废、编号→mission 反查与冲突、每个 mission 的**非功能预算与验证状态**；台账缺失时如实说明 |
| `adr_record` | `title`(必填) `decision`(必填) `alternatives` `consequences` `missionId` `supersedes` | 记录一条架构决策（追加 `adr/<NNNN>-<slug>.md` + index 行）；编号只增不改，已存在的路径拒绝，`supersedes` 必须指向已有编号 |
| `adr_list` | `query` `missionId` | **只读**列出决策（最新在前），`query` 匹配标题与「决定」正文（大小写不敏感） |

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
| `planFile` | `.dsh/plan.jsonl` | 规划台账（append-only JSONL）。默认**跟随 `rootDir`**（`rootDir` 改了就跟着走）；显式配置则相对工作区解析 |
| `adrDir` | `.dsh/adr` | 决策记录目录（默认跟随 `rootDir`） |
| `adrIndexFile` | `<adrDir>/index.jsonl` | 决策索引（append-only JSONL） |
| `milestoneRequired` | `false` | `true` 时 `spec_create` 必须带 `milestone`，否则拒绝并给出下一步 |
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
- **台账写入永远不阻断规格操作**：`.dsh` 只读、磁盘满、台账路径被占成目录……规格照样写入，
  只在工具输出里追加一条 `⚠️ 规划台账写入失败`（已写 i/n 行）+ 台账文件路径。规格是权威，台账是索引。
- **台账与 ADR 都不参与放行判定**：它们是记录；`mission.json` / `state/**` / `roles/**` 才是信任根。
  模型可以用 `adr_record` 记一条决策，但改不了任何门禁结论。
- **修订即失效**：重新 `spec_create` 会把状态打回 `draft`，旧审批同时作废（人审批的是另一份文档）。
- **子 Agent 继承**：被派发的子会话通过 `session.header.parentSession` 继承父会话的 mission，
  所以实现者不会因为“没有规格”被误拒。
- **拒绝理由可执行**：理由文本直接给出下一步（`spec_create` → `test_design_review` → `spec_approve`）。

## 与其它插件的协作

- 上游：`dsh-test-design-gate` 通过 `mission.testDesign.passed` 决定能否审批。
- 下游：`dsh-quality-gate` / `dsh-evidence-gate` 读 `mission.spec` 与 `approvedAt` 做交付判定；
  `plan_status` 的"已交付"就是读 `dsh-evidence-gate` 签发的回执（`receipts/*.json`）。
- 编排：`dsh-orchestrator` 的 `spec-clarify` / `spec-approve` 阶段由本插件提供能力。
- `dsh-suite-doctor`：本插件新增的 `plan_status` / `adr_record` / `adr_list` 不在 doctor 的
  `PLUGIN_SIGNATURES['spec-gate'].tools`（挂载证据）列表里 —— 那是签名工具清单，不是完整工具清单，
  新增工具不需要它改名；宿主若想让 doctor 也把它们算作挂载证据，需要单独改 `dsh-suite-doctor`。
