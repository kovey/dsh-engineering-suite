# dsh-test-design-gate

测试设计门禁层（docs.md §3.3 / §6）。**测试用例就是规格的可执行形式**：本插件让「根据需求设计测试」
从可选实践变成流程中不可跳过的、有门禁的阶段——`dsh-spec-gate` 的 `spec_approve` 在测试设计评审
通过之前会直接拒绝审批。

## 职责

- 读取规格工件 `.dsh/specs/<mission-id>.md`（**磁盘工件是唯一事实来源**），解析其 `## 测试设计` 章节；
- 自动评审并在 mission 记录上落定裁决（`testDesign.passed` / `findings` / `reviewedAt`）；
- 写出 `test-design-review.json`（机器可读）与 `test-design-review.md`（人可读）两个工件；
- 评审通过时把设计作为 `artifact` 证据与规格绑定（`specDigest` 一致）。

## 工具

| 工具 | 参数 | 语义 |
|---|---|---|
| `test_design_review` | `missionId?`、`strict?` | 评审覆盖度 / 场景完整性 / 可执行性 / 悬挂用例，落盘裁决与工件 |
| `test_design_template` | 无 | 返回 `SPEC_FORMAT_HINT` + 三类场景各一行填好的示例 |

评审检查项：

1. **覆盖度**：每条验收标准至少一条用例（`design.uncovered` 必须为空）；
2. **场景完整性**：`### 正向场景` / `### 异常场景` / `### 边界场景` 三类都要有（`requireAllScenarios`）；
3. **可执行性**：`操作步骤` 与 `预期结果` 非空、非占位符（`...` / `…` / `TBD` / `TODO` / `待补充` / `待定` / `-`）
   且长度 ≥ `minTextLength`；用例ID 必须匹配 `/^TC[-_ ]?\d+$/i` 且唯一；
4. **悬挂用例**：用例必须声明它覆盖的验收标准，且编号必须真实存在（`allowDanglingCase` 可放宽）；
5. **严格模式**（`strict`）：每条验收标准还要有至少一条异常或边界用例。

评审**未通过不是异常**：裁决作为数据返回（`❌ 测试设计评审未通过`），由 `spec_approve` 独立拒绝审批。

## 配置

```yaml
- id: test-design-gate
  name: 'dsh-test-design-gate'
  config:
    enabled: true
    logFile: '~/.dsh/test-design-gate.log'
    layout: { rootDir: '.dsh' }     # 可选：rootDir / specsDir / missionsDir
    minTextLength: 4
    strict: false
    allowDanglingCase: false
    requireAllScenarios: true
    prompt: { enabled: true, order: 630 }
```

以上是 profile 配置（上限）；每个仓库还可以用 `.dsh/test-design-gate.json` 细化本工作区的评审口径
（`minTextLength` / `strict` / `allowDanglingCase` / `requireAllScenarios`），详见下一节。

## 项目级配置

一个 dsh profile 同时服务多个仓库，所以"这个仓库的测试设计评审有多严"不可能对每个工作区都合适。
每个工作区可以用自己的一份文件细化本仓库的评审口径：

```
<workspace>/.dsh/test-design-gate.json
```

```json
{
  "minTextLength": 20,
  "strict": true,
  "allowDanglingCase": false,
  "requireAllScenarios": true
}
```

**profile 是上限**：项目文件只能细化评审口径，不能把门禁关掉，也不能搬走工件目录。未命中的键一律
**忽略并记录问题**（插件日志里逐键给出原因），绝不静默生效。

可覆盖键（未写的键继续用 profile 的值）：

| 键 | 类型 | 作用 |
|---|---|---|
| `minTextLength` | ≥ 1 的整数 | 本工作区「操作步骤 / 预期结果」的最小长度（默认 4） |
| `strict` | bool | 本工作区是否默认要求每条验收标准有异常或边界用例 |
| `allowDanglingCase` | bool | 本工作区是否容忍不声明验收标准的用例 |
| `requireAllScenarios` | bool | 本工作区是否要求正向 / 异常 / 边界三类场景齐全 |

**只能由 profile 决定**（写了也会被拒绝，并逐条记录原因）：

| 键 | 拒绝理由 |
|---|---|
| `enabled` | 是否加载插件是部署决策：项目文件不能把测试设计门禁关掉（关掉等于让 `spec_approve` 不再检查测试设计） |
| `logFile` | 日志落盘位置是部署决策 |
| `rootDir` / `specsDir` / `missionsDir` / `layout` | 规格 / mission / 评审报告的落点是宿主布局决定，项目文件不能迁移它们 |
| `prompt` | 系统提示词章节属于宿主装配决策 |

**信任根**：`.dsh/**` 被 `dsh-spec-gate` 的 guard 对写工具关闭（只有派生的 `specs/*.md` 可写），
所以模型无法用 `write` / `edit` 把自己的评审调松——**能改这个文件的只有人**。注意这个保护覆盖的是写类
**工具**：用 `bash`（`echo >`、`sed -i` 等）改它只在 `dsh-spec-gate` 的 `shellPolicy: strict` 下才被拦下。

**失败绝不放行**：文件不存在 / 不是合法 JSON / 顶层不是对象 / 某个值类型不对（`"20"` 不会被当成 `20`）
时，回退到 profile 配置并记录问题（逐键回退，不做类型强转），评审**照常执行**——坏掉的项目配置永远不会
变成"没有评审"。

**生效范围**：按调用方会话的 `header.cwd` **逐次调用解析**（读者按 mtime+size 缓存，热路径每次只多一次 `stat`）。
`test_design_review` 的返回与 `test-design-review.md` 都会写出生效策略与来源
（`配置：项目级 <路径>（minTextLength=…；strict=…）` 或 `配置：profile（…）`）；
prompt section 也在**每次装配时**按该 agent 的工作区渲染同一组值（未声明工作区时回退 profile 文本）。
未声明 `header.cwd` 的会话，`test_design_review` 直接拒绝执行（中文错误提示：无法确定本会话的工作区），
**绝不**退回 `process.cwd()`——那会把评审写到 harness 自己所在的、错误的项目里；
`test_design_template` 不读磁盘工件，因此没有工作区也能用。

## 工件

```
.dsh/missions/<mission-id>/
├── mission.json                     # testDesign: { cases, covered, uncovered, passed, findings, reviewedAt }
├── test-design-review.json          # { missionId, passed, reviewedAt, cases, covered, uncovered, findings, specDigest }
├── test-design-review.md            # 中文报告：用例清单 + 评审意见 + 结论
└── evidence.jsonl                   # 通过时追加一条 kind=artifact 证据（outputDigest = report 的 sha256）
```

## 事件与钩子

不监听宿主事件：门禁由 `spec_approve`（`dsh-spec-gate`）读取 `mission.testDesign.passed` 触发，
本插件只提供工具与 prompt section（`eng:test-design-gate`，order 630）。

## 开发

```bash
node ../../node_modules/typescript/bin/tsc -p tsconfig.json
node --test test/*.test.ts
```
