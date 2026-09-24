# dsh-engineering-suite

**尚未发版**（开发中，无 tag）· 兼容基线 `@deepseek-ai/dsh-*` **0.1.7-rc.1**（cordis `~4.0.4`）
· [开发记录](./CHANGELOG.md) · [升级指南](./UPGRADE.md) · [验证证据](./docs/VERIFICATION.md)

> 把 [docs.md](./docs.md) 描述的「Agent 时代软件工程落地方案」实现为一组可独立挂载的
> DeepSeek Harness（dsh）插件：**角色 → 规格 → 测试设计 → 实现 → 质量 → 证据 → 审计 →
> 编排**，每个关注点一个插件，全部通过官方插件契约接入，不改 dsh 核心。

```text
规格澄清 ─ 测试设计评审 ─ 规格审批 ─ 实现 ─ 质量验证 ─ 交付审计
   │           │            │        │        │          │
spec-gate  test-design-  spec-gate  role-  quality-   evidence-gate
           gate                     guard  gate       audit-trail
                                    │        │
                              规范/影响/覆盖率/供应链（四个新增门禁）
                    └──────── orchestrator（顶层编排）────────┘
```

11 个插件各自回答一个可判定的问题：**做的是不是对的**（spec-gate / test-design-gate）、
**谁在做、权限对不对**（role-guard）、**能不能跑**（quality-gate）、**还可维护吗**（standards-gate）、
**这次改动碰了什么**（impact-gate）、**测试有没有用**（coverage-gate）、**能不能上生产**
（supply-chain-gate）、**能不能证明**（evidence-gate / audit-trail）、**按不按流程走**（orchestrator）。

## 包一览

| 包 | 插件 id | 职责 | 关键工具 |
|---|---|---|---|
| `dsh-eng-core` | —（库） | 共享运行时：mission 工件、确定性命令执行、git 指纹、审计 JSONL、日志、扫描器、代码度量、变更影响、审批契约、fake host 测试夹具 | — |
| `dsh-role-guard` | `role-guard` | 角色文件（persona/模型/工具/技能白名单）+ 最小权限派发 + 只读评审服务 | `team_delegate`、`role_list` |
| `dsh-spec-gate` | `spec-gate` | 结构化规格 + 人工审批 + 写操作前置拦截 + 需求增改删 + 存量仓库规格接入 | `spec_create`、`spec_approve`、`spec_amend`、`spec_status`、`spec_bootstrap` |
| `dsh-test-design-gate` | `test-design-gate` | 把测试设计嵌进规格并自动评审（覆盖度/场景完整性/可执行性） | `test_design_review`、`test_design_template` |
| `dsh-quality-gate` | `quality-gate` | 宿主配置命令的三态门禁 + 写后 lint 回路 + 收尾阻断 | `quality_gate_run`、`quality_gate_status` |
| `dsh-evidence-gate` | `evidence-gate` | Mission → Evidence → Gate → Receipt，缺失证据 fail closed | `evidence_record`、`evidence_status`、`mission_complete` |
| `dsh-audit-trail` | `audit-trail` | 全量工具调用 JSONL 审计 + 写前快照 + 按轮次回滚 | `audit_report`、`audit_rewind` |
| `dsh-orchestrator` | `orchestrator` | 阶段流水线、入口/出口门禁、回退、熔断、断点恢复、按难度选模型、阶段自主派发 | `orchestrate` |
| `dsh-standards-gate` | `standards-gate` | 代码规范门禁：仓库自有阈值、基线棘轮、只读结构评审 | `standards_check`、`standards_bootstrap`、`standards_review`、`standards_status` |
| `dsh-impact-gate` | `impact-gate` | 变更影响分析：反向依赖闭包、最小回归测试集、风险分级 | `impact_analyze`、`impact_tests`、`impact_status` |
| `dsh-coverage-gate` | `coverage-gate` | 测试有效性：四种覆盖率报告、增量覆盖率、flaky 检测 | `coverage_check`、`flaky_check`、`coverage_status` |
| `dsh-supply-chain-gate` | `supply-chain-gate` | 密钥扫描（分级+脱敏）、新增依赖人工审批、依赖审计 | `secret_scan`、`dependency_audit`、`supply_chain_status` |

## 快速开始

```bash
# 1. 本地依赖（npm registry 不可用时用软链指向已安装的 harness）
bash scripts/link-deps.sh

# 2. 构建 + 全量测试
bash scripts/test-all.sh

# 3. 挂载到本地 dsh profile（默认 headless + nvim-tui，绝不碰生产 profile tui）
bash scripts/install-into-dsh.sh --dry-run     # 先看要改什么
bash scripts/install-into-dsh.sh

# 4. 重启会话，在 TUI 里 /plugins 应能看到 11 个 bundle
```

正常有 npm registry 时，也可以在每个包的目录里 `pnpm install` 后用
`dsh plugin --profile <name> add <包路径>` 挂载（脚本做的是同一件事）。

## 一条 mission 的完整生命周期

```text
1. spec_create            写 .dsh/specs/<mission-id>.md（验收标准 AC-00x / 文件边界 / 负面约束 / 测试设计）
2. test_design_review     解析规格里的测试设计，检查覆盖度 / 三类场景 / 可执行性 → mission.testDesign.passed
3. spec_approve           通过 approval seam 请人审批 → mission.spec.approvedAt 落章
                          （在拿到审批之前，任何 write/edit 调用都会被 spec-gate 直接拒绝）
4. team_delegate(role)    按角色派发实现/审查：子 Agent 的工具白名单由宿主强制（白名单外不可见、不可调用）
5. evidence_record        把命令输出摘要、git diff 指纹、测试报告登记为证据
6. quality_gate_run       执行宿主配置的 pnpm test / typecheck / lint → PASS | WARN | BLOCK
                          （门禁必须**不早于**最新的 command/test 证据，否则算证据陈旧并阻断；重跑门禁即可自愈）
7. mission_complete       规格已审批 + 门禁 PASS + 必需证据齐备，才签发不可变回执（receipts/<id>.json），mission → delivered
8. audit_report/rewind    随时审计“谁在什么上下文下改了什么”，必要时按轮次回滚工作区
```

编排插件把上面每一步变成一个**阶段**，并用 `orchestrate` 推进；门禁不通过时回退到上一个合适阶段
（超过 `maxAttempts` 则熔断并把 mission 标为 `blocked`，绝不无限循环）。

## 工件布局（全部落在被治理的仓库里，可 commit、可 diff、可审计）

```text
.dsh/
  specs/<mission-id>.md              规格工件（docs.md §3.2 规定路径）
  missions/<mission-id>/
    mission.json                     版本化的 mission 状态（跨插件共享契约）
    evidence.jsonl                   只追加的证据账本
    gates/<gate-id>.json             每次门禁的裁决与命令输出摘要
    receipts/<receipt-id>.json       不可变交付回执
    stages/<stage-id>.json           编排阶段结果（断点恢复依据）
    test-design-review.{json,md}     测试设计评审报告
  audit/<session-id>.jsonl           工具调用审计（含参数/结果摘要与指纹）
  audit/snapshots/…                  写前快照（rewind 用）
  state/sessions/<session-id>.json   会话 → mission 绑定
  roles/*.md                         工作区自定义角色
```

## 按项目配置（一个进程服务多个仓库）

profile 的 loader 行是**上限**，每个仓库可用自己仓库里的文件细化（人类提交、可 review）：

| 文件 | 典型用途 |
|---|---|
| `.dsh/quality-gate.json` | 这个仓库跑哪条测试/lint 命令、改动预算、收尾阻断次数 |
| `.dsh/spec-gate.json` | 这个仓库被管多严（`{"enforce": false}` = 试验仓库不拦写） |
| `.dsh/evidence-gate.json` | 必填证据类型、门禁来源、是否核对工作区指纹 |
| `.dsh/test-design-gate.json` | 测试设计评审口径（`minTextLength`/`strict`/`allowDanglingCase`/`requireAllScenarios`） |
| `.dsh/audit-trail.json` | 是否快照、快照上限、哪些工具不进审计 |

```jsonc
// <仓库>/.dsh/quality-gate.json
{ "commands": [{ "id": "test", "command": "cargo test", "required": true, "phase": "gate" }] }
```

不确定写什么？让脚本按项目类型生成（先 dry-run 看内容，再 --write）：

```bash
bash scripts/project-config.sh                      # 打印将写入的 JSON（不改文件）
bash scripts/project-config.sh --write              # 写 <仓库>/.dsh/quality-gate.json
bash scripts/project-config.sh --write --spec off   # 试验仓库：再写 spec-gate.json 关闭写拦截
bash scripts/project-config.sh --write --test "pnpm vitest run" --lint "pnpm eslint ."
```
  识别 `Cargo.toml` / `go.mod` / `pyproject.toml`·`tests/` / `package.json`（pnpm·yarn·npm）/ `Makefile:test`；
  lint 命令一律标成非必需（缺脚本只 WARN，不阻断交付）；已存在的文件不加 `--force` 不会覆盖。

### 日志按项目分文件

一个进程服务多个仓库时，默认单文件会在行内标注项目名（`[repo]`）以便 grep；要让每个项目写自己的文件：

```yaml
- id: quality-gate
  config:
    # {projectPath} 完全可读（推荐）：~/workspace/deepseek/dsh-project → workspace-deepseek-dsh-project
    logFileTemplate: '~/.dsh/logs/{projectPath}/quality-gate.log'
    # 或者更短、仍唯一：{project} = deepseek-dsh-project-44002d（末两段 + 6 位短哈希）
    # 或者只按目录名：{basename} = dsh-project（同名目录会共用文件）
```
未绑定工作区的行（装配日志等）仍写进 `logFile`，不会丢。
`logFile` 与 `logFileTemplate` 都是 host-only：项目文件改不了它们（否则一个仓库能把自己的日志藏起来）。

规则：**可覆盖键白名单**（写别的键会被忽略并记日志，绝不静默生效）；文件损坏 → 回退 profile 配置；
配置文件在信任根里（`.dsh/**` 对写类工具关闭），所以模型无法把自己的门禁调松；每个 status 工具都会
显示"配置来源：项目级 …/profile"。细节见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) §5.2。

## 设计红线

1. **门禁的确定性来源是宿主配置**：命令、白名单、上限都来自插件 `Config`；模型不能临时编造门禁命令。
2. **fail closed**：证据缺失 / 门禁未跑 / 状态不确定 → 阻断，并给出可执行的下一步。
3. **不可见优于被拦截**：角色白名单通过宿主 `toolFilter` 生效，越权工具在子 Agent 的工具列表里根本不存在。
4. **防死循环**：所有“阻断并要求修复”的路径都有次数上限 + 状态指纹去重。
5. **不改 dsh 核心**：只用 `ctx.tools.register()`、`ctx.tools.guard()`、`ctx.on()`、`ctx.effect()`、
   `ctx.systemPrompt.section()`、`ctx.get()` 等官方契约。

细节见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)（分层与协作契约）、
[docs/PLUGIN-CONVENTIONS.md](./docs/PLUGIN-CONVENTIONS.md)（新增插件的接口约定）、
[docs/VERIFICATION.md](./docs/VERIFICATION.md)（验证记录与复现步骤）、
[docs/KNOWN-LIMITS.md](./docs/KNOWN-LIMITS.md)（七项已知边界的现状、启用方式与验证方法）。

## 开发

```bash
bash scripts/verify.sh                 # 全量验收：typecheck + 各包单测 + 跨包集成测试
bash scripts/e2e-mission.sh            # 端到端：脚本化 stub 模型驱动真实 harness 跑完一条 mission（无需 API key）
bash scripts/typecheck-all.sh          # 仅类型检查
bash scripts/build-all.sh              # 只编译指定包：build-all.sh dsh-spec-gate
bash scripts/test-all.sh dsh-spec-gate # 单包测试
DSH_ENG_DEBUG=1 <启动 dsh>             # 让插件的文件日志同时镜像到 stderr
```

各包的 README 说明自己的配置项、工具参数与协作面；`docs/PLUGIN-CONVENTIONS.md` 是新增插件时必须遵守的接口契约；
[docs/VERIFICATION.md](./docs/VERIFICATION.md) 记录验证证据与复现步骤，[docs/KNOWN-LIMITS.md](./docs/KNOWN-LIMITS.md)
逐条列出机制测不到的边界（这比"全都支持"更有用），[UPGRADE.md](./UPGRADE.md) 是升级指南。

当前规模：**12 个包**（11 个插件 + 1 个共享库）、102 个源文件约 34k 行、17 个测试文件约 14k 行，
**498 个测试（497 通过 / 0 失败 / 1 如实跳过）**；端到端在真实 harness 上验证——
**11 个插件全部 `applied` 并跑完一条 mission**（`scripts/e2e-mission.sh`，脚本化模型，无需 API key）。
