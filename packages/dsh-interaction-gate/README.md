# dsh-interaction-gate

**套件自己的交互层**：把"必须有人决定"的时刻，从宿主的审批弹窗（只在终端里工作）搬到**可插拔通道**上——
问 / 通知 / 进度，一次性令牌、决定台账、失败即拒绝的超时。

其他门禁回答"代码行不行"；这个插件回答**"这件事谁来决定、他到底答了什么、能不能审计"**：

| 关注点 | 由谁负责 |
|---|---|
| 卡片怎么送达（IM、终端、Web UI、webhook） | **通道**（`register({ name, send, wait, describe })`） |
| 这个答案属于哪次提问 | **令牌**（不可预测、一次性、作废即失效、回程再校验） |
| 谁答的、经哪个通道、等了多久 | **台账**（`.dsh/interaction/decisions.jsonl`，append-only） |
| 能不能算通过 | **不由本插件决定**：台账只记录发生过什么，不授予任何权限 |

## 四个工具

| 工具 | 作用 |
|---|---|
| `interaction_ask` | 真的需要人决定时才用。按配置偏好（`preferredChannels`）再按注册顺序挑**第一个能用**的通道，发卡片/消息，在截止时间内等答案；回来校验**令牌对得上、回答者有资格、答案是声明选项之一**。返回决定 + 谁答的 + 哪个通道 + 台账行 id。**没有可用通道 / 超时 / 越权回答 / 答非所问 → 拒绝，并给出确切原因**（绝不猜、绝不默认"是"）。 |
| `interaction_notify` | 状态变化（门禁 BLOCK、阶段完成、环境变更）。**不等人**：推送失败如实报告（并计数），既不变成"通过"也不变成"失败"；等级按 `notifyLevels` 过滤（被过滤会明确说明，不是静默）。 |
| `interaction_progress` | 长阶段报"还在跑"。**不是日志**：窗口内（5s）完全相同的连续内容会被抑制，被抑制的内容不写台账。 |
| `interaction_status` | 只读体检：通道能力（含**为什么不能**）、生效配置与来源、审批人名单状态、台账计数（按决定）、以及**还没有决定的提问**（含年龄）。 |

四条报文都是中文、都以 `下一步：` 结尾。`interaction_ask` 的拒绝是**抛错**（决定没发生就必须让调用方停下来）；
`interaction_notify` / `interaction_progress` 的失败写在报文里（通知是尽力而为的推送，不该让一轮对话失败）。

## 通道契约

```ts
export interface InteractionChannel {
    readonly name: string
    /** fire-and-forget; must never throw */
    send(message: { kind: 'ask'|'notify'|'progress'; title: string; body: string; questionId?: string; buttons?: { value: string; label: string }[] }): Promise<{ ok: boolean; messageId?: string; error?: string }>
    /** wait for the answer to `questionId`; resolve null on timeout/abort */
    wait?(questionId: string, timeoutMs: number, signal?: AbortSignal): Promise<{ value: string; by?: string; messageId?: string } | null>
    /** per-channel capability report for the doctor */
    describe(): { canAsk: boolean; canNotify: boolean }
}
```

一个能问人的通道（10 行）：

```ts
const channel = {
    name: 'im',
    async send(message) {                                     // 推送：绝不抛错、绝不等答案
        const card = await im.sendCard(message.title, message.body, message.buttons, message.questionId)
        return { ok: true, messageId: card.id }
    },
    async wait(questionId, timeoutMs, signal) {               // 拉取：超时/中止返回 null
        const click = await im.nextClick(questionId, { timeoutMs, signal })
        return click && { value: click.value, by: click.userId, messageId: click.cardId }
    },
    describe: () => ({ canAsk: true, canNotify: true }),
}
ctx.get('interaction').register(channel)                       // 返回 disposer
```

- **没有 `wait()` 的通道只能推送**：`describe()` 会报 `canAsk: false` 并说明原因，`interaction_ask` 直接拒绝——
  "只能发出去、收不回来"的通道问不了人。
- **推送型通道**（webhook 送达答案，没有可 await 的 `wait`）在收到点击后调用
  `ctx.get('interaction').submit(questionId, { value, by, messageId })`；令牌未知/已作废的答案会被丢弃并计数。
- 服务面（`ctx.provide('interaction', …)`）：`register` / `unregister` / `get` / `list` / `describeAll` /
  `pending` / `trackLedger` / `ledgers` / `droppedAnswers` / `problems` / `im` / `setIm` / `reportProblem` 见 `src/channels.ts`。**任何方法都不向调用方抛错**：
  重复注册、坏通道、读不了的台账都降级成 `problems()` 里的一条原因 + 一个安全值（空列表 / `false`）。

## 可选 IM 通道：把提问接到 `dsh-chat-interaction`

`dsh-chat-interaction`（0.3.0+）已经把它做过的事变成了一个**版本化 API**：`ctx.get('chatInteraction').api`
（`apiVersion = 1`）负责渠道连接、消息去重、卡片、等待回复、`/命令`，以及"按钮只对这次提问有效"的
一次性令牌（`ask:<nonce>:<value>` / `act:<nonce>:<value>`）。本插件**只做一件事**：把这个 api 适配成
`interaction` 注册表里的一个通道 —— 于是套件里所有 `interaction_ask`（以及直接走注册表的其他门禁，
例如 `dsh-deploy-gate` 的 `list → arm → send → awaitAnswer`）**一行调用都不用改**就走 IM。

```yaml
im:
  channel: auto        # auto（默认）| off | required
  channelId: feishu    # 可选：固定用哪个 IM 渠道（feishu/wecom…）；省略 = 由 IM 插件解析 active chat
```

| 模式 | 行为 |
|---|---|
| `auto`（默认） | 服务存在且 `api.apiVersion >= 1` → 注册 `chat-interaction`，日志写 `interaction channel: chat-interaction(api v1)`；否则**完全保持今天的行为**，日志写 `interaction channel: local only (chat-interaction absent: <原因>)` |
| `off` | **一次都不碰**这个服务（不查找、不读属性、不调用任何方法）——与没有集成时逐字一致 |
| `required` | 服务缺失/过旧/坏掉 → `apply` 直接**拒绝装配**，日志写明装什么、怎么装（`npm i -g dsh-chat-interaction@>=0.3.0` + 宿主装配它 + 它的 `apiVersion` 版本策略），**不会**静默降级成"没有 IM" |

映射与规则：

- `send` → `api.ask({ channel?, title, body, options, timeoutMs })`：**按钮就是声明的选项值**；
  渠道不支持卡片时 IM 插件自动降级成 `1) 2)` 编号文本。`wait(questionId)` → 这次 ask 的答案，
  交回 `registry.awaitAnswer()`，与本地通道**完全同一条落账路径**（pending 行 + 决定行，
  `channel: "chat-interaction"`，同一个套件令牌，同样过审批人名单与选项校验）。
- **一次性、不可重放**：本套件的 `questionId` 仍是这次提问的身份，IM 插件的 `ask:<nonce>` 是第二层
  （旧卡 / 转发卡 / 别人请求的卡点不出当前答案）。一次提问只接受一次回答：第一次终结后令牌作废，
  重放（`submit`、再次 `wait`、再点一次）得到 `null` / `unknown-token`，台账不会多出第二行。
- **失败即拒绝**：`{ok:false, code}`（`timeout` / `channel-unsupported` / `no-target` / `send-failed` /
  `aborted` / `internal`…）、超时、答非所问（答案不在声明选项里）、`ask()` 抛错、以及本适配器不认识的
  任何返回形状 → 一律**没有答案**：`interaction_ask` 落一行 `refused:*` 并抛错，没有任何路径把它变成
  `allowed-once`。发送前就能知道的失败（没有 active chat / 渠道未连接 / 不支持入站 / 服务已释放）让
  `send` 直接失败，台账记 `refused:send-failed` 并把 IM 的原因写进拒绝报文；等答案期间才出现的失败
  记进 `problems()`（`interaction_status` 的"通道缺陷"与 IM 行都会显示）。
- **凭据**：出站载荷（标题 / 正文 / 选项）在通道层再扫一遍（内置规则 + 宿主 `redactPatterns`）；
  命中就**拒绝发送**，只记录规则名与脱敏片段——原文既不进卡片，也不进日志/台账。项目级
  `redactPatterns` 由工具在调用通道前应用（与宿主规则取并集），通道层是第二道网。
- **并发**：同一 IM 渠道同时只允许一次待回答的提问（并发提问的答案无法区分归属）；第二次 `send`
  如实拒绝并说明原因，而不是把两张卡的答案搅在一起。
- **可见性**：`interaction_status` 多一行 `IM 通道：…`；服务上的 `registry.im()` 给出
  `{mode, registered, apiVersion, pluginVersion, channelId, reason}`。注册成功时 `chat-interaction`
  也自然出现在 `describeAll()` / 通道列表里。"没配置 / 没装 / 版本旧 / 服务坏了"都是**写明的事实**，
  不是缺席。
- **通知与进度不走这里**：本通道 `canNotify: false`。渠道连接、去重、卡片样式、等待、`/命令`、入站观察
  都归 IM 插件——本插件不 `onInbound`、不 `registerCommand`、不 `connect`/`disconnect`，也不碰
  `permission.bridgeHarnessApproval`。

诚实的边界：**`auto` 且宿主没装 `dsh-chat-interaction` 时，什么都不变**——这是有意的（升级不该悄悄改变
"谁能批准什么"）。另外 IM 的 `ask` 有自己的截止上限（见它的 `API.md`：1s…10min，由它实现决定）；若宿主
`askTimeoutMs` 更大，IM 会先在它自己的上限处返回 `timeout`，本插件照样按"没有答案"拒绝并把原因记下来。

## 投票给谁：令牌、名单、选项

1. **令牌**：`questionId = q-<128bit hex>`，与时钟、计数器无关；提问时装上（arm），落定即作废（一次性），
   发卡片前先 arm，所以答案比 HTTP 响应先到也不会丢。**答错令牌的答案被丢弃，提问继续等**；
   通道如果回了一个别的令牌，同样丢弃并重新进入等待（上限 8 次，截止时间仍由我们决定）。
2. **资格**：`requireApproverList: true` 时，回答者的 `by` 必须在 `<repo>/.dsh/interaction-approvers.txt`
   （一行一个 id，`#` 注释）里；名单缺失/为空时**在发卡片之前**就拒绝（发出去也没人能合法回答）。
   默认 `false`：通道内的任何参与者都能回答——此时**通道的传输就是唯一的认证**。
3. **选项**：声明了 `options` 就必须命中其中之一（去空格、大小写不敏感）；
   选项里出现 `allowed-once` / `rejected` / `cancelled` / `unavailable` 时，决定会走套件的
   `normalizeApprovalReply`（`dsh-eng-core`）——门禁可以把自己的四个词直接交给这里。

## 配置

profile（宿主上限）与 `<repo>/.dsh/interaction-gate.json`（项目只能细化下列键）：

```yaml
- id: interaction-gate
  config:
    enabled: true
    logFile: '~/.dsh/interaction-gate.log'
    logFileTemplate: '~/.dsh/logs/{project}/interaction-gate.log'   # 可选，按工作区分文件
    askTimeoutMs: 900000                 # 15 分钟；调用方只能缩短，不能延长
    requireApproverList: false           # true = 只有名单里的人能回答
    approversFile: .dsh/interaction-approvers.txt
    ledgerFile: .dsh/interaction/decisions.jsonl
    notifyLevels: [warn, error]          # info 默认不推
    preferredChannels: []                # 空 = 全部已注册通道（注册顺序）
    maxPayloadChars: 4000
    redactPatterns: []                   # 额外拒绝规则（命中即拒绝发送）
    im: { channel: auto, channelId: feishu }   # 可选 IM 通道（见「可选 IM 通道」）；默认 auto
    prompt: { enabled: true, order: 600 }
```

| 项目级可覆盖 | 为什么 |
|---|---|
| `approversFile` / `ledgerFile` | 这个仓库的名单与台账放在哪，是仓库知识（同 `standardsFile`） |
| `preferredChannels` | 这个仓库的卡片走哪个通道（例如每个仓库一个群） |
| `notifyLevels` | 这个仓库想被通知到什么程度 |
| `redactPatterns` | 额外拒绝规则只会**收紧**：与 profile 的规则**取并集**（内置凭据规则无法从这里删掉，host 的规则也不会被项目列表替换掉；非法正则逐项忽略，全非法时 host 的规则原样保留） |

**宿主所有（项目文件写了也会被拒绝并记问题）**：`enabled`、`logFile`、`logFileTemplate`、`layout`、`prompt`、
`maxPayloadChars`、`im`，以及两个"不能自我豁免"的键：

- `askTimeoutMs`：等待人的时长决定一轮对话能挂多久，仓库抬高它等于给自己放长绳；
- `requireApproverList`：仓库若能否掉它，就是把自己的审批人名单关掉。
- `im`：打开/关闭一条"把问题发到聊天"的通道，等于改写审批边界；这必须是宿主的决定（`channelId` 也是宿主配置）。

数值不做猜测：不可用的值**保留 profile 的值**并记一条问题（`interaction_status` 会写"（N 条配置问题）"）。

## 台账格式

`<repo>/.dsh/interaction/decisions.jsonl`，一行一个事件（append-only，单次 `appendFileSync` 写一行）：

```json
{"at":1759000000000,"id":"il-3f2a…","kind":"ask","title":"需要决定：把这个交付放出去？","questionId":"q-9c1d…","channel":"im","missionId":"m-1"}
{"at":1759000042000,"id":"il-7b41…","kind":"ask","title":"需要决定：把这个交付放出去？","questionId":"q-9c1d…","channel":"im","userId":"user-7","decision":"allowed-once","messageId":"card-9","durationMs":42000}
```

- 字段固定为 `{at, id, kind, questionId?, channel?, userId?, decision?, title, missionId?, messageId?, durationMs?}`；
  `at` 是 epoch 毫秒（与套件其他工件一致）。
- **一次提问两行**：发出卡片时写 **pending 行**（没有 `decision`），落定时写 **决定行**（同一个 `questionId`）。
  所以"崩溃时正在等的提问"在台账里是看得见的 pending 行，而不是消失；`interaction_status` 与服务的
  `pending()` 把**没有决定、且没有被同令牌的决定行取代**的提问列出来（带年龄）。
- `notify` / `progress` 每个通道各一行，`channel` + `messageId` 指向一条具体的消息。
- **自由文本答案会被限界**：答案原文可能很长，落账与回显都截断到该仓库生效的 `maxPayloadChars`（并写明“已截断、
  原文 N 字符”）——台账是事实记录，不是聊天记录；要留长文本就写进文件，卡片里只放链接。读取端（`interaction_status`）
  对已经落在磁盘上的超长行同样限界渲染。
- `decision` 是封闭词汇：套件四词之一 / 声明的选项 / 自由文本答案（限量） / `refused:<原因>` /
  `notified` / `notify-failed` / `progress` / `filtered`。`refused:` 的原因有：
  `no-channel`、`channel-unusable`、`approvers-missing`、`timeout`、`cancelled`、`unauthorized`、
  `unknown-answer`、`secret`、`send-failed`、`token-lost`、`ledger-unwritable`、`bad-request`。
- 读取**容忍截断的尾行**（崩溃不是台账损坏），并且**计数**跳过了几行：`interaction_status` 会写
  "行数 N，可用行 M，跳过 K"——"0 行"和"解析不了"绝不长得一样。
- 台账写不进去 = **拒绝**：一次决定如果拿不到可审计的行 id，`interaction_ask` 不会把它交出去
  （通知/进度的台账失败只报告，因为推送已经发生、且不涉及决定）。

## 与套件其他插件的分工

| 插件 | 关系 |
|---|---|
| `dsh-spec-gate` | 规格审批可以改走这里：`interaction_ask({ options: ['allowed-once','rejected'], context: { kind: 'spec', revision } })`；`.dsh/**`（台账、名单）在它的信任根里，模型写不了 |
| `dsh-standards-gate` | 放宽阈值/基线（"这个仓库可以长到 600 行"）本来就是人的决定，直接问这里，四个词原样落账 |
| `dsh-supply-chain-gate` | 新增依赖的批准同理；本插件的凭据拒绝规则是**本地小规则集**（见下），与它的完整检测器无关 |
| `dsh-evidence-gate` | 交付审批：先跑门禁，再问人（人能批准门禁接受过的交付，不能批准门禁拒绝过的交付），台账行 id 可写进回执 |
| `dsh-orchestrator` | 长阶段用 `interaction_progress` 报"还在跑"（不是日志），阶段进入/失败用 `interaction_notify` |
| `dsh-chat-interaction`（外部插件） | 可选：`im.channel: auto/required` 时本插件把它的 `api` 适配成 `chat-interaction` 通道（本 README「可选 IM 通道」）；它负责连接/去重/卡片/等待/`/命令`，本插件只转发提问 |
| 其他 IM 桥（不在本仓库） | 也可以自己注册一个通道：`ctx.get('interaction').register({ name: 'im', send, wait, describe })`；推送型通道在点击到达时 `submit(questionId, { value, by, messageId })` |
| 体检/doctor 插件 | 只读消费 `describeAll()`（通道能力 + 为什么不能）与 `pending()`（还在等人的提问） |
| 宿主审批接缝 | **两条路**：宿主的 `ctx.get('approval')` 仍然服务 harness 自己的提示；本插件的台账**不给宿主任何权限**，也不假装给 |

## 诚实的边界

- **身份是通道自报的**，本插件不核验（IM 用户 id 由通道从平台 API 拿来）。要"必须某个角色批""双人审批"，
  在通道/名单层做，或者把策略编码进选项。
- **令牌不是认证因子**：它防的是"旧卡/别人的卡/答非所问"，不是伪造。它由我们生成、一次性、作废即失效，
  但"这张卡是不是本人点的"仍然是通道的责任（`docs/KNOWN-LIMITS.md` 附一之九）。
- **超时既不是拒绝也不是同意**；推送失败既不是通过也不是失败。台账里没有任何一行能被当成"门禁通过"。
- **IM 通道是可选层**：`auto` 且没装 `dsh-chat-interaction` 时行为与集成前逐字一致（有意如此）；`required`
  时缺了它就不装配（拒绝静默降级）；`off` 时连服务都不查找。IM 侧的连接状态、群成员身份、平台去重
  都不由本插件保证——它只保证"发出去的提问带回一个对得上令牌、且只对这一次有效的答案"。
- **进程重启后等不到答案**：pending 行还在（这是它存在的意义），但没有任何 waiter 会醒来——需要人处理，
  `interaction_status` 会把年龄摆出来。
- **中途被注销的通道**：已发出的卡片仍然可以被回答（令牌还装着）；注销不会作废别人手里的卡。
- **凭据拒绝规则是本地小规则集**（AWS/GitHub/Slack/`sk-`/Google/PEM/JWT/Bearer/通用赋值），
  **不是** `dsh-supply-chain-gate` 的完整检测器（那 11 条规则 + 熵 + allowlist 只服务于它自己的门禁）。
  这里只做一件事：**要么发得出去、要么拒绝**——绝不"打码后照发"。规则是网不是证明，漏掉的形状由
  `redactPatterns` 补（项目级可加，宿主亦可）。
- **进度去重只针对"连续的相同内容"**：A、B、A 是三条真实状态，A、A、A 是一条。
- **与宿主审批接缝的关系**：本插件不改变宿主接缝的形态（`docs/ARCHITECTURE.md` §5.12 实测它今天只传四个字符串），
  也不假装能从那里拿到身份。它是套件**自己**的第二条路：谁答的、从哪张卡、等了多久，全部落在**本插件的台账**里——
  这正是附一之九说的"溯源今天的正确落点"，只是从"通道自己写一个 jsonl"变成了"套件自己写一个 jsonl"。
- **确定性**：纯函数（配置解析、选项映射、台账汇总、去重判定、凭据扫描）不读时钟，`now` 一律注入；
  报文与台账内容可 diff、可复现。

更多边界见 `docs/KNOWN-LIMITS.md`（附一之九：IM 授权的边界）与 `docs/ARCHITECTURE.md` §5.12（审批接缝）。
