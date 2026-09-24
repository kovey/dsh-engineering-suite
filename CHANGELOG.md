# 变更记录

本文件的格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；
版本号遵循语义化版本。**套件版本与 harness 版本是两个数字**：套件 `0.1.5` 声明并验证于
`@deepseek-ai/dsh-*` **0.1.7-rc.1**（见下方"兼容基线"）。

## [0.1.5] — 首个发布

首个打 tag 的版本：11 个插件 + 1 个共享库，`verify.sh` 全绿、真机 harness 端到端可复现。
以下按插件列出能力，全部有对应的回归测试。

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

### 变更 · 兼容基线（harness 0.1.7-rc.1）

- `peerDependencies` 从 `^0.1.5-rc.2` 改为**精确锁版** `0.1.7-rc.1`（cordis `~4.0.4`）：semver 规定带预发布的
  `^0.1.x-rc.y` 不匹配 `0.1.7-rc.1`，用范围会导致 `dsh plugin add` 报 peer 不满足。
- **消息来源 kind**：0.1.7 移除了共享的 `plugin` kind（每个生产者声明自己的）→ 新增
  `dsh-orchestrator/src/sources.ts`、`dsh-quality-gate/src/sources.ts`。
- **DeepSeek provider 换成 Messages 协议**（`POST /messages`、帧带 `type`、无 `[DONE]`）→
  `scripts/stub-llm.mjs` 按新协议重写，端到端验证重新可用。
- 详见 [UPGRADE.md](./UPGRADE.md)。

### 验证

- `bash scripts/verify.sh`：**498 个测试 / 497 通过 / 0 失败 / 1 如实跳过**（12 个包 + 跨包集成）。
- `bash scripts/e2e-mission.sh`：**E2E GREEN**，11 个插件在真实 harness 里全部 `applied` 并跑完一条 mission。
- 真机额外校准：`golang/im`（113 个 Go 文件、1522 条导入边）与 `golang/spider` 上验证影响分析、
  目标阈值下的规范违规量、真实 `go test -coverprofile` 的覆盖率解析与增量判定。

[0.1.5]: https://github.com/kovey/dsh-engineering-suite/releases/tag/v0.1.5
