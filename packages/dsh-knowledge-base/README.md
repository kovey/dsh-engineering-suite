# dsh-knowledge-base

**项目知识库**：把仓库自己的规格、决策、交付台账、文档和代码索引成一份**可比对的本地检索产物**，
让 dsh 里的模型回答项目问题时**必须带 `path:line` 引用**，索引里没有的就明说"索引里没有"。

其他插件生产证据（`dsh-spec-gate` 写规格、`adr_record` 记决策、`dsh-evidence-gate` 发回执、`dsh-audit-trail` 记工具历史），
这个插件把那些证据**变成可检索的**：回答"AC-003 是什么"、"为什么选 A 不选 B"、"谁改的"、"在哪里实现"。

## 它是什么 / 不是什么

| 是 | 不是 |
|---|---|
| 布局根下的 `kb/`（`.dsh/kb/`；迁移过的仓库是 `.dsh/engineering-suite/kb/`）里的一份**构建产物**（三个纯文本文件，可读、可 diff、可进版本库） | 向量数据库 / 嵌入索引（**没有** embedding、没有网络、没有模型调用） |
| **确定性词法检索**：BM25 + 字段加权 + id 精确命中；同一索引 + 同一查询 → 同一结果与同一顺序 | 语义检索：换个说法可能召回不到（见"诚实的边界"） |
| 每条命中都带 `path:from-to`、分数、**命中原因**（哪些 token 命中了哪个字段） | 聊天机器人：回答由模型给出，索引只提供带出处的片段 |
| 契约内的**缺口上报**：跳过的文件带原因，局部索引自己声明是局部的 | git 历史索引：只看工作区**当前内容**与 `.dsh` 台账 |

## 三个工具

| 工具 | 作用 |
|---|---|
| `kb_index({ force?, only? })` | （重）建索引：按来源报告文档/块数、**每个被跳过文件的原因**、git 指纹，以及"变了没有"。**未改动时明说"索引已是最新，未变"并且不重写任何文件**；内容未变而工作区指纹变了（例如编辑了 `.gitignore` 这类没被索引的跟踪文件）时**只刷新 manifest 的指纹**，报告写"内容未变，仅刷新了指纹"——块列表与倒排索引的字节原样不动，`kb_search` / `kb_status` 的"陈旧"警告随之消失。**请求的来源覆盖和 manifest 记的不一样时**（`only` 局部构建、或改了来源的 `enabled`）报告写"**来源覆盖变了**"：manifest 按本次请求改写，块列表与倒排索引只在文档集合真的变了时才重写——所以 局部→完整（或完整→局部）**永远不会**被说成"未变"。`force: true` 才强制重写全部三个文件（那是"调用方要求重建"，与指纹刷新、覆盖改写是三件事）。未知来源 id 直接拒绝，不静默跳过、不写任何文件。 |
| `kb_search({ query, limit?, kinds?, pathPrefix?, missionId? })` | 检索：返回排序后的命中（引用、摘要、分数、命中原因）。索引不存在时**拒绝**并点名 `kb_index`。索引相对当前 git 指纹**过期**时先**自动重建一次**（与 `mission_complete` 同一个 `reindex` 管线；同一工作区受 `freshness.cooldownMs` 冷却窗口约束），成功则首行写「索引已自动更新（N 块）」；重建失败则**照常返回旧索引的结果**，但首行必须写「索引过期且自动重建失败：<原因>；结果可能缺少最近改动」并 `logger.warn` —— 绝不静默。`limit` 受 `maxLimit` 硬上限约束，被截断时报告里说明。 |
| `kb_status()` | 只读状态：manifest 摘要、产物大小、逐来源覆盖与跳过原因、与当前指纹的新鲜度、索引自己声明的不完整之处，以及"这个索引是什么/不是什么"的诚实声明。**来源覆盖按产物核对**：manifest 没记、但 `chunks.jsonl` 里确实有这个来源的块时，报告"manifest 与产物不一致（以产物为准）"并点名 `kb_index`，而不是照着 manifest 说"这个来源不在索引里"。 |

报告全部是中文，以「下一步：…」结尾；每个拒绝都给出可执行的修法。

## `/kb`：人可以直接敲的命令（可选，需要宿主装配 `@deepseek-ai/dsh-commands`）

模型有 `kb_index` / `kb_search` / `kb_status`，人则有 `/kb`：**不经过模型**（不花 token、不产生一次对话回合），
处理器在收到命令的那个 agent 上直接执行，并且与工具**共用同一份实现与同一份报告**——同一段引用格式、同一句拒绝、
同一个跳过原因，不会一个说法给模型、另一个说法给人。

```
/kb index [--force] [--source <id>]…                 显式构建/重建索引（写索引产物）
/kb search <关键词…> [--limit N] [--kind <kind>] [--prefix <path>]   检索（索引过期时先自动重建一次）
/kb status                                           状态与新鲜度（只读，不写盘）
/kb help                                             用法（空的 `/kb` 同样打印用法）
```

- **可选集成**：注册表通过 `ctx.get('commands')` 访问，**不写进 `inject`**：宿主没装 `dsh-commands` 时插件照常加载，
  只是不注册 `/kb`（日志说明原因）；`register()` 抛异常也只记一条警告，三个工具与提示词段不受影响。
- **语法失败就是错误**：不认得的子命令/参数、缺值、越界的 `--limit`、未知的 `--kind`/`--source` 都返回
  **错误结果 + 完整用法**，不会静默地"跑过了但什么都没说"。
- **只读边界**：`search` / `status` / `help` 不写任何文件（测试用 `.dsh` 逐字节快照证明）；只有 `index` 会写索引目录。
- 工具里的拒绝（缺索引、被宿主禁用、query 分词为空…）在这里变成**错误结果**，文字与工具端一模一样。

## 通过 IM 搜索（`/kb`，默认关闭）

宿主装配了官方 `dsh-chat-interaction`（≥ 0.3.8，通过 `ctx.get('chatInteraction').api` 暴露
`registerCommand`）时，本插件可以把同一个检索搬到聊天窗口：`/kb <关键词>`，结果**发回原会话**，每条带
`path:from-to` 引用与一句摘要。它走 IM 插件的**命令注册表**，不唤醒模型、不花 token，也不经过任何门禁
（因此也无从绕过门禁——它只回答"索引里有什么"）。

**默认关闭，而"哪个会话可以问"只有一个来源**：`dsh-interaction-gate` 从宿主配置解析出的 IM 目标
（`im.approvalChatId` / `im.p2pOnly`），通过它注册表上的只读访问器 `ctx.get('interaction').imTarget()`
发布（`{ channel, chatId, p2pOnly }`；未配置时是 `undefined`）。本插件**没有**自己的会话白名单——
早先的 `im.chatIds` / `im.p2pOnly` 已删除：同一件事两份配置必然漂移（改了审批会话，第二份还在回答旧会话）。
只有「宿主有 `interaction` 服务且它发布了 IM 目标」**且**「宿主有 `chatInteraction` 命令 api」时才注册命令
（不是注册了再拒绝）；没注册时若宿主配了 `im.workspace`，日志会说明缺的是 interaction-gate 的 `im.approvalChatId`。

handler 每次调用都会**重读**目标（命令名不是授权）：`ctx.chatId` 不等于 `imTarget().chatId` 就拒绝，
`p2pOnly` 为真而会话不是 p2p 也拒绝，并把这次尝试写进日志——**拒绝文案指向 interaction-gate 的配置键**，
因为知识库这边已经没有可改的会话配置了。profile 里残留的 `im.chatIds` / `im.p2pOnly`（以及项目级文件里的）
会被**报告为已移除并忽略**，不会被当成"还在生效的白名单"。

```yaml
    im:
      command: kb            # 命令名（默认 kb；只接受 [a-z0-9][a-z0-9_-]{0,31}，非法则不注册并记警告）
      maxResults: 5          # 每条回复最多几条命中（1..50）
      maxChars: 1800         # 单条回复的字符上限，超出按行截断并追加"更多结果请在 TUI 用 kb_search"
      workspace: ''          # 要检索的仓库根目录（绝对路径或 ~/…）；IM 命令没有 agent 可读 cwd，必须显式给
```

会话与 p2p 要求是 `dsh-interaction-gate` 的配置，不在这里：

```yaml
- id: interaction-gate
  config:
    im:
      approvalChatId: oc_…  # /kb 唯一允许回答的会话（也用审批卡片的发送目标）
      p2pOnly: true         # 为真时只接受 p2p 会话（群聊里的 /kb 一律拒绝）
```

handler 的行为（每一条都有测试）：

| 情况 | 回复 |
|---|---|
| 没有参数 | 用法（`/<命令> <关键词…>`，并指向 TUI 的 `kb_search`） |
| 调用时读不到 IM 目标（interaction 缺席/被撤下） | `knowledge-base 没有可用的 IM 目标…`，同时 `warn` 一行；不返回任何结果 |
| 会话不是 `imTarget().chatId` | `该会话不是 interaction-gate 配置的审批会话；要开放请改 interaction-gate 的 im.approvalChatId…`，同时 `warn` 一行（含 chatId 与原因） |
| `im.p2pOnly` 为真且不是 p2p | `该会话是群聊，而 interaction-gate 配置了 im.p2pOnly=true…` 并记录（`chatType=…`） |
| `im.workspace` 为空 | 说明缺哪一项配置（`im.workspace`）与该填什么 |
| 命中若干条 | `[n] path:from-to 「标题」` + `摘要：…`（与 `kb_search` 同一份 `SearchOutcome`） |
| 索引里没有 | 说明这是词法索引（换词/换 id 可能命中），并指向 TUI |
| 搜索失败（索引缺失 / 服务抛错） | `搜索失败：<原因>`——**不抛异常**（抛出去只会变成 IM 插件的通用"命令执行失败"，信息更少） |

## 给其它插件的服务（`knowledge-base`）

插件通过 `ctx.provide('knowledge-base', …)` 暴露一个**可选服务**，让兄弟插件不必跨包 `import`、也不会把
本插件变成它们的硬依赖（宿主没挂载时 `ctx.get('knowledge-base')` 就是 `undefined`，调用方照常工作）：

| 方法 | 作用 |
|---|---|
| `reindex(cwd, options?)` | 构建/刷新该工作区的索引（与 `kb_index` 同一个 `buildIndex`），返回 `{ changeKind, changed, dir, documents, chunks, skipped }`——调用方据此说"已更新 N 块 / 未变 / 仅刷新指纹"，不用猜。`kb_search` / IM `/kb` 的自愈走的也是这一条路径 |
| `search(input)` | `{ cwd, query, limit?, kinds?, pathPrefix?, missionId? }` → 与 `kb_search` 同一个 `SearchOutcome`（含 `path:from-to` 与摘要）；索引过期时会先自愈一次，`SearchOutcome.selfHeal` 记录这次自动重建（成功/失败/冷却跳过）；没有可用索引时**抛中文错误**（拒绝原因与工具端一致） |

`cwd` 是显式参数：一个 dsh 进程服务多个仓库，服务不能猜。第一个接入方是 `dsh-evidence-gate`：
`mission_complete` 签发回执后 best-effort 调 `reindex`（失败只记警告、只加一行附注，绝不影响回执与 mission 状态）。

## 配置（两层：profile 是上限，项目只能收紧）

```yaml
- id: knowledge-base
  config:
    enabled: true
    logFile: '~/.dsh/knowledge-base.log'
    # indexDir 不写就是跟随布局根：<布局根>/kb（有 .dsh/engineering-suite/ 时就是它，
    # 否则是 .dsh/）；写了就按写的来。
    # indexDir: .dsh/kb              # 可选：覆盖默认的索引产物目录（工作区内相对路径）
    maxFileBytes: 262144           # 超过就按 stat 跳过，绝不读进内存
    maxChunkLines: 60              # 一块最多多少行
    sources:                       # 六个收集器；globs 以 .dsh/ 开头时跟随 layout.rootDir
      - { id: spec,  kind: spec,  globs: ['.dsh/specs/*.md'] }
      - { id: adr,   kind: adr,   globs: ['.dsh/adr/*.md', '.dsh/adr/index.jsonl'] }
      - { id: trail, kind: trail, globs: ['.dsh/missions/**', '.dsh/releases.jsonl'] }
      - { id: plan,  kind: plan,  globs: ['.dsh/plan.jsonl'] }
      - { id: docs,  kind: docs,  globs: ['*.md', 'docs/**/*.md'] }
      - { id: code,  kind: code,  globs: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs', '**/*.cjs', '**/*.go', '**/*.py',
                                         '**/*.rb', '**/*.php', '**/*.rs', '**/*.java', '**/*.kt', '**/*.kts', '**/*.cs', '**/*.swift'] }
    tokenizer: { cjkBigrams: true, minTokenLength: 2 }
    search: { limit: 10, maxLimit: 50, fieldBoosts: { title: 3, symbols: 2, body: 1 } }
    freshness: { cooldownMs: 10000 }   # 同一工作区两次自动重建之间的最小间隔（0 = 每次过期检索都重建）
    im:                            # 可选：IM 里的 /kb（默认关闭；没有 interaction-gate 的 IM 目标就不注册）
      command: kb
      maxResults: 5
      maxChars: 1800
      workspace: ''                # 要检索的仓库根目录；IM 命令没有 agent 的 cwd，必须显式配置
```

会话与 p2p 要求不在这里：它们是 `dsh-interaction-gate` 的 `im.approvalChatId` / `im.p2pOnly`（唯一来源）。

**项目级可覆盖**（`<repo>/.dsh/knowledge-base.json`）：`enabled`、`indexDir`、`maxFileBytes`、`maxChunkLines`、
`sources`、`tokenizer`、`freshness`、`search`、`im` —— 且只能**收窄**：

- 数值上限（`maxFileBytes`、`maxChunkLines`、`search.limit`、`search.maxLimit`）只能调低；
- `tokenizer.minTokenLength` 只能调高；`tokenizer.cjkBigrams` 只能关掉（打开会更宽地召回）；
- `sources` 只能停用来源或**删减**模式，不能新增来源、不能换 `kind`、不能加模式；
- `freshness.cooldownMs` 只能**调大**（项目级不能缩短冷却窗口——那会让每次"读"都更容易变成一次"写"）；
- `enabled` 只能从开变关。`logFile` / `prompt` 属于宿主，项目改不了；
- `im` 只能**收窄**：`maxResults` / `maxChars` 只能调低；`im.command` 与 `im.workspace`（"搜哪个仓库"）是宿主决定，
  项目级写了会被忽略并报告；`im.chatIds` / `im.p2pOnly` **已经不是知识库的配置**（会话与 p2p 要求只有一个来源：
  `dsh-interaction-gate` 的 `im.approvalChatId` / `im.p2pOnly`），项目级写了会被当作"已移除"报告并忽略。

每一个被拒绝的放宽都会在报告里逐条说明原因（"`maxLimit=100` 超过上限 50，已忽略"），
所以"我以为改了"和"真的改了"不会长得一样。值本身不可用时**保留宿主的值**，同样上报。

## 产物布局

```
<布局根>/kb/      # .dsh/kb/，或迁移后的 .dsh/engineering-suite/kb/
  manifest.json    { version, builtAt, fingerprint, sources:[{id,kind,documents,chunks,skipped:[{path,reason}]}],
                     totals, staleness?: { reason } }
  chunks.jsonl     每行一块：{ id, docId, kind, path, title, from, to, text, symbols? }
  postings.json    { version, k1, b, chunksDigest, chunkCount, totalTokens, averageLength,
                     lengths, documentFrequency, postings:{token:{chunkId:tf}}, titleTokens, symbolTokens }
```

- **块 id 是内容寻址的**：`<docId>:<from>-<to>`（`docId = kind:path`，派生文档带 `#<mission>`/`#<version>`/`#<行号>` 区分）。
  id、块文本、倒排索引里都**没有时间戳**，所以**未改动的仓库重建后 `chunks.jsonl` 字节完全相同**，
  manifest 里只有 `builtAt` 会变 —— 这正是让"重建"可 diff 的前提。
- **写入是原子的**（临时文件 + rename），并且 `manifest.json` **最后写**：崩在中间只会留下旧索引或没有索引，
  而不是一份对不上倒排索引的块列表。`postings.json` 里存了它所依据的 `chunks.jsonl` 的 SHA-256，
  两者不一致时 `kb_search` **拒绝作答**并让你重建。
- **崩溃留下的半行不会毁掉重建**：`loadIndex` 容忍 `chunks.jsonl` 最后一行被截断，丢掉它并报告丢了几行；
  重建整体替换三个文件，不跟旧索引做合并（合并会留下已删除文件的块）。

## 分词与打分（以及它们的取舍）

| 选择 | 取值 | 取舍 |
|---|---|---|
| ASCII/Latin 词 | 小写化，短于 `minTokenLength` 丢弃 | 与代码标识符/英文文档对齐；`AC-002` 会切成 `ac` + `002`，靠下面的 id 加成补救 |
| CJK | **重叠二元组**（`登录失败` → `登录 录失 失败`），单字 run 保留为单字 token | CJK 没有空格，整段当一个 token 会让 `登录` 搜不到 `登录失败`；代价是索引更大、`录失` 这类跨词 bigram 属于噪声。关掉 `cjkBigrams` = 只匹配完全相同的 run（更精确、召回更差） |
| 打分 | **BM25**，`k1=1.2`、`b=0.75`，IDF = `ln(1 + (N-df+0.5)/(df+0.5))` | 标准参数，不调参：可复核比"更好一点"重要 |
| 字段加权 | `tf = 3·tf_title + 2·tf_symbols + 1·tf_body`（BM25F 式折叠进 tf） | 标题/符号命中优先；折叠只保留一套长度归一化，长文件不能靠重复一个词取胜 |
| id 精确命中 | 形如 `AC-003`/`R-7`/`ADR-0002`/`TC-001`/`GATE-…`/`RCP-…`/mission id 的字面查找（大小写不敏感、边界校验），命中 **+8**；**"定义处"（id 后面还跟着正文）再加 8** | 让"AC-002 是什么"返回规格里那条验收标准，而不是某份只把 id 列成清单的台账行 |
| 过滤 | `kinds` / `pathPrefix` / `missionId`，**先过滤再排序** | IDF 与平均长度仍用整个索引的统计，所以同一查询在不同过滤下分数可比 |
| 摘要 | 命中行附近最多 3 行、400 字符，两端被切时标 `…` | 够复核，不把整块塞进上下文 |

## 覆盖与新鲜度

- **覆盖**：六个来源各自的文档/块数与**跳过明细**（`binary` / `oversized` / `unreadable` /
  `excluded-path` / `missing-file` / `unparsable` / `summary-cap` / `incomplete-row`）都进 manifest。跳过 ≠ 不存在：
  报告里两者绝不会长得一样。**没有符号提取器的语言不是"跳过"**：它的文本照样进索引，报告在来源说明里写
  「无符号提取器（文本索引）：ruby × 2、rust × 1…」（`skipped` 只留真正的跳过：二进制/超限/不可读/索引目录自身等）。
  `kb_status` 的逐来源表**按磁盘上的 `chunks.jsonl` 核对** manifest 的声明：
  两边的说法不一致时（老版本留下的索引可能真是这样）以产物为准，并把"manifest 与产物不一致"说出来。
- **索引自己知道的不完整**：`manifest.staleness.reason` 记录局部构建（`only`）、遍历达到 `maxFiles` 上限、
  来源自身读不到产物等情况，`kb_search` / `kb_status` 都会转述。局部构建的声明**不是永久的**：下一次请求完整覆盖时，
  manifest 会按请求改写成完整覆盖（`changeKind: coverage`），这条"局部索引"的自我声明随之消失。
- **新鲜度（相对当前工作区）**：`kb_search` / `kb_status` 用 git 指纹判定 —— HEAD、分支、`git diff HEAD` 摘要、
  改动数任一不同即**过期**，并在报告最前面说明原因；不是 git 仓库时报告"**无法判定**"而不是假装新鲜。
- **检索期自愈（编辑期也能搜到最新内容）**：`kb_search` 与 IM `/kb` 在检索**之前**用同一枚指纹判断是否过期，
  过期就调用与 `mission_complete` 相同的 `reindex`（增量、原子写、内容寻址），然后才排序：
  - **成功**：结果**首行**写「索引已自动更新（N 块）」；触发它的那条陈旧原因仍然保留（"为什么重建"是可审计的），
    但原来的建议（先跑 `kb_index`）被"已在本次检索前自动重建"取代；
  - **失败**：**照常返回旧索引的结果**（一次维护失败不该让检索报错），但**首行**必须写
    「索引过期且自动重建失败：<原因>；结果可能缺少最近改动」，同时 `logger.warn` —— **绝不静默**；
  - **冷却**：同一工作区在 `freshness.cooldownMs`（默认 10 s）内只重建一次；**任何**一次真实构建（显式 `kb_index`、
    `/kb index`、交付后的 `reindex`、以及自动重建本身）都会重置这个窗口，所以"刚构建完又马上改一行"只会看到陈旧警告，
    不会每次检索都重写一遍索引；
  - **并发**：同一工作区同时只允许一个自动重建（先占位再构建），加上 `buildIndex` 本身的原子写，
    并发检索不会写出半份索引、也不会写第二份。
  `kb_status` **不**自愈（它是只读入口），它只报告陈旧并说明检索路径会在冷却允许时自动重建。
- **索引目录不进指纹**：构建与比较都用 `indexFingerprint(cwd, indexDir)`（`index-store.ts` 导出，包根也导出），
  它用 git pathspec `:(top,exclude,literal)<indexDir>` 把索引目录从 status 与 diff 摘要里排除，`dirty` 与改动数同步跟进。
  否则刚建好的索引会被自己的产物判成过期（真实现场：`.dsh/kb/` 没写进 `.gitignore`，`kb_index` 之后 `kb_search` 报
  "工作区改动数从 0 变成 0"）；把产物**提交**进版本库的仓库（README 允许）也不会因为 `builtAt` 变动而自我失效。
  需要比对新旧的其他面（例如 CLI 入口 `scripts/kb.mjs`）也应调用同一个函数，而不是裸 `gitFingerprint`。
  这个排除只点名索引目录本身：`.dsh/` 下**别的**文件（如 `.dsh/plan.jsonl`）照旧算改动。
- **变更判定与新鲜度判定必须一致**：`kb_index` 每次重建都比对下面这些事实（manifest 在不在、请求的来源覆盖、`chunks.jsonl` 字节、`postings.json` 字节、git 指纹、`force`），并据此给出 `changeKind`（报告里各有一句话）：

  | `changeKind` | 含义 | 写盘 |
  |---|---|---|
  | `created` | 首次构建（没有 manifest） | 三个文件全写 |
  | `coverage` | **请求的来源覆盖与 manifest 记录的不一致**（`only` 局部构建、或来源的 `enabled` 改了）；报告写"来源覆盖变了"并列出 记录→请求 的增删 | manifest 一定改写；块列表与倒排索引**只在文档集合真的变了时**跟着重写 |
  | `content` | 来源覆盖没变，重建结果与 `chunks.jsonl` 字节不同：被索引的内容变了 | 三个文件全写 |
  | `postings` | 块列表字节相同、倒排索引字节不同（分词/打分配置变了） | 三个文件全写 |
  | `forced` | `force: true`：调用方明确要求重写，内容其实没变 | 三个文件全写 |
  | `fingerprint` | 内容字节未变，但 manifest 里记的指纹已经对不上当前工作区（例如编辑了 `.gitignore` 这种**没被索引的跟踪文件**） | **只写 manifest** |
  | `unchanged` | 请求的覆盖相同、内容字节相同、指纹也一致 | 什么都不写（一个字节都不写） |

  多个事实同时成立时报**最强**的那个，顺序固定为（`ChangeKind` 的注释里也写着同一份顺序，测试按它断言）：

  `created` > `coverage` > `content` > `postings` > `forced` > `fingerprint` > `unchanged`

  两点容易误读，所以写清楚：**`coverage` 排在 `content` 前面**，因为"请求的范围和记录的范围不同"才是 manifest 记错的那件事，也是块列表为什么会变的解释——
  但它**不吞掉**内容事实：报告会同时说明块列表与倒排索引这次到底有没有被重写（`文档集合真的变了` vs `字节未动、未重写`）。
  **`forced` 排在 `fingerprint` 前面**（显式 force 永远不是"构建自己发现指纹过期"），但排在 `coverage`/`content`/`postings` 之后：真有实质变化时，报那个变化比报"调用方要求重写"有用。

- **`kb_index` 按内容比对，但也负责指纹与覆盖**：内容问题只看**字节**（未变才说"未变"），所以指纹的已知盲区
  （未跟踪文件的**内容**改动不改变 `git diff HEAD`）不会变成"假装最新"；可指纹问题反过来由重建兜住——记的指纹和当前工作区
  对不上就刷新它（`fingerprint`），否则会出现"`kb_search` 报陈旧、它让你 `kb_index`、`kb_index` 却说未变、警告永远消不掉"。
  指纹刷新只重写 manifest：块列表与倒排索引的字节**原样不动**（它们本来就和这次重建算出来的一样），
  "同一仓库两次重建字节相同"的确定性保证不受影响。
  同一类问题还有第三面：**覆盖**。字节比对看不见"这次请求的来源集合和 manifest 记的不一样"——局部构建排除的来源如果恰好一个文档都没贡献，
  它算出来的产物和完整构建**逐字节相同**，于是"只建 docs"既没被记录、`manifest` 里的"局部索引"声明也永远消不掉（`kb_status` 因此把索引说得比实际更窄）。
  所以覆盖变了就是 `coverage`：manifest 一定改写成本次请求的覆盖，块列表与倒排索引只在文档集合真的变了时才重写。
  `force`、`fingerprint`、`coverage` 是三件事，绝不混用：`force` 是"调用方要求重写"，`fingerprint` 是"构建自己发现指纹过期"，
  `coverage` 是"本次请求的范围与记录的范围不同"。

## 与其他插件的分工

| 插件 | 关系 |
|---|---|
| `dsh-spec-gate` | 写 `.dsh/specs/<id>.md`（`spec` 来源）、保护 `.dsh/**`（模型改不了索引目录里的东西）、`adr_record` 写 `.dsh/adr/*.md` + `index.jsonl`（`adr` 来源）、`spec_create/spec_approve/spec_amend` 追加 `.dsh/plan.jsonl`（`plan` 来源） |
| `dsh-evidence-gate` | `release_record` 追加 `.dsh/releases.jsonl`（`trail` 来源的发布文档）；交付成功签发回执后 **best-effort 调用本插件的 `knowledge-base` 服务重建索引**（失败只记警告、只加一行附注，绝不影响回执与 mission 状态） |
| `dsh-suite-doctor` | 可以读 `manifest.json` 报告索引新鲜度/来源覆盖（本插件不主动改别人的报告） |
| `dsh-impact-gate` | 影响面给的是"改了哪些文件"，本插件能回答"这些文件在规格/决策/台账里被谁引用" |
| `dsh-standards-gate` | 代码符号来自同一套提取器（`dsh-eng-core` 的 `scanWorkspace`），所以"符号"在两个插件里是同一个定义 |
| `dsh-audit-trail` | 检索不改写审计轨迹；索引过期时它只重写**知识库自己的产物**（`.dsh/kb/`），fresh 时逐字节不写（有测试快照证明） |
| `@deepseek-ai/dsh-commands` | **可选**：装配了就多一条人类命令 `/kb …`（与三个工具共用同一份报告，不经模型、不花 token）；没装配不影响任何工具 |
| `dsh-chat-interaction` | **可选**：装配了（≥ 0.3.8）**且** interaction-gate 发布了 IM 目标（`im.approvalChatId`）才多一条 IM 命令 `/kb`（默认关闭；见上文） |
| `dsh-interaction-gate` | **可选**：IM 目标的唯一来源——本插件只读 `ctx.get('interaction').imTarget()`；没装配就没有 IM 命令（不是回退到第二份配置） |

## 诚实的边界

- **词法召回**：同义/转述检索不到（文档只写"鉴权"时搜"登录"没有结果）。缓解手段是 id、字段过滤和"换个关键词再搜"，
  而不是假装语义。要语义就得引入模型/嵌入——那是另一个决定，不是这个插件的默认。
- **符号只覆盖 go/ts/js/python**：其余七种语言（rb/php/rs/java/kt/kts/cs/swift）**只做文本索引**，报告在来源说明
  里写「无符号提取器（文本索引）：<语言> × N」，不谎称有符号、也不把它们算成 `skipped`（文本**确实**在索引里）。
- **`trail` / `plan` 是摘要，不是原文**：它们的 `path` 指向台账文件，但 `from-to` 是**摘要自己的行号**；
  摘要里每条门禁/回执都带自己的文件路径，引用前请用 id（`GATE-…`/`RCP-…`/`R-…`）复核原文。文件类来源
  （spec / adr / docs / code）的 `from-to` 是**文件真实行号**。
- **只索引列出的来源**：`.dsh/audit/**`、`.dsh/state/**`、`node_modules`、构建产物一律不在索引里（其中 `.dsh/**`
  不从目录树遍历，只有显式声明的来源目录会被读）。发布台账 `.dsh/releases.jsonl` 的文档归 `trail` 来源
  （一行一份发布记录），`plan` 只覆盖 `.dsh/plan.jsonl`——同一份台账不会被两个来源各索引一遍。
- **索引会过期，过期在检索期自愈**：`kb_search` / IM `/kb` 发现过期会先重建一次（冷却与并发规则见上），
  成功/失败都写在结果**首行**——失败时答案仍来自旧索引，但绝不静默。`kb_status` 只报告、不修。
  另有一条**交付附带的 best-effort 重建**：`mission_complete` 签发回执后由 `dsh-evidence-gate` 调服务的 `reindex`
  ——它不阻塞交付、失败只记警告，结果作为交付输出末尾的一行附注（"索引已更新（N 块）/ 未变 / 更新失败：…"）。
- **模型可能不照做**：prompt 段要求"先查再答、每条带引用"，但这是提示级的；机械保证只有"命中必带 `path:from-to`、
  索引里没有就不返回"。
- **`only` 建出来的是局部索引**：它只包含被点名的来源，manifest 会记下这一点，检索报告也会转述——但**别把它当完整索引引用**。
  这条"局部"声明跟着**最后一次请求**走：再跑一次不带 `only` 的 `kb_index`（或在配置里重新启用来源），manifest 会被改写回完整覆盖并写 `changeKind: coverage`，
  不会出现"跑过了但 manifest 还写着局部索引"；反过来，在完整索引上跑 `only` 也一样会被记录成 `coverage`（哪怕这次算出来的字节一模一样）。

更多见 `docs/KNOWN-LIMITS.md` 与 `docs/ARCHITECTURE.md`。
