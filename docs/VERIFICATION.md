# 验证记录（2026-09-17）

本文件记录这套插件**实际被验证到什么程度**，以及哪些环节还需要人在真实会话里确认。
所有命令都可以重跑。

## 1. 类型检查 + 单元测试 + 跨包集成测试

```bash
bash scripts/verify.sh
```

最近一次结果：**9 个包 + 1 个根集成测试，342 个测试，341 通过 / 0 失败 / 1 跳过**（另有真机 harness：8 个插件全部 `applied`，E2E GREEN）
（跳过的是一条需要 `ps` 的子进程回收测试——本机沙箱不允许列进程，测试会如实跳过而不是假通过）。

第一轮（实现完成时）130 个测试；第二轮对抗式审计把漏洞变成回归测试（+49）；第三轮补齐七项已知边界（+24）。

| 包 | 测试数 | 覆盖重点 |
|---|---|---|
| `dsh-eng-core` | 11 | mission 工件持久化（含损坏文件读回 `undefined`、同秒 id 不冲突）、spec/测试设计 markdown 往返解析（含无前导竖线 / 全角竖线 / 无表头 / 标题串行）、无 shell 的命令执行、超时 / 抢占 / 进程组回收 |
| `dsh-role-guard` | 24 | 角色文件解析与覆盖优先级（含 `skills: []` 曾被解析成字符串 `"[]"` 的修复）、白名单"空即拒绝"、**技能白名单执行级强制 + 会话→角色持久绑定 + 孙会话继承**、只读角色剥离写工具、派发参数、mission 规格注入、子代理释放、角色文件热更新 |
| `dsh-spec-gate` | 26 | 装配/卸载、缺项草稿拒绝、写拦截（无 mission / 未审批 / 信任根 / 越界 / 未声明路径）、**shell 写入目标提取 + 边界/信任根校验（shellPolicy）**、**负面约束可执行子集 path:/tool:/cmd:/argv:**、读操作不被写规则拦截、审批通过/拒绝、改版撤销旧评审、工件与记录一致、跨会话不回退 |
| `dsh-test-design-gate` | 21 | 覆盖度 / 三类场景 / 可执行性 / 重复 id / 悬挂用例 / strict、报告工件与证据绑定、评审可重跑、评审摘要绑定规格 |
| `dsh-quality-gate` | 21 | 配置解析与去重、三态裁决与覆盖范围（`scope.full`）、门禁记录与证据、写后 lint 回路（同失败只报一次 + 每轮上限 + 换轮重置）、收尾阻断与 steer、取消不产生裁决、改动预算、命令不经 shell |
| `dsh-evidence-gate` | 32 | 四类证据登记、fail-closed 清单、缺规格/缺门禁/部分门禁/无结果门禁/伪造门禁/缺证据/陈旧门禁/超龄门禁/熔断全部阻断、证据必须 exitCode=0、回执不可覆盖、跨轮回执失效、**force 需宿主 allowForceOverride 才生效** |
| `dsh-audit-trail` | 27 | pre/result 配对、快照与还原、dry-run、符号链接与"回滚点后被改"保护、权限位还原、诚实统计、**轮次从三个事件学习 + since/sinceMinutes 时间回滚** |
| `dsh-standards-gate` | 12 |
| `dsh-orchestrator` | 38 | 默认六阶段、能力探测、入口/出口门禁（含新鲜度）、回退、熔断 latch + 人工 unblock、断点恢复、只能结算当前阶段、条件边、复盘与跨 run 台账回注、**阶段角色声明 + 可选 autoAdvance** |
| `test/integration.test.ts` | 3 | **七个插件同宿主跑完整条流水线**（下节） |

跨包集成测试走的路径（任何一处契约漂移都会让它失败）：

```
orchestrate start → 未审批规格下 write 被 guard 拒绝 → spec_create 落盘并绑定会话
→ test_design_review ✅ → spec_approve（approval seam）→ write 放行
→ audit: pre 行含写前快照 → quality_gate_run PASS
→ evidence_record(test/command) → mission_complete ❌（缺证据类型 + 门禁早于最新证据）
→ 重跑 quality_gate_run（自愈）→ mission_complete ✅ 签发回执 → 回执不可覆盖
→ audit_report → audit_rewind（dry-run 后真实还原被改文件）
```

## 2. 真机装配验证（真实 dsh 进程）

用一个隔离的 `DSH_HOME` 复制 `headless` profile，把 7 个 bundle 挂上后启动真实的 dsh：

```bash
# 隔离 profile（脚本化的等价步骤见下）
DSH_HOME=/tmp/dsh-eng-verify dsh --profile headless --dump-config   # 组合树：7 行都在，无 loader 报错
DSH_HOME=/tmp/dsh-eng-verify dsh --profile headless "任务"           # 真实进程加载
```

结果：

- `--dump-config` 输出了 7 个 bundle 的行与配置（`role-guard` … `orchestrator`），
  **没有** `duplicate loader entry id` 之类的装配错误。
- 真实进程启动后，7 个插件的日志各自写出 `applied (...)`，证明 `apply()` 在真实宿主里跑通、
  工具注册成功、系统提示段装配成功：

```
[dsh-role-guard]      applied (tools: team_delegate, role_list; provider=spawn; defaultRole=developer)
[dsh-spec-gate]       applied (tools: spec_create, spec_approve, spec_status; enforce=true; approval=auto)
[dsh-test-design-gate] applied (tools: test_design_review, test_design_template; prompt=true; strict=false)
[dsh-quality-gate]    applied (commands: smoke; turnStop=true; afterWrite=true)
[dsh-evidence-gate]   applied (tools: evidence_record, evidence_status, mission_complete; requireGate=true; …)
[dsh-audit-trail]     applied (tools: audit_report, audit_rewind; snapshot=true; redactArgs=true; prompt=false)
[dsh-orchestrator]    probes: dsh-role-guard(team_delegate), …, dsh-audit-trail(audit_report)
                      applied (tool: orchestrate; stages: spec-clarify → … → delivery)
```

  其中 `quality-gate` 的 `commands: smoke` 来自 profile 的覆盖型 patch
  （顶层 `- id: quality-gate` + `config:`），说明 profile 层覆盖配置的形状是对的。

## 2.5 对抗式审计与加固（2026-09-17 第二轮）

在"测试全绿"的状态下，用三个独立的对抗式审计（core/spec/role、quality/evidence、audit/orchestrator/
test-design）主动找 fail-open 路径。结论：**测试全绿 ≠ 没有漏洞**——审计找到 2 个 critical、10+ 个 major，
全部已修复并各自配了回归测试。

代表性的真实漏洞（都能在旧版本上复现）：

| 类别 | 漏洞 | 现在的行为 |
|---|---|---|
| 自审批 | `.dsh/**` 整体写豁免 → Agent 用 `write` 伪造 `mission.json` 的 `spec.approvedAt` | 只豁免派生的 `specs/*.md`；台账路径一律拒绝 |
| 权限反转 | 角色白名单过滤后为空 → `toolFilter` 被整个丢弃，只读角色拿到父 Agent 全权限 | 白名单永远生效；空集拒绝派发；`mode: read` 必须显式声明白名单 |
| 文档缩水 | 模型提交的用例表格解析不全 → 重新渲染的工件少了用例，人工却在审批它 | `designRowCounts` 比对行数/条数，不一致直接拒绝；表格解析兼容无前导竖线/全角竖线/无表头 |
| 门禁空转 | `quality_gate_run({only:['lint']})` 返回 PASS 并清零 pendingWrites → 必需命令从未执行也能交付 | `GateScope.full`；只有全量 PASS 才能交付；部分运行不清 pendingWrites |
| 证据不看结果 | `exitCode=2` 的"测试报告"也算证据 | command/test 证据必须 exitCode=0 + 有命令 + 有输出 |
| 伪造门禁 | 手写 `gates/GATE-…json` 即被视为 PASS | 必须台账里有匹配 `data.gateId` 的 gate 证据行；`lastGate` 按 `checkedAt` 而不是文件名排序 |
| 熔断可绕过 | `blocked` 只是状态文案，`resume` 即可继续 | `blocked` 是 latch，只有人工 `orchestrate({action:"unblock"})` 能解除（写 manual 证据） |
| 跳阶段 | `advance({stageId:'delivery'})` 一次跳过三个阶段与门禁 | `advance` 只能结算当前阶段；重开用 `rerun` |
| 路径逃逸 | `missionId: '../../x'` 可读写工作区外文件 | `assertSafeId` + `isInside`；越界直接抛错 |
| 边界形同虚设 | `fileBoundaries: ['**']` 匹配 `../x` 与 `/etc/hosts` | 先判越界再匹配模式 |
| 挂起 | 子进程 provider 不响应 abort → 门禁永久阻塞 | `runCommand` 自己 race 截止时间并 `terminate()`；POSIX 下整组 kill |
| 跨会话 | 未绑定会话能审批/交付"工作区里最新的 mission" | 严格解析：显式 id → 本会话 → 委派父会话；没有 latest 回退 |
| 陈旧授权 | 规格改版后旧的测试设计评审仍可授权新验收标准 | `specReviewDigest` 绑定 + 改版即清空 `testDesign` |
| 回滚误伤 | `rewind` 跟随符号链接、无条件删除创建型文件 | 符号链接跳过；删除需 mtime+digest 校验，`force` 才覆盖 |

审计脚本与证据留在 `/tmp/audit-break/live/`、`/tmp/audit-qg-eg/`、`/tmp/r*.mjs`（临时目录，可重跑）。

## 2.9 脚本化模型的端到端验证（无需 API key）

真实 harness + 真实工具链 + **本地脚本化模型**（`scripts/stub-llm.mjs` 实现 DeepSeek
chat-completions 的 SSE 子集），一条命令跑完并逐项断言：

```bash
bash scripts/e2e-mission.sh
```

最近一次结果：**E2E GREEN，15/15 断言通过**（就是我独立复跑的那次）：

```
PASS stub served every request without a protocol/script violation（14 个决策）
PASS dsh exited 0
PASS mission status: delivered
PASS spec.approvedAt recorded (by auto)
PASS testDesign.passed === true (3 cases)
PASS gate GATE-…: state PASS, scope.full === true, 1 result(s)
PASS receipt RCP-… issued
PASS audit trail: 13 pre / 13 result rows
PASS audit trail: exactly one errored tool call (write before approval) —— 其余全部成功
PASS the write tool really wrote src/health.mjs / test/health.test.mjs
PASS all 7 plugins logged their own 'applied (' mount line
```

脚本化的模型走的是真实流程：`spec_create → test_design_review → （审批前故意写一次，被 spec-gate 拒绝）
→ spec_approve → write → write → bash(node --test 真跑) → evidence_record → bash → evidence_record →
quality_gate_run → mission_complete`。

**诚实的边界**：stub 证明的是**框架路径**（harness 事件与工具链路、七个插件的门禁与钩子），
不是模型质量。真实模型会话的验证方式见下一节。

## 3. 用真实 API key 再验一次（可选）

隔离 profile 里没有 `DEEPSEEK_API_KEY`（工具沙箱会把该环境变量从子进程里抹掉），
所以**没有跑通"真实模型驱动工具"的完整会话**：

```
dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"
```

在上面这条命令前 `export DEEPSEEK_API_KEY=…`（或先 `--profile tui` 在 Models 页存一次），
就能做最后一步验收：让模型真的走一遍
`spec_create → test_design_review → spec_approve → 实现 → evidence_record → quality_gate_run → mission_complete`，
并检查 `.dsh/` 下的工件与 `audit_report` 输出。

## 4. 复现真机验证

```bash
VERIFY=/tmp/dsh-eng-verify
ROOT=/Users/zhangyong/workspace/deepseek/dsh-project
rm -rf "$VERIFY" && mkdir -p "$VERIFY/profiles/headless"
cp ~/.dsh/profiles/headless/cordis.yml ~/.dsh/profiles/headless/cordis.patch.yml "$VERIFY/profiles/headless/"
mkdir -p "$VERIFY/profiles/node_modules"
ln -sfn ~/.dsh/profiles/node_modules/@deepseek-ai "$VERIFY/profiles/node_modules/@deepseek-ai"
ln -sfn ~/.dsh/profiles/node_modules/dsh-memory   "$VERIFY/profiles/node_modules/dsh-memory"
for p in dsh-eng-core dsh-role-guard dsh-spec-gate dsh-test-design-gate \
         dsh-quality-gate dsh-evidence-gate dsh-audit-trail dsh-orchestrator; do
  ln -sfn "$ROOT/packages/$p" "$VERIFY/profiles/node_modules/$p"
done
# 把 7 个 bundle 名写进 $VERIFY/profiles/headless/package.json 的 dsh.profile.bundles，
# 并在 cordis.patch.yml 里追加覆盖（approval: auto / logFile / commands），然后：
DSH_HOME="$VERIFY" dsh --profile headless "任务"
```

在真实 profile 里挂载（会改动 `$DSH_HOME/profiles/<name>`，需要你确认）：

```bash
bash scripts/install-into-dsh.sh --dry-run                 # 先看要改什么
bash scripts/install-into-dsh.sh --profiles headless       # 只装到 headless 试验
```

> 说明：`tui` 是生产 profile，脚本默认拒绝写入，只接受发布产物（见 `docs/PLUGIN-CONVENTIONS.md`）。

## 5. 脚本化模型的端到端验证（无需 API key）

§2.9 是这条链路的**结论**；本节是它的**实现与复现说明**，供下一个人改动桩/套件时对照。

### 5.1 桩是什么

`scripts/stub-llm.mjs`：零依赖的 Node HTTP 服务，实现
`@deepseek-ai/dsh-llm-deepseek` 真正消费的那一小块 DeepSeek chat-completions 协议。

契约是从适配器源码读出来的（不是猜的）——
`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js`：

| 关注点 | 事实 |
|--------|------|
| 端点 | `POST ${baseURL}/chat/completions`（`DEEPSEEK_BASE_URL` 决定 baseURL；桩同时接受任何以 `/chat/completions` 结尾的路径） |
| 请求头 | `authorization: Bearer <key>`、`accept: text/event-stream`；`stream: true` + `stream_options.include_usage: true` |
| 响应 | SSE：`data: {json}\n\n`，以 `data: [DONE]\n\n` 结束。`parseSse` 只在**空行**上 dispatch，且 EOF 早于 `[DONE]` 视为截断（`STREAM_CLOSED`） |
| 适配器真正读的字段 | 只有 `choices[].delta{content,reasoning_content,tool_calls[]}`、`choices[].finish_reason` 和 `usage` |
| 适配器**不读**的字段 | `id` / `object` / `created` / `model`（桩照样发出，保持与真实网关字节兼容；`PROTO body keys:` 行会记录请求体形状） |
| 工具调用分片 | 同一 `index` 的 `tool_calls` 分片累加 `arguments`；`id`/`name` 是**身份**，后续分片给 `null`/`''` 表示"不变"（`acceptIdentity`）。桩**故意把每段 arguments 拆两片**发，每次调用都在验证这条规则 |
| 终止 | 工具步 `finish_reason: "tool_calls"`，文本步 `"stop"`；`usage` 走 `choices: []` 的尾包。`stop` 且没有任何 block 会被判成 `EMPTY_RESPONSE` 错误——所以文本步必须有内容 |
| 步进 | 步号 = 请求里 `role: "assistant"` 的消息条数，**由请求推导，桩无会话状态**，跨轮/重跑都成立 |
| 旁路请求 | 不带 `tools` 的请求（如会话标题）返回无害文本且不消耗步号 |

### 5.2 脚本格式与失败策略

```jsonc
{ "steps": [
  { "tool": "spec_create", "arguments": { … },
    "note": "日志里可读的说明",
    "expectResultContains": ["尚未审批"] },  // 可选：断言"这一步自己的"工具结果
  { "say": "最后的文本回复" }                 // finish_reason: stop，agent loop 到此结束
] }
```

`expectResultContains` 的语义容易写错：它在**下一次请求**里被校验，而那时的最后一条
`role: "tool"` 消息正是**这一步自己的结果**（不是上一步的）。要断言 `bash` 的真实输出，
就把期望挂在**那条 `bash` 步骤**上。

失败一律"吵闹"：协议不符、步号越界、期望不匹配 → 打 `STUB-FATAL` 到 stderr
（附原始工具结果片段）并**以非零码退出**，让 harness 直接报 TRANSPORT 而不是悄悄跑完。
`scripts/e2e-mission.sh` 会 grep 这个标记，并在失败摘要里显式区分
"**桩期望不匹配**"（脚本问题）与"**框架失败**"（harness/插件问题）。

### 5.3 怎么跑

```bash
bash scripts/e2e-mission.sh                 # 默认：先 build，再建隔离 profile，跑，断言
bash scripts/e2e-mission.sh --no-build      # 复用 packages/*/dist（快速迭代）
bash scripts/e2e-mission.sh --keep          # 不擦除 /tmp/dsh-e2e（复用 workspace）
E2E_HOME=/tmp/other STUB_PORT=8899 bash scripts/e2e-mission.sh   # 换目录/端口，可并发
```

单独用桩（排查协议问题时）：

```bash
STUB_SCRIPT=/tmp/dsh-e2e/script.json node scripts/stub-llm.mjs --check   # 只校验脚本
STUB_SCRIPT=… STUB_PORT=8787 node scripts/stub-llm.mjs                   # 起服务，GET /health 探活
```

产物位置：`/tmp/dsh-e2e/{profiles,ws,logs}`；`logs/stub-llm.log` 是桩的请求/决策流水，
`logs/dsh.log` 是 harness 的 stdout/stderr，`logs/<entry-id>.log` 是七个插件各自的挂载与运行日志。

### 5.4 它断言什么

除 §2.9 列出的逐项 PASS 外，脚本还会：

- 审计流水里**恰好一次**失败的工具调用，且必须是审批前那次 `write`——其余全部成功。
  任何别的 `isError: true` 都算回归（这条断言正是为了抓住"bash 沙箱起不来"这种静默降级）。
- 两个实现文件确实被 `write` 工具写出来（不是脚本自己造的）。
- 七个插件各自写出 `applied (` 挂载行——文件存在不算证据，挂载行才算。
- 桩的期望校验全过（`CHECK previous result matches …`），其中两条挂在 `bash` 步骤上，
  断言 `node --test` 的真实输出含 `pass 1`、`node -e` 的真实输出含 `health status = ok`。
  也就是说：**证据文本是脚本给的，但命令是真的跑了并且真的退出 0**。

### 5.5 隔离 profile 的关键覆盖与沙箱

- 七个 bundle（role-guard / spec-gate / test-design-gate / quality-gate / evidence-gate /
  audit-trail / orchestrator）挂进 `dsh.profile.bundles`；`@deepseek-ai` 与套件包都 symlink 进
  `$E2E_HOME/profiles/node_modules`（其余由 launcher 的 `healProfilesModuleFallback` 自愈）。
- `spec-gate.approval: auto`（headless 没有审批应答方）、`quality-gate.commands` 一条必过命令、
  七个 `logFile` 全部落在 `$E2E_HOME/logs`（默认值会写 `~/.dsh`，越界）、`session-title-llm` 关闭
  （否则会多出一次未脚本化的 LLM 请求）。
- **沙箱**：脚本默认用 `DSH_PERMISSION_MODE=danger-full-access` 启动子 `dsh`。验证沙箱本身已被
  seatbelt 包住，嵌套 `sandbox-exec` 会 `sandbox_apply: Operation not permitted`，于是 bash 工具
  拒绝"无沙箱后端时裸跑"（这正是它设计的 fail-closed 行为）。桩脚本里只有 `node --test` /
  `node -e` 两条只读命令，工作区是可丢弃的 `/tmp` 仓库，因此用 harness 自己给出的补救方案。
  想看拒绝路径：`E2E_PERMISSION_MODE=workspace-write bash scripts/e2e-mission.sh`。

### 5.6 诚实的边界

- 桩证明的是**框架路径**：工具派发、hook 顺序、门禁的拦与放、工件落地、审计与回执。
  它**不证明模型质量**——每一步调什么工具是脚本写死的，真实模型会不会这么走完全没被覆盖。
- `evidence_record` 的 `command`/`test` 行里，**输出文本是脚本提供的**（"node --test: 1 passed"）。
  命令本身真的执行了、真的退出 0（审计流水 + 桩的期望校验 + gate 的独立子进程都能佐证），
  但"证据文本与真实 stdout 逐字一致"这件事，桩不保证。
- `retrospective.json` 在这条链路里不会出现：脚本走的是直接工具流，没有 `orchestrate start`
  驱动流水线；断言只把它当信息项，不当失败。
- 真实 key 的那次验收（§3）仍然独立存在：桩不能替代"真实模型 + 真实 API"的最后一跳。
