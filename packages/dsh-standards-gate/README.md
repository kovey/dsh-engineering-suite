# dsh-standards-gate

**结构规范门禁**：把"代码规范"从文档变成目标仓库里的**确定性门禁**。

其他门禁分别回答"能不能跑"（`dsh-quality-gate`）、"做的是不是对的"（`dsh-spec-gate`/`dsh-test-design-gate`）、
"能不能证明"（`dsh-evidence-gate`）；这个插件回答**"还可维护吗"**：

| 维度 | 判定 |
|---|---|
| 文件行数、函数行数、嵌套深度、if/else 块行数、参数个数、导出面大小 | 确定性度量（`dsh-eng-core` 的 `measureWorkspace`） |
| 模块依赖方向（分层规则）、循环依赖 | 同上（导入图） |
| 高内聚、命名、抽象是否多余 | **不判**——交给 reviewer 角色的 rubric 评审（见 `KNOWN-LIMITS`） |

## 三个工具

| 工具 | 作用 |
|---|---|
| `standards_check` | 按**仓库自己声明**的阈值度量，产出违规清单，并把裁决写进 mission 的门禁记录（`source: dsh-standards-gate`）。**基线已接受的存量违规不算失败，新增违规失败。** |
| `standards_bootstrap` | 存量项目接入：`measure` 给出分布（各语言的文件行数/函数行数/嵌套的 p90 与最差文件）、**推荐的目标阈值**（文件 400/300、函数 80/60、嵌套 4、分支 20、参数 5）以及"按目标阈值今天会有多少违规"，`freeze` 经**人工批准**后写入仓库。**不推荐按 p90 定阈值**——真机上 p90 文件长度是 588 行，那等于没有门禁；正确做法是目标阈值 + 把存量冻结进基线。 |
| `standards_status` | 只读：当前阈值、依赖方向规则、基线（接受了多少项、何时冻结、为什么）、**本次 mission 的变化**（变胖/变瘦的文件、新增/消除的违规）、最近一次门禁裁决。 |

## 第四层：判断（`standards_review`）

数字解释不了的部分——职责是否单一、命名是否达意、抽象是否多余、错误路径是否完整、拆分是否真的更好——
交给 `standards_review`：它按可疑度挑出最值得看的几个文件，派一个**只读**子代理（`allow: [read, glob, grep]`、
**剔除 `orchestrate`**、`maxDepth: 1`）带着 rubric 去读代码，结论落盘到 mission 目录并标注：

> ⚠️ 这是**意见**，不是门禁裁决：它不改变任何门禁状态，也不构成交付依据。

rubric 明确要求"允许结论是没问题"（不要为了产出而编造问题）、每条结论带 `文件:行号`、区分事实（门禁给的数字）
与方法（评审的判断）。`role-guard` 的内置 `reviewer` 角色也指向同一份 rubric。

## 棘轮：为什么第一次就能用

阈值一旦宣布，存量仓库必然全线飘红 → 要么永远堵着，要么被关掉。所以：

```
<repo>/.dsh/standards.json           阈值、分层规则、豁免（仓库所有）
<repo>/.dsh/standards-baseline.json  已接受的违规（棘轮）
```

- 门禁对**新增**（`added`）与**恶化**（`worsened`：同一个 key 比当初接受时更大）失败，并报告**已消除**的项（`fixed`）；
- 已消除的 key 会**自动从基线删除**（只收紧、不需要批准）：否则"删掉文件让门禁变绿、之后再放回来"就能靠旧批准通过；
- 收紧靠重构（`fixed` 变多）；放宽只有一条路：`standards_check({ accept: true, note: "原因" })`，
  它会**要求人工审批**（`requireApprovalForBaseline`，默认开）；
- `.dsh/**` 在 `dsh-spec-gate` 的信任根里 → **模型自己写不了阈值和基线**。
  审计历史里"Agent 可写 `mission.json` 自我审批"那类漏洞，在这里是同类防护。

## 配置

profile（宿主上限）与 `<repo>/.dsh/standards-gate.json`（项目只能细化下列键）：

```yaml
- id: standards-gate
  config:
    enabled: true
    standardsFile: .dsh/standards.json      # 仓库所有
    baselineFile: .dsh/standards-baseline.json
    enforce: gate                            # gate=PASS/BLOCK | warn=最多 WARN（只报告不阻断）| off=不写记录
    maxFiles: 4000
    maxFileBytes: 262144
    requireApprovalForBaseline: true         # 不得由项目级配置关闭
    reviewProvider: spawn                    # 结构评审用的只读子代理
    reviewTargets: 4                         # 一次评审挑几个最可疑的文件
    reviewTimeoutMs: 600000
    reviewMaxDepth: 1
    prompt: { enabled: true, order: 665 }
```

项目级可覆盖：`enforce`、`standardsFile`、`baselineFile`、`maxFiles`、`maxFileBytes`。

## 规范文件长什么样

```json
{
  "languages": {
    "go": { "maxFileLines": 400, "maxFunctionLines": 80, "maxDepth": 4, "maxIfBlockLines": 20, "maxParams": 5, "maxExports": 20 },
    "ts": { "maxFileLines": 300, "maxFunctionLines": 60, "maxDepth": 4 }
  },
  "layers": [
    { "path": "internal/domain", "mayImport": [] },
    { "path": "internal/app", "mayImport": ["internal/domain"] },
    { "path": "cmd", "mayImport": ["internal/app", "internal/domain"] }
  ],
  "forbidCycles": true,
  "exempt": ["**/*_test.go", "**/*.test.ts", "**/testdata/**", "**/vendor/**"]
}
```

## 门禁记录与交付

每次 `standards_check`（`enforce: gate`）都会写一条 `GateRecord`（`source: dsh-standards-gate`，
含 `scope` 与工作区指纹），所以交付侧可以像要求质量门禁那样要求它：最新一条 standards 门禁必须是 PASS，
且不早于最新代码改动。`enforce: warn` 只报告；`off` 连记录都不写。

## 与套件其他插件的分工

| 插件 | 关系 |
|---|---|
| `dsh-spec-gate` | 保护 `.dsh/**`（阈值与基线模型改不了）；规格里可以写"本 mission 不得新增 standards 违规"这类可判定的 AC |
| `dsh-quality-gate` | 需要时把规范检查当普通命令；更强的是让本插件自己写门禁记录 |
| `dsh-evidence-gate` | 交付不变式可以要求最新 standards 门禁 PASS |
| `dsh-orchestrator` | `quality-verify` 阶段的离开门禁可扩展为"质量门禁 + 规范门禁" |
| `dsh-audit-trail` | 每次门禁的度量明细（含文件尺寸）落在 mission 目录；`standards_status` 比较首末两次测量，直接给出"这次让哪个文件变胖/变瘦、哪些违规新增/消除" |
| `dsh-role-guard` | 机械判不了的（内聚、命名、抽象）交给 reviewer 角色的 rubric |

## 诚实的边界

行数与嵌套是**启发式**：一个 300 行的内聚文件可能优于三个 100 行的碎片；门禁表、角色表、大 `switch`
这类"表格型代码"刻意长，应当写进 `exempt` 或按目录放宽。机械层是下限，评审是上限，两者不能互相替代。
更多见 `docs/KNOWN-LIMITS.md`。
