# 升级指南

两件互相独立的事，别混在一起：

| 你在升什么 | 从哪里到哪里 | 影响 |
|---|---|---|
| **harness**（`@deepseek-ai/dsh-*`） | 0.1.5-rc.x → **0.1.7-rc.1** | 插件的 peer 声明、消息来源 kind、Stub 协议 |
| **套件**（本仓库） | 首次发布的 0.1.0 | 新增 4 个插件、若干工具与配置键、审批接缝语义 |

升级完请跑第 3 节的验收清单——**"装上了"不等于"适配了"**。

---

## 1. 升级到 harness 0.1.7-rc.1 / rc.2

### 1.1 peer 声明会被**加载时强制校验**（0.1.7-rc.2 起必须处理）

`dsh-app-boot` 的 `evaluatePluginCompatibility` 会对每个 `@deepseek-ai/dsh*` peer 跑
`semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })`；不满足就**跳过整个插件**：

```text
dsh: skipping profile bundle "dsh-role-guard": Error: Plugin dsh-role-guard@0.1.0 is incompatible with
dsh 0.1.7-rc.2: peerDependencies {"@deepseek-ai/dsh-agent":"0.1.7-rc.1", …}
```

**症状很有迷惑性**：插件"装上了"但在会话里全都不在（`applied (` 一行都没有），工具变成 `unknown tool`，
门的记录、mission、审计文件一个都不产生——看起来像插件坏了，其实是版本声明没过门。

写法怎么选（下表是用 harness 自带的 `semver` 实测的，`includePrerelease: true`）：

| 写法 | rc.2 | rc.3 | 0.1.7 | 0.1.8-rc.1 | 0.2.0-rc.1 | 适合谁 |
|---|---|---|---|---|---|---|
| `0.1.7-rc.2`（官方/生态常用，精确） | ✓ | ✗ | ✗ | ✗ | ✗ | 每个 rc 都愿意重新发版的插件 |
| `^0.1.7-rc.2` | ✓ | ✓ | ✓ | ✓ | ✗ | 能接受跨 minor 自动跟随 |
| **`>=0.1.7-rc.2 <0.1.8-0`** | ✓ | ✓ | ✓ | ✗ | ✗ | **同线自动跟随、跨 minor 必重验**（本套件采用） |
| `^0.1.5-rc.2` | ✗ | ✗ | ✗ | ✗ | ✗ | 谁都匹配不上——不要用 |

三种例外情况：

- `workspace:^` / `workspace:~` / `workspace:*` 会被当成"当前 runtime 版本"，用于同仓开发；
- 老写法 `^0.1.5-rc.2` **匹配不到任何 0.1.7 预发布**（semver 规定：带预发布的范围只匹配同元组的预发布）；
- 想临时放行：`dsh plugin allow-version <插件>@<版本>`（或在插件管理器里开 exact-version 豁免）——
  这是"明确接受风险"，不要当成升级方案。

**协议再漂移怎么排查**：`STUB_DUMP_DIR=/tmp/dump bash scripts/e2e-mission.sh` 会把每个请求体落盘
（`req-001.json`…）。rc.2 这次就是靠它证明"工具结果形状没变、只是插件被门禁跳过了"。

### 1.2 消息来源 kind：`'plugin'` 没有了

0.1.7 的 `MessageSourceMap` **移除了共享的 `plugin` 兜底 kind**，官方注释写明
"each producer declares its own `kind` in its own module"。任何 `source: { kind: 'plugin', plugin: 'x' }`
在类型上直接失败（运行时写进去也不会被校验，但类型先拦住你）。

改法（本套件 `dsh-orchestrator`/`dsh-quality-gate` 的 `src/sources.ts` 是范例）：

```ts
export interface MyNoticeSource {
    readonly kind: 'dsh-my-plugin'
    readonly form: 'notice'
    readonly summary: string          // 会被 harness 截到 120 字符
}

declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'dsh-my-plugin': MyNoticeSource
    }
}
```

然后在注入处 `source: { kind: 'dsh-my-plugin', form: 'notice', summary }`（不再有 `plugin` 字段）。

### 1.3 DeepSeek provider 换成了 Messages 协议

0.1.5 是 `POST /chat/completions` + OpenAI chunk；0.1.7 是 `POST /messages` + Messages SSE：

- 每一帧的 JSON **必须带字符串 `type`**，且与 `event:` 名一致（否则 `MALFORMED_RESPONSE: SSE event type mismatch`）；
- 事件序列：`message_start` → `content_block_start` → `content_block_delta*` → `content_block_stop` →
  `message_delta`（`delta.stop_reason` 收口）→ `message_stop`；
- 文本块 `{type:'text'}` + `delta:{type:'text_delta',text}`；工具块 `{type:'tool_use',id,name,input}` +
  `delta:{type:'input_json_delta',partial_json}`；
- 工具结果在请求里是 `user` 消息的 `tool_result` 块（`tool_use_id` + `content`），工具声明用 `input_schema`；
- **没有 `data: [DONE]`**，`message_stop` 即结束。

**如果你有基于旧协议的 stub/mock**（本套件的 `scripts/stub-llm.mjs` 就是），它必须一起改——
否则端到端验证会以 `MALFORMED_RESPONSE` 失败，而且失败信息看起来像"插件坏了"，其实是协议没跟上。

### 1.4 审批接缝更严了（重要）

`dsh-user-approval` 的 `ApprovalOutcome` 是**四个字符串**，实现是
`OUTCOMES.includes(outcome) ? outcome : 'unavailable'`。含义：

- 应答者**返回对象会被规范化成 `unavailable`（拒绝）**——"顺手多返回一点信息"等于每次都拒绝；
- 想记录"谁批的"，只能让通道把决定写进**它自己的台账**（例如 IM 插件的 `-approvals.jsonl`），
  或等宿主放宽接缝；不要指望通过返回值传身份。

### 1.5 顺带获得的新能力（可选用）

- 子代理委派现在由 harness 自动继承 parent 的 `permissionPreset`/`sandboxMode`，并把**审批策略钉成 `never`**——
  派出去的子代理不能自己批准什么，这正是本套件想要的性质，无需插件侧改动。
- 沙箱策略服务（`dsh-fs-sandbox` / `dsh-bash-sandbox` / `dsh-pwsh-sandbox`）、权限预设
  （`dsh-permission-presets`）、`dsh-mcp-client`、问答/审批的客户端面（`dsh-user-questions`、
  `dsh-client-ui-*`）都是新东西；本套件暂未依赖，按需接入。

---

#### 0.2.0 官方能力：采纳 / 不采纳（结论，理由见 ARCHITECTURE §5.16）

- **采纳**：`workspaceChanges` 作为"变更事实"的来源（挂载且可用时优先，否则回退自研 git 解析，并在输出里标明来源）。
- **互补**：官方 Agent Teams 是协作面（roster / 邮箱 / 任务 DAG），`role-guard` 是授权面（角色 / 权限 / 模型 / 白名单）；
  协作状态**不是**证据，不能替代 mission / 回执 / 门禁记录。
- **不采纳（但它只收紧）**：`auto-review` 不得接管授权。代码级核实：它只返回 `deny` / `ask` / `cancel`，**从不返回 `allow`**；
  我们的强制性拦截又是**单调守卫**（没有守卫能强制放行）。挂上它的后果是"更严 + 更多问人 + 更多 LLM 调用"，不是绕过门禁。
- **各司其职**：`plugin-manager` / `config-editor` 负责安装与编辑；**验证与自检仍是本套件**。
- **已核实的边界（真机）**：PTC（`run_code`）的子调用经过 `prepareExecution`，守卫仍生效——实验里 PTC 程序内的 `write`
  被 spec-gate 拒绝、文件未创建、审计留下子调用自己的两行；代价是调用量（1 次 `run_code` + 1 个子调用 = 4 行审计）。
  注意 `run_code` 只在 `dsh-tools` 的 `config.mode: ptc` 下可见（默认 `native`）。

### 1.6 从 0.1.7-rc.2 到 0.2.0-rc.1（v0.2.0 的基线）

**必改的只有一件事：peer 范围。** 0.2.0 的加载时门禁会拒绝针对 0.1.7 线声明的插件
（`skipping profile bundle "<插件>": … is incompatible with dsh 0.2.0-rc.1`）。把每个 `@deepseek-ai/dsh*` peer
改为同一 0.2.0 线的范围 `>=0.2.0-rc.1 <0.2.1-0`（本项目 v0.2.0 已如此声明并验证）。

其余接缝**本轮实测未变**：`ApprovalOutcome` 仍是 `allowed-once | rejected | cancelled | unavailable`；
`MessageSourceMap` 仍要求"每个生产者声明自己的 kind、没有 `plugin` 兜底"（我们自有 kind 无需改动）；
子代理委派仍自动继承 preset/sandbox 并把审批策略钉成 `never`；DeepSeek provider 仍是 Messages 协议
（`scripts/stub-llm.mjs` 无需改动）。

**在安装前验证候选 harness**（本轮新增，默认行为不变）：

```bash
DSH_HARNESS_ROOT=/tmp/dsh020/node_modules DSH_BIN=/tmp/dsh020/node_modules/.bin/dsh \
  bash scripts/e2e-mission.sh
```

0.2.0-rc.1 比 0.1.7-rc.2 多 53 个包，其中与"工程治理"相邻、值得后续评估的有：
**`dsh-experimental-agent-team`（官方 agent 团队）**、`dsh-experimental-auto-review`（自动评审）、
`dsh-workflow-ptc` / `dsh-ptc-runtime`（程序化工具调用）、`dsh-plugin-manager` / `dsh-config-editor`、
`dsh-workspace-changes` / `dsh-tool-workspace-dependencies`，以及 **session 格式 v4
（`dsh-session-format-v3-to-v4`，我们不受影响）**。本套件暂未依赖它们——接入（例如让 role-guard 复用官方
agent-team）需要单独一轮评估。

## 2. 使用套件 0.1.0（首次发布）

### 2.1 新增的插件（挂上去即可，默认不打扰）

`dsh-standards-gate`、`dsh-impact-gate`、`dsh-coverage-gate`、`dsh-supply-chain-gate`。
它们的默认行为要么是"只在被调用时动作"，要么是 opt-in（例如 `requireStandardsGate`、
`requireDeliveryApproval` 默认关）。加进 profile 的 `dsh.profile.bundles`：

```json
"bundles": ["…原有…", "dsh-standards-gate", "dsh-impact-gate", "dsh-coverage-gate", "dsh-supply-chain-gate"]
```

### 2.2 新增的工具面

| 工具 | 用途 |
|---|---|
| `spec_amend` | 需求/验收标准的**增/改/删**（编号稳定、删除作废不复用、删除被用例引用的标准需 `cascade`） |
| `standards_check` / `standards_bootstrap` / `standards_review` / `standards_status` | 代码规范门禁与棘轮 |
| `impact_analyze` / `impact_tests` / `impact_status` | 变更影响与最小回归测试集 |
| `coverage_check` / `flaky_check` / `coverage_status` | 覆盖率（含增量）与 flaky |
| `secret_scan` / `dependency_audit` / `supply_chain_status` | 密钥与供应链 |

### 2.3 需要你确认的配置（仓库级，`.dsh/*.json`）

- 规范门禁需要 `<repo>/.dsh/standards.json`（`bash scripts/project-config.sh --standards on` 可生成骨架）；
- 覆盖率/flaky 需要 `coverageCommand` 或 `reportFile`；
- 供应链需要（可选）`deps.auditCommands`，否则最多 WARN——"没配审计命令"不等于"依赖没问题"；
- 影响分析的测试命令模板（`testCommandTemplate`）没配时，`impact_tests` 会**拒绝**而不是猜。

### 2.4 行为变化

- 交付：如果开了 `requireDeliveryApproval`，`mission_complete` 会在清单全绿后等人点头，回执里带审批人；
- 规范/覆盖率/供应链门禁会把记录写进 mission（`gates/`），交付侧可以要求它们（`requireStandardsGate` 等）；
- 编排：阶段可以声明 `difficulty`/`model`，可以开 `autoDispatch`（默认关），`standards-pass` 是新增门禁种类。

---

## 2.5 从 v0.1.0 到当前开发版（六阶段补齐）

v0.1.0 覆盖 规划/实现/测试/交付 四段为主；这一版把 **交互** 与 **部署** 补上。要做的事：

**① 挂三个新 bundle**（默认不打扰，但要用就得挂）：

```json
"bundles": ["…原有 11 个…", "dsh-interaction-gate", "dsh-suite-doctor", "dsh-deploy-gate"]
```

**② 需要人决定的两个新配置**（都在仓库里，属于信任根）：

```bash
bash scripts/project-config.sh --workspace <repo> --write --interaction on --deploy on
# 顺带会把运行时台账写进 .gitignore（幂等，可用 --no-gitignore 跳过）
```

- `.dsh/interaction-gate.json`：`askTimeoutMs`、`requireApproverList`（严格名单）等；**严格名单要配
  `<repo>.dsh/interaction-approvers.txt`**，否则所有回答都会被判"无权限"。
- `.dsh/deploy-gate.json`：`environments` 默认空 → `deploy_plan`/`deploy_run` 直接拒绝；
  每个环境要声明 `deployCommands` / `verifyCommands` / `rollbackCommands`（**没有回滚命令就不判 go**）。

**③ 如果想让流水线覆盖部署**：在阶段配置里用新的门禁种类 `deploy-go`（部署已执行）与 `deploy-verified`
（上线后验证通过）。它们**不在默认流水线里**——多数 mission 不部署，宿主显式声明阶段才生效。

**④ 台账只增不减的仓库**：先看再搬：

```bash
bash scripts/archive-missions.sh --keep 20 --days 90 --dry-run   # 看会搬什么
bash scripts/archive-missions.sh --keep 20 --days 90             # 执行（未交付默认不动）
```

**⑤ 先自检再开工**：`bash scripts/doctor.sh [<repo>]`（必需项缺失时退出码 1），会话里用 `suite_status`。
它会指出仓库缺哪些门禁配置、每条都给出确切命令；`unknown` 不等于没问题。

**行为变化**：`.gitignore` 的粒度被明确（运行时忽略、配置提交）；`dsh-interaction-gate` 会往
`.dsh/interaction.jsonl` 写决定台账；`dsh-deploy-gate` 会往 `.dsh/deployments.jsonl` 写部署台账——
两者都是运行时文件，应被忽略（脚手架会补）。

---

## 3. 升级后的验收清单（照着跑）

```bash
# 1) 套件自身：类型 + 单测 + 跨包集成
bash scripts/verify.sh                     # 期望：498 测试 / 497 通过 / 0 失败 / 1 跳过

# 2) 真实 harness 端到端（脚本化模型，不需要 API key）
bash scripts/e2e-mission.sh                # 期望：E2E GREEN，11 个插件全部 applied

# 3) 真机装配（隔离 DSH_HOME，不碰生产 profile）
DSH_HOME=/tmp/dsh-check bash scripts/install-into-dsh.sh   # 之后启动会话，/plugins 应看到 11 个 bundle
```

再看三件事，确认"适配"而不只是"装上"：

1. **注入类功能是否正常**：触发一次阶段自动推进或门禁 BLOCK，确认会话里出现通知且没有 `MALFORMED_RESPONSE`；
2. **审批链是否通**：`spec_create` → `test_design_review` → `spec_approve`，确认审批通过后写操作放行；
3. **门禁记录是否落账**：`.dsh/missions/<id>/gates/` 里能看到对应 `source` 的记录，且 `mission_complete` 认可。

## 4. 回滚

套件本身无状态迁移：把 profile 的 `bundles` 改回旧集合、`git checkout` 到旧 tag 重新 `install-into-dsh.sh` 即可。
harness 回滚到 0.1.5-rc.x 时，记得同时把插件的 peer 声明改回能匹配旧版的写法（并集或旧版范围），
否则模块解析会失败——0.1.0 只声明并验证 `>=0.1.7-rc.2 <0.1.8-0`。
