# 升级指南

两件互相独立的事，别混在一起：

| 你在升什么 | 从哪里到哪里 | 影响 |
|---|---|---|
| **harness**（`@deepseek-ai/dsh-*`） | 0.1.5-rc.x → **0.1.7-rc.1** | 插件的 peer 声明、消息来源 kind、Stub 协议 |
| **套件**（本仓库） | 0.1.0 → **0.1.5** | 新增 3 个插件、若干工具与配置键、审批接缝语义 |

升级完请跑第 3 节的验收清单——**"装上了"不等于"适配了"**。

---

## 1. 升级到 harness 0.1.7-rc.1

### 1.1 peer 声明必须锁版

0.1.7 的官方与生态包都用**精确版本**：`"@deepseek-ai/dsh-agent": "0.1.7-rc.1"`、`"@deepseek-ai/cordis": "~4.0.4"`。

**不要**写 `^0.1.5-rc.2` 这类范围：semver 规定，带预发布的范围只匹配**同一 major.minor.patch 元组**的预发布，
所以 `^0.1.5-rc.2` **不匹配** `0.1.7-rc.1` —— `dsh plugin add` 会报 peer 不满足（或装上了却在运行期解析失败）。

若确实要同时支持两版，用并集：`"^0.1.5-rc.1 || ^0.1.7-rc.1"`（本套件选择锁版，因为它按版本验证）。

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

## 2. 升级套件 0.1.0 → 0.1.5

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
否则模块解析会失败——本套件的 `0.1.5` 只声明并验证 `0.1.7-rc.1`。
