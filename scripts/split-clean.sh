#!/usr/bin/env bash
# split-clean.sh — the ONE explicit command that removes leftover task worktrees.
#
# WHY a separate command and not "the runner cleans up after itself": a worktree
# is a directory, and it is often the only copy of what a worker wrote before the
# process died. Deleting it is therefore a decision a person makes, with the list
# in front of them — never a side effect of running a status view, a smoke test or
# a "recovery" helper.
#
# Two rules are structural, not documentation:
#
#   1. **dry-run is the default.** Without `--apply` the command prints every
#      candidate and the exact deletion it WOULD perform, and deletes nothing.
#   2. **"先导入再删" is enforced by the code that deletes.** Every removal goes
#      through `cleanupTaskWorktree`, which re-scans the mission's worktrees for
#      unimported evidence and REFUSES the whole batch while anything is pending
#      (`git worktree remove` is then never invoked). The command also refuses up
#      front when the doctor already sees a `needs-import` directory, listing the
#      pending rows: the operator should see "import first" as the reason, not a
#      partially-processed batch.
#
# `git worktree remove` (no `--force`) is the removal primitive inside the
# library, so a worktree with uncommitted, non-ignored files is refused by git
# itself; the branch is never deleted, so commits stay reachable on
# `split/<missionId>/<taskId>`.
#
# usage: split-clean.sh --orphans --mission <id> [--apply] [--workspace <dir>]
#
#   --orphans          list/clean the leftover task worktrees of one mission
#                      (`orphan` + `safe-to-clean`; `needs-import` is never a
#                      candidate — it must be imported first)
#   --mission <id>     which mission (required: no "latest mission" guessing)
#   --apply            actually remove the candidates (default: dry-run only)
#   --workspace <dir>  workspace root (default: auto-detected from this script's
#                      repository, like every other script here)
#   -h | --help        print this help
#
# exit: 0 = the run happened (dry-run printed, or every candidate was removed)
#       1 = a refusal (pending imports, or a removal that failed) — nothing was
#           silently skipped
#       2 = usage error (unknown flag, missing --mission)
#
# Nothing here writes to `.dsh/` except the removals it was asked to perform:
# the doctor view is read-only, and a dry-run leaves the workspace byte-identical.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  sed -n '2,/^set -euo pipefail$/p' "$0" | sed '$d'
}

ORPHANS=0
APPLY=0
MISSION=""
WORKSPACE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --orphans) ORPHANS=1; shift ;;
    --apply) APPLY=1; shift ;;
    --mission)
      [ "$#" -ge 2 ] || { printf 'split-clean.sh: --mission 需要一个值\n' >&2; exit 2; }
      MISSION="$2"; shift 2 ;;
    --workspace)
      [ "$#" -ge 2 ] || { printf 'split-clean.sh: --workspace 需要一个值\n' >&2; exit 2; }
      WORKSPACE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)
      printf 'split-clean.sh: 不认识的参数 %s（拼写错误不能变成"什么都不做"）\n' "$1" >&2
      printf 'usage: bash scripts/split-clean.sh --orphans --mission <id> [--apply]\n' >&2
      exit 2 ;;
  esac
done

if [ "$ORPHANS" != "1" ]; then
  printf 'split-clean.sh: 目前只支持 --orphans（其余清理路径请走 runner 的收尾步骤）\n' >&2
  exit 2
fi
if [ -z "$MISSION" ]; then
  printf 'split-clean.sh: 缺少 --mission <id>（不猜"最近一个 mission"：删错目录不可撤销）\n' >&2
  exit 2
fi
if [ -z "$WORKSPACE" ]; then
  WORKSPACE="$ROOT"
fi
if [ ! -d "$WORKSPACE" ]; then
  printf 'split-clean.sh: --workspace %s 不存在\n' "$WORKSPACE" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  printf 'split-clean.sh: 找不到 node（本脚本用构建后的库判定，未验证任何东西）\n' >&2
  exit 1
fi
for required in \
  "$ROOT/packages/dsh-eng-core/dist/worktree.js" \
  "$ROOT/packages/dsh-eng-core/dist/worktree-doctor.js"; do
  if [ ! -f "$required" ]; then
    printf 'split-clean.sh: 缺少 %s —— 先构建：bash scripts/build-all.sh（未验证任何东西）\n' "${required#"$ROOT"/}" >&2
    exit 1
  fi
done

node --input-type=module - "$ROOT" "$(cd "$WORKSPACE" && pwd)" "$MISSION" "$APPLY" <<'NODE'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [root, ws, missionId, applyArg] = process.argv.slice(2)
const apply = applyArg === '1'
const load = async (relative) => import(pathToFileURL(path.join(root, relative)).href)
const { resolveLayout } = await load('packages/dsh-eng-core/dist/index.js')
const { cleanupTaskWorktree } = await load('packages/dsh-eng-core/dist/worktree.js')
const { describeOrphanWorktrees, findOrphanWorktrees, orphanCount } = await load('packages/dsh-eng-core/dist/worktree-doctor.js')

const say = (line) => process.stdout.write(`${line}\n`)
const refuse = (line) => {
  process.stderr.write(`REFUSED: ${line}\n`)
  process.exit(1)
}

const layout = resolveLayout(ws)
let report
try {
  report = findOrphanWorktrees({ mainTree: ws, missionId, layout })
} catch (error) {
  // An unsafe mission id (`../x`, an absolute path) must be a refusal sentence,
  // not a stack trace: this command deletes directories.
  refuse(`mission id ${JSON.stringify(missionId)} 不可用：${error instanceof Error ? error.message : String(error)}`)
}

say(`mission: ${missionId}（workspace ${ws}）`)
say(`worktree 根：${report.root}`)
say(`run.json：${report.runRecordRead ? '已读' : '缺失/无法解析（目录按孤儿列出）'}`)
for (const problem of report.problems) say(`problem: ${problem}`)
if (report.missingDirs.length > 0) say(`run.json 记录但目录已不存在：${report.missingDirs.join('、')}（无需处理）`)
say(`分类：orphan=${orphanCount(report, 'orphan')} needs-import=${orphanCount(report, 'needs-import')} safe-to-clean=${orphanCount(report, 'safe-to-clean')}`)
for (const line of describeOrphanWorktrees(report, 50)) say(line)

// Rule 2 (the first half): a pending import anywhere in this mission refuses the
// WHOLE batch, with the list. Deleting one orphan while another directory still
// holds unimported evidence would make "the mission's evidence is complete"
// unanswerable — and the cleanup library would refuse anyway.
if (report.pending.length > 0) {
  refuse(
    [
      `存在 ${report.pending.length} 个子任务的未导入本地 evidence：整批中止，一个目录都不删。`,
      ...report.pending.map((entry) => `- ${entry.taskId}：${entry.rows} 条待导入（${entry.worktree}）`),
      '先导入（split 导入器 / 完成一次 runSplitPlan 收尾），再重新执行本命令。',
    ].join('\n'),
  )
}

const candidates = report.entries.filter((entry) => entry.kind === 'orphan' || entry.kind === 'safe-to-clean')
if (candidates.length === 0) {
  say('没有可清理的目录（孤儿 0 个，可安全清理 0 个）：什么都没删。')
  process.exit(0)
}

if (!apply) {
  say('')
  say('DRY-RUN：以下目录会被删除（没有删除任何东西）。确认后加 --apply：')
  for (const entry of candidates) say(`  将删除 ${entry.taskId}（${entry.kind}）：${entry.worktree}（分支 ${entry.branch} 保留）`)
  say(`再执行：bash scripts/split-clean.sh --orphans --mission ${missionId} --apply`)
  process.exit(0)
}

// Rule 2 (the second half): each removal reuses the importer-aware cleaner; the
// FIRST refusal aborts the batch and prints why. Nothing is skipped silently.
for (const entry of candidates) {
  const result = cleanupTaskWorktree({ mainTree: ws, missionId, taskId: entry.taskId, layout })
  if (!result.ok) {
    refuse([`清理 ${entry.taskId} 被拒绝：整批中止（后面的目录一个都没动）`, ...result.problems.map((problem) => `- ${problem}`)].join('\n'))
  }
  say(`已清理 ${entry.taskId}：removed=${result.removed} alreadyGone=${result.alreadyGone}（${entry.worktree}）`)
}
say(`完成：${candidates.length} 个目录已处理。`)
NODE
