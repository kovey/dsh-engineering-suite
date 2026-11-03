# 一致性总览（Conformance）：设计稿

> 状态：**设计稿**，未实现。实现约束见文末"硬约束"，它们是不可协商的。

## 1. 它回答的问题（以及不回答的）

套件现在有三个面，各答一件事：

| 面 | 回答 | 状态 |
|---|---|---|
| `doctor` / `suite_status` | **这套装置配好了吗**——配置、忽略规则、白名单、过期授权、单一写者 | 有 |
| `orchestrate({ action: 'metrics' })` | **交付在变好还是变坏**——lead time、审批等待、门禁失败率、回滚率 | 有 |
| **一致性总览** | **这一次交付离"规则允许的范围"有多远，且能与别的 mission 比较** | **本设计** |

它**不**回答"能不能交付"——那个问题由门禁记录 + 回执回答（`mission_complete` 直接读它们）。

## 2. 为什么需要它

今天的结论是**逐门禁、逐 mission** 的：`quality_gate_run` 说"命令过没过"、`standards_check` 说"规范超没超"、
`evidence` 说"证据够不够"、`mandate` 说"当初被允许吗"。**没有任何一个输出能横向比较两个 mission 的整体状态**，
操作者只能自己在脑子里合成——这既慢，又不可复核。

## 3. 形态：五个维度 + 一个头行状态

全部由现有台账确定性算出，**不新增任何记录**：

| 维度 | 输入 | 取值 |
|---|---|---|
| **授权** | `mandate`（strength / scope / policyVersion / withdrawn）、`legacy` 标记 | `ok` / `stale:<reason>` / `legacy` / `withdrawn` / `missing` |
| **证据** | 回执、`scope.full`、门禁来源匹配 | `full` / `partial` / `absent` |
| **门禁** | 各来源最新记录（含 `observations` 的影子项） | `pass` / `warn` / `block` / `no-record` |
| **新鲜度** | `policyVersion`、工作区指纹、基线/索引是否过时 | `fresh` / `stale:<reason>` / `unknown` |
| **一致性** | 台账↔产物（回执指向的工件在不在、manifest 与 chunks、基线与计数） | `consistent` / `divergent:<detail>` / `unknown` |

**头行状态 = 最差维度**，取值只有四个：`conformant` / `partial` / `divergent` / `unknown`。
排序：`divergent` < `partial` < `conformant`，而 **`unknown` 永远不优于 `partial`**（未知不是好消息）。

每个维度必须带上**它的依据**（哪几个文件、哪几次记录、样本量），以及**它的盲区**
（未记录的 mission、`legacy` 授权、缺失的台账看不见）。

## 4. 硬约束（不可协商）

1. **只读、派生、可复现**：同一份台账进 → 同一份输出出；不写任何文件；不含时间戳以外的非确定性输入。
2. **零权力**：任何门禁都不得读它；`mission_complete` 直接读门禁记录与回执。它可以叫"裁决"，但它裁的是**一致性**，不是**许可**。
3. **`unknown` 不许被平均成"还行"**：头行状态取最差维度，且 `unknown` 最多算 `partial`。
4. **不做加权分数**：一个分数会掩盖"哪个维度坏了"，也会诱导优化分数本身。要比较就用**同一组维度的分布**，
   要趋势就用已有的 `metrics`。
5. **不新建插件、不新增配置键（除非确有必要）**：给 `suite_status` 加一段、给 `metrics` 加一个跨 mission 分布即可。

## 5. 与既有面的边界

| 谁 | 读它吗 | 说明 |
|---|---|---|
| `mission_complete` | **不读** | 交付允许与否仍只由门禁记录 + 回执决定 |
| `suite_status` | 读（作为一段） | 人看的一致性摘要 |
| `metrics` | 读（作为分布） | 跨 mission 比较与趋势 |
| 各门禁 | **不读** | 任何门禁都不得据此放行或拒绝 |

## 6. 测试清单（实现时必须全有）

- 五个维度各自至少一个 `ok` 与一个非 `ok` 用例，且非 `ok` 必须带**可读的原因**（不是状态码）；
- 头行状态 = 最差维度；`unknown` + `conformant` ⇒ 头行 `partial`（不得是 `conformant`）；
- 一个 mission 同时有 `stale` 授权与 `full` 证据 ⇒ 头行 `divergent`/`partial` 且两个维度都被列出；
- 空仓库 / 未记录 mission ⇒ 全部 `unknown` + 原因，头行 `unknown`，**绝不输出"看起来健康"**；
- `legacy` 授权作为事实呈现，不计入 `divergent`；
- 只读：`.dsh` 前后 sha256 快照一致；
- 确定性：同一棵树两次运行输出逐字节相同（含维度顺序）；
- 盲区声明：缺台账时输出里必须出现"盲区：…"一行；
- **知识库索引（已解决，不再是盲区）**：按 manifest 声明的 `algorithm` + `excludes` 复算；旧索引未声明
  → `unknown` + 盲区行，绝不 `fresh`（见 ARCHITECTURE §5.26）。
