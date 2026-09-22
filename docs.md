# 基于 dsh 的 Agent 时代软件工程落地方案

> 目标：在 DeepSeek Harness（dsh）中，通过自研插件组合，落地一套**完全可控、可迭代**的 Agent 软件工程体系。  
> 核心思路：将工程流程中的每个关注点封装为独立插件，再通过流程编排插件将它们编织成一条可审计、可回退、可进化的流水线。

---

## 1. 背景与核心原则

### 1.1 从 Vibe Coding 到 Agentic Engineering

Agent 时代的软件工程，核心是从“人写代码”转向 **“人定义问题与标准，Agent 执行，人验收”** 的协作范式。要实现落地、可控与迭代，关键在于构建一套将**非确定性 Agent** 约束在**确定性工程流程**中的“Harness（框架/缰绳）”。

- **Vibe Coding**：凭感觉编程，不审查代码，只求快速出结果，本质是**用速度换取理解和控制**，适用于原型验证。
- **Agentic Engineering**：工程师保留所有关键决策权，将 Agent 视为问题分析和方案设计的伙伴，在**维持甚至提升质量标准**的前提下提升效率。

### 1.2 基石：规格即程序（Specification is the Program）

Agent 产出质量不稳定的核心原因往往是**协调失败**，而非模型能力不足。模糊的指令产生模糊的输出。因此，必须提供**结构化的、可验收的规格说明**，包括：

- 明确的验收标准
- 文件边界
- 负面约束（明确禁止的操作）
- **结构化的测试设计**（见第 6 节）

### 1.3 可控性三要素

1. **流程约束**：角色分离与最小权限，避免“自己设计、自己实现、自己审批”。
2. **验证闭环**：TDD 与分层质量门禁，绝不让 Agent 在没有测试保护的情况下写代码。
3. **追溯审计**：完整记录模型版本、提示词、输入上下文、行为日志，形成不可篡改的审计历史。

---

## 2. 整体架构：四层插件化研发底座

dsh 本身是 Agent 运行时，我们的软件工程体系是运行在其上的一套**预设（Preset）与插件组合**。整体分为四层：

| 层级 | 职责 | dsh 实现方式 |
|---|---|---|
| **认知层** | 项目知识、架构决策、历史上下文 | 通过 `dsh-superpowers` 的 `brainstorming` / `writing-plans` 技能，将隐性知识固化为可检索的规格与计划工件 |
| **编排层** | 多 Agent 角色分工、任务分发、依赖管理 | 自研流程编排插件（见第 5 节），参考 `dsh-expert-team` / `dsh-knj-workflow` |
| **执行层** | 模型调用、工具执行、代码读写 | dsh 原生 `dsh-agent-loop` 插件驱动，支持声明式 Agent 与会话恢复 |
| **治理层** | 质量门禁、结构规范、审计、安全沙箱、成本追踪 | 自研插件组合：`dsh-role-guard`、`dsh-spec-gate`、`dsh-quality-gate`、`dsh-standards-gate`、`dsh-audit-trail`、`dsh-evidence-gate`、`dsh-test-design-gate` |

---

## 3. 核心自研插件设计

每个插件聚焦一个关注点，通过 dsh 的 Cordis 插件规范实现：导出 `name`、`inject`、`apply(ctx, config)`，可同时包含 Host 半边（Node 进程）和 Client 半边（浏览器 UI）。

### 3.1 `dsh-role-guard`：角色与权限层

**职责**：为不同 Agent 角色分配独立的工具白名单和模型，实现最小权限。

**实现要点**：
- 一个 `.md` 文件定义一个角色（persona + 模型 + 工具白名单 + 技能白名单）。
- 注册 `team_delegate` 工具，主 Agent 通过它派发任务。
- 根据角色文件自动过滤可用工具——白名单外的工具对子 Agent **不可见、不可调用**。
- 写操作角色（如 `developer`）和只读角色（如 `reviewer`、`qa`）严格分离。

### 3.2 `dsh-spec-gate`：规格与计划层

**职责**：确保 Agent 在动手前先产出结构化规格，并经过人类审批。

**实现要点**：
- 注册 `spec_create` 工具，要求 Agent 将任务描述为包含**验收标准、文件边界、负面约束、测试设计**的结构化规格工件。
- 监听 `tools/pre-execute`，当检测到写类工具（`write`、`edit`）被调用时，检查当前会话是否已有审批通过的 spec。没有则拦截。
- 规格工件落盘为 `.dsh/specs/<mission-id>.md`，可版本控制。

### 3.3 `dsh-test-design-gate`：测试设计门禁层

**职责**：在规格审批通过之前，强制要求规格中包含结构化的测试用例设计，否则规格门禁不通过。

**实现要点**：
- 扩展规格模板，增加**测试设计章节**：
  ```markdown
  ## 测试设计

  ### 正向场景
  | 用例ID | 前置条件 | 操作步骤 | 预期结果 |
  |--------|----------|----------|----------|
  | TC-001 | ...      | ...      | ...      |

  ### 异常场景
  ...

  ### 边界场景
  ...
  ```
- 注册 `test_design_review` 工具，对规格中的测试设计进行自动化评审：
  - **覆盖度检查**：每个验收标准至少有一个对应测试用例。
  - **场景完整性检查**：正向、异常、边界三类场景都有覆盖。
  - **可执行性检查**：操作步骤和预期结果足够具体，能被转化为可执行断言。
- 门禁不通过时，流程回退到“规格澄清”阶段。
- 测试设计通过后，将测试用例列表和评审结果作为**证据工件**与规格绑定。

### 3.4 `dsh-quality-gate`：质量门禁层

**职责**：在 Agent 声称任务完成的时刻，自动执行确定性验证。

**实现要点**：
- 监听会话的 `agent/pre-step` 或任务状态变更事件，当 Agent 尝试将任务标记为 `completed` 时触发门禁。
- 门禁内容是**宿主配置的确定性命令**（如 `pnpm test`、`pnpm run typecheck`），不由模型临时编造。
- 门禁结果以 `PASS` / `WARN` / `BLOCK` 三态返回。`BLOCK` 时**拒绝状态流转**，强制 Agent 修复后重新提交。
- 可集成已有的 lint 反馈循环模式：在 Agent 编辑文件后自动触发 lint，发现问题立即反馈给 Agent 修复。

**需求的增 / 改 / 删（同一套流程）**：`spec_amend({ part, action, target, text, cascade })`

- `add` 分配新编号；`update` 按编号改写（编号不变）；`remove` 使编号作废（**永不复用**）。
- 删除被测试用例引用的验收标准会被**拒绝**，除非 `cascade: true`（连同用例移除并要求重新评审测试设计）。
- 任何改动都会 `revision + 1` 并**撤销审批**：需求文档里会渲染变更历史（改动前后 + 理由 + 已作废编号），
  流程回到 `test_design_review` → `spec_approve`，阶段门禁 `spec-approved` 重新生效。
- `spec_create` 的整篇重写按**文本**保留未变条目的编号，因此不会再出现"插入一条就整体重编号"。

### 3.5 `dsh-evidence-gate`：证据与交付层

**职责**：确保 Agent 提交的“完成”有可验证的证据支撑。

**实现要点**：
- 定义 `Mission → Evidence → Quality Gate → Receipt` 的流转模型。
- Evidence 包括：**验证命令的执行输出、Git diff 的摘要指纹、测试报告**。
- 缺失或不确定的证据 **fail closed**（默认阻断）。
- 只有确定性 Quality Gate 产生 `APPROVED` 后，才生成不可变的 `Receipt` 工件。

### 3.6 `dsh-standards-gate`：代码规范（结构可维护性）门禁

**职责**：把"代码规范"从文档变成**可执行的门禁**，只覆盖能机械判定的部分。

**实现要点**：
- 规范由**目标仓库自己拥有**：`<repo>/.dsh/standards.json` 声明阈值（文件/函数行数、嵌套深度、`if/else` 块行数、
  参数个数、导出面大小）、分层依赖方向、循环依赖与豁免；`.dsh/**` 在 `dsh-spec-gate` 的信任根内，模型改不了。
- **基线棘轮**：`<repo>/.dsh/standards-baseline.json` 记录已接受的存量违规；门禁只挡**新增**违规，
  并报告"已消除"的项（重构进度）。放宽基线（`standards_check({ accept: true })`）**必须人工批准**。
- 阈值取**目标值**而非分位数：先定"文件 400 行 / 函数 80 行 / 嵌套 4 / 分支 20 行"，
  再把现有违规冻结进基线——这样就既不用为了存量债务放弃规范，也不会第一天全线飘红。
- 人工判断的部分（高内聚、命名、抽象是否多余）交给 `standards_review` 派出的**只读评审者**按 rubric 判，
  结论标注为"意见"，不写任何门禁状态。
- 交付侧可要求它：`dsh-evidence-gate` 的 `requireStandardsGate` 要求最新一条规范门禁 PASS 且不早于最新
  command/test 证据；`dsh-orchestrator` 提供 `gate: standards-pass` 供阶段使用。

### 3.7 `dsh-audit-trail`：审计与追溯层

**职责**：记录每一次工具调用的完整链路，支持事后回放和审计。

**实现要点**：
- 监听 `tools/pre-execute` 和 `tools/result`，将每次调用的 **agent id、工具名、决定、结果、耗时** 写入结构化 JSONL 日志。
- 对写类工具建立**前状态快照 → 执行 → 补偿操作**链路，支持按轮次 `rewindTo(turnId)` 恢复工作区。
- 审计日志的路径和粒度通过 `Config` 暴露。

---

## 4. 流程编排插件：定义阶段与插件调用

需要一个**流程编排插件（Orchestrator Plugin）** 来定义“什么阶段使用哪个插件”，作为顶层协调者。

### 4.1 职责

- **定义阶段序列**：将工程流程拆解为明确的阶段。
- **编排插件调用**：在正确的阶段激活对应的插件，并传递必要的上下文。
- **管理状态流转**：跟踪每个任务当前的阶段，处理阶段间的依赖和条件分支。
- **提供中断/恢复能力**：当某个阶段失败时，支持从断点恢复。

### 4.2 推荐实现路径

**路径一：配置驱动的固定流水线（主干）**

参考 `dsh-knj-workflow` 的设计模式，通过声明式配置定义一条固定的阶段流水线。

```yaml
# 编排插件的 Config 示例
stages:
  - id: spec-clarify
    prompt: "澄清需求，产出规格草稿"
    requiredPlugins: [dsh-spec-gate]
  - id: test-design-review
    prompt: "评审测试设计，确保覆盖度与可执行性"
    requiredPlugins: [dsh-test-design-gate]
  - id: spec-approve
    prompt: "审批规格"
    requiredPlugins: [dsh-spec-gate]
  - id: implement
    prompt: "实现代码"
    requiredPlugins: [dsh-role-guard]
  - id: quality-verify
    prompt: "执行质量门禁"
    requiredPlugins: [dsh-quality-gate, dsh-evidence-gate]
  - id: delivery
    prompt: "交付审计"
    requiredPlugins: [dsh-audit-trail]
```

- 注册 `orchestrate` 工具，Agent 通过它推进阶段。
- 监听阶段完成事件，自动触发下一阶段，并激活对应插件。
- 阶段结果落盘（如 `<taskDir>/stages/<stageId>.json`），支持断点恢复和阶段重跑。

**路径二：状态机驱动的条件编排（处理分支）**

参考 `dsh-state-graph`，支持声明式的节点/静态边/条件边，实现多分支条件路由、循环重试与迭代熔断。

- 条件边根据运行时上下文（如质量门禁的结果）决定下一个状态。
- 支持循环（如质量门禁不通过时回到实现阶段）和迭代熔断（防止无限循环）。

**推荐组合**：以路径一作为主干，路径二处理条件分支。既能保证流程的确定性和可审计性，又能灵活应对回退重试等场景。

### 4.3 与现有插件的协作

| 插件 | 协作方式 |
|---|---|
| `dsh-role-guard` | 在进入“实现”阶段前激活 developer 角色，在进入“审查”阶段前激活 reviewer 角色 |
| `dsh-spec-gate` | 第一个阶段就是“规格澄清”，该阶段激活 spec-gate |
| `dsh-test-design-gate` | 在“规格澄清”之后、“规格审批”之前插入独立子阶段 |
| `dsh-quality-gate` | 在“验证”阶段激活，监听其结果决定是否进入下一阶段 |
| `dsh-audit-trail` | 作为旁路监听器，编排插件不直接调用它，它监听所有阶段的事件进行记录 |

---

## 5. 完整流程视图

```
规格澄清 → 测试设计评审 → 规格审批 → 实现 → 质量验证 → 交付
   │            │            │         │         │         │
   ▼            ▼            ▼         ▼         ▼         ▼
dsh-spec-   dsh-test-    dsh-spec-  dsh-role- dsh-quality- dsh-audit-
gate        design-gate  gate       guard     gate +       trail
                                             evidence-gate
```

每个阶段都有对应的插件激活，门禁不通过时流程回退到上一合适阶段。

---

## 6. 测试左移：需求→测试设计作为规格的一部分

在 Agent 时代的软件工程中，测试设计不应是开发完成后的独立环节，而应**嵌入到规格阶段**——**测试用例就是规格的可执行形式**。

核心逻辑：
1. **规格**：测试用例是需求的可执行、无歧义的精确表达。
2. **护栏**：Agent 可以自动运行测试来验证自己的工作，无需人工介入每一轮循环。
3. **契约**：测试套件是人与 Agent 之间的契约——人写测试，Agent 写实现，测试通过即契约履行。

`dsh-test-design-gate` 的价值在于，它让“根据需求设计测试”从可选实践变成流程中**不可跳过的、有门禁的阶段**。

---

## 7. 插件组合：`cordis.patch.yml` 编排

每个插件打包为 Bundle 后，通过 `cordis.patch.yml` 中的 `insert` 条目插入到 dsh 的组合树中。顶层 patch 文件声明插件之间的依赖顺序：

```yaml
# cordis.patch.yml — 工程体系组合层
- insert:
    - id: dsh-role-guard          # 角色权限必须最先加载
      name: 'dsh-role-guard'
- insert:
    - id: dsh-spec-gate           # 规格门禁依赖角色信息
      name: 'dsh-spec-gate'
- insert:
    - id: dsh-test-design-gate    # 测试设计门禁依赖规格模板
      name: 'dsh-test-design-gate'
- insert:
    - id: dsh-quality-gate        # 质量门禁依赖规格和角色
      name: 'dsh-quality-gate'
- insert:
    - id: dsh-audit-trail         # 审计旁路监听，无强依赖
      name: 'dsh-audit-trail'
- insert:
    - id: dsh-evidence-gate       # 证据门禁依赖质量门禁的输出
      name: 'dsh-evidence-gate'
- insert:
    - id: dsh-orchestrator        # 流程编排插件，顶层协调
      name: 'dsh-orchestrator'
```

安装：`dsh plugin --profile web add <你的包路径>`

---

## 8. 实施路线图

### 第一阶段：最小可行闭环（1–2 周）
- 实现 `dsh-role-guard` + `dsh-quality-gate`。
- 用角色文件定义“实现者”和“验证者”两个角色，验证者只有 `read` 权限。
- 质量门禁只做一件事：在 `write` 工具执行后自动运行 `pnpm test`，失败则阻断。
- 目标：立刻感受到“可控”的价值。

### 第二阶段：规格与审计（2–3 周）
- 加入 `dsh-spec-gate`，强制 Agent 先出 spec 再写代码。
- 加入 `dsh-audit-trail`，用 JSONL 记录所有工具调用。
- 目标：能回答“谁在什么上下文下改了什么、证据是否完整”。

### 第三阶段：测试设计与证据（2–3 周）
- 实现 `dsh-test-design-gate`，将测试设计嵌入规格阶段。
- 实现 `dsh-evidence-gate`，将验证输出和 Git 指纹绑定为不可变工件。
- 目标：形成完整的“需求→测试设计→实现→验证→交付”闭环。

### 第四阶段：流程编排与持续迭代（持续）
- 实现 `dsh-orchestrator`，将各插件编织为可配置的流水线。
- 引入跨 run 经验蒸馏：每次 Mission 结束后，将规格质量、门禁违规模式、返工原因沉淀为知识条目，下次开工前回注上下文。
- 用度量数据驱动插件组合的持续调优。

---

## 9. 关键约束与最佳实践

- **绝不修改 dsh 核心代码**。所有扩展通过 `ctx.tools.register()`、`ctx.on()` 等官方契约完成。
- **Host 半边的工具过滤是“不可见”而非“被拦截”**。确保子 Agent 的工具列表里根本不出现越权工具。
- **门禁的确定性来源是宿主配置，不是模型输出**。验证命令、允许的文件路径、最大改动文件数，都应从插件的 `Config` 中读取。
- **保持职责单一**。一个插件聚焦一项能力，复杂插件可拆分为多个子模块。
- **显式声明一切**。通过 `inject` 声明依赖，通过 `Config` 声明配置，不依赖运行时的“巧合”。
- **利用生命周期自动清理**。通过 `ctx` 注册的工具、事件监听器、定时器都会在插件卸载时自动清理。

---

## 10. 总结

本方案的核心是：**用 dsh 的插件组合机制，将 Agent 软件工程中的每个关注点（角色、规格、测试设计、质量、证据、审计）封装为独立插件，再通过流程编排插件将它们编织成一条可配置、可门禁、可回退、可审计的流水线。**

工程师的角色从代码的“生产者”转变为系统的“架构师”和结果的“评判者”。这套体系不依赖任何黑盒私有方案，所有环节都可观察、可干预、可迭代，从而真正实现 Agent 时代软件工程的**完全可控与持续进化**。

> 注意：dsh 目前仍处于 Developer Preview 阶段，API 可能发生变化，社区插件版本也有差异。建议先在非关键项目上验证这套组合的稳定性，再逐步推广到核心交付流程。
