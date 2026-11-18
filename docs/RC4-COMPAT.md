# dsh 0.2.2-rc.4 兼容核实（rc.2 → rc.4）

> **核实结论：16 个包（15 个宿主插件 + `dsh-eng-core`）不需要改任何代码就能在 rc.4 下加载与编译。**
>
> 证据强度从高到低：① 我们依赖的 **7 个接缝在 rc.2 与 rc.4 之间逐字节相同**（`lib` + `src` + 全部 `.d.ts`，
> 只有 `package.json` 的版本号不同）；② rc.4 依赖闭包里 **165 个 `@deepseek-ai/*` 包逐一比对**，
> 159 个逐字节相同、5 个不同（都是同一件事：新增一个 LLM 错误码 + 一个新 bundle）、1 个新增；
> ③ 用 **rc.4 的 `dsh-app-boot.evaluatePluginCompatibility`** 跑我们的 `peerDependencies`，rc.4 下 **16/16 兼容**；
> ④ 用 **rc.4 的 `.d.ts`** 编译我们 `packages/*/src` 全部 **282 个源文件**，`tsc` **退出 0**。
>
> 本文件只记录核实，不含任何行为改动；解包物已清理（`.tmp/` 在 `.gitignore` 里），本机 dsh 宿主仍是 **0.2.2-rc.2**，未升级。

- 任务：mission `dsh-0-2-2-rc-4-rc-2-16-diff-d-ts-20261118-143115`（implement 阶段）
- 核实日期：2026-11-18
- 基线（本机已装 rc.2）：`/Users/zhangyong/.nvm/versions/node/v24.18.0/lib/node_modules/@deepseek-ai/dsh`，`version: 0.2.2-rc.2`；
  接缝包在 `…/dsh/node_modules/@deepseek-ai/` 下，均为 `0.2.2-rc.2`
- 目标（npm 上的 rc.4）：`@deepseek-ai/dsh@0.2.2-rc.4`，tarball `deepseek-ai-dsh-0.2.2-rc.4.tgz`，
  `shasum: 3906b6f86a36c25475da1a8aec6d9095f5a06b0b`，`integrity: sha512-DRJaTWIk4ObkD…L9g1/UlMwNvpw==`，
  包 2.2 MB / 解包 6.2 MB / 534 个文件
- 范围：`packages/` 下 16 个包（`dsh-audit-trail`、`dsh-coverage-gate`、`dsh-deploy-gate`、`dsh-eng-core`（共享库）、
  `dsh-evidence-gate`、`dsh-impact-gate`、`dsh-interaction-gate`、`dsh-knowledge-base`、`dsh-orchestrator`、
  `dsh-quality-gate`、`dsh-role-guard`、`dsh-spec-gate`、`dsh-standards-gate`、`dsh-suite-doctor`、
  `dsh-supply-chain-gate`、`dsh-test-design-gate`）

---

## 1. 升级指南里与本套件相关的条目（AC-001）

### 1.1 指南自己说明的分段语义（原文）

`.tmp/rc4/package/docs/upgrade-guide/README.md:1-5`：

```text
# Upgrade guides

Generated when `@deepseek-ai/dsh` is packed. A `v<T>` section lists what to change when upgrading from release vT to the release after it; vT is the release being left, not the target. Paths are relative to this file.

打包 `@deepseek-ai/dsh` 时生成。`v<T>` 一节列出从 vT 版本升级到其下一个版本时需要做的修改；vT 是升级前的版本，不是目标版本。路径相对于本文件。
```

也就是说：`v0.2.2-rc.2` 段 = rc.2→rc.3 要改什么，`v0.2.2-rc.3` 段 = rc.3→rc.4 要改什么。

### 1.2 关键事实：rc.4 的指南里**没有** `v0.2.2-rc.2` 段 —— rc.2→rc.3 没有破坏性变更

rc.4 与 rc.2 的指南 README 全文 diff，**新增内容只有 `v0.2.2-rc.3` 一个 6 行段落**：

```text
$ diff -u <rc.2>/docs/upgrade-guide/README.md .tmp/rc4/package/docs/upgrade-guide/README.md
@@ -4,6 +4,12 @@
 
 打包 `@deepseek-ai/dsh` 时生成。`v<T>` 一节列出从 vT 版本升级到其下一个版本时需要做的修改；vT 是升级前的版本，不是目标版本。路径相对于本文件。
 
+## v0.2.2-rc.3
+
+| Item | Summary | 摘要 | English | 中文 |
+| --- | --- | --- | --- | --- |
+| DeepSeek content refusal error code | The DeepSeek streamed content refusal code changes from MALFORMED_RESPONSE to CONTENT_REFUSED. | DeepSeek 流式内容拒答的错误码从 MALFORMED_RESPONSE 改为 CONTENT_REFUSED。 | [v0.2.2-rc.3/deepseek-refusal-code/guide.md](…) | [v0.2.2-rc.3/deepseek-refusal-code/guide.zh.md](…) |
+
 ## v0.2.2-rc.1
```

两侧的 `v0.2.2` 段落清单（`grep -n '^## v0.2.2'`）：

| 版本 | 指南里有的 `v0.2.2` 段 |
|---|---|
| rc.2（本机已装） | `v0.2.2-rc.1`、`v0.2.2-alpha.3`、`v0.2.2-alpha.2` |
| rc.4（npm 最新） | **`v0.2.2-rc.3`**、`v0.2.2-rc.1`、`v0.2.2-alpha.3`、`v0.2.2-alpha.2` |

`grep -rn "v0.2.2-rc.2" .tmp/rc4/package/docs/upgrade-guide/` **没有任何命中**；目录清单里也只有
`v0.2.2-rc.3/` 一个新目录（`v0.2.2-rc.2/` 不存在）。所以 **rc.2→rc.4 的破坏性变更清单 = rc.3→rc.4 的那一条**
（rc.2→rc.3 段为空）。另外用 `npm view @deepseek-ai/dsh versions` 确认 `0.2.2-rc.3` 确实发布过
（45 个版本，最后 4 个：`0.2.2-rc.1`、`0.2.2-rc.2`、`0.2.2-rc.3`、`0.2.2-rc.4`），
所以"没有 rc.2 段"不是漏打包，而是那一步确实没有需要人改的东西。

### 1.3 唯一条目：DeepSeek 内容拒答错误码（原文）

`v0.2.2-rc.3/deepseek-refusal-code/guide.md`：

```text
# DeepSeek content refusal error code

## Change

When DeepSeek ends a model stream with `stop_reason: "refusal"`, DSH reports `CONTENT_REFUSED` in the LLM error finish and in the failed turn's `turn/end` error. Previously, the adapter reported `MALFORMED_RESPONSE` for this stop reason.

## Migration

1. Handle `CONTENT_REFUSED` in code that classifies LLM error finishes or `turn/end` errors. Tell the user that the provider refused the request.
2. Replay a Messages stream ending in `refusal` and check that your handler takes the refusal path.
```

`guide.zh.md`（同一份的中文）：

```text
## 变更

当 DeepSeek 以 `stop_reason: "refusal"` 结束模型流时，DSH 在 LLM 的错误终止块和失败轮次的 `turn/end` 错误中报告 `CONTENT_REFUSED`。此前，适配器对这一停止原因报告 `MALFORMED_RESPONSE`。

## 迁移

1. 在对 LLM 错误终止块或 `turn/end` 错误分类的代码中处理 `CONTENT_REFUSED`，向用户说明提供方已拒绝该请求。
2. 回放一条以 `refusal` 结束的 Messages 流，确认处理程序进入拒答分支。
```

### 1.4 与本套件的关系：**无关**（逐条结论 + 依据）

| 指南条目 | 原文摘要 | 与 16 个包的关系 | 结论 |
|---|---|---|---|
| `v0.2.2-rc.2` 段（rc.2→rc.3） | **不存在**（该段为空） | rc.2→rc.3 没有要改的东西 | 无关 |
| DeepSeek content refusal error code（rc.3→rc.4） | `stop_reason: "refusal"` 时错误码 `MALFORMED_RESPONSE` → `CONTENT_REFUSED` | 迁移第 1 步要求"对 LLM 错误终止块或 `turn/end` 错误分类的代码"处理新码；**我们的源码不做任何 LLM 错误分类**（下节给出 grep 证据） | 无关，无需改动 |

"不分类 LLM 错误"的证据（`packages/*/src` 全量 grep，排除 `dist/`）：

```text
$ grep -rn "MALFORMED_RESPONSE\|CONTENT_REFUSED\|LlmError\|finishReason\|turn/end" packages/*/src --include=*.ts
（无输出）
$ grep -rhoE "from '@deepseek-ai/[a-z0-9-]+'" packages/*/src --include=*.ts | sort | uniq -c
  16 from '@deepseek-ai/dsh-tools
  15 from '@deepseek-ai/cordis
   2 from '@deepseek-ai/dsh-llm      ← 只有 createUserMessage 与 MessageSourceMap 模块增强
```

我们对 `@deepseek-ai/dsh-llm` 的全部用法：

- `packages/dsh-orchestrator/src/hooks.ts:31` / `packages/dsh-quality-gate/src/hooks.ts:26`：`import { createUserMessage } from '@deepseek-ai/dsh-llm'`
- `packages/dsh-orchestrator/src/sources.ts:21` / `packages/dsh-quality-gate/src/sources.ts:19`：`declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { … } }`（类型增强，不涉及错误码）

两条代码级旁证（rc.4 侧）：

```text
$ grep -n "CONTENT_REFUSED\|MALFORMED_RESPONSE" .tmp/rc4/extra/node_modules/@deepseek-ai/dsh-llm/src/error.ts
24:  CONTENT_REFUSED: {},
48:  MALFORMED_RESPONSE: { retryChoice: true },
```

→ 新码是**新增**，旧码 `MALFORMED_RESPONSE` 保留，不构成"移除/改名"（对既有代码无影响）。

---

## 2. 七个接缝的 diff 结论（AC-002）

### 2.1 结论表

比对方式：把 7 个包以 `0.2.2-rc.4` 装进 `.tmp/rc4/seams/`，与本机 rc.2 副本
（`…/dsh/node_modules/@deepseek-ai/<pkg>`）做 `diff -rq` + `lib`/`src` 全文件 sha256 汇总哈希。
**7 个包的全部代码与类型声明逐字节相同**——`diff -rq` 除 `package.json`（版本号）与本地多出的嵌套 `node_modules/`
之外没有任何差异；哈希（`lib`+`src`，忽略路径）完全一致：

| 接缝 | rc.2 / rc.4 版本 | 比对文件数（`lib`+`src`） | rc.2 与 rc.4 汇总 sha256（前 12 位） | 新增 | 变更 | 移除 | 影响我们？ |
|---|---|---|---|---|---|---|---|
| `dsh-tools` | 0.2.2-rc.2 / **0.2.2-rc.4** | 53 | `8e670df825f0` = `8e670df825f0` | 无 | 无 | 无 | **不影响**：`ctx.tools.register/guard/get/restrict` 全在，逐字节相同 |
| `dsh-user-approval` | 0.2.2-rc.2 / **0.2.2-rc.4** | 11 | `3bfc09aaabb2` = `3bfc09aaabb2` | 无 | 无 | 无 | **不影响**：`approval.request` 与 `approval/request` 事件不变 |
| `dsh-user-questions` | 0.2.2-rc.2 / **0.2.2-rc.4** | 26 | `9d2454d9f222` = `9d2454d9f222` | 无 | 无 | 无 | **不影响**：`ask`/`askTimed` 不变 |
| `dsh-subagent` | 0.2.2-rc.2 / **0.2.2-rc.4** | 116 | `aea86e53a182` = `aea86e53a182` | 无 | 无 | 无 | **不影响**：`startActivation`/`getProvider`/`registerProvider`/`prompt`/`sendMessage` 不变 |
| `dsh-commands` | 0.2.2-rc.2 / **0.2.2-rc.4** | 26 | `82bffb8f1899` = `82bffb8f1899` | 无 | 无 | 无 | **不影响**：`commands.register` 不变 |
| `dsh-agent` | 0.2.2-rc.2 / **0.2.2-rc.4** | 41 | `da246c0cf709` = `da246c0cf709` | 无 | 无 | 无 | **不影响**：`agent/turn-stopping`、`agent/disposed`、`agent/pre-step` 等事件名不变（我们只做结构类型，不 import 运行时值） |
| `dsh-plugin-manager` | 0.2.2-rc.2 / **0.2.2-rc.4** | 91 | `fbb410de6e01` = `fbb410de6e01` | 无 | 无 | 无 | **不影响**：我们的源码不 import 它、也不 `ctx.get` 它的服务（`grep -rn "pluginManager\|plugin-manager" packages/*/src` 无命中） |

`.d.ts` 层面同样零变化（`lib/types/*.d.ts` 文件数与类型哈希；rc.2 与 rc.4 相同，故同一哈希）：

| 接缝 | `.d.ts` 个数 | rc.4 `lib/types/*.d.ts` 汇总 sha256（前 12 位） |
|---|---|---|
| `dsh-tools` | 10 | `d7ecfc12c987` |
| `dsh-user-approval` | 2 | `4552fd1dc1f1` |
| `dsh-user-questions` | 4 | `44605371ff4f` |
| `dsh-subagent` | 22 | `4a5ff9f1a566` |
| `dsh-commands` | 4 | `23f9ff72eb12` |
| `dsh-agent` | 8 | `b40fe1b346d4` |
| `dsh-plugin-manager` | 17 | `28344bed10b9` |

`diff -rq` 的原始输出为空（这是"无差异"的直接证据）：

```text
$ for p in dsh-tools dsh-user-approval dsh-user-questions dsh-subagent dsh-commands dsh-agent dsh-plugin-manager; do
    echo "##### $p"; diff -rq "$LOCAL/$p/lib" "$NEW/$p/lib" | grep -v '\.js\.map';
  done
##### dsh-tools
##### dsh-user-approval
##### dsh-user-questions
##### dsh-subagent
##### dsh-commands
##### dsh-agent
##### dsh-plugin-manager
（7 个包都没有任何输出）
```

### 2.2 我们到底用到这些接缝的哪些成员（对照依据）

`packages/*/src`（不含 `dist/`）里 `ctx.get(...)` 的分布：

```text
$ grep -rhoE "ctx\.get\(['\"][^'\"]+['\"]\)" packages/*/src --include=*.ts | sed -E "s/ctx\.get\(['\"]([^'\"]+)['\"]\)/\1/" | sort | uniq -c | sort -rn
  15 interaction        ← 本套件 dsh-interaction-gate 自己 provide
  13 approval           ← dsh-user-approval
  11 subprocess         ← dsh-subprocess
   8 commands           ← dsh-commands
   7 subagents          ← dsh-subagent
   7 knowledge-base     ← 本套件 dsh-knowledge-base 自己 provide
   5 nvim-tui           ← 外部插件（非 @deepseek-ai/dsh-* 版本线）
   4 chatInteraction    ← 外部插件（同上）
   4 agentTeams         ← dsh-agent-team
   3 workspaceChanges   ← dsh-workspace-changes
   3 orchestrator       ← 本套件 dsh-orchestrator 自己 provide
   2 userQuestions      ← dsh-user-questions
   2 agentPresets       ← dsh-agent-preset-registry
   1 tools              ← dsh-tools
   1 clock              ← cordis 的 timer 插件（宿主 package.json 里版本未变）
```

其中 7 个接缝覆盖了 `approval`、`commands`、`subagents`、`userQuestions`、`tools`、`dsh-agent`（事件），
`dsh-plugin-manager` 未被使用。**宿主事件订阅**（`packages/*/src`）：

```text
'session/disposed' ×5   'agent/turn-stopping' ×4   'agent/disposed' ×4   'tools/result' ×3
'tools/pre-execute' ×2  'tools/post-execute' ×2    'session/event' ×2    'approval/request' ×2   'agent/pre-step' ×2
```

这些事件名定义在上面这些**逐字节相同**的包里，所以"事件接缝"同样零变化。

### 2.3 用宿主自己的兼容门禁与类型系统复核（不是靠人读 diff）

**(a) peer 版本门禁**：`dsh-app-boot` 的 `evaluatePluginCompatibility(manifest, exemptions?, runtimeVersion)`
（rc.2 起加载时强制，UPGRADE.md §1.1）。用 **rc.4 的** `dsh-app-boot` 跑我们 16 个包的 `package.json`：

```text
$ node .tmp/rc4/compat-check.mjs
runtime 0.2.2-rc.2: compatible=16/16
runtime 0.2.2-rc.3: compatible=16/16
runtime 0.2.2-rc.4: compatible=16/16
```

`semver` 真值表（`includePrerelease: true`，与宿主判定一致）：

```text
satisfies(0.2.2-rc.4, ">=0.2.0-rc.1 <0.2.3-0", includePrerelease) = true
satisfies(4.1.0, "^4.0.4", includePrerelease) = true
```

（rc.4 宿主对 `@deepseek-ai/cordis` 的声明是 `~4.1.0`，与 rc.2 的 `package.json` 逐字相同；本机装的是 4.1.0。）

我们 16 个包的 peer 声明是 `@deepseek-ai/dsh-{agent,llm,tools,subagent,subprocess} >=0.2.0-rc.1 <0.2.3-0` +
`@deepseek-ai/cordis ^4.0.4`，**已经覆盖 rc.4，不需要改版本范围、不需要重发版**。

**(b) 用 rc.4 的 `.d.ts` 编译我们的全部源码**（临时 tsconfig 把 `@deepseek-ai/*` 指向 rc.4 的类型，`noEmit`）：

```text
$ node node_modules/typescript/bin/tsc -p .tmp/rc4/tsconfig.rc4-all.json ; echo "EXIT: $?"
EXIT: 0
$ node node_modules/typescript/bin/tsc -p .tmp/rc4/tsconfig.rc4-all.json --listFilesOnly | grep -c "/packages/"
282
```

即：282 个源文件在 rc.4 的类型面下编译通过（其中 `dsh-llm` 的 `MessageSourceMap` 增强、
`createUserMessage` 都仍然成立）。

**(c) 我们自己的宿主 API 审计脚本**（`scripts/check-host-api.sh`，把 `ctx.get` 的服务/成员写成表）：

```text
$ bash scripts/check-host-api.sh                      # rc.2（本机）
  ok   approval           request
  ok   subprocess         spawn
  FAIL subagents: 缺少成员 list
  ok   agentPresets       register,mount
  ok   userQuestions      ask,askTimed
  ok   workspaceChanges   summary,diff
  SKIP agentTeams         dsh-experimental-agent-team 未安装（可选）
7 条服务假设，1 条不成立。   EXIT 1

$ bash scripts/check-host-api.sh --harness-root .tmp/rc4/hostroot   # rc.4
（逐行完全相同的输出）   EXIT 1
```

**rc.2 与 rc.4 的审计结论逐字相同**，即升级没有带来**新的**失败项。但这里有两条**与本 mission 无关的既有问题**
（rc.2 上就存在，`dsh-subagent` 又是逐字节相同的，所以绝不是 rc.4 回归），列出来交给 Lead 决定是否另开 mission：

1. 【已修，见下方「后续」】`subagents … list` 这条期望过期：rc.2/rc.4 的 `dsh-subagent` 的 `SubagentRuntime` 声明的是
   `listDescendants(...)`，**没有 `list`**（`grep -n "    list" …/dsh-subagent/lib/types/*.d.ts` 只命中
   `index.d.ts:241: listDescendants(`）。我们的代码自己也把它当可选：`packages/dsh-eng-core/src/delegation.ts:593`
   `if (typeof subagents.list !== 'function') return undefined`。所以脚本表里应把 `list` 标成可选（或改成真实成员），
   否则这条 `FAIL` 会永远在。
2. 【已修，见下方「后续」】`agentTeams|dsh-experimental-agent-team` 的**包名过期**：rc.2 与 rc.4 的宿主都只装 `dsh-agent-team`
   （两条宿主的 `node_modules/@deepseek-ai/` 里都没有 `dsh-experimental-agent-team`；npm 上这个旧名字停在
   `0.1.5-alpha.2`，与 0.2.2 线无关），
   于是这一行 **永远 SKIP**，`agentTeams` 的 `spawnTeammate` 从没被真正审计过。建议改成 `dsh-agent-team`。

**后续（2026-11-18，mission `check-host-api-sh-subagents-list-20261118-151907`）：两条都已修**，且修的方式不是把
"缺成员"降级成跳过，而是让表与宿主真实接口一致：

```text
$ bash scripts/check-host-api.sh          # rc.2，修后
  ok   subagents          startActivation,getProvider,listDescendants,registerProvider,prompt,sendMessage
  ok   agentTeams         isEnabled,setEnabled,createTask,getTask,listTasks,updateTask
7 条服务假设，0 条不成立。   EXIT 0
```

- `subagents` 行：`list` → `listDescendants`（`dsh-subagent/lib/types/index.d.ts:241`）。
- `agentTeams` 行：包名 `dsh-experimental-agent-team` → `dsh-agent-team`，成员改为该服务真实暴露的
  `isEnabled/setEnabled/createTask/getTask/listTasks/updateTask`——**没有 `spawnTeammate`**（所以上面"从没被真正
  审计过"的方法其实并不存在；真正该审计的是这 6 个）。
- `|optional` 的语义同时收紧：只允许"**包未安装**"跳过，**装着的包缺成员一律失败并点名**。旧实现把"缺成员"也
  当可选，于是即使包名写对了，下一次改名仍会被静默吞掉。
- 反证：把某一行的成员临时改成宿主不声明的名字 → `exit 1` 并点名该成员；`scripts/selftest-ops.sh` 的 C12 夹具
  同步改为 `listDescendants`，并新增"装着的可选包缺成员 → exit 1 且点名""可选包未安装 → 跳过不失败"两条断言。

> 附：当时这条审计脚本**不在** `scripts/verify.sh` 的流水线里，所以它的 `EXIT 1` 不影响 AC-004 的 verify 全绿。
> 2026-11-18 已接进 `verify.sh`（mission `check-host-api-sh-verify-dsh-ski-20261118-154419`）：检测到 `dsh` 时
> 该阶段真跑、失败即 verify 失败；`command -v dsh` 为空时打印
> `SKIP host API audit: 没有检测到 dsh 安装（command -v dsh 为空）…` 并继续（退出码 0）——
> "没查"和"查过且成立"是两句话，只有后者算绿。

---

## 3. 接缝之外：rc.2 → rc.4 的**全部**实际变化

为回答"有没有第七个接缝以外的东西被改了"，把 rc.4 的依赖闭包整棵树拉下来
（`.tmp/rc4/extra/`，165 个带 `lib` 的 `@deepseek-ai/*` 包）与本机 rc.2 逐个做 `lib`+`src` 全文件哈希比对：

```text
with lib: 165
IDENTICAL: 159
DIFFER: dsh-llm-deepseek dsh-llm dsh-official-bundles dsh-repeat-tool-reminder dsh-session-persistence-jsonl
NEW-IN-rc4: dsh-deepseek-chat-import
```

宿主主包 `@deepseek-ai/dsh` 自身：`lib` 的 `diff -rq` **无输出**，`src` 汇总哈希两侧同为 `8ad49c0da1248b7d`；
`package.json` 只差版本号，外加**新增一个依赖** `@deepseek-ai/dsh-deepseek-chat-import`（其余依赖只是版本串从 rc.2 → rc.4）。

### 3.1 `dsh-llm`：错误码表**新增** `CONTENT_REFUSED`（纯附加）

```text
$ diff -u <rc.2>/dsh-llm/src/error.ts <rc.4>/dsh-llm/src/error.ts
@@ -21,6 +21,7 @@
   ACCOUNT_TOKEN_INVALID: {},
   AUTH: {},
   CLIENT_UPGRADE_REQUIRED: {},
+  CONTENT_REFUSED: {},
   CONTEXT_WINDOW_EXCEEDED: {},
```

`lib/index.js`、`lib/types/error.js`、`lib/types/error.d.ts` 是同一行的编译产物。**`MALFORMED_RESPONSE` 仍在**
（`src/error.ts:48`），没有删除、没有改名。

### 3.2 `dsh-llm-deepseek`：`stop_reason: "refusal"` 现在抛 `CONTENT_REFUSED`，且先产出 usage

```text
$ diff -u <rc.2>/dsh-llm-deepseek/lib/index.js <rc.4>/dsh-llm-deepseek/lib/index.js
+function refusal(details) {
+	const explanation = … details.explanation : void 0;
+	return new LlmError(`DeepSeek refused to answer under its content safety review${…}`, "CONTENT_REFUSED");
+}
 …
-			if (delta.stop_reason != null) reason = stopReason(delta.stop_reason);
+			if (delta.stop_reason === "refusal") refused = refusal(delta.stop_details);
+			else if (delta.stop_reason != null) reason = stopReason(delta.stop_reason);
 …
+			usage.totalTokens = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
+			if (refused !== void 0) {
+				yield { type: "usage", usage };
+				throw refused;
+			}
```

rc.4 源码里的原注释（`.tmp/rc4/extra/node_modules/@deepseek-ai/dsh-llm-deepseek/src/translate.ts:158`）：
`// Tokens consumed before a refusal are billed, so report them before failing.`
`lib/types/translate.d.ts` 只有 JSDoc 变化（"A refusal yields final usage before throwing `CONTENT_REFUSED`"）。
**我们没有任何代码读 LLM finish / `turn/end` 错误，所以这条行为变化对我们零影响**（见 §1.4 的 grep）。

### 3.3 `dsh-official-bundles`：只是把新 bundle 加进三张清单

```text
$ diff -u <rc.2>/src/bundles.ts <rc.4>/src/bundles.ts
+  '@deepseek-ai/dsh-deepseek-chat-import',

$ diff -u <rc.2>/src/plugin-manager.ts <rc.4>/src/plugin-manager.ts
+  '@deepseek-ai/dsh-deepseek-chat-import',   （两处清单）
```

### 3.4 `dsh-repeat-tool-reminder` / `dsh-session-persistence-jsonl`：只是"打包了新版错误码表"

两者的 diff **各自只有一行**，都是内联的 `CONTENT_REFUSED: {}`（它们的历史打包产物内联了 `dsh-llm` 的常量表）：

```text
$ diff -u <rc.2>/dsh-repeat-tool-reminder/lib/index.js <rc.4>/…/lib/index.js
+	CONTENT_REFUSED: {},
$ diff -u <rc.2>/dsh-session-persistence-jsonl/lib/worker.cjs <rc.4>/…/lib/worker.cjs
+	CONTENT_REFUSED: {},
```

### 3.5 新增包 `@deepseek-ai/dsh-deepseek-chat-import@0.2.2-rc.4`

```text
name: @deepseek-ai/dsh-deepseek-chat-import
version: 0.2.2-rc.4
description: Import DeepSeek chat exports as stored Sessions in a chosen Workspace
dsh.client.platform: web
peerDependencies: cordis ~4.1.0 / dsh-llm 0.2.2-rc.4 / dsh-session 0.2.2-rc.4 / dsh-session-title 0.2.2-rc.4 / dsh-tool-web 0.2.2-rc.4
```

宿主文档里的同一件事（rc.4 新增的 `ctx.deepseekChatImport` 服务，owner-only 上传路由）：

```text
docs/capability-seams.md: | `ctx.deepseekChatImport` | `service` | … | Serves the owner-only upload route that imports each conversation of a DeepSeek chat export as a Session, and the upload limits the browser checks first. |
docs/config-catalog.md:   ## `@deepseek-ai/dsh-deepseek-chat-import`  (maxSessions / maxUploadBytes / maxEntryBytes / maxTitleBytes)
docs/subsystems/persistence.md: ### `ctx.deepseekChatImport` — `DeepseekChatImportService`
```

rc.4 的文档 diff 全部是这三处（+ 升级指南），**没有任何已有 seam 的语义变化**。

---

## 4. 需要改的清单 —— 结论：**代码无需改动**

（AC-002 要求"我们用到且被改的必须改代码并说明改动点"：我们**用到**的包里只有 `dsh-llm` 被改，且是纯附加；
其余被改的 4 个包我们都不 import、不 `ctx.get`、不订阅它们的事件。）

| 变化 | 我们是否用它 | 为什么不需要改 |
|---|---|---|
| `dsh-llm` +`CONTENT_REFUSED` | 是（`createUserMessage` + `MessageSourceMap` 增强） | 错误码表是**新增**；我们不读 LLM 错误码（`grep` 无命中）；rc.4 类型下 282 个文件 `tsc` 退出 0 |
| `dsh-llm-deepseek` refusal 行为 | 否（不 import） | 我们不做错误分类；新行为只改变宿主怎么把"拒答"报给会话 |
| `dsh-official-bundles` +新 bundle | 否（`grep -rn official-bundles packages/*/src` 无命中） | 只是可选 bundle 清单多了"导入 DeepSeek 聊天记录"这一个 Web bundle |
| `dsh-repeat-tool-reminder` / `dsh-session-persistence-jsonl` | 否 | 只是内联常量表多一行，无行为变化 |
| 7 个接缝 | 是 | 逐字节相同（§2） |
| 宿主主包（CLI/boot） | 是（运行在它上面） | `lib` 无差异、`src` 哈希相同 |
| peer 版本校验 | 是（加载时强制） | `>=0.2.0-rc.1 <0.2.3-0` 与 `cordis ^4.0.4` 都覆盖 rc.4；rc.4 的 `evaluatePluginCompatibility` 判 16/16 兼容 |

**必须改的：无。** 本 mission 因此只产出本文件（+ 一条 CHANGELOG 记录）。
两条**建议另开 mission** 的既有问题见 §2.3 末尾（`check-host-api.sh` 的 `list` 与 `agentTeams` 包名）；**两条都已于
2026-11-18 修复**（mission `check-host-api-sh-subagents-list-20261118-151907`，改法与验证见 §2.3 末尾的「后续」）。

---

## 5. 新能力：有没有值得采用的？（AC-003 → 结论：不采用，理由如下）

rc.2→rc.4 只带来两样"新东西"，两样都不是插件接缝：

| 新东西 | 是什么 | 值不值得采用 | 依据 |
|---|---|---|---|
| `CONTENT_REFUSED` 错误码 | LLM 错误码表里的一个新值 | **不采用** | AC-003 的迁移点限定为"对 LLM 错误终止块 / `turn/end` 错误分类的代码"。本套件没有这样的代码（§1.4 grep 全为空）；我们唯一的 `dsh-llm` 用法是 `createUserMessage` 与消息来源类型增强。要"采用"它只能凭空造一个错误分类面（我们的门禁不消费模型的终止原因），那是新增行为，不是适配，且没有真实调用方会用 |
| `@deepseek-ai/dsh-deepseek-chat-import` + `ctx.deepseekChatImport` | 可选的 **Web** bundle：浏览器里上传 `deepseek_data-*.zip`，把 DeepSeek 官网聊天导出成 Workspace 里的 Session（owner-only 上传路由） | **不采用** | 它要动的是会话导入与 Web 客户端注入（`dsh.client.platform: web`）；本套件是 host 侧门禁插件，与"聊天记录导入"没有交集；16 个包的 peer 也不依赖它。采用等于给套件加一个未被要求的功能 |

因此 AC-003 走"**明确说明为何不采用**"这一支：**rc.4 没有为本套件提供可用的新接缝**，
两条候选都被上面的证据排除。测试设计里的 TC-1894（"采用新能力 → 运行相关用例"）是条件分支，
本次不触发——没有采用点，也就没有新增用例。

如果将来 Lead 坚持要一个"采用点"，唯一诚实的位置是文档/诊断（例如在 `docs/KNOWN-LIMITS.md`
或 suite-doctor 的宿主能力说明里记一句"rc.4 起拒答会以 `CONTENT_REFUSED` 上报"），
它不改变任何行为、也没有可断言的运行时效果——收益是注释，所以本次不做。

---

## 6. 未覆盖与诚实边界

1. **没有升级宿主，因此没有真机端到端验证**。本报告证明的是 API/类型/字节层面的兼容，不是"rc.4 上跑一遍 16 个插件
   的门禁全都正常"。真机验证需要 `dsh plugin update` 并重启会话（负面约束禁止在本 mission 里做）。
2. **对比范围**：rc.4 依赖闭包里带 `lib` 的 165 个 `@deepseek-ai/*` 包全部比对；本机 rc.2 共有 338 个包，
   未比对的 173 个是 rc.4 闭包没拉下来的**可选 bundle**（client UI、CUA、experimental、web frontend 等），
   它们既不在我们的 import 面（只有 `dsh-tools`/`cordis`/`dsh-llm`），也不在 `ctx.get` 的服务面（§2.2）里。
   若需要"零遗漏"，要装整棵 rc.4 树再比一遍（本次没做，代价是几百 MB 与数分钟）。
3. `check-host-api.sh` 的 rc.4 结果是**用 `.tmp` 里的 host-root 拼出来的**：该脚本从 `<root>/dsh/package.json` 读版本，
   而 `.tmp/rc4/extra` 里没有 `dsh` 主包，所以造了 `.tmp/rc4/hostroot/dsh/{package.json(来自 rc.4 tarball), node_modules→…/extra/node_modules}`。
   这是**路径拼装**，不改任何被审计内容；拼装物随后已随 `.tmp/rc4` 删除。
4. `nvim-tui`、`chatInteraction` 两个服务来自**外部插件**（不在 `@deepseek-ai/dsh` 版本线上），它们的兼容性
   不由本次 rc.2→rc.4 的变化决定，本报告不覆盖。
5. 我们的 `dist/`（未入库）里存在与 `src/` 不一致的旧产物（例：`packages/dsh-spec-gate/dist/llm.d.ts`
   没有对应的 `src/llm.ts`）。它不影响本报告的类型结论（`tsc` 只读 `src`），但说明工作区里的 `dist` 可能陈旧：
   **`scripts/verify.sh` 重建之后这个文件仍然在**（构建不清理 `dist` 的残留），所以它是"陈旧产物没被删除"，
   不是"这次构建漏掉了某个源文件"。

---

## 7. 实际执行的命令与关键输出

> 所有路径为绝对路径（门禁要求）。`<ABS>` = `/Users/zhangyong/workspace/deepseek/dsh-project`。

### 7.1 拉取与解包 rc.4

```text
$ mkdir -p <ABS>/.tmp/rc4 && cd <ABS>/.tmp/rc4
$ npm pack @deepseek-ai/dsh@0.2.2-rc.4 --cache <ABS>/.tmp/npmcache
npm notice name: @deepseek-ai/dsh
npm notice version: 0.2.2-rc.4
npm notice filename: deepseek-ai-dsh-0.2.2-rc.4.tgz
npm notice package size: 2.2 MB
npm notice unpacked size: 6.2 MB
npm notice shasum: 3906b6f86a36c25475da1a8aec6d9095f5a06b0b
npm notice integrity: sha512-DRJaTWIk4ObkD[...]L9g1/UlMwNvpw==
npm notice total files: 534
deepseek-ai-dsh-0.2.2-rc.4.tgz

$ tar -xzf <ABS>/.tmp/rc4/deepseek-ai-dsh-0.2.2-rc.4.tgz -C <ABS>/.tmp/rc4
$ ls <ABS>/.tmp/rc4/package/docs/upgrade-guide/
… v0.2.1-rc.4  v0.2.2-alpha.2  v0.2.2-alpha.3  v0.2.2-rc.1  v0.2.2-rc.3   ← 没有 v0.2.2-rc.2
```

### 7.2 七个接缝

```text
$ npm install --prefix <ABS>/.tmp/rc4/seams --cache <ABS>/.tmp/npmcache \
    @deepseek-ai/dsh-tools@0.2.2-rc.4 @deepseek-ai/dsh-user-approval@0.2.2-rc.4 \
    @deepseek-ai/dsh-user-questions@0.2.2-rc.4 @deepseek-ai/dsh-subagent@0.2.2-rc.4 \
    @deepseek-ai/dsh-commands@0.2.2-rc.4 @deepseek-ai/dsh-agent@0.2.2-rc.4 \
    @deepseek-ai/dsh-plugin-manager@0.2.2-rc.4
added 84 packages in 35s

$ # 版本自证
dsh-tools 0.2.2-rc.4 / dsh-user-approval 0.2.2-rc.4 / dsh-user-questions 0.2.2-rc.4 /
dsh-subagent 0.2.2-rc.4 / dsh-commands 0.2.2-rc.4 / dsh-agent 0.2.2-rc.4 / dsh-plugin-manager 0.2.2-rc.4

$ # 逐包汇总哈希（lib+src；值相同 ⇒ 逐字节相同）
dsh-tools            local=8e670df825f0(53 files) new=8e670df825f0(53 files) IDENTICAL
dsh-user-approval    local=3bfc09aaabb2(11 files) new=3bfc09aaabb2(11 files) IDENTICAL
dsh-user-questions   local=9d2454d9f222(26 files) new=9d2454d9f222(26 files) IDENTICAL
dsh-subagent         local=aea86e53a182(116 files) new=aea86e53a182(116 files) IDENTICAL
dsh-commands         local=82bffb8f1899(26 files) new=82bffb8f1899(26 files) IDENTICAL
dsh-agent            local=da246c0cf709(41 files) new=da246c0cf709(41 files) IDENTICAL
dsh-plugin-manager   local=fbb410de6e01(91 files) new=fbb410de6e01(91 files) IDENTICAL

$ diff <rc.2>/dsh-tools/package.json <rc.4>/dsh-tools/package.json
< "version": "0.2.2-rc.2"   > "version": "0.2.2-rc.4"
（其余只有它自己依赖的版本串：rc.2 → rc.4）
```

### 7.3 接缝之外（宿主闭包全量比对）

```text
$ # 装扩大的宿主服务面（这些包提供我们 ctx.get 的服务）
$ npm install --prefix <ABS>/.tmp/rc4/extra @deepseek-ai/dsh-llm@0.2.2-rc.4 \
    @deepseek-ai/dsh-subprocess@0.2.2-rc.4 @deepseek-ai/dsh-workspace-changes@0.2.2-rc.4 \
    @deepseek-ai/dsh-agent-preset-registry@0.2.2-rc.4 @deepseek-ai/dsh-agent-team@0.2.2-rc.4
added 65 packages in 2s
$ npm install --prefix <ABS>/.tmp/rc4/extra @deepseek-ai/dsh-app-boot@0.2.2-rc.4 \
    @deepseek-ai/dsh-base@0.2.2-rc.4 @deepseek-ai/dsh-session@0.2.2-rc.4 \
    @deepseek-ai/dsh-llm-deepseek@0.2.2-rc.4            → added 302 packages in 2m
$ npm install --prefix <ABS>/.tmp/rc4/extra @deepseek-ai/dsh-official-bundles@0.2.2-rc.4
$ npm install --prefix <ABS>/.tmp/rc4/extra @deepseek-ai/dsh-deepseek-chat-import@0.2.2-rc.4

$ # 全量比对（lib+src；165 个带 lib 的 @deepseek-ai 包）
with lib: 165
IDENTICAL: 159
DIFFER: dsh-llm-deepseek dsh-llm dsh-official-bundles dsh-repeat-tool-reminder dsh-session-persistence-jsonl
NEW-IN-rc4: dsh-deepseek-chat-import

$ # 宿主主包
$ diff -rq <rc.2>/dsh/lib <ABS>/.tmp/rc4/package/lib | grep -v '\.js\.map'    → 无输出
host src sha256: rc.2=8ad49c0da1248b7d rc.4=8ad49c0da1248b7d IDENTICAL
```

### 7.4 宿主兼容门禁 + rc.4 类型面编译

```text
$ node <ABS>/.tmp/rc4/compat-check.mjs      # 用 rc.4 的 dsh-app-boot 判我们 16 个包
runtime 0.2.2-rc.2: compatible=16/16
runtime 0.2.2-rc.3: compatible=16/16
runtime 0.2.2-rc.4: compatible=16/16

$ node node_modules/typescript/bin/tsc -p <ABS>/.tmp/rc4/tsconfig.rc4-all.json ; echo "EXIT: $?"
EXIT: 0
$ node node_modules/typescript/bin/tsc -p … --listFilesOnly | grep -c "/packages/"   → 282
```

### 7.5 交付验证（本报告落地后、解包物删除后各跑一次 verify）

```text
$ bash scripts/verify.sh --quiet
per-package build (dependency order)           ok
type-check (no emit)                           ok
per-package tests                              ok
cross-package integration test                 ok
the tooling's own self-test (no dsh, no build, no network) ok

all green.
VERIFY EXIT: 0

$ bash scripts/standards-check.sh --quiet
结构规范检查：PASS — 无新增/恶化违规（基线已接受 537 项，本次扫描 1418 个文件）
STANDARDS EXIT: 0
```

（本报告与 CHANGELOG 的改动不影响这两条命令的输入：`verify.sh` 的构建/类型/测试都只读 `src`/`dist`；
`grep -rn "docs/" packages/*/test test/*.ts scripts/*.sh` 的命中全是注释与临时夹具里造出来的 `docs/…` 路径，
没有任何一个测试读仓库自己的 `docs/` 目录。）

### 7.6 清理与本机状态

```text
$ rm -rf <ABS>/.tmp/rc4
$ ls <ABS>/.tmp            → 只剩 npmcache（预先存在的缓存目录，已被 .gitignore 的 `.tmp/` 覆盖）
$ git status --porcelain   → 只有本文件与 CHANGELOG.md 的改动（见交付说明）
$ node -e "console.log(require('<global>/@deepseek-ai/dsh/package.json').version)"   → 0.2.2-rc.2（未升级）
```

### 7.7 附录：两个临时脚本（已随 `.tmp/rc4` 删除，内容抄录以便复核）

`.tmp/rc4/compat-check.mjs` —— 用 **rc.4 的** `dsh-app-boot` 判我们 16 个包的 peer 兼容性：

```js
import { readdirSync, readFileSync } from 'node:fs'
import { evaluatePluginCompatibility } from '<ABS>/.tmp/rc4/extra/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'

const root = '<ABS>/packages'
const names = readdirSync(root).sort()
for (const runtimeVersion of ['0.2.2-rc.2', '0.2.2-rc.3', '0.2.2-rc.4']) {
    let ok = 0
    const bad = []
    for (const name of names) {
        const manifest = JSON.parse(readFileSync(`${root}/${name}/package.json`, 'utf8'))
        const result = evaluatePluginCompatibility(manifest, undefined, runtimeVersion)
        if (result === undefined) ok += 1
        else bad.push(`${name}: ${JSON.stringify(result)}`)
    }
    console.log(`runtime ${runtimeVersion}: compatible=${ok}/${names.length}${bad.length ? ' problems: ' + bad.join(' | ') : ''}`)
}
```

`.tmp/rc4/tsconfig.rc4-all.json` —— 只改 `paths`，把 8 个 `@deepseek-ai/*` 的**类型**指到 rc.4（其余靠工作区既有
`node_modules`；那些包在两版之间逐字节相同）：

```json
{
  "extends": "<ABS>/tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": "<ABS>",
    "paths": {
      "@deepseek-ai/dsh-llm":          ["<ABS>/.tmp/rc4/extra/node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts"],
      "@deepseek-ai/dsh-tools":        ["<ABS>/.tmp/rc4/seams/node_modules/@deepseek-ai/dsh-tools/lib/types/index.d.ts"],
      "@deepseek-ai/dsh-subagent":     ["<ABS>/.tmp/rc4/seams/node_modules/@deepseek-ai/dsh-subagent/lib/types/index.d.ts"],
      "@deepseek-ai/dsh-user-approval":["<ABS>/.tmp/rc4/seams/node_modules/@deepseek-ai/dsh-user-approval/lib/types/index.d.ts"],
      "@deepseek-ai/dsh-user-questions":["<ABS>/.tmp/rc4/seams/node_modules/@deepseek-ai/dsh-user-questions/lib/types/index.d.ts"],
      "@deepseek-ai/dsh-commands":     ["<ABS>/.tmp/rc4/seams/node_modules/@deepseek-ai/dsh-commands/lib/types/index.d.ts"],
      "@deepseek-ai/dsh-agent":        ["<ABS>/.tmp/rc4/seams/node_modules/@deepseek-ai/dsh-agent/lib/types/index.d.ts"],
      "@deepseek-ai/dsh-plugin-manager":["<ABS>/.tmp/rc4/seams/node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/index.d.ts"]
    }
  },
  "include": ["<ABS>/packages/*/src/**/*.ts"]
}
```
