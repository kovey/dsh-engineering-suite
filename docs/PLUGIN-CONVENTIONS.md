# 插件实现约定（dsh-engineering-suite）

本文件是套件内所有插件的**接口契约**。实现新插件时先读它，再读
`packages/dsh-spec-gate`（模板插件）与 `packages/dsh-eng-core/src/*.ts`。

## 1. 包结构

每个插件是一个独立的 npm 包，目录固定：

```
packages/dsh-<name>/
├── package.json          # type: module, main: ./dist/index.js, dsh.bundle.patch
├── tsconfig.json         # extends ../../tsconfig.base.json + rootDir src / outDir dist
├── cordis.patch.yml      # bundle patch：insert 一行 id: <plugin-id>
├── README.md             # 插件职责 / 配置 / 工具 / 事件
├── src/
│   ├── index.ts          # 插件入口（name / inject / apply）
│   ├── config.ts         # 配置解析与默认值（纯函数，不依赖 harness）
│   └── …                 # 按关注点拆分子模块
└── test/
    └── *.test.ts         # node --test，从 ../dist/*.js 导入
```

`package.json` 骨架（照抄后改 name/description）：

```json
{
  "name": "dsh-xxx",
  "version": "0.1.0",
  "description": "…",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }, "./package.json": "./package.json" },
  "files": ["dist/", "cordis.patch.yml", "README.md"],
  "license": "Apache-2.0",
  "engines": { "node": "^22.19 || >=24" },
  "dependencies": { "dsh-eng-core": "workspace:*" },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/dsh-agent": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-llm": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-tools": "^0.1.5-rc.2"
  }
}
```

`cordis.patch.yml`（bundle patch，profile 只需把包名加进
`dsh.profile.bundles`；`insert` 是纯追加语义，**profile 不得重复 insert 同一个 id**）：

```yaml
- insert:
    - id: <plugin-id>          # 例如 quality-gate
      name: 'dsh-quality-gate'
      config: { enabled: true }
```

## 2. 插件入口

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-xxx'                 // 与包名一致
export const inject = ['tools']               // 只声明真正用到的服务
export function apply(ctx: Context, config: unknown = {}): void { … }
```

规则：

- **绝不修改 dsh 核心**：只使用 `ctx.tools.register()`、`ctx.tools.guard()`、
  `ctx.on()`、`ctx.effect()`、`ctx.systemPrompt.section()`、
  `ctx.get('…')`、`agent.ctx` 等官方契约。
- **apply 必须整体 try/catch**：插件装配失败绝不能弄坏宿主会话；失败写
  日志并以 `return` 收场。
- **不写 stdout**：日志只进文件（`cfg.logFile`）；`DSH_ENG_DEBUG=1` 时才镜像 stderr。
- **所有注册都走 `ctx.effect`**：`ctx.tools.register` 的返回值、`ctx.on` 的返回值、
  定时器，一律收集后在 effect 里释放（HMR / 卸载安全）。
- **运行时只 import 两个 harness 包**：`@deepseek-ai/dsh-tools`（`defineTool`）
  与 `@deepseek-ai/dsh-llm`（`createUserMessage`）。其余 harness 类型一律
  `import type`，保证插件对 harness 版本漂移有韧性。

## 3. 配置解析

配置来自 loader 行的 `config`，**没有 schemastery 也必须能给默认值**：

```ts
export interface XxxConfig { enabled: boolean; logFile: string; … }
export function resolveConfig(input: unknown): XxxConfig {
  const raw = (input ?? {}) as Record<string, unknown>
  return { enabled: raw['enabled'] !== false, logFile: str(raw['logFile'], '~/.dsh/xxx-plugin.log'), … }
}
```

- 布尔用 `!== false`，字符串/数字/数组用 core 的类型守卫（见 `dsh-eng-core` 用法）。
- **门禁的确定性来源是宿主配置**：命令、路径白名单、上限值都来自 config，
  绝不接受模型临时编造的命令作为门禁依据。

## 4. 共享运行时 `dsh-eng-core`

```ts
import {
  MissionStoreRegistry, resolveLayout, runCommand, splitCommand, outputDigestOf,
  gitFingerprint, gitDiffSummary, createLogger, parseSections, parseTestDesign,
  parseAcceptanceCriteria, renderSpecMarkdown, renderTestDesignBody, SPEC_FORMAT_HINT,
  sha256, missionId, sessionIdOf, sessionCwd, isSubagent, tail, formatTime,
  // 审计后追加：
  isSafeId, assertSafeId, pathMatchesAny, pathMatchesPattern, globToRegExp,
  specReviewDigest, designRowCounts, type GateScope,
} from 'dsh-eng-core'
```

- `MissionStoreRegistry#for(cwd)` 返回该工作区的 `MissionStore`（按 `rootDir` 缓存）。
  每个插件持有**自己的** registry；store 的每次写入都是 read-modify-write +
  原子替换，所以多个插件同时挂载也一致。
- 工作区布局（`resolveLayout`，默认根目录 `.dsh`）：
  `specs/<id>.md`、`missions/<id>/mission.json`、`missions/<id>/evidence.jsonl`、
  `missions/<id>/gates/*.json`、`missions/<id>/receipts/*.json`、
  `missions/<id>/stages/<stageId>.json`、`audit/<sessionId>.jsonl`、
  `audit/snapshots/…`、`state/sessions/<sessionId>.json`。
- 会话 → 任务绑定：`store.bindSession(sessionId, missionId)`、
  `store.active(sessionId)`、`store.resolve(sessionId, explicitId)`。
- `runCommand(spec, service?)` 返回 `{exitCode, signal, stdout, stderr, durationMs, timedOut, spawnError?}`，
  非零退出**不是**异常；`service` 传 `ctx.get('subprocess')`（存在则优先走 harness 沙箱）。
- 日志：`createLogger({ tag: name, file: cfg.logFile })`，返回 `logger.info/warn/error/debug`。

## 5. 事件与钩子（已核对 `@deepseek-ai/dsh-*` 的 .d.ts）

| 事件 | 模式 | 用途 |
|---|---|---|
| `tools/pre-execute` | waterfall `(exec, next) => Promise<PreToolDecision>` | 写操作前置拦截（spec-gate）、审计记录（audit-trail） |
| `tools/post-execute` | waterfall `(exec, result, next) => Promise<PostToolDecision>` | lint 反馈回路（quality-gate） |
| `tools/result` | emit `(exec, result)` | 审计结果落盘 |
| `agent/turn-stopping` | serial `(payload) => Promise<void>` | 轮次收尾门禁；用 `agent.steer(msg)` 阻止收尾（quality-gate） |
| `agent/pre-step` | waterfall `(payload, next) => Promise<PreStepDecision>` | 注入上下文 |
| `agent/created` / `agent/disposed` | emit | 按 agent 注册 scoped 内容（prompt section、工具） |
| `session/disposed` | emit | 清理会话态 |

`PreToolDecision = {kind:'allow'} | {kind:'deny', reason} | {kind:'ask', reason?}`；
`PostToolDecision = {kind:'accept', content?, additionalContexts?} | {kind:'block', feedback: ContentBlock[], additionalContexts?}`。

工具执行上下文（`exec`）：`{ agent, callId, rootCallId, name, arguments, signal, deferContext(), concludeTurn() }`。
**必须**观察 `exec.signal` 的取消语义。

## 6. 工具注册范式

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'

const TEXT_OUTPUT = { type: 'string' } as const
ctx.tools.register(defineTool({
  name: 'xxx_do',
  description: 'English, model-facing, one paragraph.',
  parameters: {
    missionId: { type: 'string', description: '…' },
    count: { type: 'integer', description: '…' },
    flag: { type: 'boolean', description: '…' },
    items: { type: 'array', items: { type: 'string' }, description: '…' },
  },
  output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value }] },
  async execute(args, exec) { … return 'text result' },
}))
```

- `parameters` 的隐式根是开放对象；必填用 `required: true`。
- `output.schema` 必填；文本结果用 `{ type: 'string' }` + 上面的 render。
- 返回值必须匹配 `output.schema`，否则注册表会判为工具错误。
- 中文/英文：**工具描述与参数说明用英文**（模型面），**工件文本与门禁提示用中文**
  （与 docs.md 的表格/章节名保持一致）。

## 7. 工具面契约（跨插件引用，不得改名）

### 4.1 新增的共享不变量（2026-09-17 对抗式审计后追加）

- **工件是信任根**：`.dsh/` 下除 `specs/*.md`（派生文档）之外的一切（`mission.json`、`state/**`、
  `roles/**`、`gates/`、`receipts/`、`stages/`、审计）都**不允许**被 `write`/`edit` 改写；
  插件自己的工件用 `fs` 写，不走工具管道。理由：一份可被被治理 Agent 改写的 `mission.json` 等于自审批。
- **id 是路径段**：任何来自模型或宿主的 id（missionId、sessionId）都必须过
  `isSafeId`/`assertSafeId`，`artifactPath` 还要 `isInside` 校验；绝不做"清洗后继续"。
- **解析即写作**：凡是"模型提交 markdown → 解析 → 重新渲染成工件"的地方，必须比较
  **提交行数 vs 解析条数**（`designRowCounts`），不一致就报错；否则人工审批的是另一份文档。
- **裁决要绑定被裁决的对象**：评审结果记 `specReviewDigest`（验收标准+用例的规范摘要），
  审批时重算比对；变更即失效，绝不复用旧 `passed`。
- **门禁要能自证覆盖范围**：`GateRecord.scope = { selected, total, full }`，
  只有 `full === true` 的门禁才能用于交付判定。
- **配置分两层**：profile 的 loader 行是**上限**，`<workspace>/.dsh/<plugin-id>.json` 只能细化它
  （典型：本仓库跑哪条测试命令）。用 `dsh-eng-core` 的 `loadProjectConfig()` 读取（带 mtime 缓存），
  显式声明"可覆盖键"与"忽略并记日志"的键；绝不允许项目文件 `enabled: false` 或改布局路径。
  配置文件在信任根里，模型写不了（见第 1 条）。
- **mission 解析是严格的**：显式 id → 本会话绑定 → 委派父会话绑定；**没有**
  "工作区里最新的 mission"回退，绑定记录损坏时直接报错（fail closed）。

| 插件 | 工具 | 语义 |
|---|---|---|
| dsh-role-guard | `team_delegate` / `role_list` | 按角色派发子代理 / 列出角色与白名单 |
| dsh-spec-gate | `spec_create` / `spec_approve` / `spec_status` | 建规格（写 `specs/<id>.md`）/ 人工审批 / 查询 |
| dsh-test-design-gate | `test_design_review` | 评审测试设计覆盖度、场景完整性、可执行性 |
| dsh-quality-gate | `quality_gate_run` / `quality_gate_status` | 执行宿主配置命令并三态裁决 / 查询最近门禁 |
| dsh-evidence-gate | `evidence_record` / `evidence_status` / `mission_complete` | 记录证据 / 证据与门禁总览 / 交付验收并签发回执 |
| dsh-audit-trail | `audit_report` / `audit_rewind` | 审计汇总 / 按轮次回滚工作区 |
| dsh-orchestrator | `orchestrate` | 推进/查询/重跑阶段流水线 |

门禁三态统一为 `PASS` / `WARN` / `BLOCK`（`GateState`），写入
`store.recordGate(missionId, { source, state, reason, results, fingerprint })`。

## 8. 测试约定

- 用 `dsh-eng-core/testing` 的 `createFakeHost()`：它提供 `tools.register/guard/get`、
  `on`、`effect`、`systemPrompt.section`、`get()`、`approval.request`、
  `subagents.start`、`subprocess.spawn`，并提供 `emit` / `waterfall` / `runTool` /
  `sectionText` / `dispose` 驱动事件与工具。
- 测试从 `../dist/index.js` 导入（构建产物），因此 `npm test` 前必须先 `tsc`。
- 每个插件至少覆盖：装配注册面（工具名 / 监听事件 / prompt section）、
  每条门禁的通过路径、**拒绝路径**（fail closed）、以及 dispose 后无残留。
- 命令：`node ../../node_modules/typescript/bin/tsc -p tsconfig.json && node --test test/*.test.ts`
  （本机 npm registry 不可用，node_modules 由 `scripts/link-deps.sh` 软链到 harness 安装目录）。

## 9. 质量红线

1. **fail closed**：证据缺失、门禁未跑、状态不确定 → 阻断并给出可执行的下一步，
   绝不"默认放行"。
2. **防死循环**：任何"阻断并要求修复"的路径都必须有次数上限与状态指纹比较
   （同一指纹不重复阻断）。
3. **副作用可回滚**：写文件前先快照（audit-trail 提供），门禁只读不写业务代码。
4. **工件可审计**：所有落盘内容都是 UTF-8 文本/JSON，可 commit、可 diff。
