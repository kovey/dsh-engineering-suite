# 审批环节：让评审人先看到需求文档与测试用例

> 背景：真机试用反馈——`spec_approve` 弹出的审批窗只有一行说明，评审人看不到已生成的需求文档与
> 测试用例，只能"盲批"；且打回之后没有"要改什么"的回路。
>
> 本文件记录**两侧**的改动：插件侧（本仓库，已完成）与 nvim-tui 侧（另一个仓库，**待你确认后再改**）。

## 一、插件侧（已完成，本仓库）

### 1. 审批提示词变成一份"可核对清单"（多行）

`spec_approve` 传给审批 seam 的 `reason` 现在长这样（`renderApprovalPrompt()`，`packages/dsh-spec-gate/src/tools.ts`）：

```
规格审批（第 2 次送审）：给 /health 加真实探活
mission add-health-20260917-101010 · rev 2 · 摘要 abcdef123456

需求文档目录: .dsh/specs/
需求文档: .dsh/specs/add-health-20260917-101010.md（验收标准 2 条）
  · AC-001 GET /health 在依赖正常时返回 200 与 {status:ok}
  · AC-002 依赖超时时返回 503 且 5s 内返回

测试用例目录: .dsh/missions/add-health-20260917-101010/
测试用例: .dsh/missions/add-health-20260917-101010/test-design-review.md（用例 2 条，覆盖全部验收标准）
  · TC-001 → AC-001：响应 200 且 body.status == ok
  · TC-002 → AC-002：依赖超时后 5s 内 503

通过：写操作放行。
不合格：拒绝并在对话里说明要改什么——规格会回到草稿，模型据此重写后再次送审（可反复多轮）。
```

- **两个目录 + 两个文件**都在里面，且每条验收标准/用例都带了摘要（各最多 6 条，多的折叠）；
- 路径是**相对会话工作区**的，UI 侧按会话 cwd 解析（见下）；
- 连续送审会显示"第 N 次送审"。

### 2. 打回重写是一个真正的回路

| 环节 | 行为 |
|---|---|
| 人工拒绝 | `mission.approval = { state:'rejected', round, by, note }` 落盘；**同时清空 `spec.approvedAt`**（旧审批作废，任何写路径都一致认为"未审批"） |
| 问清原因 | 若宿主装配了 `ctx.userQuestions`，自动弹出多选题「要改什么？」（验收标准不全 / 测试用例不合格 / 边界与约束不对 / 方案要换 / 暂不批），支持自由文本 |
| 反馈给模型 | `spec_approve` 返回（**不是错误**，是可继续的结果）：人工意见 + 「spec_create 修订 → test_design_review → spec_approve（第 N+1 次）」三步；并提醒意见不清时先问人，别猜 |
| 可追溯 | `spec_status` 增加两行：`需求文档:` / `测试用例:` 路径，以及 `审批记录: 第 2 次 → 打回（by approval，时间）；人工意见：…` |
| 无问答通道时 | 照旧记录打回与轮次，只是没有 note（不阻塞流程） |

测试：`packages/dsh-spec-gate/test/spec-gate.test.ts` 新增 4 条 `(regression)`
（提示词含两目录两文件与内容摘要；打回记录轮次+清空审批+问询通道被调用+模型拿到回路指引；第二次送审标注"第 2 次"；
无问答通道时仍能打回），并把 2 条旧断言更新为新契约（打回不再是 `isError`）。

## 二、nvim-tui 侧：**不需要改 TUI**（用它公开的扩展 API）

> **真机踩坑记录（第一版为什么不能用）**：最初的实现把 `ui.card` 当主通道，结果
> ①卡片按设计渲染进**会话 feed（聊天区）**——不是弹窗，看起来就像"内容被写进了聊天"；
> ②`feed.ts: extCardLines()` 只渲染**前 4 个动作**（`actions.slice(0, 4)`），而当时给了 6 个，
> 「通过并放行」「打回重写」**根本没显示**，用户"没法按提示选择"。
> 结论：**裁决必须放在浮窗里（`ui.picker`），卡片只当记录且动作永远 ≤4 个。**

初版方案是给 TUI 打补丁（多行渲染 + 打开文件的键）。后来发现 nvim-tui 已经 `ctx.provide('nvim-tui', …)`
了一套稳定的扩展 API（`src/ext-api/index.ts`，契约见 `src/kernel/ext-types.ts`），**审批评审完全可以建在它上面**：

| 需求 | 用到的公开 API |
|---|---|
| **弹出的审批窗（决策）** | `ui.picker({ title, items })` —— TUI 自己的浮窗选择器，`<CR>` 确认 / `jk` 移动 / `Esc` 取消；选"查看…"后菜单再弹一次 |
| 聊天区里的记录（含条目摘要） | `ui.card({ plugin, title, body, actions })` —— 渲染进会话 feed，动作 **≤4 个且全是"查看"**（TUI 只渲染前 4 个） |
| **只读预览（首选）** | `nvim.lua('return require("dsh_tui").show_lines_float(...)', [title, lines, path])` —— TUI 自己的只读浮窗（设置/工作流查看器同款）：原生滚动、**`q`/`Esc` 关闭回到原窗口**、`i`/`o` 打开文件编辑。评审菜单**等它关闭后再弹**（两个浮窗叠在一起会挡住文档），收尾时自动关闭 |
| 打开需求文档 / 测试用例（末位退路，不在菜单里单列） | 三条路由依次尝试：①`nvim.lua('return require("dsh_tui").open_file_tab(...)', [path])`（**TUI 自己的公开入口，`gF` 走的就是它，在 nvim 内部执行**）→ ②`nvim.call('fnameescape')` + `nvim.ex('tabedit …')` → ③本地转义 + `nvim.ex`；每条 4s 超时，成功/失败都用 `ui.notice` 明确告知 |
| "进去之后可以打开文档" | `ui.picker({ title, items })` 列目录（Node 侧 `fs.readdir`），选中即在新标签页打开；子目录可继续下钻（≤3 层） |
| 不合格打回重写 | 卡片动作 `{ kind: 'input', inputPrompt: '打回原因（要改什么）：' }` —— **TUI 走输入框**，输入的文字就是人工意见 |
| 通过 | 卡片动作 `{ kind: 'confirm' }` |
| 能力探测 / 降级 | `capabilities()`（headless 只有 panel/region 关掉，card/picker 仍可用）；服务缺失或宿主无 TUI 时**自动回退**到通用审批 seam |

关键点：

- **打开工件不决定审批**：卡片动作只开文件，卡片与等待保持；只有"通过并放行 / 打回重写"会结束等待。
- **打回意见直接落库**：`mission.approval = { state:'rejected', round, note }`，旧的 `spec.approvedAt` 同时清空；
  模型收到人工意见与三步回路（`spec_create` → `test_design_review` → `spec_approve` 第 N+1 次）。
- **超时/取消 = 不通过**：默认等待 15 分钟（`reviewTimeoutMs` 可配），超时只把卡片改成"已超时未决定"，绝不默认放行。
- **通道可选**：`reviewChannel: 'auto' | 'tui' | 'approval'`（默认 auto）。`tui` 表示"必须在 TUI 里评审"，
  服务缺失时**直接报错而不是静默降级**；`approval` 则始终走通用 seam（headless/web/CI）。
  两个键都可在 `<repo>/.dsh/spec-gate.json` 里按仓库覆盖。

原本的 Lua 补丁（多行 reason 渲染 + `gF`）仍然有效、但**已不必要**：通用 seam 的 reason 依旧是那份多行清单，
任何能把 `需求文档:` / `测试用例:` 行接上打开动作的 UI 都能得到同等效果。

## 三、真机验收步骤

1. 重启 nvim-tui（插件已挂载；`ctx.get('nvim-tui')` 由 TUI 自己 provide）；
2. 让模型走 `spec_create → test_design_review → spec_approve`；
3. 会话 feed 里应出现一张卡片：标题「规格审批（第 N 次送审）：…」，正文列出两份工件与条目摘要，
   底部动作 `1-6`；
4. 按 `1`/`2` 应在**新标签页**打开需求文档 / 测试用例（`:tabprevious` 回来看卡片）；按 `3`/`4` 列出两个目录
   并可选中打开；
5. 按 `6` 打回：TUI 会让你在输入框写明原因 → 卡片变为「已打回」，模型收到人工意见并重写，
   再次 `spec_approve` 时标题显示"第 2 次送审"；`spec_status` 的 `审批记录` 也应显示第 1 次被打回及原因；
6. 按 `5` 通过：返回"规格已审批"，之后的写操作放行。

若第 3 步没出现卡片，说明该会话没有拿到 `nvim-tui` 服务（例如在 headless/web 上），此时会自动走通用审批弹窗——
两者的文案完全一致，只是不能点开文件。
