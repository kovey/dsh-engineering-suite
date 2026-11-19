# 0002 任务拆分：单 mission + git worktree 并行 + 人工审核拆分结果

```json
{
  "number": 2,
  "slug": "mission-git-worktree",
  "title": "任务拆分：单 mission + git worktree 并行 + 人工审核拆分结果",
  "recordedAt": 1795053577204,
  "missionId": "design-task-split-20261118"
}
```

## 状态

已接受（记录于 2026-11-19 01:59:37Z）。
本文件按「ADR 只增不改」原则不再修改：是否已被取代以 `adr_list` / `index.jsonl` 里的 `supersededBy` 为准，
绝不回写这份文档——去年读过它的人看到的应该还是同一份内容。

## 背景

来自 mission `design-task-split-20261118`（规格 `.dsh/specs/design-task-split-20261118.md`，证据 `.dsh/missions/design-task-split-20261118/evidence.jsonl`）。

## 决定

任务拆分采用"单 mission 内的子任务 + git worktree 并行 + 拆分结果人工审核 + 返工率阈值"：① 子任务不另立 mission，全部挂在原 mission 的 mandate 下，最终仍只有一张回执；② 每个可并行的子任务在独立 git worktree 里执行，路径不相交只是并行前提而不是隔离手段；③ 拆分产物（子任务清单：目标、路径、覆盖的 AC、依赖、可否并行）必须先过人工审核（复用宿主 approval 接缝 / interaction-gate 的 IM 卡），审核通过才允许派发第一个 worker；④ 返工率按"需要重做的子任务数 ÷ 已开始子任务数"计算，阈值项目级可配，缺省 0.3，超过则把后续子任务升级到 planner 模型并告警，不自动中止。

## 备选方案与为什么不选

备选一：子任务做成独立 mission（每个子任务自己的 spec/审批/回执）。隔离最彻底、门禁语义最干净，但审批次数随子任务线性增长，拆分本身就是任务，成本会吃掉并行收益，所以不选。

备选二：并行但共享同一工作区，按路径分区约束（不引入 worktree）。省掉 worktree 的依赖与构建开销，但文件冲突只能靠"路径不相交"这类静态规则预防，一旦 planner 判断错误就是静默覆盖；而且我们的审计/结构规范/diff 指纹都是按单一工作树设计的，冲突后归属难查，所以不选。

备选三：不用人工审核，只靠自动规则（每条子任务有验收、路径不相交、AC 全覆盖）判定拆分是否可开工。便宜模型的拆分错误往往恰好长得像"合规"（拆得细、路径也分开了），自动规则拦不住语义性错误，所以不选。

## 后果

必须解决三件事，否则方案落不了地：① 布局根钉定——worktree 里的 .dsh/engineering-suite 是 git  checkout 出来的配置副本，而 missions/specs 等运行目录被 gitignore，worker 若按自己的 cwd 解析布局会写进 worktree 自己的运行时状态，证据与台账就跟主树分叉了；② 依赖与构建开销——worktree 不共享 node_modules，16 个包的 build/type-check 在每个 worktree 都要重来一遍，这是并行的隐性税，需要明确"子任务在 worktree 里跑什么、合并后跑什么"；③ 门禁只认合并后的整体——子任务各自绿不构成交付依据，与现有"部分运行不构成交付依据"同一原则。返工率阈值（项目级可配，默认 30%）只用于升级模型与告警，不自动中止。

## 证据链接

- 记录来源：`adr_record`（dsh-spec-gate）
- 规格：`.dsh/specs/design-task-split-20261118.md`
- 证据：`.dsh/missions/design-task-split-20261118/evidence.jsonl`
- 规划台账：`.dsh/engineering-suite/plan.jsonl`（这次决策发生在哪次规格变更前后）
