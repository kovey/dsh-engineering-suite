# dsh-role-guard

角色与权限层（`docs.md` §3.1）：**一个 `.md` 文件定义一个角色，白名单由宿主强制**。

## 职责

- 角色文件 = persona + 模型路由 + 工具白名单 + 技能白名单（YAML frontmatter + 正文）。
- `team_delegate`：主 Agent 通过它派活；每个子 Agent 按角色创建，携带
  `toolFilter`（**白名单外的工具在子 Agent 的工具列表里根本不存在**，不是“调用后被拒绝”）、
  `persona`（影子 persona 段）、`agentOptions`（provider/model/reasoningEffort/maxTokens）。
  `agentOptions` 默认取角色文件的模型路由，也可以**按调用覆盖**（见下文「按调用覆盖模型」）。
- 严格的写/只读分离：`mode: read` 的角色无论文件怎么写，都会被剥掉 `readonlyDeny` 里的写工具。
- 技能白名单在调用时强制：子会话 id → 角色的绑定落盘，`ctx.tools.guard` 拒绝加载白名单外的技能
  （见下文「技能白名单如何被强制」）。
- 把角色清单与职责分离要求注入系统提示。
- 与官方 **Agent Teams**（`agentTeams` 服务 + `spawn_teammate` 等工具，harness 0.2.0）合成：
  `team_delegate` 会**按名字拒绝**走官方 teammate 创建路径并说明缺哪条保证，
  官方路径创建的 teammate 一律被记录为 `ungoverned`（见下文「与官方 Agent Teams 的合成」）。

## 角色文件

```markdown
---
id: developer            # 小写 kebab-case，唯一
name: 实现者
description: 按已审批的规格实现代码
mode: write              # write | read
tools:                   # 工具白名单（留空 = 继承全部，再用 deny 减）
  - read
  - write
  - edit
  - bash
deny: []                 # 追加排除
model: deepseek-official/deepseek-v4-flash   # provider/model，留空 = 继承父 Agent
maxTokens: 8192
skills:                  # 技能白名单（调用时由宿主强制；留空 = 不限制）
  - auto-retrospective
persona: |
  你是实现者……
---

正文会追加到 persona 之后。
```

查找顺序（**后者覆盖前者**）：

1. 本包自带 `roles/`（`developer` / `reviewer` / `qa`）；
2. 工作区 `<root>/roles/*.md`（默认 `.dsh/roles/`）；
3. 配置里的 `roleDirs`；
4. 配置里的内联 `roles: [...]`。

解析失败的角色**不会**让插件崩：错误会出现在 `role_list` 输出里，其余角色照常可用。

## 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `team_delegate` | `role` `task`(必填) `context` `deliverable` `model` `reasoningEffort` `maxTokens` `dispatch` | 按角色派发；返回子 Agent 会话 id、stop reason、工具/技能白名单、**实际生效的模型路由及来源**、**派发路径**与产出 |
| `role_list` | `role` | 列出角色表（含技能白名单）；给 `role` 时输出该角色完整 persona 与白名单强制状态 |

派发时子 Agent 的 prompt 会自动带上：角色卡、任务、上下文、交付要求、**当前 mission 的规格摘要**
（验收标准 / 文件边界 / 负面约束，`injectSpec` 控制）、以及硬约束清单。

### 服务 seam：让别的插件"不用模型"也能按角色派发

`team_delegate` 是给模型用的；自主派发器（例如 orchestrator 进入阶段时）没有模型在环，需要同一个答案。
装配后本插件提供 `role-guard` 服务：

```ts
const plan = ctx.get('role-guard').plan({ role: 'developer', cwd: mission.cwd, agent })
// → { persona, mode, toolFilter, dropped, route, source }
```

- 用的是**与 `team_delegate` 完全相同的解析器**（工具白名单过滤、只读模式降权、角色路由），
  所以"自动派发的子代理"不会拿到比"模型派发的子代理"更多的权限；
- **未知角色抛错**（fail closed），调用方应拒绝派发而不是放宽权限；
- `plan({ role, cwd })` 按 **cwd** 解析角色层（`<repo>/.dsh/roles/`），不传 cwd 时按调用方 agent 的会话目录；
- 该服务**不提供按调用覆盖模型**：自主派发器不能替角色升级模型。

### 按调用覆盖模型

角色的模型路由可以**按调用覆盖**：`team_delegate` 多接三个可选参数，用来表达"这一阶段的难度"这类
只有在调用点才知道的信息（例如按 `cheap` / `standard` / `deep` 难度选模型）。

| 参数 | 期望类型 | 说明 |
|---|---|---|
| `model` | string | `provider/model`（与角色文件同一套简写），或裸模型 id —— 裸 id 沿用角色的 `provider` |
| `reasoningEffort` | string | 推理档位（非空字符串；DeepSeek 适配器认 `off` / `low` / `high` / `max`） |
| `maxTokens` | 正整数 | 子 Agent 的输出 token 上限 |

**优先级：调用参数 > 角色文件 > 宿主默认**，并且**逐字段生效**——只覆盖 `reasoningEffort` 的调用
不会丢掉角色的模型。结果里会写明子代理实际拿到的路由，以及每个字段来自哪一层（`effort` / `maxTokens`
与模型不同源时也会标出来源）：

```
模型：deepseek-official/deepseek-v4-pro（调用覆盖；effort=high）
模型：deepseek-official/deepseek-v4-flash（角色文件）
模型：宿主默认
```

**畸形参数既不静默生效、也不让整次派发失败**：这三个参数由插件逐字段校验（工具 schema 故意不声明类型），
坏值被忽略，该字段回落到角色路由（角色也没有就回落宿主默认），并在结果里 warning 说明原因。
覆盖到的坏值：空字符串、类型不对（如 `model: 42`）、非正整数（如 `maxTokens: -5`）、
以及"裸模型 id 但角色路由也没有 provider"（这种路由无法定位 provider，直接拒绝该字段）。结果里的 `模型：…`
行永远等于真正传给 provider 的 `agentOptions`，同一条路由也写进绑定文件，事后可审计。

**宿主开关 `allowModelOverride`（默认 `true`）**：置 `false` 时三个参数一律**忽略**，结果里明确写出
`宿主禁用了按调用覆盖模型：沿用角色路由（被忽略的调用参数：…）`。为什么要有这个开关：
**模型覆盖是一个成本决策**——调用方（模型自己）能把一个便宜角色改派到贵模型上，宿主必须能一刀禁掉；
禁用后子 Agent 一律按角色文件 / 宿主默认的路由运行，调用参数不会悄悄生效。

## 与官方 Agent Teams 的合成

harness 0.2.0 带来官方 **Agent Teams**：`@deepseek-ai/dsh-experimental-agent-team`（服务 `agentTeams`：
名册 / 持久 mailbox / 共享任务 DAG）与 `@deepseek-ai/dsh-experimental-tool-agent-team`
（模型面工具 `spawn_teammate` / `send_message` / `interrupt_agent` / `list_agents` / `team_task_*`）。

**合成规则：Agent Teams 是协作面，不是权限面。**

`SpawnTeammateRequest` 只有 `{ name, description, prompt, context: 'fresh' | 'fork', provider, signal }`
——**没有** persona / toolFilter / agentOptions / maxDepth，也没有权限参数。服务把它转成
`ctx.subagents.startContinuable({ provider, request: { prompt, parent } })`，于是 teammate 按
`resolveChildAgentOptions(parent, undefined, depth)` 与 `{ persona: undefined, toolFilter: undefined }` 组装：
**继承 Lead 的 provider/model 和全部工具，跑在部署 persona 下**。而 `startContinuable` 本身是接受
`persona` / `toolFilter` / `agentOptions` / `maxDepth` 的——缺口就在官方这一层请求类型上。

因此本插件的做法是：

1. **`team_delegate` 的 `dispatch: 'team'` 一律被按名字拒绝**，改用本插件自己的 `ctx.subagents.start()`
   路径（`dispatch path: subagents（请求 team：拒绝 agentTeams.spawnTeammate——它无法表达：…）`）。
   拒绝不是笼统的"不支持"，而是逐条点名：`persona 影子段`（官方请求没有 persona 字段，而每个角色都必须有
   persona——这条是**结构性**的，所以今天**任何**角色都走不了官方路径）、`工具白名单`（没有 toolFilter，
   只读模式的降权也靠它）、`模型路由`（没有 agentOptions）、`技能白名单`（绑定必须早于 teammate 第一轮，
   而官方 spawn 只在创建完成后才给出会话 id）。报告里同时写明官方 API 需要怎么改才可用。
   **本插件从不调用 `spawnTeammate`**：它只探测这个方法在不在（`auto` 模式），不在就说明"官方服务只是模型
   工具的底座"。
2. **官方路径创建的 teammate 被记录为 `ungoverned`**：官方名册每次写 Lead 会话日志时（`session/event`
   且 `event.type === 'team/member'`——官方服务自己不 emit 事件，只在 Lead 日志里写 `team/member` /
   `team/task` / `team/message/queued` / `team/message/delivered`），本插件把该 teammate 的会话 id、团队 id、
   名字、phase，以及**它没有被施加哪些角色策略**写进 `<root>/state/teammates/<sessionId>.json`
   （`governance: 'ungoverned'`，`missing: [...]`，`provenance: 'team/member'`）。同一 teammate 只写一份记录，
   后续名册写入只更新 phase。
3. **谁保证什么**：官方给的是协作（名册、点对点 mailbox、任务 DAG）；**宿主自己**给所有 in-process
   子会话的是审批钉死（`captureDelegatedPolicyOverrides` → `approvalPolicy: 'never'`，一次性与持续两条
   创建路径都有，teammate 也在内）；本插件给的是 persona 影子段、宿主强制的工具白名单、模型路由、
   技能白名单、只读降权，以及每个子会话的绑定与派发路径记录。**本插件不保证**（也没法保证）：
   官方路径创建的 teammate 的工具面、persona、模型路由。
   **委派深度不属于任何一方**：`SpawnTeammateRequest` 没有 `maxDepth`，官方路径不设每子深度上限；而
   `team_delegate` 今天也不传 `maxDepth`（深度上限由宿主的 `maxDepth` 配置**在模型面派发工具里**把关，
   见「已知边界」）。teammate 又继承 Lead 的整个工具面（可能包含派发类工具），所以这是本合成里
   唯一一处"两条路径都不设限"的地方，写在这里以免被误读成已覆盖。
4. **没有"防止"，只有"记录"——这是刻意的**：官方 teammate 只能在其创建**之后**被观察到
   （`session/event` 是 post-commit 事件，服务不 emit 自己的创建事件），而 `ctx.tools.guard` 只覆盖
   模型面的 `spawn_teammate`：任何插件直接调 `agentTeams.spawnTeammate` 都能绕过 guard。既然如此，
   声称"已阻止未经治理的 teammate"就是**假保证**；本插件改为把它记成 `ungoverned`（失败关闭的方向是
   "不承认它受治理"，而不是"假装拦住了它"）。
5. **协作面永远不会变成授权**：teammate 的消息、任务板条目、汇报都不是审批；本插件没有任何 API 接受
   teammate 的说法来放行、授权写入或写入证据。记录本身写的是**本插件的结论**（"我没有治理它"）加上一条
   持久事实（官方名册事件），不是 teammate 的自我声明。

**配置开关 `composeWithAgentTeams`（默认 `'auto'`）**：`'off'` 时完全不读 `agentTeams`、不装名册观察者、
提示词也不加那一段，行为与引入本能力之前**逐字段一致**（回归测试断言：`off` 与 `auto` 下同一次派发给
`ctx.subagents.start` 的请求完全相同、工具输出逐字节相同）。装配日志会打印
`agentTeams=off(config)` / `absent` / `on(availability=programmatic-spawn|no-programmatic-spawn)`。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | |
| `logFile` | `~/.dsh/role-guard.log` | |
| `includeBuiltin` | `true` | 是否加载包内角色 |
| `roleDirs` | `[]` | 额外角色目录（相对会话工作区解析） |
| `roles` | `[]` | 内联角色（最高优先级） |
| `provider` | `'spawn'` | `ctx.subagents` 的 provider 名 |
| `defaultRole` | `'developer'` | `team_delegate` 省略 `role` 时使用 |
| `readonlyDeny` | `['write','edit','str_replace_editor']` | 只读角色强制剥离的工具 |
| `maxOutputChars` | `6000` | 子 Agent 产出回传上限 |
| `allowModelOverride` | `true` | 是否允许 `team_delegate` 按调用覆盖角色路由（`model` / `reasoningEffort` / `maxTokens`）；`false` = 忽略并在结果里说明（成本决策由宿主把关） |
| `injectSpec` | `true` | 是否把 mission 规格注入子 Agent prompt |
| `enforceSkillWhitelist` | `true` | 是否在**调用时**强制角色的技能白名单 |
| `skillTools` | `['skill']` | 会加载技能的工具名（只有这些工具被上面的开关检查） |
| `composeWithAgentTeams` | `'auto'` | 与官方 Agent Teams 的合成：`'auto'` = 拒绝官方 teammate 创建路径（点名缺哪条保证）并把官方创建的 teammate 记成 `ungoverned`；`'off'` = 完全不读 `agentTeams`，行为与引入该能力前逐字段一致（未知值按 `'auto'`，因为 `'auto'` 才是拒绝 + 记录的那一侧） |
| `prompt.enabled` / `prompt.order` | `true` / `610` | |

## 技能白名单如何被强制

技能白名单（角色文件的 `skills`）**不是提示级约束**，它在**调用时**由宿主强制：

1. `team_delegate` 启动子 Agent 后，把它返回的会话 id（`SubagentRun.id`）与角色一起写进
   `<root>/state/roles/<sessionId>.json`（`{ sessionId, roleId, role, mode, skills, tools, route, dispatch, updatedAt }`；
   `route` = 这个子代理**实际生效**的模型路由，字段与 `agentOptions` 一致、全部可选，继承宿主默认时整个键省略；
   `dispatch` = 产生这个子会话的派发路径，`team_delegate` 写 `'subagents'`；`role-guard` 服务的
   `bind`（自主派发器自己创建子会话）不写这个键——那条路径本插件没有亲眼看到）。
   文件是唯一事实来源：插件重载、宿主重启、会话恢复后依然有效。
2. 插件注册一个**单调 guard**（`ctx.tools.guard`，不是 `tools/pre-execute` 监听器——guard 没有
   "allow" 结果，监听器顺序无法把拒绝变回允许），对配置 `skillTools`（默认 `['skill']`，
   即 `@deepseek-ai/dsh-tool-skill` 注册的工具名）里的工具调用做检查：
   - 从参数里取技能 id（依次识别 `name` / `skill` / `skill_id` / `id`，取第一个字符串）；
   - 找到调用方会话的角色绑定（自己没有就沿 `parentSession` 继承直接父级，孙代理因此同样受限）；
   - 有绑定、角色声明了**非空** `skills`、且请求的技能不在列表里 → **拒绝**，理由里给出角色、
     请求的技能、允许的技能，并要求把需求写进汇报交回主 Agent。
3. 其余情况一律放行：没有绑定、`skills` 为空（= 不限制）、参数解析不出技能 id、绑定文件损坏或不可读，
   都视为"不归我管"。guard **永不抛异常**，每次工具调用最多多一次 `statSync`（命中缓存时不读文件；
   冷读一次小 `readJson`）。
4. 会话销毁（`agent/disposed` / `session/disposed`）只清内存缓存，**不删绑定文件**——被恢复的子 Agent
   仍保留它的角色。缓存文件损坏时按"无绑定"处理，不会误拦。

为什么不在技能目录里裁剪：`ctx.skills`（`@deepseek-ai/dsh-skill`）是**分层、只增不减**的注册表，
`register()` 只往调用方作用域层加、`list({ scope })` 合并整条作用域链，没有任何"按子 Agent 减掉"的面。
所以**技能目录可能仍然列出其他技能**——目录里有 ≠ 有权加载；被拒的调用会拿到上面那条中文拒绝理由。

相关配置：`enforceSkillWhitelist`（默认 `true`，置 `false` 关闭强制）与 `skillTools`
（默认 `['skill']`；留空数组会回落到默认值，要关就用前一个开关）。装配日志会打印
`skillGate=on(skill)` / `off(disabled)` / `unavailable(no ctx.tools.guard)`。

## 审计后加固的行为（务必了解）

- **白名单永远生效**：角色声明了 `tools` 就一定产出 `toolFilter.allow`（哪怕过滤后是空列表）。
  "白名单全空 → 不加过滤"会让只读角色拿到父 Agent 的全部权限，已修掉并配回归测试。
- **只读角色必须显式声明 `tools`**：`mode: read` 但没有白名单时拒绝派发（deny 只能减去已知名字，
  挡不住未知的写工具）。
- **角色文件解析失败 = 该角色不可用**：不会静默回退到内置的同名角色（那会把"降权"变成"提权"），
  `team_delegate` 直接拒绝并给出文件问题。
- **`[]` 就是空列表**：`skills: []` / `tools: []` / `deny: []` 解析为空列表。此前会被解析成字面量
  `"[]"`，把"显式不限制"变成一个只含不可能名字的白名单（工具白名单会被拒绝派发，技能白名单会拒绝
  所有技能），已修掉：`[]` = 不限制，省略键也 = 不限制。
- **角色文件热更新**：注册表按目录 mtime+size 重新校验，改完角色文件后下一次装配即生效，无需重启会话。
- **模型路由可追溯、且不会静默换模型**：结果里的 `模型：…` 行 = 真正传给 provider 的 `agentOptions`
  = 绑定文件里的 `route`。按调用覆盖只在 `allowModelOverride` 允许时生效；畸形覆盖值逐字段回落到
  角色路由并在结果里 warning（既不会静默换模型，也不会把整次派发弄失败）。
- **子代理一定被释放**：派发结束后调用 `run.dispose()`（seam 的契约要求）。
- **官方 teammate 只记录、不阻止**（见「与官方 Agent Teams 的合成」）：`ctx.tools.guard` 只覆盖模型面的
  `spawn_teammate`，插件直接调 `agentTeams.spawnTeammate` 可以绕过它，所以"已阻止"会是假保证；
  本插件的选择是把这类 teammate 记成 `ungoverned` 并说明缺哪些策略，绝不把它们当受治理对象。

## 已知边界（诚实说明）

- 角色工具白名单通过 `toolFilter` 生效，需要 provider 支持 `toolFilter` 能力
  （`@deepseek-ai/dsh-subagent-spawn-in-process` 支持）；不支持的 provider 会在 `start` 时报错，
  本插件会把错误原样返回给模型。
- 角色文件里的工具名如果在当前部署不存在，会被**从白名单里剔除**并在结果里 warning
  （宿主对未知工具名是硬失败，剔除比整次派发失败更可取；剔除只会减少权限，不会增加）。
- 技能继承只走**一跳**（自己的绑定 → 直接父会话的绑定）：子会话头里只有 `parentSession`，
  再往上的链在持久事实里无法重建。因此"孙子由通用 `subagent` 直接派生、父级不是 `team_delegate` 子代理"
  这种链路不在强制范围内（父级本身没有绑定，也就没有可继承的角色）。
- 绑定写在 `team_delegate` 拿到子会话 id **之后**；写入失败（例如工作区只读）不会中断派发，
  但会在返回内容里 warning：该子 Agent 的技能白名单不生效，工具白名单不受影响。
- `model` / `reasoningEffort` / `maxTokens` 三个覆盖参数的工具 schema **故意不声明类型**（`type: 'json'`）：
  宿主对类型不匹配是硬失败（`invalid arguments: "model" must be a string`，整次派发直接不启动），
  而这里要的是"坏值忽略 + 逐字段回落 + 结果里说明"，所以类型约束写在参数描述里、由插件自己校验。
  代价是模型看到的 schema 少一条类型提示——三个参数都标了期望类型（string / 非空 string / 正整数）。
- 裸模型 id（`model: 'deepseek-v4-pro'`）需要 provider：角色路由里有 provider 时沿用（角色文件写
  `model: deepseek/…`，内联角色还可以单独写 `provider`），否则该字段被拒绝并 warning
  （不把无法定位 provider 的裸模型名递给宿主）。
- 绑定文件按**派发方**工作区解析（`<cwd>/.dsh/state/roles/`，`rootDir` 可配绝对路径），强制时按
  **调用方**会话的 `header.cwd` 定位。如果某个 provider 让子会话跑在另一个工作区，两侧路径不一致，
  就会读不到绑定（= 不限制）。默认的 `spawn` provider 子会话继承父会话 cwd，不受影响；把 `rootDir`
  配成绝对路径（如 `~/.dsh/eng`）可以让绑定与工作区解耦。
- 官方 teammate 的记录（`<root>/state/teammates/<sessionId>.json`）同样是**报告**，不是策略：
  它不改变任何门禁。`ungoverned` 的 teammate 因此也**不受技能白名单约束**（它没有绑定，技能门禁按
  "无绑定 = 不归我管"放行）——这正是记录要说明的缺口；反过来，如果某个 teammate 的父会话有绑定
  （把 `maxDepth` 放宽后由受治理的子代理派生），技能门禁照旧按那条绑定强制，与该记录无关。
- teammate 记录只在官方名册**成功写入**时产生（`session/event` 是 post-commit 事件）。若官方服务在
  teammate 启动前就失败（`phase: 'failed'` 会被记下，创建失败则不会有名册行），或者 Lead 会话头里没有
  `cwd`（本插件拒绝用 `process.cwd()` 兜底，会在日志里 warning 并**不记录**——宁可漏记也不写错项目），
  那段过程就没有记录。
- 名册观察者是**事后**的：`team_delegate` 拒绝官方创建路径是事前决定，但官方工具/插件**已经**创建出来的
  teammate 只能被观察到并记录（原因见「与官方 Agent Teams 的合成」第 4 条）。
- 本插件只探测 `agentTeams.spawnTeammate` 是否**存在**，不校验它的签名；官方若把语义改坏（例如接受
  了 persona 却忽略），探测依然只能报"官方路径不可用/可用性未知"。真正修好这条合成需要在官方请求类型上
  带上委派请求，或提供"接管一个已按角色创建的子会话"的操作。
- **委派深度不由本插件设置**：`team_delegate` 不传 `maxDepth`（子 Agent 的深度上限由宿主的
  `ctx.subagents` 配置在模型面派发工具里生效，本插件的角色文件也没有 depth 字段）。官方 teammate
  创建路径同样不传，且它继承 Lead 的工具面——所以"teammate 不会再往下派"这句话今天**不成立**，
  要收紧只能在宿主侧配置，或等官方请求类型支持 `maxDepth`。

