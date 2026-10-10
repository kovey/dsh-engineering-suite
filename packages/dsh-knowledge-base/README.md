# dsh-knowledge-base

**项目知识库**：把仓库自己的规格、决策、交付台账、文档和代码索引成一份**可比对的本地检索产物**，
让 dsh 里的模型回答项目问题时**必须带 `path:line` 引用**，索引里没有的就明说"索引里没有"。

其他插件生产证据（`dsh-spec-gate` 写规格、`adr_record` 记决策、`dsh-evidence-gate` 发回执、`dsh-audit-trail` 记工具历史），
这个插件把那些证据**变成可检索的**：回答"AC-003 是什么"、"为什么选 A 不选 B"、"谁改的"、"在哪里实现"。

## 它是什么 / 不是什么

| 是 | 不是 |
|---|---|
| `.dsh/kb/` 下的一份**构建产物**（三个纯文本文件，可读、可 diff、可进版本库） | 向量数据库 / 嵌入索引（**没有** embedding、没有网络、没有模型调用） |
| **确定性词法检索**：BM25 + 字段加权 + id 精确命中；同一索引 + 同一查询 → 同一结果与同一顺序 | 语义检索：换个说法可能召回不到（见"诚实的边界"） |
| 每条命中都带 `path:from-to`、分数、**命中原因**（哪些 token 命中了哪个字段） | 聊天机器人：回答由模型给出，索引只提供带出处的片段 |
| 契约内的**缺口上报**：跳过的文件带原因，局部索引自己声明是局部的 | git 历史索引：只看工作区**当前内容**与 `.dsh` 台账 |

## 三个工具

| 工具 | 作用 |
|---|---|
| `kb_index({ force?, only? })` | （重）建索引：按来源报告文档/块数、**每个被跳过文件的原因**、git 指纹，以及"变了没有"。**未改动时明说"索引已是最新，未变"并且不重写任何文件**；`force: true` 才强制重写，`only` 只建部分来源（manifest 会记下这个局限）。未知来源 id 直接拒绝，不静默跳过。 |
| `kb_search({ query, limit?, kinds?, pathPrefix?, missionId? })` | 检索：返回排序后的命中（引用、摘要、分数、命中原因）。索引不存在时**拒绝**并点名 `kb_index`；相对当前 git 指纹**过期**时在报告最前面警告（"最近改动可能没进索引"），不会静默作答。`limit` 受 `maxLimit` 硬上限约束，被截断时报告里说明。 |
| `kb_status()` | 只读状态：manifest 摘要、产物大小、逐来源覆盖与跳过原因、与当前指纹的新鲜度、索引自己声明的不完整之处，以及"这个索引是什么/不是什么"的诚实声明。 |

报告全部是中文，以「下一步：…」结尾；每个拒绝都给出可执行的修法。

## 配置（两层：profile 是上限，项目只能收紧）

```yaml
- id: knowledge-base
  config:
    enabled: true
    logFile: '~/.dsh/knowledge-base.log'
    indexDir: .dsh/kb              # 索引产物目录（工作区内相对路径）
    maxFileBytes: 262144           # 超过就按 stat 跳过，绝不读进内存
    maxChunkLines: 60              # 一块最多多少行
    sources:                       # 六个收集器；globs 以 .dsh/ 开头时跟随 layout.rootDir
      - { id: spec,  kind: spec,  globs: ['.dsh/specs/*.md'] }
      - { id: adr,   kind: adr,   globs: ['.dsh/adr/*.md', '.dsh/adr/index.jsonl'] }
      - { id: trail, kind: trail, globs: ['.dsh/missions/**', '.dsh/releases.jsonl'] }
      - { id: plan,  kind: plan,  globs: ['.dsh/plan.jsonl'] }
      - { id: docs,  kind: docs,  globs: ['*.md', 'docs/**/*.md'] }
      - { id: code,  kind: code,  globs: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs', '**/*.cjs', '**/*.go', '**/*.py'] }
    tokenizer: { cjkBigrams: true, minTokenLength: 2 }
    search: { limit: 10, maxLimit: 50, fieldBoosts: { title: 3, symbols: 2, body: 1 } }
```

**项目级可覆盖**（`<repo>/.dsh/knowledge-base.json`）：`enabled`、`indexDir`、`maxFileBytes`、`maxChunkLines`、
`sources`、`tokenizer`、`search` —— 且只能**收窄**：

- 数值上限（`maxFileBytes`、`maxChunkLines`、`search.limit`、`search.maxLimit`）只能调低；
- `tokenizer.minTokenLength` 只能调高；`tokenizer.cjkBigrams` 只能关掉（打开会更宽地召回）；
- `sources` 只能停用来源或**删减**模式，不能新增来源、不能换 `kind`、不能加模式；
- `enabled` 只能从开变关。`logFile` / `prompt` 属于宿主，项目改不了。

每一个被拒绝的放宽都会在报告里逐条说明原因（"`maxLimit=100` 超过上限 50，已忽略"），
所以"我以为改了"和"真的改了"不会长得一样。值本身不可用时**保留宿主的值**，同样上报。

## 产物布局

```
.dsh/kb/
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

- **覆盖**：六个来源各自的文档/块数与**跳过明细**（`binary` / `oversized` / `unreadable` / `unsupported-language` /
  `excluded-path` / `missing-file` / `unparsable` / `summary-cap` / `incomplete-row`）都进 manifest。跳过 ≠ 不存在：
  报告里两者绝不会长得一样。
- **索引自己知道的不完整**：`manifest.staleness.reason` 记录局部构建（`only`）、遍历达到 `maxFiles` 上限、
  来源自身读不到产物等情况，`kb_search` / `kb_status` 都会转述。
- **新鲜度（相对当前工作区）**：`kb_search` / `kb_status` 用 git 指纹判定 —— HEAD、分支、`git diff HEAD` 摘要、
  改动数任一不同即**过期**，并在报告最前面说明原因；不是 git 仓库时报告"**无法判定**"而不是假装新鲜。
- **`kb_index` 不靠指纹**：它按**内容**比对重建结果，未变才说"未变"且不重写文件。
  指纹的已知盲区（未跟踪文件的**内容**改动不改变 `git diff HEAD`）因此不会变成"假装最新"。

## 与其他插件的分工

| 插件 | 关系 |
|---|---|
| `dsh-spec-gate` | 写 `.dsh/specs/<id>.md`（`spec` 来源）、保护 `.dsh/**`（模型改不了索引目录里的东西）、`adr_record` 写 `.dsh/adr/*.md` + `index.jsonl`（`adr` 来源）、`spec_create/spec_approve/spec_amend` 追加 `.dsh/plan.jsonl`（`plan` 来源） |
| `dsh-evidence-gate` | `release_record` 追加 `.dsh/releases.jsonl`（`trail` 来源的发布文档）；交付侧可以把"索引是否覆盖本次改动"当作一条检查 |
| `dsh-suite-doctor` | 可以读 `manifest.json` 报告索引新鲜度/来源覆盖（本插件不主动改别人的报告） |
| `dsh-impact-gate` | 影响面给的是"改了哪些文件"，本插件能回答"这些文件在规格/决策/台账里被谁引用" |
| `dsh-standards-gate` | 代码符号来自同一套提取器（`dsh-eng-core` 的 `scanWorkspace`），所以"符号"在两个插件里是同一个定义 |
| `dsh-audit-trail` | 检索是**只读**的（测试用 `.dsh` 逐字节快照证明），不会污染审计轨迹 |

## 诚实的边界

- **词法召回**：同义/转述检索不到（文档只写"鉴权"时搜"登录"没有结果）。缓解手段是 id、字段过滤和"换个关键词再搜"，
  而不是假装语义。要语义就得引入模型/嵌入——那是另一个决定，不是这个插件的默认。
- **符号只覆盖 go/ts/js/python**：扩展名不在现有提取器范围内的文件**只做文本索引**，并在 `skipped` 里如实标注
  （不是"跳过"，是"没有符号"）。
- **`trail` / `plan` 是摘要，不是原文**：它们的 `path` 指向台账文件，但 `from-to` 是**摘要自己的行号**；
  摘要里每条门禁/回执都带自己的文件路径，引用前请用 id（`GATE-…`/`RCP-…`/`R-…`）复核原文。文件类来源
  （spec / adr / docs / code）的 `from-to` 是**文件真实行号**。
- **只索引列出的来源**：`.dsh/audit/**`、`.dsh/state/**`、`node_modules`、构建产物一律不在索引里（其中 `.dsh/**`
  不从目录树遍历，只有显式声明的来源目录会被读）。发布台账 `.dsh/releases.jsonl` 的文档归 `trail` 来源
  （一行一份发布记录），`plan` 只覆盖 `.dsh/plan.jsonl`——同一份台账不会被两个来源各索引一遍。
- **索引会过期**：过期会**报告**，不会被自动修好；插件不会在 `kb_search` 里偷偷重建（写操作必须由 `kb_index` 触发）。
- **模型可能不照做**：prompt 段要求"先查再答、每条带引用"，但这是提示级的；机械保证只有"命中必带 `path:from-to`、
  索引里没有就不返回"。
- **`only` 建出来的是局部索引**：它只包含被点名的来源，manifest 会记下这一点，检索报告也会转述——但**别把它当完整索引引用**。

更多见 `docs/KNOWN-LIMITS.md` 与 `docs/ARCHITECTURE.md`。
