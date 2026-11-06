## [未发布]

### 重构 · scope 插件上移到 `dsh-eng-core`，`autoDispatch` 改走 `startActivation` + Agent Preset

两件事一起做，因为它们共享同一个前提：**子作用域里"到底强制了什么"只有一个实现点**。

- **scope 插件搬家**：`packages/dsh-role-guard/src/scope.ts` → `packages/dsh-eng-core/src/scope.ts`，行为不变
  （先 `ctx.tools.restrict` 再 persona；能力缺失只告警；空白名单 `allow: []` 直接拒绝挂载）。eng-core 新增子路径导出
  `dsh-eng-core/scope`，role-guard **删掉自己的 `./scope` 导出与源码**。两个插件不再各带一份：复制一份的代价不是几十行，
  而是两处可以各自漂移——一边修好"空白名单必须拒绝挂载"、另一边没修，就有一个子代理带着父 Agent 的全部工具在跑，
  而测试只覆盖修好的那一边。方向规则不变：eng-core 不 import role-guard / orchestrator。
  preset 行里的插件名现在是**从实现 import 的常量**（`SCOPE_PLUGIN_NAME = name`），不是手写字符串——
  改名不会留下"指向旧名字的行"（那样的行加载失败，子代理就**没有限制**）。
- **orchestrator 的第二处 `subagents.start` 修掉了**：`autoDispatch` 之前还在调 0.2.2-rc.1 已删除的两参
  `start(provider, request)`（真机上就是 `start is not a function`），并靠请求里的 `toolFilter`/`persona` 传限制
  ——新宿主没有这两个字段。现在：每个被派发的阶段角色注册一个 preset
  `{ id: 'orchestrator:<role>'（无角色阶段是 'orchestrator:stage'）, order: 200+i, plugins: [{ id: 'orchestrator-scope', name: 'dsh-eng-core/scope', config: { persona?, allow?, deny } }] }`，
  派发走 `startActivation({ ..., request: { prompt, parent, agentPreset, maxDepth, agentOptions }, delivery: 'caller' })`。
- **防递归没有被顺手丢掉**：`withoutOrchestrate(toolFilter)` 现在是 preset 行 config 里的一行（`deny` 必含
  `orchestrate`，有 `allow` 时同时把它从 `allow` 里剔掉），`maxDepth` 仍然随请求传。两条路径共用同一个守卫函数：
  旧宿主上它落在请求的 `toolFilter` 里。真机事故（~800 个子会话）的修法因此是**结构性**的，不是提示词。
- **旧路径保留但不是默认**：只有宿主没有 `startActivation`、仍有 `start(provider, request)` 时才走旧路径，
  且派发记录里如实写「旧宿主 / persona、toolFilter 随启动请求传递 / orchestrate 已在过滤里剔除」，
  绝不把旧宿主描述成 preset 强制。
- **五种缺失前提 fail closed**（不会再出现裸 TypeError）：无 `startActivation` 也无 `start`；有 `startActivation`
  但无 `agentPresets` 服务；preset 不是本插件注册的（被他人注册 / 注册失败 / 注册时的限制与本次要用的不一致）；
  provider 未注册（列出 `service.list()`）；provider 的 `capabilities.agentPreset === false`（限制无法强制，等于剔不掉
  `orchestrate`）。报文点名缺什么、该挂哪些包，以及闭包过期时的 `bash scripts/repair-profile-closure.sh --apply`。
  另加一条同类的 fail-closed：角色白名单在剔除 `orchestrate` 后为空时拒绝派发，而不是把 `allow: []` 交给宿主。
- **测试**：`dsh-eng-core` 186 → **190**（scope 插件的用例随代码搬过来，并补上"先 restrict 后 persona"的顺序断言、
  section 身份稳定、非数组 `allow` 不算声明）；`dsh-role-guard` 53 → **51**（2 条 scope 用例搬走），但新增一行断言：
  preset 行的 `name` 必须等于 `dsh-eng-core/scope` 这个实现导出的常量；`dsh-orchestrator` 92 → **100**
  （新路径带 `agentPreset`+`maxDepth` 且 preset 里没有 `orchestrate`、无角色阶段的自有 preset、旧宿主回退且如实说明、
  五种拒绝）。`bash scripts/verify.sh --quiet` 全绿。
- **文档**：`docs/ARCHITECTURE.md` §5.6 改为"两处 preset 都挂 `dsh-eng-core/scope`"并写明为什么共享而不是复制；
  `docs/KNOWN-LIMITS.md` 附一之十八跟着改名，并补上 orchestrator preset 同样"注册时固化、按 id 与工作区无关"的代价。
  上一条 `[未发布]` 里写的 `dsh-role-guard/scope` 由本次上移取代（同一个未发布版本，不另留旧名）。


### 修复 · `orchestrate metrics` 的偶发不确定（0.1 天取整 × 实时钟）

门禁里偶发失败：`metrics distribution is deterministic: two runs on the same tree are
byte-identical`。**不是测试太严**——报告把时长按 **0.1 天**取整渲染，而采集用的是
`Date.now()`：两次调用相隔几毫秒，只要其中一次跨过取整边界（例如 0.049 → 0.051 天），
中位数就从 `0.0 天` 变 `0.1 天`。全量并发时间隔更大，所以只在门禁里出现。

修法是把**观察时刻变成依赖**，而不是放宽断言：

- `SequenceDeps` 增加可选 `now()`；`metricsAction` 通过它取时间（**默认仍是 `Date.now`**，
  生产行为不变，异常/非有限值回落到真实钟）；
- 宿主可以提供 `clock` 服务（cordis 的注入方式）；真实部署不提供，测试提供冻结时钟；
- 两条确定性用例都改用冻结时钟，**断言 `assert.equal(first, second)` 一字未改**；
- 新增反向用例：跨时钟（+2 小时）时报告**必须不同**——证明时钟仍被读取，不是靠忽略时间赢的确定性。

orchestrator 91 → 92 测试；`scripts/verify.sh --quiet` 连跑 3 次全绿。

## [未发布]

### 修复 · `team_delegate` 改接 `startActivation` + Agent Preset（0.2.2-rc.1 的真实 API）

`packages/dsh-role-guard/src/tools.ts` 里的 `subagents.start(provider, request)` **在 0.2.2-rc.1 已不存在**：
`SubagentRuntime` 只暴露 `startActivation(spec)` / `registerProvider` / `getProvider` / `list` / `prompt` /
`sendMessage` / `interrupt` 与 catalog 一族。此前手写的 `SubagentsLike` 类型说了谎，真机上 `team_delegate`
死于 `subagents.start is not a function`。同一个版本还删掉了 `SubagentStartRequest` 的 `persona` 与
`toolFilter` 两个字段——角色策略不能再"随请求带过去"。

- **persona / 工具白名单改由 Agent Preset 承载**：新增 `presets.ts`，为每个角色注册
  `{ id: 'role:<roleId>', order: 100+i, plugins: [{ id: 'role-guard-scope', name: 'dsh-eng-core/scope' }] }`
  （该行的插件在同一个未发布版本里已上移到 eng-core，见文件顶部条目：`dsh-role-guard/scope` 不再存在）；
  新增 `scope.ts`，它是那一行的插件，**运行在子作用域**，在那里
  `ctx.tools.restrict({allow, deny})`（宿主强制）并写入 `role-guard:persona` section。限制**先于** persona 应用；
  `restrict` 被拒绝时**抛出**（子代理启动失败），绝不吞掉错误让子代理带着父 Agent 的全部工具跑起来。
- **派发路径**：`startActivation({ provider, label, request: { prompt, parent, signal, agentOptions, agentPreset }, signal, delivery: 'caller' })`，
  并把 activation 归一为 `{ id: childId, result, dispose }`。**`agentPreset` 必须随请求传**——不传时子代理加入
  父 Agent 的 composition，角色的 preset 根本不会挂载（"看起来派发了，其实没强制"）。
- **旧路径保留但不是默认**：只有当宿主没有 `startActivation`、仍有 `start(provider, request)` 时才走旧路径，
  且工具输出里如实写「旧宿主 / persona、toolFilter 随启动请求传递」，不假装用了 preset。
  两条路径的产物、绑定记录与提示词完全一致，差别只在工具输出里那一行 `派发:`。
- **四种缺失前提一律 fail closed**（不会再出现裸 TypeError）：既无 `startActivation` 也无 `start`；有
  `startActivation` 但无 `agentPresets` 服务；角色 preset 不是本插件注册的（被他人注册 / 注册失败 / 注册时的
  工具过滤与当前角色文件不一致）；provider 未注册（列出 `service.list()`）或 `capabilities.agentPreset === false`。
  报文点名**缺什么**、**该挂哪些包**（`@deepseek-ai/dsh-subagent` + 一个 provider +
  `@deepseek-ai/dsh-agent-preset-registry`），以及闭包过期时的 `bash scripts/repair-profile-closure.sh --apply`。
- **假宿主**（`dsh-eng-core/testing`）补上 `startActivation` 与 `agentPresets`：`withActivation` / `withAgentPresets` /
  `providers` / `activationChildId` / `activationResult` 全部可选，旧的 `start` 保持原样——同一个 fake 既能装旧宿主
  也能装新宿主；新增 `activationSpecs` / `activationDisposals()` / `presetDefinitions` / `presetRegistrations`。
- **测试**：`dsh-role-guard` 42 → **53**（11 条新增：两条派发路径、四种拒绝、preset 被他人注册 / 注册被拒 /
  过滤过期，以及 scope 插件的 restrict+persona 与"能力缺失不抛错、restrict 被拒必须抛"）。
- **文档**：`docs/ARCHITECTURE.md` §5.6 里"派发时把 persona/toolFilter 传进启动请求"的说法已被替换；
  `docs/KNOWN-LIMITS.md` 附一之十八 补上"闭包过期时 preset 行根本加载不了"与 id 按角色（而非工作区）固化的代价。

### 新增 · `scripts/repair-profile-closure.sh`：修掉 profile 共享闭包的过期软链

多个 profile 通过**一份共享闭包**（`~/.dsh/profiles/node_modules/@deepseek-ai`）解析 `@deepseek-ai/*`，而那是一堆指进
全局 dsh 安装树的符号链接。升级全局 dsh 会**改名与拆分**包（0.2.2-rc.1 把 `dsh-agent-presets` 拆成 `dsh-agent-preset` +
`dsh-agent-preset-registry`，把 `dsh-subagent-in-process-driver` 拆成 `-spawn-in-process` / `-fork-in-process`），闭包于是指向
不存在的路径——**悬空链接不会自己报错，它只是让某个包永远解析不到**。

脚本对账闭包与安装树，报告三类：断链 / 缺失（树里有、闭包没有）/ 冲突（同名但不是符号链接），**默认 dry-run 不写盘**，
`--apply` 只清断链、补缺失，**真实目录一律不覆盖**（共享闭包，覆盖等于破坏）。收敛结果由**重新读取**判定，不看自己的计划。

本机实测（dry-run）：**断链 23 / 缺失 104 / 冲突 0 / 正常 227**——`dsh-agent-preset` 与 `dsh-agent-preset-registry` 都在
缺失清单里，这解释了为什么 `agentPresets` 服务在当前 profile 上不可用。

OPS SELFTEST 新增 **C11**（5 项）：tree 不存在时以用法错误退出且不碰闭包、dry-run 零写盘、`--apply` 收敛、
真实目录不被链接替换、二次 `--apply` 为无操作。

## [0.6.3] — 2026-11-06

### 兼容 · harness 0.2.2-rc.1（**两处文档断言此前是错的**）

`rc.2 → rc.1` 不是常规递增：**新增 26 个包、移除 1 个、301 个包版本变化**（cordis 4.0.5 → 4.1.0）。两处变化推翻了我们文档里的旧说法：

- **PTC 的启用方式变了**：`dsh-tools` 删除了 `mode` 配置（`z.never()`："Removed. Mount a native or PTC tool executor instead."），
  新增 `dsh-tool-executor-native` / `dsh-tool-executor-ptc`；PTC 现在 = **挂载 ptc 执行器**（base patch 里该行默认 `disabled: true`）。
  旧文档写"`config.mode: 'ptc'`"是**错的**——写下它就是一个硬配置错误。
- **守卫语义的措辞与实现位置变了**：字面 "no guard can force-allow" 已不存在；契约原文改为
  "Because guards have no allow result, listener ordering cannot turn a denial back into permission"，方法 `guardReason` → `checkGuards`，
  位置在 `waterfall('tools/pre-execute')` 之后。**结论不变**（守卫只能加拒绝）。PTC 子调用仍经过
  `ToolExecutionPipeline.prepare/dispatch/complete`（旧名 `prepareScheduledExecution`/`prepareExecution` 已删）。
- 其余契约**未变**（逐条复核）：`ApprovalOutcome` 四词、`workspaceChanges` 的 `summary`/`diff` 与事件、
  `SpawnTeammateRequest` 六字段、`commands` 与 `CommandResult`、cordis 4.1.0 的 `provide(name,value,check)` 语义。

### 修复 · peer 范围的真实缺口（0.2.2 正式版会被拒）

此前只把 `dsh-agent` 扩到 `<0.2.3-0`；`dsh-tools` / `dsh-llm` / `dsh-subagent` / `dsh-subprocess` 仍是 `<0.2.2`——
它们能接受 `0.2.2-rc.1`（预发布排序在正式版之前），但会在 **0.2.2 正式版**上被宿主门禁拒绝。现已全部改为
`>=0.2.0-rc.1 <0.2.3-0`；`cordis` 由 `~4.0.4` 改为 `^4.0.4`（rc.1 实际是 4.1.0，旧声明是假的，虽然宿主不强制）。

### 验证

- 在 **0.2.2-rc.1**（隔离安装，581 包）上：build / typecheck / `test-all --quiet` 全部 exit 0（16/16 包）；
  `E2E GREEN` 且 **15/15 插件挂载**，日志无 `skipping` / `incompatible`。
- semver 真值表（`includePrerelease`）：`0.2.1-rc.2` ✓、`0.2.2-rc.1` ✓、`0.2.2` ✓、`0.2.3-rc.1` ✗。

## [0.6.2] — 2026-11-06

### 新增 · 门禁 quiet 模式与更可诊断的失败输出

`scripts/verify.sh --quiet` 与 `scripts/test-all.sh --quiet`：每阶段一行、失败时只打失败行（不再打上千行通过用例）。
门禁命令改为 `bash scripts/verify.sh --quiet`（`lint` 换成 `bash scripts/typecheck-all.sh`——`npm run lint` 在本仓库并不存在）。

顺带修掉三处会让失败**无法诊断**的自伤：

- stage 失败原本打印 `tail -40`，而真正失败的包在**头部**，被后面通过的包挤掉；
- 诊断代码里的 `printf "$output" | head` 会让 `printf` 收到 SIGPIPE，`pipefail` 把退出码改写成 **141**，把真实失败吃掉；
- `verify.sh --quiet` 没有把 `--quiet` 传给 `test-all.sh`，后者仍打上千行。

### 修复 · eng-core 的"孙进程不残留"用例只在全量并发时失败

它数的是**全机的 `sleep 60`**，而套件里其它超时用例也会 spawn 同名进程，于是全量跑时数到别人的进程。改为孙进程自带 marker、只数自己，并用有界轮询等待回收；**最终仍要求 0 残留**（不是放宽断言）。

### 新增 · `shellAllow`：strict 下区分受评审脚本与任意代码

`shellPolicy: 'strict'` 原本会连仓库自己的 `bash scripts/verify.sh` 一起拒掉（于是只能把门禁关掉）。新增**宿主键** `shellAllow`（glob 列表）：命中则放行，`python3 -c` / `node -e` 这类内联解释器仍**拒绝**；命令含 `..` 永不匹配。项目级不可覆盖（否则等于自我豁免）。5 条回归测试。

### 验证

- `bash scripts/verify.sh --quiet`：全绿（16 个包 + 跨包集成 + 工具自检）。

## [0.6.1] — 2026-11-05

### 修复 · shell 分析器把 heredoc 正文与比较运算符当成重定向

真实使用中撞了两次：一条 `git commit -F -`（提交信息里有"apiVersion 大于等于 1"）被拒，理由是
"shell 命令要写等号，不在规格声明的文件边界内"——分析器把大于号当重定向、把紧随的等号当成目标文件；
heredoc 正文里的"大于号加文件名"也会被当作写盘。

- **扫描前剥离 heredoc 正文**（`stripHeredocs`）：正文是**数据**，不是 shell 语法。保留开标记那一行，
  因为真实重定向常写在它前面（例如 cat 重定向到文件的同时挂 heredoc）；未终止的 heredoc 直接丢弃剩余部分——
  它后面的内容同样不能再被当作可信的 shell 语法。
- **重定向目标不能以等号开头**：比较运算符里的等号是运算符的尾巴，不是文件名。
- 两处正则与分词都改为读取剥离后的文本（否则总有一条仍在扫描正文）。
- **不放松**：带引号的文本照旧不算，文件描述符复制仍不算文件，与号大于仍被检出，四种真实重定向写法逐条有断言。

新增 8 条回归测试（`packages/dsh-spec-gate/test/shell.test.ts`），其中第一条就是这个 bug 本身。

### 验证

- `bash scripts/verify.sh`：**1108 测试 / 1107 通过 / 0 失败 / 1 如实跳过**，OPS SELFTEST GREEN。

### 新增 · 测试命令识别覆盖主流语言（表驱动），脚手架同步

`doctor` 的"质量门禁里有没有测试类命令"此前是一段手写正则，**PHP 整块被漏掉**（`phpunit`/`vendor/bin/phpunit`/`pest`/
`php artisan test`/`composer test` 全不识别），于是健康的 PHP 仓库会被提示"没有一条能认出是测试"。

- 改成**冻结的表**（`dsh-eng-core/src/test-commands.ts`，52 行 / 127 个示例）：JS/TS、Python、Go、Rust、JVM、.NET、
  C/C++、**PHP**、Ruby、Elixir/Erlang、Swift/Apple、Zig/Nim/Lua/Perl/Shell、Haskell、以及 `make test|check|verify` 与
  `bash|sh *test*.sh` 这类包装器。
- 匹配规则写在模块注释里：按**命令词边界**锚定（`^(?:pattern)(?=\s|$)`）、大小写不敏感；跳过 `NAME=value`、`env/sudo/time/command/exec/nohup`、
  `npx/pnpx/bunx`、`pnpm|yarn exec|dlx`、`bun x`、`bundle exec`、`poetry|pipenv run` 等前缀；路径归约为 basename
  （`./`、`vendor/bin/`、`bin/`、`node_modules/.bin`、绝对路径）；工具名之后的参数忽略；`echo pytest`、`grep phpunit`、
  `cat jest.config.js` 这类**含词但不执行**的命令不识别；首行命中即止。
- `doctor` 的 detail 现在**点名生态与工具**（`识别为 PHP / phpunit、Rust / cargo…`），比"1 条测试命令"有用得多；
  严重度语义不变：命令列表为空才是 `required`，"有命令但认不出"仍是建议级。
- **脚手架同步**：`scripts/project-config.sh` 的 `detect()` 按清单文件给出建议命令，覆盖 composer.json→`vendor/bin/phpunit`、
  Gemfile→`bundle exec rspec`、mix.exs→`mix test`、Package.swift→`swift test`、gradle→`./gradlew test`、pom.xml→`mvn test`、
  Cargo.toml→`cargo test`、go.mod→`go test ./...`、pyproject/tox→`pytest`、package.json→`npm test`、CMakeLists→`ctest`、
  `*.csproj/*.sln`→`dotnet test`、Makefile→`make test`；`--test/--lint` 仍优先。新增 **`--print`**：只打印
  `kind=/test=/lint=`、**不写任何文件**（检测不出时返回 3）。
- **防漂移**：新测试用 16 个清单夹具跑 `--print`，断言脚手架给出的命令**恰好被识别器认出、且生态/工具一致**，
  同时断言没有写 `.dsh/`、重复运行结果相同。两个列表从此不能各自漂移。

### 已知未覆盖（明确报告）

- `scan.ts` 的 `suggestCommands`（**第三份**清单→命令列表，用于 `spec_bootstrap` 的建议）尚未同步这批清单文件——
  它有自己的测试钉着，本轮未动；
- 纯文本匹配无法区分 `phpunit --version` 与真正跑测试（参数被忽略）；
- `sudo -u deploy phpunit`、带引号的 `xcodebuild` destination、`make -C dir test` **刻意不匹配**（保守：宁可漏认，不可误认）。

### 验证

- `bash scripts/verify.sh`：**1090 测试 / 1089 通过 / 0 失败 / 1 如实跳过**（含 OPS SELFTEST GREEN）。
- 手工抽检：`vendor/bin/phpunit` → `PHP / phpunit`、`php artisan test` → `PHP / artisan`、`pest` → `PHP / pest`、
  `composer test` → `PHP / composer`；而 `php -l`、`echo pytest`、`grep phpunit` **不识别** ✓。

## [0.6.0] — 2026-11-03

### 修复 · 知识库索引新鲜度可复现（一致性总览的最后一个盲区）

一致性总览此前只能读索引 manifest **自述**的陈旧标记，因为真正的计算在 `dsh-knowledge-base`（`eng-core` 不能依赖它，会成环），
而索引指纹是在**排除 `.dsh/kb`** 之后算的——读者用自己的排除集去比会**永久假 stale**，比"不知道"更糟。

- 新增 `dsh-eng-core/src/fingerprint.ts`：`fingerprintWithExcludes(cwd, {paths})`（git pathspec + `-uall`）、
  `sameFingerprint(a,b)`（只比六个字段）、`changedPathsWithExcludes()`（**点名**哪些文件变了）。`gitFingerprint` 一字未改。
- **产物声明怎么比较它**：`.dsh/kb/manifest.json` 的 `fingerprint` 增加 `algorithm: 'git-status-v1'` 与 `excludes: ['.dsh/kb']`；
  `indexFingerprint`/`stalenessOf` 仍从 `dist/index-store.js` 导出（`scripts/kb.mjs` 不变），但**只是 core 的薄转发**——全仓一份比较逻辑。
- **总览据此复算**：声明齐全 → `fresh` / `stale`（并列出改动的文件）；缺声明（旧索引）→ **`unknown` + 盲区行"旧索引未声明算法与排除集，无法复算"**，
  **绝不 `fresh`**；算法未知 / 排除集不可用 / 非 git 仓库同样 `unknown`。
- 一条测试专门证明读者**按声明在算**：把 `excludes` 手改成 `[]`，结论必须随之改变（这正是之前会产生"永久假 stale"的地方）；
  另有测试断言 `kb_status`、`scripts/kb.mjs`、一致性总览三处结论一致。

### 验证

- `bash scripts/verify.sh`：**1082 测试 / 1081 通过 / 0 失败 / 1 如实跳过**（含 OPS SELFTEST GREEN）。
- 包内计数：eng-core 173→179、knowledge-base 52→59。

### 新增 · 影子模式推广到 `standards-gate`（含一条硬规矩），`impact-gate` 明确不适用

- **`dsh-standards-gate`**：规则级 `mode: observe|enforce` 放在仓库自己的 `.dsh/standards.json` 的 `rules` 映射里
  （与阈值同文件、同信任根；缺省 `enforce`；未知规则名/未知 mode/无对应阈值的 mode 都是配置问题并保持 enforce）。
  规则 = 度量 id（`maxFileLines`/`maxFunctionLines`/`maxDepth`/`maxIfBlockLines`/`maxParams`/`maxExports`/`layer`/`cycle`），
  每条恰好判定一次，统一走 core 的 `applyRuleModes`；记录 `observations`、报告 `影子（observe）…` 段与切换下一步。
- **硬规矩（新）**：**影子测量永远不得写入基线（棘轮）**。规范门禁有只收紧的基线，若观察也参与写入，
  "观察一天"就会改变明天的裁决。两条写路径都只吃 enforce 规则——`accept` 冻结基线、自动收紧按 `rule|path|label` 修剪；
  并且**影子的"新增"与"恶化"都排除**（第一版只判断新增，被测试抓到）。影子测量保留在 `observations` 与度量明细工件里，门禁不回读。
- **`dsh-impact-gate` 不适用（结论，非遗漏）**：它不写任何 `GateRecord`，输出是风险分类 + 选中测试命令，阈值是 core 里的代码常量，
  也没有门禁消费 `risk`——造 `mode` 等于凭空发明规则条目。用两条"decision record"测试 + README 段落钉住这个判断。
- 顺带修正医生 `gate.observe` 的修复文案：此前只说"重跑 `quality_gate_run`"，现在点名**两个**门禁
  （`quality_gate_run` / `standards_check`），因为 observe 记录来自两者。

### 验证

- `bash scripts/verify.sh`：**1011 测试 / 1010 通过 / 0 失败 / 1 如实跳过**（含 OPS SELFTEST GREEN）。
- 包内计数：`dsh-standards-gate` 24→35、`dsh-impact-gate` 60→62。

## [0.5.0] — 2026-11-02

### 文档 · 「上下文不是授权」写成硬规矩 + 被否决的设计清单

- `ARCHITECTURE §5.23`：把参考设计那句 "bypasses the gate and grants no new authority" 提升为**全局硬规矩**，
  并列出四类上下文（知识库片段 / IM 消息与点击 / 引用的文档 / 子代理产出）各自"可以影响什么、永远不能做什么"，
  以及**今天靠哪五条机制成立**（授权强度、证据完整性、一次性 token、信任根封闭、撤销与取代）——
  同时诚实标注哪些只是"提示级"（回答必须带引用这类要求，机械保证只有"命中必带 `path:from-to`"）。
- 新增 `docs/REJECTED-DESIGNS.md`：把散落各处的"我们刻意不做的事"收拢成一份**可引用**的清单（执行面 / 授权面 / 检索面 / 交付面 / 流程面），
  每条都写"否决什么 / 理由 / **什么条件下可以重新考虑**"——设计不是信仰，前提变了就该重新评估。

### 新增 · 注意力一等化（`Attention`）与"暂停只顺延"

- **派生而非第三真值源**：一个问题 = 台账 `ask` 行且 token 无决定行；只有无法派生的（`whyYou`、`superseded`/`withdrawn`、暂停区间）
  落盘到 `.dsh/interaction/attention.jsonl`。**回答仍只来自一次性 token + 台账**。
- **`whyYou` 两值**：`decision-required` / `result-usable`（未知默认前者；第三值被拒绝）。
- **`stale` 读时计算并给理由**（策略版本变了 / 等得太久（默认 24h）/ mission 已结束），**仍列出并打标记**，绝不静默隐藏。
- **取代与撤回**：mission 交付或授权撤回 → 每个未决问题**恰好一条** `superseded`；**迟到答案一律拒绝**（`refused:superseded`
  / `refused:withdrawn`）且**不写任何决定**——否则"当时的问题"可能几小时后被点成批准。
- **暂停只顺延**：`deadlineAt = askedAt + window + pausedMs`（精确相等），等待重新武装而非过期，超时文案写明"延长了 Nms"；
  恢复后从顺延后的截止继续。`suite_status` / `interaction_status` 保持只读（不扫单），所以已结束 mission 的旧问题在被下一次提问扫到前
  会显示为 `stale(mission-ended)`。
- **`suite_status` 只回答三个问题**（需要我做什么 / 系统健康 / 历史），并钉住不变量：计数等于列表长度、健康时一行、
  截断说明隐藏数量、一次探测失败不算问题、读不出来要写"未知（读取失败，不是没有）"。

### 修复 · 注册表计时器与通道超时的竞态（既有问题）

通道侧会在截止时间前 1ms 记"等待回答超时"，而注册表自己的计时器可能与它同时触发，导致 `problems()` 偶发为空。
现在注册表计时器在截止后 **5ms** 才触发（`TIMEOUT_GRACE_MS`），让通道记录先落定。

### 验证

- `bash scripts/verify.sh`：**998 测试 / 997 通过 / 0 失败 / 1 如实跳过**（含 OPS SELFTEST GREEN）。
- 包内计数：`dsh-interaction-gate` 42→53、`dsh-suite-doctor` 41→47。


### 新增 · 提问的持久化 outbox（提问不再随进程消失）

此前"要人拍板"是内联发送并等待：进程死掉/宿主重启/渠道抖动发生在"决定要问"与"卡片离开进程"之间时，问题**无声消失**，
门禁只看到"没有答案"。现在 `.dsh/interaction/outbox.jsonl` 先把**意图**落盘，再发卡；之后每次状态变化追加一行，读取时同 id 最后一行胜出。

- **先 intent 后网络**；**撕裂末行被容忍并计数**（"0 行" ≠ "读不出来"）。
- **内容寻址 id**（`channel+chatId+questionId`）：重放同一问题得到同一 id，**绝不会多问一次**。
- **同一会话保序**：后一条等前一条落定或连续失败到上限（坏问题不会永久堵住会话，转而成为医生里的系统问题）。
- **推迟 ≠ 失败**：无槽位/暂停/渠道临时不可用记 `deferred`，不增 `attempts`；只有真实发送失败才退避（5s 起翻倍至 300s）。
- **永久失败 → `dropped` + 原因，只记一次，永不再入队**。
- **重放是机会式的**（装配时 + 下次提问前），**空闲会话不会自己重试**——这是边界，明确写出而不是隐藏。
- **outbox 行永远不是答案**：重放 token 已过期/已消费的提问只记 `timeout`/`dropped`，**既不重问也不放行**。
- `interaction_status` 新增 outbox 段：各状态计数、`behind` 数量、最老未落定记录的年龄；连续失败 3 次进 `problems()`。

### 验证

- `bash scripts/verify.sh`：**981 测试 / 980 通过 / 0 失败 / 1 如实跳过**（含 OPS SELFTEST GREEN）。
- 包内计数：`dsh-interaction-gate` 30→41。


### 新增 · 门禁规则影子模式（`observe`）：先测量，再收紧

规则可带 `mode: 'observe' | 'enforce'`（**默认 `enforce`**，既有行为逐字节不变）。`observe` 下规则**照跑、结论照记**，
但**不计入**门禁裁决：

- 记录：`gates/*.json` 的 `observations: [{rule, mode:'observe', would, reason}]`（按规则 id 排序；无 observe 规则时不写该字段，
  旧记录照常渲染）；影子结果行渲染为 `[影子 would=…]`，永不显示成 PASS/FAIL/BLOCK。
- 报告专段：`影子（observe）：本会拦下 N 条 …` + 每规则一行 + 切换前的下一步；未知 `mode` 报"配置问题"并保持 `enforce`。
- **不削弱强制裁决**：强制 BLOCK + 影子通过 = BLOCK，且只点名强制规则。
- 医生新增 `gate.observe`（**建议级，永不是阻塞项**）：读最近 20 个 mission，汇总"本会拦下"总数、按规则分组与连续零差异次数，
  建议"同一规则连续 5 次零差异后再切 enforce"。
- 跨包细节：**影子预算行不写进 `results`**，因为 `spec-gate` 的 plan ledger 由 `gate.state` + 结果 id 推导"预算已验证"，
  未执行的预算不能读成已验证。
- 刻意不做：`contract_check` 暂无 `mode`；**规格里声明的预算不能自带 `mode`**（规格是模型可写的，会变成自我豁免）；
  无法测量的 observe 预算仍**拒绝**。

### 修复 · 一条超时用例的假失败（flake）

`interaction-gate` 的"超时记拒绝"用例用 `timeoutMs: 60`，而通道会把超时夹到 1s 下限；重负载下发送侧预检可能先输掉这场赛跑，
于是报 `send-failed` 而不是断言的 `timeout`。**断言不改**（仍然精确要求 `refused:timeout`），只把该用例的截止时间提到 3000ms
给出余量；连续 5 次全绿，之后的全量 verify 也不再出现。它此前会伪装成别人改动的失败，这类 flake 必须钉死。

### 验证

- `bash scripts/verify.sh`：**969 测试 / 968 通过 / 0 失败 / 1 如实跳过**（含 OPS SELFTEST GREEN）。
- 包内计数：eng-core 119→127、quality-gate 81→92、suite-doctor 35→41。


### 新增 · Mandate v2：准入记录 + 策略版本 + 恢复前重校验

补上"授权前史"：`spec_approve` 现在写一条**不可变**的授权记录（强度 / 范围 / 策略版本 / 批准人 / 时间），
外加 write-once 的 `missions/<id>/policy-fingerprint.json`（批准时刻的信任根逐文件摘要）。

- **强度是算出来的**：子代理一律 `inferred`（即使在白名单里）；配了白名单 ⇒ 只有名单内的人算 `explicit`（IM 途径同样适用）；
  没配白名单 ⇒ 仅本地/终端来源且非子代理算 `explicit`，未知来源按远端处理；`approval: auto` 只有**没有**白名单时才算 `explicit`。
  白名单以只读方式取自信任根 `.dsh/role-guard.json`（`approvers`/`allowlist`）与交互层的 `approversFile`。
- **`inferred` 今天失败关闭**：被记录并被点名，但不满足强制门禁——需要"已批准规格"的写操作仍被拒绝，理由点名 `inferred`。
- **不可变**：再次批准不覆盖旧记录；**要更宽的范围必须开新 mission**（会被拒绝并说明）。
- **只有人的 stop 撤销它**：新增 `orchestrate({ action: 'stop' })` 记录 `withdrawn`；`mission_complete` 不撤销任何东西。
- **恢复前重校验**：`orchestrate({ action: 'unblock' })` 校验策略版本 / 批准人仍在名单 / 未撤销 / 记录未损坏，不通过则
  **失败关闭**（仍 blocked，写 `result:"refused"` 台账行）。因记录不可变，**策略漂移的修复办法是新建 mission 重新送审**
  （拒绝信息与医生建议都这么说）。
- **可见性**：医生新增 `mandate.policy` 检查（在飞 mission 的策略版本不一致 = 必需级缺口，列出 ≤5 个 mission 与改动的信任根文件）；
  `legacy`（本机制引入前批准的 mission）按 `explicit` 兼容处理，并在报告里作为**事实**陈述。

### 验证

- `bash scripts/verify.sh`：**944 测试 / 943 通过 / 0 失败 / 1 如实跳过**（含 OPS SELFTEST GREEN）。
- `scripts/e2e-mission.sh`：**E2E GREEN，15/15 插件**，且真机会话里确认 mandate 已落盘
  （`strength: explicit`、`scope.paths` 来自规格、`policyVersion` 为空信任根的既定值）。

## [0.4.0] — 2026-10-30

### 新增 · IM 交互通道（可选，基于 `dsh-chat-interaction` v0.3.0）

规格送审、部署 go/no-go、上线后验证这些"要人拍板"的环节，现在可以在**飞书/企微**里回答，
前提是宿主挂了 `dsh-chat-interaction` 且它暴露 `chatInteraction.api`（`apiVersion >= 1`）。

- **挂载条件**：`api.apiVersion >= 1`；服务缺席、版本过旧、对象不完整或访问抛错 = 没有 IM 通道，`apply` 照常完成。
- **`im.channel`（宿主键）三档**：`auto`（默认：有则用、无则本地）/ `off`（**永不触碰**该服务，逐字节等于旧行为）/
  `required`（必须存在，缺席时在 apply 阶段明确拒绝并给出安装指引）。
- **只做路由**：连接/去重/卡片/等待/按钮一次性 token 由官方插件负责；本套件保留**自己的问题身份**（`q-<128bit>` 台账 token），
  一次回答只消费一次——重放的点击或重复回答得到 `unknown-token`。
- **失败关闭**：`timeout` / `aborted` / `send-failed` / `channel-unsupported` / `internal` 映射为
  `timeout`/`cancelled`/`refused:<原因>` 并写台账；**超时不是同意**，门禁读不到"允许"。出站文本仍走既有脱敏。
- 现状可见：`interaction` 注册表的描述/问题列表会显示 IM 通道是否已挂载、未挂载时为什么——"没配置"是一个**被陈述的事实**，不是空白。

### 验证

- `bash scripts/verify.sh`：**911 测试 / 910 通过 / 0 失败 / 1 如实跳过**（含 OPS SELFTEST GREEN）。
- 说明：IM 通道目前是**用假 `chatInteraction` 做的单元级验证**（注册条件、卡片选项映射、一次性 token、重放拒绝、
  失败关闭、脱敏）；**尚未对真实飞书/企微渠道做端到端验证**（需要凭证与真实会话）。

## [0.3.1] — 2026-10-19

### 兼容 · harness 0.2.1-rc.1 / rc.2

- **核实改动**：`rc.1 → rc.2` 为常规 rc 递增（新增 `dsh-client-ui-deepseek-model-label-1017`、`dsh-web-deepseek-api`
  两个 UI/web 包；295 个包版本号前移）。本套件依赖的 7 项契约**全部未变**（逐项复核，见 `docs/VERIFICATION.md`）。
- **验证**：0 类型错误；**903 测试 / 902 通过 / 0 失败 / 1 如实跳过**；**E2E GREEN 且 15/15 插件挂载**（在真机 0.2.1-rc.2 上）。
- **修正文档与实现的漂移**：文档此前写 `>=0.2.0-rc.1 <0.2.1-0`，而 manifest 实际声明 `<0.2.2`——后者更松，
  且在 `includePrerelease` 下会放进**未验证的 `0.2.2-rc.1`**。现统一为 `>=0.2.0-rc.1 <0.2.2-0`：
  接受 0.2.0/0.2.1 两条线（含预发布），拒绝 0.2.2 的任何预发布。历史条目不改写，仅在新记录里标注。

## [0.3.0] — 2026-10-12

### 新增 · 项目知识库（`dsh-knowledge-base`，第 15 个插件）

把项目的**需求、决策、交付台账、文档与代码**整理成本地知识库，让 dsh 里的大模型能回答项目相关问题。
设计的核心是把问题拆成两半：**检索必须确定性、可引用**；**回答由模型做，但每个论断都要带引用**。

- **六类来源**：`spec`（`.dsh/specs/*.md`：需求/验收标准/测试设计原文）、`adr`（决策与备选）、
  `trail`（每个 mission **一条摘要** + 每条发布：读 store，不手解 `mission.json`）、`plan`（`.dsh/plan.jsonl`、`releases.jsonl`）、
  `docs`（仓库自己的 markdown）、`code`（源码：文件 + **符号表** + 分块正文）。
- **工具**：`kb_index({force?,only?})`（逐来源文档/块数 + **每个跳过文件的原因** + 指纹；未改动时明说"索引已是最新，未变"且不重写任何文件）、
  `kb_search({query,limit?,kinds?,pathPrefix?,missionId?})`（命中带 `路径:起-止`、片段、分数与**命中原因**）、
  `kb_status()`（覆盖/跳过/新鲜度 + "它是什么不是什么"）。
- **确定性**：分块 id 内容寻址（`docId:from-to`，**无时间戳**）；三个产物原子写且 **manifest 最后写**（提交点），
  `postings.json` 携带它由之构建的 chunks 摘要（不一致即拒绝作答）。未改动仓库两次重建 → `chunks.jsonl`/`postings.json`
  **逐字节相同**，只有 `builtAt` 变（有测试断言）。
- **检索**：ASCII 小写化 + 最小长度；CJK **重叠二元组**；**BM25**（k1=1.2、b=0.75、IDF 标准式）+
  字段加权折进词频（标题 3 / 符号 2 / 正文 1）+ **精确 ID 加成**（点名 `AC-003`/`R-7`/`ADR-0002`/`GATE-…` 能命中，
  且优先返回**定义处**而不是台账里的清单行）。
- **fail-closed**：无索引 → 拒绝并点名 `kb_index`；索引相对当前 git 指纹**陈旧** → 报告开头告警（"可能漏掉最近的改动"）而不是默默回答；
  跳过的文件（二进制/超大/不可读/语言不支持）逐个列名；**不做**嵌入/向量库/网络/模型调用，也不索引审计行与 git 历史。
- **索引是运行时产物**（`.dsh/kb/`）：医生与脚手架都已把它纳入"必须被 git 忽略"的清单——否则每次重建索引都会弄脏工作区，
  交付时的 `requireCleanTree` 会报指纹不一致。

### 修复 · 索引把自己判成过期（`dsh-knowledge-base`，真机抓出）

建索引会写出 `.dsh/kb/`；在一个 `.gitignore` 早于该目录的仓库里这就是未跟踪改动，于是**指纹在"建"与"比"之间变了**，
`kb_search` 会对它刚建好的索引告警（真机报告是自相矛盾的"工作区改动数从 0 变成 0"）。根因是 `gitFingerprint` 的
`excludePaths` **只过滤 `changedFiles`**（`dirty` 与无 pathspec 的 `git diff HEAD` 摘要不受影响），而它在 7 个包里有 21 处调用，
改它不 additive；因此排除放在本包自己的 `indexFingerprint(cwd, indexDir)` 里，交给 git 的 pathspec
（`:(top,exclude,literal)<dir>`，且必须 `-uall`——否则未跟踪目录被折叠成一行 `?? .dsh/`，产物又从父目录溜回来）。
四条回归测试，每条在旧行为上失败；除新鲜度那两行外工具输出逐字节不变。

### 修复 · 覆盖范围也是索引身份（`dsh-knowledge-base`）

同一类问题的第二个实例：构建只比较"内容字节 + 指纹"，于是**请求的范围**与 manifest 记录不一致时（例如先全量、再
`only:['docs']`、再全量），排除的来源恰好没有文档的话就报 `unchanged` 且不写盘——"对局部索引发起的全量请求"静默保持局部，
而 `kb_status` 一边说 `spec：**不在本次索引里**` 一边说 `文档/块：13 篇 / 13 块`。`ChangeKind` 新增 **`coverage`**，
优先级显式定义并断言：`created > coverage > content > postings > forced > fingerprint > unchanged`；
`artifactsWritten` 区分"范围变了且文档真的动了"与"范围变了但没有文档动"（只改写 manifest）。
`kb_status` 现在**从产物读覆盖范围**：某来源在磁盘上有 chunks 而 manifest 无记录时，明确写"manifest 与产物不一致，以产物为准"并给出重跑 `kb_index`。
七条测试（六条在修复前失败）。

### 新增 · 人/CI 入口与 `/kb` 命令

- **`bash scripts/kb.sh index|search|status [<repo>]`**：与插件共用同一份实现（建索引/加载/打分都从包内模块导入，
  不复制逻辑），真机在两个真实仓库上跑过（本仓库 468 文档 / 2 794 块；`golang/im` 含 spec/trail 来源）；
- **`/kb index|search|status|help`**：官方 `dsh-commands` 的**人类命令**（直接对 agent 执行、**不产生模型消息、不花 token**）。
  只通过 `ctx.get('commands')` 注册（**不加进 `inject`**，宿主没装该插件时本插件照常加载）；渲染抽到共享的 `report.ts`，
  且命令调用与工具**完全相同**的操作——有测试断言"命令输出与工具输出逐字节相同"。

### 运维

- 运行时忽略规则补齐到**你的其他真实仓库**：扫描所有带 `.dsh/` 台账的工作区，发现 `deepseek/dsh-memory` 缺
  `.dsh/missions`、`.dsh/state`、`.dsh/specs` **与新的 `.dsh/kb`**——同一个坑晚了一个目录（未忽略的台账会让每次门禁都弄脏工作区，
  交付时 `requireCleanTree` 报两个不同指纹）。已补齐并逐个 `git check-ignore` 确认；配置类文件仍被跟踪（信任根）。

### 验证

- `bash scripts/verify.sh`：**903 测试 / 902 通过 / 0 失败 / 1 如实跳过**（含 OPS SELFTEST GREEN）。
- `scripts/e2e-mission.sh`：**E2E GREEN，15/15 插件**挂载并跑完一条真实 mission。
- 真机验收：`golang/im` 上"改一个被跟踪但未被索引的文件 → 检索报陈旧 → 非 force 重跑 index → 警告消失"这条用户路径逐步验过。

### 已知边界（明确留下，未修）

- 记录的覆盖范围只比较**来源 id**：项目配置删掉一个**本来没匹配到文件**的 glob 仍报 `unchanged`；
- 由 `only` 排除的来源，提示文案仍是既有的 `已在配置里停用（enabled=false）`；
- `/kb` 目前只有单元测试层证据（命令文本与工具文本逐字节一致、注册与降级行为），**尚未在 nvim-tui 里真敲过**。

### 修复

- `scripts/e2e-mission.sh` 的成功文案从 `SUITE` 计数派生（此前硬编码"the fourteen plugins"，加了第 15 个插件后就与实际不符——
  挂载断言一直是动态的，只有这句文案漂移了）。

### 验证

- `bash scripts/verify.sh`：**881 测试 / 880 通过 / 0 失败 / 1 如实跳过**（含 OPS SELFTEST GREEN）。
- `scripts/e2e-mission.sh`：**E2E GREEN**，**15/15** 插件挂载并跑完一条 mission。

## [0.2.3] — 2026-09-30

### 新增 · 交付度量（`orchestrate({ action: 'metrics' })`）

没有任何东西回答"交付到底怎么样"，而台账里其实什么都有。现在一次调用给出：

- **lead time**（创建 → 首个回执）与**审批等待**（创建 → 规格审批）：中位数 + p90，**写明分位方法**（linear interpolation, R-7），每行都带**样本量**（n=1 标"单样本"，n=0 说"没有数据：<原因>"）；
- **门禁失败率**：交付前最后一次门禁 ≠ PASS（WARN 也算），BLOCK 原因**按 source 归组**；"交付前完全没有门禁记录"单独计数，**不冒充 PASS、不缩小分母**；
- **部署失败率与回滚**：按环境配对（同一失败的回滚只算一次，失败率永不 >100%），无部署台账时明说"无部署台账"而不是报 0；
- **在飞**（无回执的 mission，最老在前，截断会报告）与**最近发布**；
- 缺口（台账缺失 / JSONL 末行撕裂 / 未知 state）一律降级为**有名字的缺口**，绝不变成看起来像测量值的 0。只读、不写任何文件；宿主级配置 `metrics.windowDays`（默认 90 天，被排除的数量会报告）。

### 修复 · 真机验证抓出的两个 bug（`dsh-impact-gate`）

- **无变更的轮次会静默复用上一轮的记录**：服务只在"有变更的轮"追加 `workspace/changes` 记录，于是同一会话里的后一次分析会把第 1 轮的改动逐字当成第 3 轮的。现在记录被使用后**标记已消费**，遇到已消费的最新记录就**回退 git 并说明原因**（"不用旧记录冒充本轮"）；新记录到达后照常使用。
- **同秒两次分析写同一个工件**：`stamp()` 是秒级，第二次分析覆盖第一次的 `impact/<stamp>.json`，而**两条证据行都指向那一个路径**。现在工件名唯一化，并有断言要求两条证据行指向**不同**工件。

### 修复 · 自检的两个假警报（`doctor`）

- `make test` 这类**包装命令**不被认作测试命令（旧启发式只认工具链二进制）→ 已扩到 make/gradle/dotnet/脚本包装；且"有命令但认不出是测试"降级为**建议**，"命令列表为空"才是必需缺口；
- **非 git 工作区**被要求补 `.gitignore` 运行时规则——那条规则在那里**不适用**（没有指纹就没有 `requireCleanTree` 冲突），现在如实写"不适用"并说明失去指纹保护，而不是当成阻塞项。

### 验证 · 官方 `workspaceChanges` 采纳路径真机跑通

在隔离安装的 **0.2.0-rc.2**（289 包，含 `dsh-workspace-changes`）上，用官方 **SDK stdio profile + 脚本化 JSON-RPC 客户端**跑出真实多轮：报告给出
`变更来源：workspaceChanges（会话 … 第 1 轮，事件 seq=46）`，工件 `added=[[1,1],[6,9]], removed=1` 与 `git diff -U0`（numstat `5 1`）**逐语义一致**，
`changeSource` 块（turn/granularity/limits/crossCheck）落盘，交叉核对**确实触发**（一致变体）；固化为 `changeSource: 'git'` 时，已挂载的服务**完全不被使用**。

### 运维

- 两个真实 Go 仓库补齐必填门禁配置：`golang/im`（运行时忽略 + 必填证据类型；其 Makefile 早已把 Go 缓存指到仓库内）、
  `golang/spider`（不是 git 仓库；门禁用 `env GOCACHE=<绝对路径> go test/vet`——沙箱会拒绝 Go 默认缓存，已当场验证退出码 0）。

### 验证

- `bash scripts/verify.sh`：**850 测试 / 849 通过 / 0 失败 / 1 如实跳过**（含 OPS SELFTEST GREEN）。
- `scripts/e2e-mission.sh`：**E2E GREEN**，14/14 插件。

## [0.2.2] — 2026-09-30

**已在 harness `0.2.0-rc.2` 上完成全量验证：零代码改动。** 这一版是"验证 + 文档"的发布，理由值得写清楚：
同一 0.2.0 线的 peer 范围 `>=0.2.0-rc.1 <0.2.1-0` **本来就匹配 rc.2**（同时匹配 0.2.0 正式版），
所以宿主升 rc 不需要重发插件——这是放弃精确锁版换来的，也应当被记录成一次"无需改动"的证据。

### 验证

- 15 个包在 rc.2 上类型编译 **0 错误**；`bash scripts/verify.sh` **830 测试 / 829 通过 / 0 失败 / 1 如实跳过**
  （含 OPS SELFTEST GREEN）；`scripts/e2e-mission.sh` 在**真机安装的 rc.2** 上 **E2E GREEN**，14/14 插件挂载并跑完一条 mission。
- 依赖的契约逐条复核（非假设）：`ApprovalOutcome` 仍四个字符串；"每个生产者声明自己的 kind、无 `plugin` 兜底"仍在；
  单调守卫语义（"no guard can force-allow"）仍在；`run_code` 仍由 `dsh-tools` 的 `config.mode` 门控（默认 `native`）；
  PTC 仍走 `prepareScheduledExecution → prepareExecution`（我们的守卫仍在链上）。

### 文档 · 官方能力缺席时的行为

- **实测降级**：真机 profile 是 **250 包的基础安装**，不含 `dsh-workspace-changes` / `dsh-experimental-agent-team` /
  `dsh-experimental-auto-review` / `dsh-ptc-runtime(-node)` / `dsh-workflow-ptc`（完整安装为 289 包）。
  两个新集成按设计显式退化并说明原因：`impact_analyze` 报
  `变更来源：git（回退：宿主没有挂载 workspaceChanges 服务…）`，`role-guard` 记 `agentTeams=absent`；
  不报错、不静默改变语义。
- `docs/VERIFICATION.md` 基线 → rc.2，并新增本次适配记录（含上面的实测数据与 250/289 对比）；
- `UPGRADE §1.8` 说明"升到 rc.2 不需要改任何声明"，以及**官方能力是可选包**——要用需显式装进 profile
  （`dsh-base` 的 patch 声明了 PTC 两行，但缺包不会自动补）。

## [0.2.1] — 2026-09-29

### 兼容与组合（官方 0.2.0 能力的采纳边界）

- **采纳**：`impact-gate` 的变更事实改用官方 `workspaceChanges`（`changeSource: 'auto' | 'workspaceChanges' | 'git'`，宿主键）。
  语义是**按轮**的：靠 `workspace/changes` 事件的 `seq` 定位、无变更的轮不产生事件、记录随会话消失。输出与工件**处处标注来源**
  （`workspaceChanges（会话 … 第 N 轮）` / `git` / `git（回退：<原因>）`）；不可用一律回退 git 并说明原因；
  与 `git diff <base>` 不一致时打印 ⚠️ 交叉核对（报告，不作为裁决）；二进制/超大文件只有路径与计数、重命名的旧路径
  无法从该服务恢复——都作为**明写的限制**而不是补出来的假数据。
- **互补（官方 spawn 对我们不可用，实测）**：官方 Agent Teams 的 `SpawnTeammateRequest` 只有
  `{name,description,prompt,context,provider,signal}`，无法表达 persona 影子段 / 工具白名单 / 模型路由 / 深度上限；
  而每个可加载角色都必须有 persona ⇒ 官方路径表达不了任何角色的策略。`role-guard` 因此**点名拒绝** `dispatch: 'team'`、
  回落自研 `subagents` 路径，并把官方创建出的 teammate 记为 **ungoverned**（`.dsh/state/teammates/<id>.json`）——
  刻意**不**声称"已阻止"：工具守卫只覆盖模型面的 `spawn_teammate`，插件直接调服务即可绕过。新增宿主键
  `composeWithAgentTeams: 'auto' | 'off'`（`off` 逐字段等于旧行为）。
- **不采纳**：官方 `auto-review` 不得接管授权。代码级核实它只返回 `deny` / `ask` / `cancel`，**从不 `allow`**；
  我们的强制拦截又是**单调守卫**（"任何守卫都可以拒绝，但没有任何守卫能强制放行"）。挂上它的后果是更严 + 更多问人 +
  更多 LLM 调用，不是绕过门禁——但它仍**不是**授权依据。
- **PTC 真机验证 + 量化**：`run_code` 只在 `dsh-tools` 的 `config.mode: 'ptc'` 下可见（默认 `native`）。打开后，
  PTC 程序里的 `await tools.write({...})` 被 spec-gate 拒绝（审计留下**子调用自己的两行**，拒绝原文与下一步提示都在），
  文件未被创建，拒绝作为程序错误传回。代价：1 次 `run_code` + 1 个子调用 = 4 行审计——治理预算要预期这个放大系数。
- **文档**：`ARCHITECTURE §5.16`（官方 vs 自研的采纳边界与守卫机制）、`UPGRADE` 的"采纳 / 不采纳"清单。

### 验证

- `bash scripts/verify.sh`：**830 测试 / 829 通过 / 0 失败 / 1 如实跳过**（含 OPS SELFTEST GREEN）。
- `scripts/e2e-mission.sh`：**E2E GREEN**，14/14 插件在 `@deepseek-ai/dsh-*` **0.2.0-rc.1** 上完成一条真实 mission。

## [0.2.0] — 2026-09-29

### 兼容基线

声明并验证于 `@deepseek-ai/dsh-*` **0.2.0-rc.1**（cordis `~4.0.4`）；peer 用同一 0.2.0 线的范围
`>=0.2.0-rc.1 <0.2.1-0`。相比 0.1.7-rc.2，本轮**只有 peer 范围必须改**：15 个包零编译错误，审批四词契约、
消息来源 kind 规则、委派策略捕获与 Messages 协议都未变（详见 UPGRADE §1.6）。

### 内容

按 **六阶段（规划 / 实现 / 测试 / 交互 / 交付 / 部署）** 补齐套件：v0.1.0 覆盖了前四段中的三段半，
这一轮把**交互**与**部署**两段补上，并把"还缺什么"做成一个可回答的问题。

### 新增 · 插件（3）

| 插件 | 阶段 | 职责 | 工具 |
|---|---|---|---|
| `dsh-interaction-gate` | 交互 | 统一 ask / notify / progress；**通道可插拔**（IM 插件注册一个 channel 即可）；一次性 token；项目级审批人名单；决定台账；超时 fail-closed | `interaction_ask`、`interaction_notify`、`interaction_progress`、`interaction_status` |
| `dsh-suite-doctor` | 入口 | 一个工具回答"我们在哪、缺什么"：18 项配置/台账检查 + 运行时事实（插件挂载、阶段、待审批、通道能力）；每条发现带下一步命令 | `suite_status` |
| `dsh-deploy-gate` | 部署 | 环境清单 → go/no-go → 人工批准（生产默认要）→ argv 执行 → 上线后验证（有限重试）→ 回滚；部署台账记 revision/审批人/门禁 | `deploy_plan`、`deploy_run`、`deploy_verify`、`deploy_rollback`、`deploy_status` |

### 新增 · 机制

- **自检引擎**（`dsh-eng-core` 的 `checkWorkspace`/`renderDoctor` + `scripts/doctor.sh`）：离线可判定的部分（配置、台账、指纹陷阱、规模）与运行时事实合并成一份报告；**读不到就说 `unknown`，绝不算通过**；每条发现都给确切命令。
- **部署门禁**：编排器新增 `deploy-go` / `deploy-verified` 两种门禁种类（同一来源、最新一条必须 PASS、不早于阶段进入——与规范门禁同一套 fail-closed 规则）。**不进默认流水线**：多数 mission 不部署。
- **台账归档**（`archiveMissions` + `scripts/archive-missions.sh`）：把旧的**已交付** mission 移到 `.dsh/archive/<年-月>/`，写索引，仍可反查；未交付默认不动；只搬不删；目标冲突拒绝合并。
- **粒度忽略规则**：运行时（missions/audit/state/specs、已存在的根级 `*.jsonl`）必须被 git 忽略，配置类文件（`.dsh/*.json`、`roles/`）**不能**——否则 `requireCleanTree` 会把"每次门禁都改动工作区"报成两个不同的 diff 摘要。脚手架会自动补上正确的行，且幂等。
- **部署/交互的配置骨架**：`project-config.sh --interaction on --deploy on`；deploy 骨架默认 `environments: []`（未声明就拒绝部署）。

### 新增 · 测试有效性（P4）

- **变异测试**（`coverage-gate` 的 `mutation_check`）：16 个词法操作符，逐个变异 → 跑测试 → **按字节还原**；
  killed / survived / **run-error** 三分类，run-error 绝不算 killed 也不进分母；得分公式与两个数字一起打印；
  预算与抽样截断时如实标注"部分结果"，绝不分外推。
- **指标预算**（`quality-gate` 的 `budget_check`）：命令耗时或正则提取的数字；绝对上下限 + `maxRegressionPercent`
  对比历史最好值（点名那个值与时间）；首次运行只记录基线并如实说明"还没有数据"。
- **契约冒烟**（`quality-gate` 的 `contract_check`）：逐条断言退出码/stdout/JSON 路径（路径缺失 = 失败，不是跳过）。
- **flaky 隔离计划**（`impact-gate` 的 `flaky_plan`/`flaky_status`）：分类 + 必须有 owner 与到期时间 + 过期升级 +
  "隔离后长期未出现"提醒。
- **非功能预算进规格**：`spec_create`/`spec_amend` 接受 `budgets[]`（p95/包体积/迁移耗时…），
  随规格一起**审批**、渲染进 `## 非功能预算` 表、可关联 `requirementIds`；`spec_amend` 支持整组重声明与
  单条增改（删除作废、编号不复用）；`plan_status`/`spec_status` 显示"已验证/未验证"。
  宿主配置与规格同 id 时**宿主生效但差异被报告**（两个值都写出来）；`requireSpecBudgets`（宿主键，默认关）
  让"声明了却没验证"的预算拦住交付。
- **自检同步**：`suite_status`/`doctor.sh` 新增五项配置检查（变异/预算/契约/flaky/规格预算），未配置时如实说明"可选"。

### 修复

- **辅助裁决不得授权交付**：`budget_check`/`contract_check` 记录门禁时用 `scope.full=false`、不清 `pendingWrites`、
  reason 带前缀——否则"source 撞车 + full=true"能在没跑过宿主命令集的情况下授权交付（P4 实现时发现并固化）。
- `scripts/doctor.mjs` 的参数解析：`--json <path>` 时路径被忽略、结果报的是当前目录（看起来像"目标仓库是空的"）。
- 目录型忽略规则必须用尾斜杠查询，文件则不能带尾斜杠（两个 bug 都是在真实仓库上抓到的，不是测试里）。
- `.dsh/media/` 等只在对应插件被使用后才存在的运行时目录，改为"存在才要求忽略"（避免给每个仓库塞无效规则）。

## [0.1.0] — 2026-09-28

首个发布（v0.1.0）：11 个插件 + 1 个共享库，`verify.sh` 全绿、真机 harness 端到端可复现（11 个插件全部挂载）。
每条能力与修复都有对应的回归测试。

### 新增 · 插件（11）

| 插件 | 职责 | 主要工具 |
|---|---|---|
| `dsh-eng-core`（库） | mission 工件、确定性命令执行、git 指纹、审计 JSONL、日志、扫描器、指标、变更影响、审批契约、fake host | — |
| `dsh-role-guard` | 角色文件（persona/模型/工具/技能白名单）、最小权限派发、结构化评审服务 | `team_delegate`、`role_list` |
| `dsh-spec-gate` | 结构化规格 + 人工审批 + 写操作前置拦截 + **需求增改删** + 存量仓库规格接入 | `spec_create`、`spec_approve`、`spec_amend`、`spec_status`、`spec_bootstrap` |
| `dsh-test-design-gate` | 测试设计评审（覆盖度/三类场景/可执行性/悬挂用例） | `test_design_review`、`test_design_template` |
| `dsh-quality-gate` | 宿主配置命令的三态门禁、覆盖范围、写后 lint 回路、收尾阻断 | `quality_gate_run`、`quality_gate_status` |
| `dsh-evidence-gate` | Mission → Evidence → Gate → Receipt、fail-closed 交付清单、伪造检测 | `evidence_record`、`evidence_status`、`mission_complete` |
| `dsh-audit-trail` | 全量工具调用 JSONL、写前快照、按轮次回滚、符号链接与"回滚点后被改"保护 | `audit_report`、`audit_rewind` |
| `dsh-orchestrator` | 阶段流水线、入口/出口门禁、回退、熔断、断点恢复、**按难度选模型**、**阶段自主派发** | `orchestrate` |
| `dsh-standards-gate` | 代码规范门禁：仓库自有阈值、**基线棘轮**、度量明细、只读结构评审 | `standards_check`、`standards_bootstrap`、`standards_review`、`standards_status` |
| `dsh-impact-gate` | 变更影响分析：反向依赖闭包、最小回归测试集、风险分级 | `impact_analyze`、`impact_tests`、`impact_status` |
| `dsh-coverage-gate` | 测试有效性：四种覆盖率格式、**增量覆盖率**、flaky 检测 | `coverage_check`、`flaky_check`、`coverage_status` |
| `dsh-supply-chain-gate` | 密钥扫描（分级 + 脱敏）、新增依赖人工审批、依赖审计 | `secret_scan`、`dependency_audit`、`supply_chain_status` |

### 新增 · 机制

- **审批接缝**：所有"需要人点头"的动作走同一个 `ctx.get('approval').request(...)`；套件侧的规范化
  函数接受"四个字符串"与可选溯源对象，无法识别一律 `unavailable`（fail closed）。理由里可嵌
  ```approval-context``` 块供 IM/卡片渲染字段。
- **交付人工审批**（opt-in `requireDeliveryApproval`，默认关）：确定性清单全绿之后才问人，
  回执里带审批人与来源（进摘要，不能换人重签）。
- **规范棘轮**：基线记录"接受时有多大"，同一条违规变大即失败；已消除的自动收紧；
  放宽必须人工批准（`.dsh/**` 在信任根内）。
- **变更影响**：Go 的包目录 import、TS 相对路径、Python 包都会被解析成图；重命名同时跟随旧路径；
  判不出来的一律写明（接口分派、DI、反射、字符串查表）。
- **门禁证据**：门禁记录带 `scope`、工作区指纹；交付要求"最新一条 PASS 且不早于最新 command/test 证据"，
  手写 `gates/*.json` 视为伪造。

### 修复（对抗式审计与真机发现的真缺陷）

- **信任根是词法判定** → 工作区里的符号链接可绕过 `.dsh/**` 保护：改为按 `realpath` 判定。
- **`standards-pass` 取"最新 PASS"** → 先 PASS 后 BLOCK 仍放行；同毫秒判为新鲜：改为"最新一条必须是 PASS"，
  同毫秒按陈旧处理（与 `quality-pass` 一致）。
- **伪造的规范门禁**能被交付接受：补台账行（`kind: 'gate'` + `data.gateId`）校验。
- **度量：无花括号的单行 `if` 吞掉后面的块**（本仓库凭空报出 349 行的 `if` 块；50 条违规里 20 条是幻觉）、
  真块被首字符过滤与 300 字符窗口漏掉、Go 导出面漏统计、TS 泛型函数整体消失、括号包裹箭头幻影参数：
  按语言解析 + 用 `go/ast` 与 TypeScript 编译器 API 对账（修后与 oracle 完全一致）。
- **棘轮不带量级、已消除的 key 永久保留、账本与文字不一致**（`accept` 打印 PASS 却不写记录、
  `enforce: warn` 记 BLOCK）：全部修正并补回归。
- **项目级覆盖会重置未列字段**（把宿主 60s 超时放大成 600s）：改为逐键覆盖 + 校验。
- **密钥扫描噪声**（真实仓库 120 文件 461 条命中，多为文档 base64）：按 severity 分级，
  只有已知凭据形状阻断；熵检测按上下文降为建议级（复测阻断级 0 命中）。
- 多个 flaky（时间容差、门禁新鲜度同毫秒、`isError` 与文本拒绝混用等）修正并补测试。

### 变更 · 兼容基线（harness `>=0.1.7-rc.2 <0.1.8-0`）

- `peerDependencies` 从 `^0.1.5-rc.2` 改为**精确锁版** `0.1.7-rc.1`（cordis `~4.0.4`）：semver 规定带预发布的
  `^0.1.x-rc.y` 不匹配 `0.1.7-rc.1`，用范围会导致 `dsh plugin add` 报 peer 不满足。
- **消息来源 kind**：0.1.7 移除了共享的 `plugin` kind（每个生产者声明自己的）→ 新增
  `dsh-orchestrator/src/sources.ts`、`dsh-quality-gate/src/sources.ts`。
- **DeepSeek provider 换成 Messages 协议**（`POST /messages`、帧带 `type`、无 `[DONE]`）→
  `scripts/stub-llm.mjs` 按新协议重写，端到端验证重新可用。
- **0.1.7-rc.2：peer 版本在加载时被强制校验**（`dsh-app-boot`），锁 `0.1.7-rc.1` 的插件会被整包跳过
  （真机：11 个插件 0 挂载、工具变 `unknown tool`、端到端全红）。声明改为同一 0.1.7 线的范围
  `>=0.1.7-rc.2 <0.1.8-0`（实测真值表见 UPGRADE），同线 rc 增量自动跟随、跨 minor 必须重新验证。
- `scripts/stub-llm.mjs` 新增 `STUB_DUMP_DIR`：把每个请求体落盘，协议漂移时以原始 body 为准排查。
- 详见 [UPGRADE.md](./UPGRADE.md)。

### 验证

- `bash scripts/verify.sh`：**498 个测试 / 497 通过 / 0 失败 / 1 如实跳过**（12 个包 + 跨包集成）。
- `bash scripts/e2e-mission.sh`：**E2E GREEN**，11 个插件在真实 harness 里全部 `applied` 并跑完一条 mission。
- 真机额外校准：`golang/im`（113 个 Go 文件、1522 条导入边）与 `golang/spider` 上验证影响分析、
  目标阈值下的规范违规量、真实 `go test -coverprofile` 的覆盖率解析与增量判定。

[0.1.0]: https://github.com/kovey/dsh-engineering-suite/releases/tag/v0.1.0
