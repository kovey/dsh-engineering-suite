#!/usr/bin/env bash
# split-smoke.sh — one command that walks the whole split workflow in a
# THROWAWAY repository: write plan → review → dispatch → import → cleanup.
#
# WHY a separate script: the workflow spans four artifacts (`split/plan.json`,
# `split/review.json`, `split/run.json`, `split/report.json`) and two libraries
# (the checked writer in `split-plan-tool.ts` and the runner). A script is the
# only form in which "the whole path still works together" can be exercised
# without touching a real mission — and, importantly, in which the UNTESTABLE
# part can say so out loud:
#
#   **Dispatch needs a real subagent channel.** A standalone process has no
#   `ctx.subagents`; the runner refuses by design (`state: refused`, "宿主没有
#   装配子代理服务"). So unless this machine both allows it and a `dsh` binary
#   exists, this script prints
#
#       SKIP: 没有可用的真实子代理通道
#
#   and states "未验证派发". A skip is exit 0 (the other steps DID run for real)
#   and is NEVER reported as a pass: scripts/selftest-ops.sh C22 pins both that
#   sentence AND the counter-proof (`DSH_SMOKE_REAL=1` without `dsh` must exit
#   non-zero), so deleting the probe or greening the skip fails the suite.
#
# The import/cleanup steps run against REAL artifacts even when dispatch is
# skipped: the script creates one task worktree, commits in it, writes the same
# local evidence row a worker writes, merges it and imports it through the real
# importer. That is labelled `simulated worker` in the output — the ONE thing it
# does not prove is that a real worker produces such a commit.
#
# usage: split-smoke.sh
#
#   default            write plan → review → dispatch refused (SKIP) → import → cleanup
#   DSH_SMOKE_REAL=1   ... → dispatch by running a REAL dsh session in the temp
#                      repo, then verify split/run.json says state=ran.
#                      Requires: dsh on PATH, DSH_SMOKE_PROFILE=<profile>,
#                      DSH_SMOKE_MODEL=<provider/model>, and a profile whose
#                      config mounts this suite with split.enabled: true.
#                      Optional: DSH_SMOKE_TIMEOUT (seconds, default 600),
#                      DSH_SMOKE_KEEP=1 (keep the temp repo and print its path).
#
# exit: 0  the steps that could run did run; a SKIP was printed with its reason
#       1  a step failed, or the real dispatch left no usable run record
#       2  this machine was ASKED for a real dispatch and cannot provide one
#
# Nothing here writes to this checkout: the driver imports its built modules,
# every artifact lands under `mktemp -d`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REAL="${DSH_SMOKE_REAL:-0}"

case "$REAL" in
  0|1) ;;
  *) printf 'ERROR: DSH_SMOKE_REAL=%s 不是 0/1（不认识的开关不能默默当作"跳过"）\n' "$REAL" >&2; exit 2 ;;
esac

# Refuse when the engine was never built: a smoke test that cannot load the
# modules has verified nothing, and saying SKIP here would be a lie.
for required in \
  "$ROOT/packages/dsh-eng-core/dist/split.js" \
  "$ROOT/packages/dsh-orchestrator/dist/split-plan-tool.js" \
  "$ROOT/packages/dsh-orchestrator/dist/split-runner.js"; do
  if [ ! -f "$required" ]; then
    printf 'ERROR: 缺少 %s —— 先构建：bash scripts/build-all.sh（未验证任何东西）\n' "${required#"$ROOT"/}" >&2
    exit 1
  fi
done
if ! command -v git >/dev/null 2>&1; then
  printf 'ERROR: 找不到 git（冒烟需要在临时仓库里跑，未验证任何东西）\n' >&2
  exit 1
fi

DSH_BIN="$(command -v dsh || true)"
if [ "$REAL" = "1" ]; then
  if [ -z "$DSH_BIN" ]; then
    printf 'ERROR: DSH_SMOKE_REAL=1 但 PATH 上没有 dsh —— 要求真派发就必须能派发，这不是通过\n' >&2
    exit 2
  fi
  if [ -z "${DSH_SMOKE_PROFILE:-}" ] || [ -z "${DSH_SMOKE_MODEL:-}" ]; then
    printf 'ERROR: DSH_SMOKE_REAL=1 需要 DSH_SMOKE_PROFILE=<profile> 与 DSH_SMOKE_MODEL=<provider/model>（真派发要能路由模型）\n' >&2
    exit 2
  fi
fi

WS="$(mktemp -d)"
cleanup() {
  if [ "${DSH_SMOKE_KEEP:-0}" = "1" ]; then
    printf 'kept: %s\n' "$WS"
    return
  fi
  rm -rf "$WS"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. the throwaway repository (git is required: import/cleanup are git facts)
# ---------------------------------------------------------------------------
(
  cd "$WS"
  git init -q -b main
  git config user.email "smoke@example.com"
  git config user.name "split smoke"
  git config commit.gpgsign false
  printf '# split smoke workspace\n' > README.md
  # Runtime trail state is ignored, exactly like a real workspace: the worker's
  # local evidence ledger lives inside its worktree under `.dsh/`, and an ignored
  # ledger is what lets `git worktree remove` clean up after the import.
  printf '.dsh/\n' > .gitignore
  git add -A
  git commit -qm "chore: smoke workspace"
)
# The minimal trail config a real workspace would have: the model classes the
# split workflow routes to, and a bounded per-worker deadline (so a wedged worker
# in the real branch cannot hang this run for the host's default 10 minutes).
mkdir -p "$WS/.dsh/engineering-suite"
MODEL="${DSH_SMOKE_MODEL:-smoke/worker}"
node -e '
const fs = require("node:fs")
const [file, model] = process.argv.slice(1)
fs.writeFileSync(file, JSON.stringify({
  planner: { model },
  worker: { model },
  split: { reviewRequired: true, maxTasks: 8, maxParallel: 2, maxReworkRounds: 2, taskTimeoutMs: 120000 },
  quality: { maxReworkRatio: 0.3 },
}, null, 2) + "\n")
' "$WS/.dsh/engineering-suite/models.json" "$MODEL"

# ---------------------------------------------------------------------------
# 2. the driver (real library calls, no host, no network)
# ---------------------------------------------------------------------------
read -r -d '' DRIVER <<'NODE' || true
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [root, ws, mode, phase] = process.argv.slice(2)
const load = async (relative) => import(pathToFileURL(path.join(root, relative)).href)
const { MissionStoreRegistry, resolveLayout } = await load('packages/dsh-eng-core/dist/index.js')
const {
    cleanupTaskWorktree,
    importTaskEvidence,
    loadModelsConfig,
    pendingImports,
    readSplitPlan,
    recordSplitReview,
    splitReviewStatus,
    splitTaskBranch,
    splitWorktreeDir,
    workerEvidenceFile,
} = await load('packages/dsh-eng-core/dist/split.js')
const { applySplitPlan } = await load('packages/dsh-orchestrator/dist/split-plan-tool.js')
const { runSplitPlan } = await load('packages/dsh-orchestrator/dist/split-runner.js')
const { defaultSplitWorktrees } = await load('packages/dsh-orchestrator/dist/split-run-git.js')
const { splitReportFile, splitRunFile } = await load('packages/dsh-orchestrator/dist/split-run-types.js')

const layout = resolveLayout(ws)
const say = (line) => process.stdout.write(`${line}\n`)
const fail = (line) => {
    process.stderr.write(`FAIL: ${line}\n`)
    process.exit(1)
}
const git = (cwd, args) => {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
    if (result.status !== 0) fail(`git ${args.join(' ')} 失败：${result.stderr}`)
    return (result.stdout ?? '').trim()
}

/** The two-task plan: disjoint paths, both criteria covered, one parallel group. */
const tasks = [
    { id: 'T-001', goal: '写入 src/a.txt', paths: ['src/a.txt'], acceptance: ['AC-001'], dependsOn: [], parallel: true },
    { id: 'T-002', goal: '写入 src/b.txt', paths: ['src/b.txt'], acceptance: ['AC-002'], dependsOn: [], parallel: true },
]

/** Create the mission + approved spec the checked writer validates against. */
function seedMission() {
    const store = new MissionStoreRegistry().for(ws)
    store.create({ id: 'smoke', title: '拆分冒烟', cwd: ws, sessionId: 'smoke-session' })
    store.bindSession('smoke-session', 'smoke', 'split-review')
    const now = Date.now()
    store.update('smoke', () => ({
        stage: 'split-review',
        status: 'spec-approved',
        spec: {
            title: '拆分冒烟',
            background: 'smoke test of the split workflow',
            requirements: ['写入两个文件'],
            acceptanceCriteria: [
                { id: 'AC-001', text: 'src/a.txt 存在' },
                { id: 'AC-002', text: 'src/b.txt 存在' },
            ],
            fileBoundaries: ['src/**'],
            negativeConstraints: [],
            revision: 1,
            createdAt: now,
            updatedAt: now,
            approvedAt: now,
            approvedBy: 'smoke',
        },
        testDesign: { cases: [], covered: ['AC-001', 'AC-002'], uncovered: [], passed: true, reviewedAt: now },
    }))
    return store.read('smoke')
}

/** Phase 1: write the plan through the CHECKED writer, then approve it. */
function planPhase() {
    const mission = seedMission()
    const written = applySplitPlan({ layout, missionId: mission.id, spec: mission.spec, tasks, parallelGroups: [['T-001', 'T-002']] })
    if (!written.ok) fail(`写 plan 被拒绝：${written.problems.join(' | ')}`)
    say(`plan: ${written.file}（摘要 ${written.digest.slice(0, 12)}，${written.taskCount} 个子任务）`)
    const review = recordSplitReview(layout, mission.id, { approver: 'smoke', decision: 'approved', planDigest: written.digest, at: Date.now() })
    if (!review.ok) fail(`审核记录写入被拒绝：${review.problems.join(' | ')}`)
    say(`review: ${review.record.decision}（绑定摘要 ${written.digest.slice(0, 12)}）`)
}

/** Default mode: the dispatch refusal is a REAL assertion, not a sentence. */
async function dispatchRefusalPhase() {
    const mission = new MissionStoreRegistry().for(ws).read('smoke')
    const models = loadModelsConfig(layout).config
    const result = await runSplitPlan({ layout, missionId: mission.id, cwd: ws, models, provider: 'spawn' })
    if (result.state !== 'refused') fail(`没有子代理通道时 runSplitPlan 必须 refused，实际 ${result.state}`)
    say(`dispatch: state=${result.state}（本进程没有 ctx.subagents，按设计拒绝）`)
    say(`run: ${result.file}`)
    say(`report: ${result.reportFile}`)
    say('SKIP: 没有可用的真实子代理通道')
    say('未验证派发：runner 在无 ctx.subagents 时按设计拒绝（state=refused），本次只验证了拒绝路径与 run/report 记录')
    say('（要真派发：DSH_SMOKE_REAL=1 DSH_SMOKE_PROFILE=<profile> DSH_SMOKE_MODEL=<provider/model> bash scripts/split-smoke.sh）')
}

/** Real mode: the dispatch happened if (and only if) run.json says so. */
function verifyPhase() {
    const file = splitRunFile(layout, 'smoke')
    if (!fs.existsSync(file)) fail(`真实派发没有留下 ${file}：dsh 会话没有跑到 implement（profile 是否开了 split.enabled？）`)
    const run = JSON.parse(fs.readFileSync(file, 'utf8'))
    say(`dispatch: state=${run.state} tasks=${Array.isArray(run.tasks) ? run.tasks.length : 0}`)
    if (run.state !== 'ran') fail(`真实派发没有发生（state=${run.state}）：${(run.problems ?? []).join(' | ')}`)
    if (!Array.isArray(run.tasks) || run.tasks.length === 0) fail('run.json 里没有子任务：派发没有发生')
}

/**
 * One simulated worker artifact: worktree → commit → local evidence row → merge.
 * Labelled in the output; it is what makes the import/cleanup steps real when
 * the dispatch step was skipped.
 */
function simulateWorker() {
    const seam = defaultSplitWorktrees()
    const created = seam.create({ mainTree: ws, missionId: 'smoke', taskId: 'T-001' })
    if (!created.ok) fail(`simulated worker: 建 worktree 失败：${created.problems.join(' | ')}`)
    fs.mkdirSync(path.join(created.worktree, 'src'), { recursive: true })
    fs.writeFileSync(path.join(created.worktree, 'src', 'a.txt'), 'smoke\n')
    git(created.worktree, ['config', 'user.email', 'worker@example.com'])
    git(created.worktree, ['config', 'user.name', 'simulated worker'])
    git(created.worktree, ['add', 'src/a.txt'])
    git(created.worktree, ['commit', '-qm', 'T-001: smoke 的模拟产物'])
    const head = seam.head(created.worktree)
    if (!head.ok || head.commit === undefined) fail(`simulated worker: 读不到 commit：${head.problems.join(' | ')}`)
    // The local evidence ledger a real worker writes inside its own worktree.
    const ledger = workerEvidenceFile(created.worktree, ws, layout, 'smoke')
    fs.mkdirSync(path.dirname(ledger), { recursive: true })
    fs.appendFileSync(
        ledger,
        `${JSON.stringify({
            id: 'smoke-ev-1',
            kind: 'test',
            at: 1_700_000_000_000,
            summary: 'simulated worker 的本地验证记录',
            taskId: 'T-001',
            commit: head.commit,
            worktree: created.worktree,
            branch: splitTaskBranch('smoke', 'T-001'),
        })}\n`,
    )
    const merge = seam.merge({ mainTree: ws, branch: created.branch, taskId: 'T-001' })
    if (!merge.ok) fail(`simulated worker: 合并失败：${merge.problems.join(' | ')}`)
    say(`simulated worker: commit ${head.commit.slice(0, 8)}（分支 ${created.branch}，merged=${merge.merged}）`)
}

/** Phase 3: import every pending row through the real importer, then clean up. */
function artifactPhase() {
    const stored = readSplitPlan(layout, 'smoke')
    if (stored === undefined) fail('plan.json 不见了：无法执行导入/清理')
    say(`review-status: ${splitReviewStatus(layout, 'smoke').state}`)
    if (pendingImports({ mainTree: ws, missionId: 'smoke', layout }).length === 0) {
        // No worker ran (skip/real already imported): simulate one artifact so
        // the importer and the cleaner are still exercised for real.
        simulateWorker()
    }
    const pending = pendingImports({ mainTree: ws, missionId: 'smoke', layout })
    say(`pending-imports: ${pending.length} 个子任务 / ${pending.reduce((sum, entry) => sum + entry.rows.length, 0)} 条`)
    for (const entry of pending) {
        const result = importTaskEvidence({ mainTree: ws, missionId: 'smoke', planDigest: stored.digest, rows: entry.rows, layout, at: Date.now() })
        if (!result.ok) fail(`导入 ${entry.taskId} 被拒绝：${result.problems.join(' | ')}`)
        say(`import ${entry.taskId}: ${result.imported.length} 条（来源映射 ${result.sources.length} 行）`)
    }
    for (const task of stored.plan.tasks ?? []) {
        const result = cleanupTaskWorktree({ mainTree: ws, missionId: 'smoke', taskId: task.id })
        if (!result.ok) fail(`清理 ${task.id} 被拒绝：${result.problems.join(' | ')}`)
        say(`cleanup ${task.id}: removed=${result.removed} alreadyGone=${result.alreadyGone}`)
        if (fs.existsSync(splitWorktreeDir(layout, 'smoke', task.id))) fail(`清理之后 worktree 仍在：${splitWorktreeDir(layout, 'smoke', task.id)}`)
    }
    const report = splitReportFile(layout, 'smoke')
    if (!fs.existsSync(report)) fail(`report.json 缺失：${report}`)
    say(`report-fields: ${Object.keys(JSON.parse(fs.readFileSync(report, 'utf8'))).join(',')}`)
}

switch (phase) {
    case 'plan':
        planPhase()
        break
    case 'dispatch-refusal':
        await dispatchRefusalPhase()
        break
    case 'verify':
        verifyPhase()
        break
    case 'finish':
        artifactPhase()
        break
    default:
        fail(`未知阶段 ${phase}`)
}
NODE

run_driver() {
  node --input-type=module - "$ROOT" "$WS" "$REAL" "$1" <<<"$DRIVER"
}

# ---------------------------------------------------------------------------
# 3. the workflow
# ---------------------------------------------------------------------------
section() { printf '\n== %s\n' "$*"; }

section "1/5 写 plan（split_plan 的校验路径）+ 人工审核"
run_driver plan

if [ "$REAL" = "1" ]; then
  section "2/5 派发（真实 dsh 会话：profile=${DSH_SMOKE_PROFILE} model=${DSH_SMOKE_MODEL}）"
  TIMEOUT="${DSH_SMOKE_TIMEOUT:-600}"
  TASK="这是拆分冒烟的临时仓库。mission smoke 的拆分计划已审核通过。请调用 orchestrate({ action: \"advance\", missionId: \"smoke\", verdict: \"PASS\", summary: \"拆分冒烟\" })，让 implement 阶段的拆分派发跑起来；不要修改其他文件。"
  DSH_LOG="$WS/.dsh-smoke-dsh.log"
  (
    cd "$WS"
    "$DSH_BIN" --profile "$DSH_SMOKE_PROFILE" "$TASK"
  ) >"$DSH_LOG" 2>&1 &
  DSH_PID=$!
  # Watchdog by POLLING, not by a background `sleep` subshell: a background
  # sleeper inherits the caller's stdout, and when this script runs inside
  # `$(...)` that pipe keeps the whole capture open for the full timeout (a
  # five-minute hang that looks like a wedged dsh). `SECONDS` + `kill -0` needs
  # no extra process and no extra file descriptor.
  DEADLINE=$((SECONDS + TIMEOUT))
  while kill -0 "$DSH_PID" 2>/dev/null && [ "$SECONDS" -lt "$DEADLINE" ]; do
    sleep 1
  done
  if kill -0 "$DSH_PID" 2>/dev/null; then
    printf 'dsh 未在 %ss 内结束：先 TERM 再 KILL（这次不是通过）\n' "$TIMEOUT"
    kill -TERM "$DSH_PID" 2>/dev/null || true
    sleep 2
    kill -KILL "$DSH_PID" 2>/dev/null || true
  fi
  set +e
  wait "$DSH_PID"
  DSH_RC=$?
  set -e
  printf 'dsh exit=%s（日志 %s 行：%s）\n' "$DSH_RC" "$(wc -l < "$DSH_LOG" | tr -d ' ')" "$DSH_LOG"
  section "2b/5 验证真实派发留下的记录（不看退出码，看 split/run.json）"
  run_driver verify
else
  section "2/5 派发（本进程没有 ctx.subagents → 必须拒绝并说明）"
  run_driver dispatch-refusal
fi

section "3/5 导入待导入的本地证据"
section "4/5 清理 worktree（导入完成之后才允许）"
run_driver finish

section "结果"
if [ "$REAL" = "1" ]; then
  printf 'REAL: 派发经过真实 dsh 会话，split/run.json 的 state=ran 已核实。\n'
else
  printf 'SKIP: 没有可用的真实子代理通道 —— 写 plan / 审核 / 导入 / 清理已实测，**未验证派发**。\n'
fi
