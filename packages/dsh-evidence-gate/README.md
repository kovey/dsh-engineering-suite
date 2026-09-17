## `force` 需要宿主显式开启

`mission_complete({ force: true })` 默认**不生效**：宿主的 `allowForceOverride` 为 `false` 时，
交付判定不接受任何人工放松，报告会明确写出"force=true 未被采纳"。
宿主显式设 `allowForceOverride: true` 后，`force` 也只放松"必填证据类型"这一项，
并且一定补写一条 `manual` 证据留痕——它永远不能绕过门禁本身、规格审批或陈旧性检查。

# dsh-evidence-gate

证据与交付门禁（docs.md §3.5）：把 `Mission → Evidence → Quality Gate → Receipt` 固化下来。
"完成"必须有可验证的证据；证据缺失或不确定时**默认阻断**（fail closed），只有确定性的门禁 `PASS` 才签发不可变回执。

## 工具

| 工具 | 作用 |
|---|---|
| `evidence_record` | 登记一条证据：`kind` = `command` / `test` / `artifact` / `diff` / `manual`。行内绑定当时的 Git 指纹、`sha256(output)` 与截断后的输出尾部（`maxOutputTail`）；`manual` 必须带 `note`；`gate` 不接受手工登记（由质量门禁写入）。失败的运行**照样可以登记**（有参考价值），但不会满足交付检查表——登记时会当场提示。工作区取 `session.header.cwd`，未声明时拒绝执行。 |
| `evidence_status` | 输出整条链路现状：规格审批、各类型证据计数与最新 5 条、最新门禁裁决、已签发回执，以及 `mission_complete` 的 fail-closed 检查表与下一步。**用的是与交付路径完全相同的那份检查表**（报告与判定不分裂）；未能核对的项以 ⚠️ 标注。检查表是**本工作区**（`session.header.cwd`）的生效配置，未声明工作区时拒绝执行。 |
| `mission_complete` | 验收并交付：逐项检查 mission 熔断状态 / 规格审批 / 门禁（完整、真实、覆盖最新证据）/ 必填证据（成功的行）/ 工作区指纹；全部通过才签发回执并把 mission 置为 `delivered`，否则返回 ❌ 清单且**不改状态、不写回执**。回执写在**本工作区**（`session.header.cwd`），未声明工作区时拒绝执行（绝不写进宿主目录）。 |

### mission 解析顺序（不猜）

`missionId`（显式传入）→ 本会话绑定的 mission（`spec_create` / `orchestrate start` 会绑定）→ 委派父会话的 mission（子代理从自己的 session header 继承）。

**不会**回退到"工作区里最新的 mission"：那可能是别的会话的任务，回退会让一个无关会话给别人的 mission 记证据、甚至交付它。解析不到时返回中文错误，并给出两条路：显式传 `missionId`，或用 `orchestrate start` / `spec_create` 建立并绑定 mission。

### 工作区（`session.header.cwd`）

三个工具的工作区一律取**调用会话自己声明的** `session.header.cwd`，**没有** `process.cwd()` 回退：
会话没声明工作区时，mission store、证据台账与回执都会落到宿主自己的目录——也就是**另一个项目**。
此时三个工具都直接返回中文错误（`无法确定本会话的工作区（session.header.cwd 缺失）…`），不写任何工件；
store 需要布局，所以**显式 `missionId` 也不能替代工作区**（同一个 id 在不同工作区指向不同的 mission 文件）。
与 `dsh-spec-gate` 的拒绝语义保持一致。

系统提示词章节 `eng:evidence-gate` 同样按**本次装配的调用会话**解析：`<cwd>/.dsh/evidence-gate.json` 生效的
必填类型 / 门禁来源 / `requireCleanTree` / `maxGateAgeMinutes` 会写进本次提示词（profile 只是默认值/上限，不重复罗列）；
无法确定工作区（或解析失败）时回退为 profile 文本——提示词章节**从不抛异常**。

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭后不注册任何工具与提示词。 |
| `logFile` | `~/.dsh/evidence-gate.log` | 只写文件，绝不写 stdout（`DSH_ENG_DEBUG=1` 时镜像 stderr）。 |
| `layout.rootDir` / `missionsDir` / `specsDir` | `.dsh` / `.dsh/missions` / `.dsh/specs` | 也可用扁平键 `rootDir` / `missionsDir` / `specsDir` 覆盖。 |
| `requireGate` | `true` | 是否要求存在确定性门禁记录。置 `false` 时不再校验门禁的 `scope`/`results`/台账一致性（宿主逃生舱），但仍会展示最新记录。 |
| `gateSource` | `dsh-quality-gate` | 其裁决被认可为交付依据的插件 id。 |
| `requiredEvidenceKinds` | `['command','test']` | 必填证据类型；显式传 `[]` 表示不要求类型，全是未知名字则回退默认（fail closed）。 |
| `maxOutputTail` | `2000` | 每条证据保留的输出字符数（`tail()`，含丢弃字符数提示）。 |
| `requireCleanTree` | `true` | 交付时工作区指纹必须与门禁观测时一致（比对双方都排除 `.dsh/` 台账目录）。 |
| `maxGateAgeMinutes` | `0` | `0` = 不限年龄；否则早于 N 分钟的门禁阻断。 |
| `prompt.enabled` / `prompt.order` | `true` / `650` | 系统提示词章节 `eng:evidence-gate`；章节文本按本次装配的调用会话解析（见上"工作区"）。 |

## 项目级配置（同一个 dsh 进程服务多个仓库）

一个 profile 同时服务多个仓库，所以全局的"必填证据类型"不可能对每个仓库都合适：
每个仓库可以用自己的 `.dsh/evidence-gate.json` 细化**自己**的交付检查表，profile 永远是**上限**。

```json
{
  "requiredEvidenceKinds": ["artifact"],
  "requireCleanTree": false,
  "maxGateAgeMinutes": 30
}
```

| 可覆盖键 | 类型 | 映射到 |
|---|---|---|
| `requiredEvidenceKinds` | `('command'\|'test'\|'artifact'\|'diff'\|'manual')[]` | `requiredEvidenceKinds`（未知名字**丢弃并记问题**；`'gate'` 永不接受——gate 行由质量门禁自己写入，模型无法登记；全数组都不可用时**回退 profile**，绝不 fail open；显式 `[]` 表示"本仓库不要求类型"） |
| `requireCleanTree` | boolean | `requireCleanTree` |
| `requireGate` | boolean | `requireGate` |
| `gateSource` | 非空字符串 | `gateSource` |
| `maxGateAgeMinutes` | ≥ 0 的数字 | `maxGateAgeMinutes` |
| `maxOutputTail` | 正整数 | `maxOutputTail` |

| 不可覆盖键（写了会被忽略并记问题） | 为什么 |
|---|---|
| `enabled` | 是否加载插件是部署决策：项目文件不能把交付门禁关掉。 |
| `logFile` | 日志落盘位置是部署决策。 |
| `rootDir` / `missionsDir` / `specsDir` / `layout` | 工件（证据台账 / 门禁记录 / 回执）落在哪由宿主布局决定，项目文件不能迁移它们。 |
| `allowForceOverride` | 它决定**模型传入的** `force: true` 能否放松检查表，只能由宿主显式开启（默认 `false`）；项目文件是模型可能经 shell 改写的路径，不得打开这个逃生舱。 |
| `prompt` | 系统提示词章节属于宿主装配决策。 |

- **文件本身在信任根里**：`dsh-spec-gate` 的 guard 关闭了 `.dsh/**`（只有派生的 `specs/*.md` 可写），
  所以模型不能用 `write`/`edit` 把自己的交付检查表改松——这也是允许项目级细化的前提。
- **绝不 fail open**：文件损坏（非法 JSON / 顶层不是对象）、或某个可覆盖键类型不对（例如
  `requireCleanTree: "yes"`），该键一律**回退 profile 值**并记问题；`requiredEvidenceKinds` 里的
  未知名字与 `'gate'` 逐个丢弃并记问题，若因此一个可用类型都不剩，同样回退 profile 的类型。
- **来源可见**：`evidence_status` 会打印 `配置来源：项目级 <path>` / `配置来源：profile`，以及生效的
  `requireGate` / `requiredEvidenceKinds` / `requireCleanTree` / `maxGateAgeMinutes`。
  只有当项目文件**确实改了**某个可覆盖键时才写"项目级"——把所有键都拒绝掉（或全是坏类型）的文件
  不构成检查表的来源，会显示为 `profile` 并附上配置问题条数。
- 读取结果按 mtime+size 缓存（门禁在热路径上求值），改完文件即刻生效。

## 工件

- 证据台账（append-only）：`.dsh/missions/<mission-id>/evidence.jsonl`
- 门禁记录（只读）：`.dsh/missions/<mission-id>/gates/<gate-id>.json`
- 回执（写一次，不可覆盖）：`.dsh/missions/<mission-id>/receipts/RCP-<stamp>-<digest8>.json`
- mission 状态：`.dsh/missions/<mission-id>/mission.json`（交付后 `status: delivered`）

## 协作方式

- **dsh-spec-gate**：共用同一个 `MissionStore` 文件契约；`spec.approvedAt` 是交付的第 1 项检查，未审批规格直接阻断并提示 `spec_create → spec_approve`。
- **dsh-quality-gate**：`store.lastGate(missionId, { source: gateSource })` 是唯一授权来源；`PASS` 才放行，未跑 / `WARN` / `BLOCK` / 部分覆盖 / 伪造 / 陈旧全部阻断。门禁记录里的 `fingerprint` 供 `requireCleanTree` 比对。
- 回执绑定门禁 id、全部证据 id、规格 digest 与门禁观测的 Git 指纹，可交给 `dsh-audit-trail` 或人工追溯。

## fail-closed 语义

1. 检查顺序：mission 未熔断 → 规格审批 → 门禁存在 → `PASS` → **完整覆盖** → **执行过命令** → **台账有对应行** → 门禁严格晚于最新 `command`/`test` 证据 → 必填证据类型（成功的行）→ 工作区指纹；任一项失败即整体拒绝。
2. **成功语义（presence ≠ success）**：只有同时满足 `exitCode === 0`、有非空 `command`、且捕获到非空输出（`outputDigest !== sha256('')`）的 `command`/`test` 行才算数；`kind: 'manual'` 行永远不能顶替必填类型。不合格的行会被检查表**点名**（例如 `EV-… 记录了 exitCode=2`），而失败运行仍然留在台账里供追溯。
3. **门禁四条硬要求**（缺一条即拒绝，`force` 也不能绕过）：
   - `gate.scope.full === true`：没有 `scope` 字段的旧记录视为"未覆盖全部命令"，理由固定为"门禁只覆盖了部分命令（scope.full=false），请重跑完整门禁"；
   - `gate.results.length > 0`：没验证任何命令的 `PASS` 不是证据；
   - 台账里有 `kind: 'gate'` 且 `data.gateId === gate.id` 的行：手工写 `gates/*.json` 而没有质量门禁的落盘记录 = 伪造，明确拒绝；
   - 门禁**严格晚于**最新 `command`/`test` 证据：`gate.checkedAt === 证据的 recordedAt`（同一毫秒）算**陈旧**（fail closed），需要重跑 `quality_gate_run`。可靠顺序是"先记证据，最后跑门禁，再 `mission_complete`"。
4. **熔断**：`mission.status === 'blocked'` 时交付通道关闭，`mission_complete` 直接拒绝（`force` 无效），先解除阻断或新建 mission。
5. **工作区指纹**（`requireCleanTree`，默认 `true`）：把 `gitFingerprint(cwd, { excludePaths: [layout.rootDir] })` 与门禁记录的 `fingerprint` 比对——两边都排除 `.dsh/`，因为这个台账每次工具调用都会变，绝不能拿它判定"工作区被改过"。门禁没记录指纹时 fail closed 阻断；**双方都不是 git 仓库**时不阻断，但检查表和交付报告都会显式写"无法核对（非 git 工作区）"，绝不暗示"已核对"。
6. `force: true` **只**放松"必填证据类型"检查，并在通过时强制写入一条 `manual` 证据说明覆盖原因（回执会绑定它）；它绝不能绕过规格审批、门禁（缺失 / `WARN` / `BLOCK` / 部分覆盖 / 伪造 / 陈旧）、`blocked` 状态或工作区指纹检查。
7. 回执不可变：`issueReceipt` 写一次即定稿；重复调用只返回"已经交付过"，不改文件、不改台账。
8. 阻断路径不抛异常、不改 mission 状态，只返回中文清单与确切的下一步工具调用；唯一的异常路径是**会话未声明工作区**（`session.header.cwd` 缺失）：此时工具直接抛中文错误、拒绝执行、不写任何工件（见"工作区"）。

## 构建与测试

```bash
node ../../node_modules/typescript/bin/tsc -p tsconfig.json && node --test test/*.test.ts
```

测试从 `dist/` 导入，必须先 `tsc`。共 40 个用例：装配/卸载、证据捕获（digest、tail 截断、Git 指纹、`kind=diff`）、全部阻断路径、`force` 边界、回执不可变性、`requireCleanTree`（真实 git 仓库；环境无 git 时自动 skip），审计回归：解析不回退最新 mission、失败行 / manual 不能顶替必填类型、伪造门禁、部分覆盖与无 `scope` 旧记录、空 `results`、同毫秒陈旧、`blocked` 熔断、默认 `requireCleanTree` 下的"门禁后改动"与非 git 工作区的"无法核对"提示，项目级配置回归：一个 host 服务两个仓库时检查表互不影响、host-only 键（`enabled`/`allowForceOverride`/`logFile`/布局）被忽略、项目级 `requireCleanTree=false` 只放松自己的工作区、损坏文件回退 profile 且交付照常、坏类型值逐条记问题、`evidence_status` 显示配置来源与生效值，以及工作区回归：提示词章节按本次装配的调用会话解析（同一注册、不同 cwd 得到不同文本，工作区改动下一次装配即生效，无工作区时回退 profile 文本且不抛异常）、未声明 `header.cwd` 时三个工具一律拒绝且**不往宿主目录写任何工件**（含显式 `missionId`）。
