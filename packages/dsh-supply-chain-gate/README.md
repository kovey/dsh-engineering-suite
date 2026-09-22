# dsh-supply-chain-gate

**供应链与密钥门禁**：回答所有门禁里最前面的那个问题——**"这东西到底能不能发出去"**。

其他门禁分别回答"能不能跑"（`dsh-quality-gate`）、"做的是不是对的"（`dsh-spec-gate`/`dsh-test-design-gate`）、
"能不能证明"（`dsh-evidence-gate`）、"还可维护吗"（`dsh-standards-gate`）。这个插件管三件它们都不管的事：

| 问题 | 判定 |
|---|---|
| 这次改动有没有把密钥写进去？ | 规则（11 条）+ 熵检测，**默认只看新增行**；命中即 BLOCK |
| 有没有未经人确认的新依赖？ | 清单 diff 找出**新增声明**，一次列出全部送人工批准；拒绝/通道不可用 = BLOCK |
| 锁文件有没有"没有声明依据"的变化？ | 锁文件变了而它的声明文件没变 = BLOCK（那正是"悄悄钉一个版本"的形状） |
| 已知漏洞？ | 跑宿主配置的审计命令，按 severity 名单 BLOCK/WARN；**看不懂的报告一律 BLOCK** |
| 这个依赖是否可信、许可证是否合适？ | **不判**——见下面的"诚实的边界" |

## 严重度分级：为什么熵检测默认不阻断（真机实测）

第一版"任何命中即 BLOCK"，在真实仓库上直接不可用：

| 仓库 | 扫描文件 | 命中（初版全部阻断） | 其中阻断级（修复后） |
|---|---|---|---|
| `golang/im` | 120 | **461**（几乎全是 README/文档里的 base64） | **0**（461 info + 7 medium） |
| `golang/spider` | 29 | 21（README base64） | **0**（21 info） |

一个会对文档报警的门禁，一天之内就会被人关掉——那样它什么都没保护。所以：

- **只有已知凭据形状阻断**（`critical`/`high`：AWS/GitHub/Slack/OpenAI/DeepSeek/Google、PEM 私钥块、JWT）；
- **`high-entropy-string` 按上下文分级**：出现在密钥语义的键值/`Authorization: Bearer`/凭据文件里 → `low`（建议）；
  否则 → `info`（仅提示）。文档里的 base64 属于后者；
- **`generic-secret-assignment` → `medium`**（默认不阻断）：它命中测试夹具（`password = "wrong-1"` 这类
  7 字符占位符现在直接不报）；真实的赋值仍会被报告；
- `secretScan.blockSeverities` 可改（默认 `["critical","high"]`）；**空数组会被拒绝**——
  "什么都不阻断"必须由宿主显式写 `enabled: false`，不能是打错字的产物；
- 规则里 `:?=` 同时接受 `=` 与 Go 的 `:=`（真实 Go 仓库里后者才是常见写法，第一版漏掉了）；
- **熵值本身不是判别器**（实测：英文句子 4.39 > base64 图片片段 4.15 > 斜杠单词表 4.16 > sha256 十六进制 3.94），
  所以这条规则只做建议级，另加一个**结构性过滤**：`AWS/GitHub/Slack/...` 这种"全是字母的斜杠/短横线分段"判为文档而非凭据。
  真正的判别靠已知形状与上下文，不靠一个阈值。

> **本仓库的测试夹具在运行时拼装**（`fake('AKIA', 'IOSFODNN7EXAMPLE')`）：把真实形状的密钥字面量写进文件会被
> GitHub push protection 拦下（本插件的第一次提交就被拦了），也会污染 secret scanning 面板。文件末尾有一条自检测试，
> 用本插件的规则扫描自己，确保这种字面量不会再回来。

## 三个工具

| 工具 | 作用 |
|---|---|
| `secret_scan` | 扫**本次新增行**（默认）/ 显式 `paths` 整文件 / `wholeTree: true` 整棵树（有上限）。命中 → BLOCK；报告与 artifact 里只有**脱敏摘要**（前 4 + 后 2 位 + 长度）和值的 sha256 指纹，原值不落任何地方。 |
| `dependency_audit` | ① 用 `git show <base>:<manifest>` 对比工作区，找出新增/版本变更/删除的声明依赖；② `requireApprovalForNewDeps` 开着时，**一次请求列出全部新增依赖**（一次人工决策，而不是 N 次弹窗），拒绝或审批通道不可用 → BLOCK；③ 查孤儿锁文件变更；④ 跑 `auditCommands`（argv 数组，不过 shell，带超时、听 `signal`）。**只写一条**门禁记录，状态取最差结果。 |
| `supply_chain_status` | 只读：当前生效配置（规则数、allowlist 条数、审计命令、阻断 severity）、本次 mission 最新一条 supply-chain 门禁、最新明细工件。 |

三个工具都以 `下一步：` 结尾，并且都会写 `GateRecord`（`source: dsh-supply-chain-gate`，含 `scope` 与工作区指纹）
+ 明细 artifact（`<mission>/supply-chain/<GATE-id>.json`）。

## 规则清单

| 规则 id | 严重度 | 匹配 |
|---|---|---|
| `aws-access-key-id` | critical | `AKIA[0-9A-Z]{16}` |
| `aws-secret-access-key` | critical | `aws…secret…key = "40 位"`（只认赋值形式，裸 40 位 base64 太常见） |
| `github-token` | critical | `gh[pousr]_[A-Za-z0-9]{20,}` |
| `slack-token` | critical | `xox[baprs]-…` |
| `deepseek-api-key` | critical | `sk-[a-f0-9]{32}` |
| `openai-api-key` | critical | `sk-[A-Za-z0-9]{20,}`（含 `sk-proj-` 变体：现网 key 就是这个形状） |
| `google-api-key` | high | `AIza[0-9A-Za-z\-_]{35}` |
| `private-key-block` | critical | `-----BEGIN [A-Z ]*PRIVATE KEY-----`（**只认标记行**，私钥正文不读、不存、不显示） |
| `jwt` | high | `eyJ….….` 三段式 |
| `generic-secret-assignment` | medium | `(password\|passwd\|secret\|token\|api_key)\s*[:=]\s*"…8 位以上…"` |
| `high-entropy-string` | medium | ≥20 字符且 Shannon 熵 ≥ `entropyThreshold`（默认 4.0） |

两条实现细节值得知道：

- **同一个值只报一次**：同一行的同一个值被多条规则命中时，由**更具体的规则**命名，其余记在 `alsoMatched`
  （`token = "AKIA…"` 是 `aws-access-key-id`，不是通用赋值）；熵候选若**包含**本行已被具体规则命中的值，也不再重复报。
- **占位符只对低置信规则放行**：`password = "changeme"`、`token = "${TOKEN}"`、`xxx…` 不算命中；
  但 `AKIA…`、PEM 头这类高置信形状**永远不豁免**。

## allowlist（人来写，模型改不了）

`.dsh/secret-allow.json`（路径可配）——`.dsh/**` 在 `dsh-spec-gate` 的信任根里，写工具进不去，所以模型无法给自己发豁免：

```json
{
  "entries": [
    { "rules": ["aws-access-key-id"], "paths": ["test/**"], "note": "文档里的示例值" },
    { "paths": ["internal/legacy/"], "until": "2026-12-31", "note": "存量，Q4 清理" },
    { "values": ["<sha256 指纹，就是报告里那列 hash>"], "note": "第三方测试夹具" }
  ]
}
```

- 一条条目生效 = 它写的**每个维度都匹配**（`rules` **且** `paths` **且** `values`），且 `until` 未过期；
- `paths` 支持 glob（`**/*.test.ts`）、精确路径、目录前缀（`test/` 覆盖 `test/**`）；
- `values` **只做哈希比较**：写 64 位 sha256 指纹；写明文时会在内存里哈希后比较（明文不会被本插件写入任何产物），
  但会作为问题提示你换成指纹——否则 allowlist 文件本身就成了泄露点；
- **过期 / 无法解析的 `until` / 没有任何条件的条目都不生效**，并各自报一条问题（读不懂的 allowlist 不是 allowlist）。

## 配置

profile（宿主上限）与 `<repo>/.dsh/supply-chain-gate.json`（项目级只能细化下列键）：

```yaml
- id: supply-chain-gate
  config:
    enabled: true
    logFile: '~/.dsh/supply-chain-gate.log'
    secretScan:
      enabled: true              # 宿主开关：项目级改不了
      entropyThreshold: 4.0       # 1..8（超出会被夹紧）
      maxFileBytes: 1048576       # 单文件上限（超过 = 跳过并报告）
      allowlistFile: .dsh/secret-allow.json
      scanWholeTree: false        # false = 只扫改动新增行
    deps:
      enabled: true
      requireApprovalForNewDeps: true   # 宿主开关：项目级改不了
      manifests: [go.mod, go.sum, package.json, pnpm-lock.yaml, package-lock.json, yarn.lock,
                  requirements.txt, pyproject.toml, Cargo.toml, Cargo.lock, pom.xml, build.gradle]
      auditCommands: []                 # argv 形式，不过 shell；空 = 依赖侧最多 WARN
      auditSeverities:
        block: [high, critical]
        warn: [moderate, medium, low]
    maxFiles: 4000                # 整棵树扫描的上限
    maxManifestBytes: 524288
    auditTimeoutMs: 300000
    maxOutputBytes: 262144
    prompt: { enabled: true, order: 645 }   # 640 质量 · 645 供应链 · 650 证据 · 660 编排
```

项目级可覆盖：`secretScan`（`entropyThreshold`/`maxFileBytes`/`allowlistFile`/`scanWholeTree`）、
`deps`（`manifests`/`auditCommands`/`auditSeverities`）、`maxFiles`、`maxManifestBytes`、`auditTimeoutMs`、`maxOutputBytes`。

**明确拒绝**（会记一条问题并忽略）：`enabled`、`secretScan.enabled`、`deps.enabled`（关掉门禁是宿主决定）、
`deps.requireApprovalForNewDeps`（仓库不能豁免"新依赖要人看"）、`logFile`、`logFileTemplate`、`layout`、`prompt`。
叠加是**逐字段**做的：项目文件没提到的键保持 profile 的值，不会被重置成插件默认值。

## 支持的清单与审计报告

| 类别 | 处理 |
|---|---|
| `go.mod` / `package.json` / `requirements*.txt` / `pyproject.toml`（PEP 621 + poetry）/ `Cargo.toml` | 解析出声明依赖，做 added/removed/changed |
| `go.sum` / `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` / `Cargo.lock` | **不解析**（那是传递依赖的洪流），只做孤儿变更判定 |
| `pom.xml` / `build.gradle` | 只观察：变了就报告"无法判断变了什么"（WARN），不静默放过 |
| 其他名字 | 报一条问题（不支持的清单格式），不参与判定 |
| `govulncheck`（text / JSON/JSONL）、`npm audit --json`、`pip-audit --format json`、通用 JSON 里带 severity 字段的报告 | 解析成 findings；按 `auditSeverities` 分类 |
| 短报告里的 "no vulnerabilities found" / "0 vulnerabilities" | 干净（但整段里一旦出现 `Vulnerability #`/`CVE-…`/`GHSA-…`/`"severity":` 就不认这句话） |
| 其他一切（含空输出、退出码非 0 却没有任何条目） | **problem → BLOCK** |

## 门禁语义（fail-closed 的那几条）

| 情形 | 结果 |
|---|---|
| 命中未豁免的密钥 | BLOCK |
| 一个文件都没扫到、或范围无法确定（非 git 工作区 / base 不可解析） | WARN（"没扫到"不等于"干净"） |
| 有文件因 `maxFileBytes` 或不可读被跳过、或整树遍历被 `maxFiles` 截断 | 裁决照旧，但 `scope.full=false`，报告点明覆盖不完整 |
| 新增依赖未获批 / 审批通道不可用 / 审批报错 | BLOCK |
| 锁文件变了而声明文件没变 | BLOCK |
| 审计报告无法识别、命令启动失败、超时、被 tokenizer 拒绝（含 shell 元字符） | BLOCK |
| 审计条目 severity 在 `block` 名单里 | BLOCK |
| 审计条目 severity 既不在 `block` 也不在 `warn`（含 `govulncheck`/`pip-audit` 的"报告里没有 severity"） | 报告 + 至少 WARN，**不 BLOCK**；想让它们阻断就把 `"unknown"` 加进 `block` |
| 清单没变、也没配审计命令 | WARN（"没有可判定的对象"），并说明该配什么——绝不静默 PASS |
| 清单变了但没配审计命令 | WARN（新版本是否已知漏洞无人检查） |
| 宿主把 `secretScan.enabled` / `deps.enabled` 关了 | 不产出裁决、不写记录，只说明 |
| 轮次被取消（`signal` abort） | 不构成裁决、不写记录 |

## 与套件其他插件的分工

| 插件 | 关系 |
|---|---|
| `dsh-eng-core` | `changedRanges`（"改动新增了哪些行"）、`runCommand`（argv，无 shell）、`gitFingerprint`、mission/artifact 存储 |
| `dsh-spec-gate` | 保护 `.dsh/**`：allowlist 与项目级配置模型写不了；规格里可以写"本 mission 不得新增依赖"这类可判定 AC |
| `dsh-quality-gate` | 互补：它管"命令跑不跑得绿"，本插件管"跑绿了能不能发" |
| `dsh-evidence-gate` / `dsh-orchestrator` | 交付不变式可以要求最新一条 supply-chain 门禁 PASS（含 `scope.full`） |
| `dsh-audit-trail` | 每次判定都留下 gate + artifact：谁在哪个项目、什么范围、什么结论、被豁免了什么 |

## 诚实的边界

- **规则 + 熵是网，不是证明**。一次干净的扫描只说明"没有匹配到这些模式"：拆分拼接的密钥、编码过的密钥、
  自定义格式的凭据、被 `.dsh/**`（工程痕迹，不参与扫描）或二进制文件（跳过并报告）遮住的内容都扫不到。
  所以**不要说"仓库里没有密钥"**，只能说"这次扫描没有命中"。真发现了：一律当作已泄露，先删、再去平台轮换。
- **审计命令只覆盖它自己认识的那部分生态**：`govulncheck` 只对 Go 模块可达路径报警，`npm audit` 只看 npm 生态。
  没配命令 = 依赖是否已知漏洞无人检查——门禁只会给 WARN，不会替你假装检查过。
- **pip-audit / govulncheck 的报告里没有 severity**，所以默认不 BLOCK（只报告 + WARN），这是刻意的：
  与其编一个 severity，不如把"没有严重度信息"如实标成 `unknown`，并让你显式决定是否阻断。
- **"新增依赖"看的是声明**：锁文件的传递依赖不逐个批准（那是几百条噪声），改由孤儿变更规则兜住；
  版本变更只报告、不要求批准（已知漏洞由审计命令覆盖）。
- **不判"这个依赖是否可信"**：抢注/投毒/维护者变更/许可证兼容性都不在本插件的判定范围内，
  它只回答"有没有人看过这次变化、有没有已知漏洞、有没有密钥形状的字符串"。
- 清单解析是**行/JSON 导向**的（不引入 TOML/YAML 依赖），覆盖声明依赖的那部分构造；
  超出这个范围的清单变化会被标成"未能判定"（WARN），而不是当成没变化。
