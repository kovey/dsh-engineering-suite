# 已知边界：七项限制的现状与解决方案

2026-09-17 的对抗式审计后，遗留了 7 项"仍然存在的边界"。本文件记录每一项**现在是什么状态**、
**怎么启用/使用**、**怎么验证**，以及**残余的诚实边界**。

| # | 限制 | 现状 |
|---|---|---|
| 1 | 角色 `skills` 白名单只是提示级 | ✅ 已改为**执行级强制**（`skill` 工具调用被单调守卫拦下） |
| 2 | `negativeConstraints` 是散文，无法校验 | ✅ 定义**可执行子集** `path:` / `tool:` / `cmd:` / `argv:`，由写守卫强制；其余仍为提示级并单列 |
| 3 | `bash` 写文件不受边界约束 | ✅ **shell 写入目标提取** + 信任根/边界校验；不可归属的命令由 `shellPolicy` 决定 |
| 4 | §4「自动触发下一阶段 / 激活角色」未实现 | ✅ 阶段 `role` 声明与广播 + **可选** `autoAdvance`（门禁驱动、默认关、有熔断与限流） |
| 5 | 未观测 `agent/pre-step` 的快照无法回滚 | ✅ 轮次改从三个事件学习 + 新增 `since` / `sinceMinutes` **按时间回滚** |
| 6 | `force` 可放松必填证据 | ✅ 默认**不生效**，需宿主显式 `allowForceOverride: true`，且只放松证据类型并留痕 |
| 7 | 未用真实模型驱动验证 | ✅ 新增**脚本化 stub 模型** + `scripts/e2e-mission.sh`（无需 API key） |

---

## 1. 技能白名单：执行级强制

**为什么不能做目录级过滤**：`ctx.skills`（`@deepseek-ai/dsh-skill`）是**分层且只能追加**的注册表
（`register()` 往调用方 scope 层加，`list({scope})` 合并 scope 链），没有任何"减去"能力。
所以目录里仍会列出其它技能，但**调用会被拒绝**。

**现在的行为**：`team_delegate` 记录 `sessionId → role` 到 `<root>/state/roles/<sessionId>.json`
（子会话的 session id 就是 `SubagentRun.id`）；一个单调守卫（`ctx.tools.guard`，无 allow 结果、
顺序无法翻回允许）在 `skill` 工具被调用时解析调用方角色，若角色声明了非空 `skills` 且请求的技能不在
名单内 → 拒绝并给出可执行的解释。没有绑定 / 没有白名单 / 参数不可解析 → 一律放行（不越权）。

**配置**：`skillTools: ['skill']`（默认即真实工具名，已在 `@deepseek-ai/dsh-tool-skill` 源码核对）、
`enforceSkillWhitelist: true`。

**验证**：`cd packages/dsh-role-guard && node --test test/*.test.ts`（含 6 条 `(regression)`：
白名单外拒绝/白名单内放行、无绑定不拦、无白名单不拦、孙会话继承、坏参数不抛错、开关可关）。

**残余边界**：目录里仍能看到其它技能名（提示层已说明白名单是强制的）；技能文件本身若自带写操作，
仍受写守卫与边界约束，但技能"加载"与"按技能指示行动"之间没有更强的隔离。

## 2. 负面约束：可执行子集

```markdown
## 负面约束（禁止）
- path:src/core/**          # 禁止改动匹配路径（write/edit 目标 + shell 可识别写入目标）
- tool:web_search            # 禁止调用该工具（任何工具，不只写类）
- cmd:rm -rf                 # shell 命令中禁止出现该子串
- argv:"deploy"\s*:\s*true   # 任意工具的参数 JSON 禁止匹配该正则
- 不得修改 dsh 核心代码       # 无前缀 → 提示级（人工审查 + 提示模型）
```

**现在的行为**：四类前缀被写守卫强制（`path:`/`cmd:` 只作用于**写**的一侧，读操作不受影响——
否则审查者连被禁文件都读不了）；无前缀或 `argv:` 正则编译失败的行进入**提示级**，
`spec_create` 的返回与 `spec_status` 都会写明「可机器校验 N 条；仅提示级 M 条」。

**验证**：`cd packages/dsh-spec-gate && node --test test/*.test.ts`（含 2 条 `(regression)`：
四类约束各自命中/放行、读操作不受约束影响、解析失败降级为提示级而不是崩溃）。

**残余边界**：散文约束永远只能靠人和模型自觉；`argv:` 只匹配序列化后的参数，无法理解语义。

## 3. shell 写入：目标提取 + 边界校验

**能识别的**：重定向（`>`、`>>`、`2>`、`&>`）、`tee`、`sed -i` / `perl -i`、`rm`/`rmdir`/`mv`/`cp`/
`ln`/`touch`/`mkdir`/`truncate`/`install`/`chmod`/`chown`、`dd of=`，以及它们出现在管道/`&&`/`;`
里的情况。识别出的目标会和 `write`/`edit` 一样过**信任根**（`.dsh/**` 除派生的 `specs/*.md`）与
**文件边界**，也会参与 `path:` 约束与 `boundaryExemptPaths`。

**不能识别的**：`git checkout/restore/apply/stash/clean`、`find -delete|-exec`、`python`/`node` 脚本、
包管理器、`sh -c`/`xargs`/`env`/`sudo` 之后的命令等 → 标记为 `undecidable` 并给出原因。

**策略（配置 `shellPolicy`）**：
- `targets`（默认）：能识别的照查，识别不了的放行但记录盲区（收尾门禁仍会用 git 指纹发现"工作区变了"）；
- `strict`：出现不可归属的写类命令就**拒绝**（受控仓库推荐）；
- `off`：完全不做 shell 分析（`cmd:` 约束仍然生效）。

**验证**：`node --test packages/dsh-spec-gate/test/*.test.ts`（2 条 `(regression)`：
越界/信任根/sed -i/rm 目标被拒、strict 拒不可归属命令、off 放行）。

## 4. 阶段角色与自动推进

```yaml
stages:
  - id: implement
    role: developer              # 声明并广播：阶段工件 + prompt 都写"请用 team_delegate({role:'developer'})"
    autoAdvance: true            # 可选：出口门禁通过时自动结算并进入下一阶段
turnStop:
  maxAutoAdvancesPerTurn: 2      # 每轮上限（熔断）
```

**现在**：默认流水线只给 `implement` 标了 `role: developer`（内置角色里真实存在的那个；
不凭空发明 `qa`/`evidence`）。`autoAdvance` 默认**全关**——自动状态流转必须由宿主显式开启。
开启后由 `agent/turn-stopping` 触发，且只在：出口门禁是 gated 且当前通过、后继阶段所需插件已挂载、
mission 未熔断、信号未取消、同 `(mission, stage, attempt)` 未自动推进过、且未超过每轮上限时才发生；
推进后会用一条 `plugin` 来源的 notice 告知模型阶段已变。失败一律吞掉并记日志，不影响回合收尾。

**角色强制在哪**：orchestrator 只"声明 + 广播"角色；真正的权限由 `dsh-role-guard` 的角色文件 +
工具白名单 + 技能门禁执行。

**验证**：`node --test packages/dsh-orchestrator/test/*.test.ts`（6 条 `(regression)`：role 落工件/
prompt/mission、stages 与 status 展示、自动推进触发一次并通知模型、五种不该触发的情形、每轮上限与
已结算不重复、默认关闭时为 no-op）。

## 5. 轮次归属与按时间回滚

**现在**：轮次从三个事件学习——`agent/pre-step`（首选）、`agent/inbox/claimed`、`agent/turn-stopping`。
只要其中之一出现过，快照就能按轮次回滚；SDK 嵌入等不发 `pre-step` 的会话也能被回滚。
三者都没有时，改用时间选择器：

```
audit_rewind({ since: '2026-09-17T07:30:00Z', dryRun: true })
audit_rewind({ sinceMinutes: 30, dryRun: false, confirm: true })
```

`turn` 与 `since`/`sinceMinutes` 至少要给一个（不会"默认回滚一切"）；时间选择不依赖轮次，
窗口内的全部快照都会纳入回放。报告会如实说明还有多少条快照缺轮次信息、以及换时间选择能否纳入。

**验证**：`node --test packages/dsh-audit-trail/test/*.test.ts`（2 条 `(regression)`：
仅 `inbox/claimed` 的会话可回滚、无任何轮次信号时用 `since`/`sinceMinutes` 回滚成功且坏时间戳被拒）。

## 6. `force` 需要宿主显式开启

`allowForceOverride` 默认 **`false`**：`mission_complete({ force: true })` 不被采纳，报告里明确写出
「force=true 未被采纳」。宿主设为 `true` 后，`force` 也只放松「必填证据类型」一项，且一定补写一条
`manual` 证据留痕——它永远不能绕过门禁本身、规格审批、陈旧性或伪造检测。

**验证**：`node --test packages/dsh-evidence-gate/test/*.test.ts`（1 条 `(regression)`：
默认拒绝 force 且不签发回执；开启后交付并留下 manual 覆盖行）。

## 7. 脚本化模型的端到端验证（无需 API key）

`dsh` 的 DeepSeek 适配器是标准 `POST {baseURL}/chat/completions` + SSE，因此可以起一个**本地脚本化
模型**：它按预先写好的脚本返回工具调用与最终文本，让真实 harness 完整跑一遍流水线——工具派发、
事件钩子、写守卫、门禁、证据、回执全都真实执行，只是"模型"是确定性的。

```bash
bash scripts/e2e-mission.sh          # 建立隔离 profile、起 stub、跑一条完整 mission、断言全部工件
```

**它断言**：`.dsh/specs/<id>.md` 含验收标准、`mission.json` 达到交付状态且 `spec.approvedAt` 存在、
`testDesign.passed === true`、存在 `scope.full === true` 的 PASS 门禁、`receipts/RCP-*.json` 已签发、
`audit/<session>.jsonl` 有 pre/result 行、复盘工件存在。

**诚实的边界**：stub 证明的是**框架路径**（harness 的事件与工具链路、我们的门禁与钩子），
不是模型质量——模型是否"愿意"按规格行事、写出的代码是否正确，仍需真实模型会话验证：
把 `DEEPSEEK_API_KEY` 导出后按 `docs/VERIFICATION.md` §3 的命令跑即可。

---

## 附：这七项之外的既有诚实边界

- 技能**目录**仍是全量（见第 1 项原因）；
- `read`/`grep` 等只读工具不受边界与 `path:` 约束（这是刻意的：否则审查者读不了被禁文件）；
- 未在 `shellTools` 里配置的工具（例如自定义 shell 工具、`run_code`）不做写入目标分析；
- 项目级配置覆盖四个插件：`quality-gate`（命令/预算/触发）、`spec-gate`（enforce/边界/shell 策略）、
  `evidence-gate`（必填证据类型/门禁来源/指纹核对/强制覆盖开关是否可用）、`audit-trail`（快照开关与上限/工具过滤）；
  `role-guard` 与 `orchestrator` 不需要——角色文件与阶段流水线本身就是仓库自带的工件；
- 审计快照本身没有快照（`audit_rewind` 不能被 rewind）；
- 规格工件与记录的"一致性"在审批时刻校验；审批之后若有人手改工件，门禁读的仍是记录（可用
  `spec_status` 的摘要复核）。

---

## 附一之二：除了配置，还有哪些东西按会话工作区解析（2026-09-17 第三轮）

| 类别 | 状态 |
|---|---|
| 配置（6 张表见附二） | ✓ 五个插件都有 `<repo>/.dsh/<plugin-id>.json` 覆盖层 |
| **提示词段** | ✓ 按装配上下文（`AssembleContext.scope` = 调用方 agent）渲染该仓库的生效值；取不到工作区回退 profile 文案，段内绝不抛错 |
| **工具解析的工作区** | ✓ 未声明 `header.cwd` 时**拒绝执行**（规格/测试设计/证据/门禁工具一致），绝不落到 `process.cwd()`（= harness 自己的目录，另一个项目） |
| **审计轨迹的落点** | ✓ 未声明工作区 → 跳过该会话的审计行并 warning（绝不写进 harness 目录） |
| **计数与观测** | ✓ spec-gate 拦截计数按工作区；status 同时给"本工作区 N / 进程合计 M" |
| 会话级内存态（gate 计数、turn 归属、自动推进记账） | 按 session 键即正确（一个会话只属于一个工作区） |
| 存储缓存（MissionStoreRegistry 按 rootDir、项目配置按文件路径） | 键已是工作区粒度 |
| **日志文件** | ✓ 两种模式：默认单文件但**行内带项目名**（可 grep）；配 `logFileTemplate`（host-only，如 `~/.dsh/logs/{projectPath}/quality-gate.log`，`{projectPath}` 完全可读 / `{project}` 短哈希 / `{basename}` 仅目录名）则**按项目分文件**，未绑定工作区的行仍进 `logFile` |
| `role-guard` / `orchestrator` | 角色文件与阶段流水线本身是仓库自带工件；`routing`（按难度选模型）与 `autoDispatch`（自主派发）由宿主 profile 配置 |

## 附一之三：存量项目接入（`spec_bootstrap`）的诚实边界

- **推断不是需求**：没有需求文档时，验收标准由代码面（导出函数/路由/CLI/已有测试名）推断，全部带 `[推断]`；
  它描述"代码现在做了什么"，不等于"应该做什么"——必须由人确认后才是规格。
- **索引有上限**：默认最多 4000 个文件、单文件 256 KiB，索引条目 40 条；超出会截断并提示"用 glob/grep 自己继续找"。
  扫描器只用于**索引与缺口**，不充当草稿的证据来源。
- **语言覆盖**：Go / TypeScript / JavaScript / Python 的**浅层**符号与用例提取（正则级，不做类型解析）；
  其它语言只会被计入 `stats.languages`，不产出符号。动态注册的路由/命令（运行时拼出来的）识别不到。
- **模型读代码，插件只校验"形状"**：草稿由模型（当前 agent 或只读子代理）读代码后写出；插件检查解析、覆盖、
  步骤长度与占位符，**不判断内容对不对**（"这条标准是否真的成立"仍需人工过目）。
- **草稿不是审批**：`.dsh/bootstrap/<stamp>/spec-draft.md` 不写 mission、不签发门禁记录、不产生回执；
  脚手架里的 `[待确认]` 占位会被 `test_design_review` 拒绝（刻意）。
- **没有"自动补齐到通过"**：套件不会为了让你过关而降低标准；草稿 → 人工确认 → 审批这条链一步都不能省。

## 附一之四：模型路由（difficulty → routing）的边界

- **是声明，不是切换**：orchestrator 无法改变当前会话的模型，它只在阶段工件与报告里写明路由与应调用的形式；
  真正的落实靠 `team_delegate` 的按调用覆盖（`dsh-role-guard`）。不派发就没有路由。
- **需要宿主配置**：`routing` 没配 → 难度只作为提示，阶段沿用会话默认模型（报告里会说明）。
- **成本开关在宿主**：`allowModelOverride: false` 时按调用覆盖被忽略，沿用角色路由（防止模型自行选更贵的模型）。
- **草稿子代理单独配置**：`spec_bootstrap` 读代码的只读子代理用 `bootstrap.model`（不配则沿用会话模型）——
  大批量读代码是最适合下沉到便宜模型的工作。
- **不校验模型是否存在**：路由里写了不存在的 provider/model，要等宿主 provider 在真实调用时报错；
  插件只保证"传下去的路由字段是一致的"。写例子时请用适配器当前声明的模型
  （DeepSeek 适配器：`deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v4-flash-vision-exp`，
  provider 为 `deepseek-official`；`reasoningEffort` 认 `off` / `low` / `high` / `max`，没有 `medium`）。

## 附一之五：自主派发（autoDispatch）的边界与代价

- **它会自己花 token**：进入阶段即派子代理，不需要模型同意；因此默认 `enabled: false`，且建议只给
  真正需要的阶段开（如 `implement`）。
- **派发不等于完成**：子代理说"做完了"不是证据；门禁仍需通过，`mission_complete` 仍要证据与门禁记录。
- **需要 `ctx.subagents`**：宿主没装配子代理 provider 时只报告不派发（阶段照旧可手动执行）。
- **一个阶段一个子代理**：不做并行/多子代理竞争；子代理之间不共享上下文，靠 mission 工件与文件传递信息。
- **权限取决于角色可用性**：`dsh-role-guard` 的 service 缺失或角色文件损坏时，配置里的 `toolFilter` 兜底
  （此时"谁来写"由配置决定，而不是角色文件）；角色未知一律**拒绝派发**。
- **超时后子代理可能仍在跑**：超时只是停止等待并记录，宿主是否真正终止该子代理取决于 provider。
- **仍会阻塞工具调用**：派发是同步等待（默认上限 10 分钟，`autoDispatch.timeoutMs`），期间 `orchestrate`
  不返回。中断靠调用方的 `signal`（已接通），但"后台派发 + 完成后通知"尚未实现。
- **递归只能靠结构性禁止**：子代理的工具过滤里被强制去掉 `orchestrate` 且 `maxDepth=1`；
  若宿主自己把 `orchestrate` 又塞回子代理（例如另开一个 provider 绕开本插件），仍可能递归。

## 附一之六：代码规范门禁（`dsh-standards-gate`）的边界

- **行数/嵌套只是启发式**：一个 300 行的内聚文件可能优于三个 100 行的碎片；门禁表、角色表、大 `switch`
  这类"表格型代码"刻意长——应当写进 `exempt` 或按目录放宽，而不是把阈值调大到无意义。
- **判不出来的部分不假装判定**：高内聚、命名达意、抽象是否多余 → 交给 `reviewer` 角色的 rubric；门禁只覆盖可机械判定的维度。
- **度量是浅层语法**（与 `scan` 同源）：不解析类型、不做调用图；Go 的 `func` 字面量、Python 的 lambda、
  TS 的泛型类型参数与装饰器不计入函数/参数统计；TS 正则字面量与对象字面量会计入花括号深度（已知近似）。
- **豁免是整条路径匹配**：`*.gen.go` 只匹配根目录，跨目录必须写 `**/*.gen.go`；命中豁免的文件保留行数、
  不产生函数/依赖/违规，并计入 `stats.exempted`。
- **`.gocache` / `.cache` / `vendor` / `target` 等默认忽略**：真机上曾把仓库内的 Go 模块缓存当成源码
  （7800 行的生成文件把 p90 拉到 1010 行）。把工具链缓存放进工作区是允许的，但它不是被测代码。
- **同一函数内的多个超长 if 块**的违规 key 追加 `#L<行号>`（否则"接受一条=接受全部"，棘轮失效）。
- **基线文件损坏按"没有基线"处理**（会报告全部违规），而不是"全部已接受"——先失败，再让人修。
- **交付侧的门禁新鲜度**按"最新 command/test 证据"判断，同毫秒算陈旧（fail closed）：门禁自己写的 ledger 行
  不算证据，否则每条门禁都会被它自己的一毫秒判成过期。

## 附二：项目级配置的完整键表（一个 dsh 进程服务多个仓库）

| 文件 | 可覆盖（人类提交在仓库里） | 拒绝并记日志（profile 是上限） |
|---|---|---|
| `<repo>/.dsh/quality-gate.json` | `commands`（替换）、`limits.maxChangedFiles`、`defaultTimeoutMs`、`maxOutputBytes`、`writeTools`、`turnStop.{enabled,maxBlocksPerTurn}`、`afterWrite.{enabled,blockOnFailure,maxPerTurn}` | `enabled`、`logFile`、布局 |
| `<repo>/.dsh/spec-gate.json` | `enforce`、`enforceBoundaries`、`writeTools`、`shellTools`、`shellPolicy`、`boundaryExemptPaths`、`requireTestDesign`、`approval`、`reviewChannel`、`reviewTimeoutMs`、`bootstrap` | `enabled`、`logFile`、`rootDir`/`specsDir`/`missionsDir` |
| `<repo>/.dsh/evidence-gate.json` | `requiredEvidenceKinds`、`requireGate`、`gateSource`、`requireCleanTree`、`maxGateAgeMinutes`、`maxOutputTail` | `enabled`、`logFile`、布局、**`allowForceOverride`**（它放松的是模型能主动传的 `force`）、`prompt` |
| `<repo>/.dsh/audit-trail.json` | `snapshot.{enabled,maxFileBytes,maxFilesPerTurn}`、`writeTools`、`trackTools`、`ignoreTools`、`maxArgsSummary`、`maxResultTail`、`redactArgs` | `enabled`、`logFile`、`auditDir`/`rootDir`/`stateDir`、`prompt` |
| `<repo>/.dsh/test-design-gate.json` | `minTextLength`、`strict`、`allowDanglingCase`、`requireAllScenarios` | `enabled`、`logFile`、布局、`prompt` |

共同规则：

1. **来源不撒谎**：只有当项目文件真的改动了允许键时才报告 `配置来源：项目级 <path>`；
   全部被拒 / 全部类型不对 → 仍报 `profile` 并附「问题条数」（见各 status 工具）。
2. **值不做猜测**：类型不对的键逐条记问题并回退该键（不强制转换）；JSON 坏 / 顶层不是对象 → 整体回退 profile。
3. **信任根**：这些文件在 `.dsh/**` 下，写类工具改不了（只有派生的 `specs/*.md` 可写）；
   但 `bash` 改写只在 `shellPolicy: strict` 下会被拦——这是第 3 项的既有盲区。
4. **快捷生成**：`bash scripts/project-config.sh --write`（按项目类型识别并生成，`--spec off` 可让试验仓库不拦写）。

### 附二之二：无工作区的会话（`header.cwd` 缺失）

嵌入场景（SDK / 无 cwd 的会话）下所有会"认错项目"的路径都拒绝执行，而不是猜测：

| 位置 | 行为 |
|---|---|
| 写类工具（`write`/`edit`/可识别的 shell 写入） | 拒绝，`spec-gate: 无法确定本会话的工作区（session.header.cwd 缺失），写操作被拒绝（fail closed）` |
| `spec_create` / `spec_approve` / `spec_status` | 拒绝（规格与 mission 会被写到错误目录）；显式 `missionId` 也不能绕过——定位台账同样需要工作区 |
| `test_design_review` | 拒绝（评审会写到错误项目） |
| `evidence_record` / `evidence_status` / `mission_complete` | 拒绝（证据与回执会写到错误项目） |
| `quality_gate_run` / `quality_gate_status` | 拒绝（宿主命令会在错误目录执行） |
| 自动触发（写后 lint、收尾门禁、审计快照/审计行、阶段自动推进） | 静默跳过 + 每个会话一次 warning |
| 审计行 | 跳过并 warning（绝不写进 harness 自己的目录） |
