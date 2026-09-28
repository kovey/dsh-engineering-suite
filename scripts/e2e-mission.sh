#!/usr/bin/env bash
# e2e-mission.sh — run the REAL dsh harness against a SCRIPTED local model and
# assert that the fourteen-plugin engineering suite actually produced its
# artifacts.
#
# Why: the suite had never been verified with a live agent loop (no
# DEEPSEEK_API_KEY in the verification sandbox, and no budget for one). This
# script replaces only the token generator — `scripts/stub-llm.mjs` speaks the
# DeepSeek chat-completions SSE subset the adapter consumes — and keeps
# everything else real: the harness boot, tool dispatch, plugin hooks, the
# quality gate's subprocess, the mission store, the audit trail.
#
# usage: bash scripts/e2e-mission.sh [--no-build] [--keep] [--timeout SECONDS] [--selftest]
#   --no-build   reuse the existing packages/*/dist (default: build first)
#   --keep       keep the logs and DSH_HOME under /tmp/dsh-e2e; the WORKSPACE is
#                ALWAYS wiped (see the C2 note below) and the profile is rewritten
#   --timeout    watchdog for the dsh run in seconds (default 300)
#   --selftest   do not run dsh at all: exercise this script's own assertions
#                against synthetic inputs (the three false-green classes below),
#                then run scripts/selftest-ops.sh (the same for the ops scripts),
#                and exit non-zero if any of them stops biting
#
# WHY THESE ASSERTIONS LOOK PARANOID — 2026-09 adversarial audit, findings C1-C3,
# every one of them reproduced with a GREEN run:
#   * the readiness probe accepted ANY listener on $PORT. With a foreign process
#     (or a leftover stub from an earlier run) holding the port, our own stub
#     died of EADDRINUSE while the run printed "PASS stub-llm healthy" and the
#     suite's own model server served ZERO requests.
#   * under --keep the previous run's workspace survived, so `ls -t … | head -1`
#     returned the OLD mission/spec/audit and a model that did nothing at all
#     still satisfied every artifact assertion.
#   * `grep -q 'applied ('` also matches a plugin's own partial-failure line
#     ("applied (tools: …; failed: …)"), and every plugin wraps apply() in
#     `catch { log.error('apply failed:') }` without rethrowing — so a
#     HALF-MOUNTED plugin counted as mounted.
# The fixes are assertions, not extra log lines: --selftest proves they bite.
#
# SANDBOX: the run sets DSH_PERMISSION_MODE=danger-full-access for the child
# `dsh` unless $E2E_PERMISSION_MODE says otherwise. The verification sandbox is
# itself seatbelted, so a nested `sandbox-exec` fails with
# "sandbox_apply: Operation not permitted" and the *bash tool* refuses to run
# unconfined ("no sandbox backend is usable on this host; … otherwise switch
# the consumer to danger-full-access"). The harness's own error message names
# this remedy; the workspace here is a throwaway /tmp scratch repo whose only
# commands are `node --test` / `node -e`. Set E2E_PERMISSION_MODE=workspace-write
# to see the refusal instead (the flow then fails loudly, by design).
#
# Everything it creates lives under $E2E_HOME (default /tmp/dsh-e2e); nothing
# outside it is written. Re-runnable: the profile, the workspace and the stub
# script are rebuilt from scratch on every run.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
E2E_HOME="${E2E_HOME:-/tmp/dsh-e2e}"
PORT="${STUB_PORT:-8787}"
BASE_URL="http://127.0.0.1:${PORT}/v1"
PROFILE="headless"
WS="$E2E_HOME/ws"
LOGS="$E2E_HOME/logs"
STUB_LOG="$LOGS/stub-llm.log"
DSH_LOG="$LOGS/dsh.log"
TIMEOUT_SECONDS=300
DO_BUILD=1
KEEP=0
SELFTEST=0
PERMISSION_MODE="${E2E_PERMISSION_MODE:-danger-full-access}"

# Every plugin under verification (dsh-eng-core is a library dependency, linked
# but not a bundle). The assertion below counts these mounts, so a plugin that
# silently fails to apply fails the run.
SUITE=(
  dsh-role-guard
  dsh-standards-gate
  dsh-impact-gate
  dsh-coverage-gate
  dsh-supply-chain-gate
  dsh-spec-gate
  dsh-test-design-gate
  dsh-quality-gate
  dsh-evidence-gate
  dsh-audit-trail
  dsh-orchestrator
  dsh-interaction-gate
  dsh-suite-doctor
  dsh-deploy-gate
)

while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) DO_BUILD=0; shift ;;
    --keep) KEEP=1; shift ;;
    --timeout) TIMEOUT_SECONDS="${2:-300}"; shift 2 ;;
    --selftest) SELFTEST=1; shift ;;
    -h|--help) sed -n '2,/^set -euo pipefail/p' "$0" | sed '$d'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

FAILURES=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
info() { printf '  ---- %s\n' "$*"; }
section() { printf '\n=== %s\n' "$*"; }

# ---------------------------------------------------------------------------
# judgement helpers — one place per false-green class, used by the run AND by
# --selftest (a check that is never exercised against a known-bad input is how
# this script liked a foreign listener for its own stub).
# ---------------------------------------------------------------------------

# Whether a plugin log proves a COMPLETE mount: its own `applied (…)` line, with
# no failed tool in it and no `apply failed:` anywhere (audit C3). The plugins
# catch their own apply() errors, so "the file exists" and even "applied (" both
# survive a plugin that registered nothing. `failed to register` covers the other
# half of the class: plugins that print no `failed:` segment in their mount line
# (coverage-gate, deploy-gate, …) still log one line per tool they could not
# register, and a healthy mount never logs it.
mount_ok() { # mount_ok <plugin-log>
  local log="$1"
  [ -f "$log" ] || return 1
  grep -q 'applied (' "$log" 2>/dev/null || return 1
  grep -q 'applied (.*failed:' "$log" 2>/dev/null && return 1
  grep -q 'apply failed:' "$log" 2>/dev/null && return 1
  grep -q 'failed to register' "$log" 2>/dev/null && return 1
  return 0
}

# Whether the listener on a port is OUR stub: the process is alive AND its own
# log says it bound that port (audit C1 — a probe that only asks "does something
# answer /health?" says yes to any stranger).
stub_owns_port() { # stub_owns_port <pid> <log> <port>
  local pid="$1" log="$2" port="$3"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [ -f "$log" ] || return 1
  grep -Fq "listening on http://127.0.0.1:${port}" "$log" 2>/dev/null || return 1
  return 0
}

# A file written by the CURRENT run (audit C2: `ls -t | head -1` returns the
# previous run's artifact just as happily).
postdates() { # postdates <file> <sentinel created at/just before the run>
  local file="$1" sentinel="$2"
  [ -f "$file" ] || return 1
  [ -f "$sentinel" ] || return 0
  [ "$file" -nt "$sentinel" ]
}

# Every run starts from an EMPTY workspace. `--keep` may keep the logs and the
# DSH_HOME (that is what makes a failed run debuggable), but artifacts must never
# survive: under `--keep` the previous workspace's mission/spec/audit satisfied
# every artifact assertion below, so "a model that does nothing" was GREEN.
reset_workspace() { # reset_workspace <dir>
  local ws="$1"
  rm -rf "$ws"
  mkdir -p "$ws"
  if [ -e "$ws/.dsh" ] || [ -n "$(ls -A "$ws" 2>/dev/null)" ]; then
    printf 'reset_workspace: %s is still not empty after the reset\n' "$ws" >&2
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# --selftest: drive the three helpers above with inputs that MUST be refused.
# No dsh, no profile, no workspace — a few hundred milliseconds.
# ---------------------------------------------------------------------------
selftest() {
  local free_port real_port foreign_pid stub_pid probe
  # Global on purpose: the EXIT trap below runs after this function returned, and
  # a `local` is unset by then (set -u would make the trap itself fail the run).
  SELFTEST_TMP="$(mktemp -d)"
  tmp="$SELFTEST_TMP"
  trap 'rm -rf "$SELFTEST_TMP"' EXIT

  section "selftest 1/4 — the mount needle rejects a half-mounted plugin (C3)"
  printf 'INFO applied (tools: bash, write; enforce=true; approval=auto)\n' > "$tmp/clean.log"
  printf 'INFO applied (tools: bash, write; failed: evidence_record; enforce=true)\n' > "$tmp/partial.log"
  printf 'ERROR apply failed: Error: boom\n' > "$tmp/apply-failed.log"
  printf 'INFO applied (tools: coverage_check; thresholds: 80%%)\nWARN tools that failed to register: mutation_check\n' > "$tmp/unregistered.log"
  printf 'INFO nothing to see here\n' > "$tmp/empty.log"
  if mount_ok "$tmp/clean.log"; then pass "accepts a complete 'applied (…)' line"; else fail "refused a complete mount line"; fi
  if mount_ok "$tmp/partial.log"; then fail "accepted 'applied (…; failed: tool)' — a half-mounted plugin"; else pass "refuses the partial-failure mount line"; fi
  if mount_ok "$tmp/apply-failed.log"; then fail "accepted 'apply failed:' — apply() threw"; else pass "refuses a log whose apply() threw"; fi
  if mount_ok "$tmp/unregistered.log"; then fail "accepted a plugin with a tool that 'failed to register'"; else pass "refuses a plugin with an unregistered tool"; fi
  if mount_ok "$tmp/empty.log"; then fail "accepted a log with no mount line at all"; else pass "refuses a log with no mount line"; fi

  section "selftest 2/4 — a foreign listener is not our stub (C1)"
  free_port="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')"
  real_port="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')"
  printf '{"steps":[{"say":"selftest"}]}\n' > "$tmp/script.json"
  node -e 'require("node:http").createServer((_q,s)=>{s.writeHead(200,{"content-type":"application/json"});s.end("{\"ok\":true}")}).listen(Number(process.argv[1]),"127.0.0.1")' "$free_port" >"$tmp/foreign.log" 2>&1 &
  foreign_pid=$!
  sleep 0.4
  probe=1
  node -e "fetch('http://127.0.0.1:${free_port}/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" 2>/dev/null || probe=0
  if [ "$probe" = "1" ]; then pass "the health probe alone is fooled by the foreign listener (so the extra checks are load-bearing)"; else fail "the foreign listener did not answer /health"; fi
  STUB_SCRIPT="$tmp/script.json" STUB_PORT="$free_port" node "$ROOT/scripts/stub-llm.mjs" >"$tmp/stub.log" 2>&1 &
  stub_pid=$!
  sleep 1
  if stub_owns_port "$stub_pid" "$tmp/stub.log" "$free_port"; then
    fail "took the foreign listener on $free_port for our own stub"
  else
    pass "refuses the foreign listener: our stub is dead / never logged the port (EADDRINUSE)"
  fi
  kill "$stub_pid" 2>/dev/null || true; wait "$stub_pid" 2>/dev/null || true
  kill "$foreign_pid" 2>/dev/null || true; wait "$foreign_pid" 2>/dev/null || true

  section "selftest 3/4 — our own stub on a free port is accepted (the check is not vacuous)"
  STUB_SCRIPT="$tmp/script.json" STUB_PORT="$real_port" node "$ROOT/scripts/stub-llm.mjs" >"$tmp/real.log" 2>&1 &
  stub_pid=$!
  probe=0
  for _ in $(seq 1 30); do
    if stub_owns_port "$stub_pid" "$tmp/real.log" "$real_port"; then probe=1; break; fi
    sleep 0.2
  done
  if [ "$probe" = "1" ]; then pass "accepts our own stub (pid $stub_pid) on 127.0.0.1:$real_port"; else fail "did not recognise our own stub on a free port"; fi
  kill "$stub_pid" 2>/dev/null || true; wait "$stub_pid" 2>/dev/null || true

  section "selftest 4/4 — stale artifacts and a stale workspace (C2)"
  mkdir -p "$tmp/ws/.dsh/missions/M-stale" "$tmp/ws/.dsh/specs"
  printf '{}\n' > "$tmp/ws/.dsh/missions/M-stale/mission.json"
  if reset_workspace "$tmp/ws" && [ ! -e "$tmp/ws/.dsh" ]; then pass "reset_workspace removes a previous run's ledger"; else fail "reset_workspace left artifacts behind"; fi
  printf '{}\n' > "$tmp/old.json"
  touch -t 202001010000 "$tmp/old.json"
  : > "$tmp/sentinel"
  if postdates "$tmp/old.json" "$tmp/sentinel"; then fail "accepted an artifact from a previous run"; else pass "refuses an artifact that does not postdate the run start"; fi
  if postdates "$tmp/sentinel" "$tmp/old.json"; then pass "accepts a file written after the run start"; else fail "refused a fresh file"; fi

  section "selftest summary"
  if [ "$FAILURES" = "0" ]; then
    printf '  \033[32mSELFTEST GREEN\033[0m — every assertion above rejects its known-bad input.\n'
  else
    printf '  \033[31mSELFTEST RED\033[0m — %s check(s) failed: the E2E would report a false GREEN.\n' "$FAILURES"
    return 1
  fi

  # The ops scripts (archive/doctor/project-config/install/build-all) are the
  # other half of "is the tooling trustworthy": their own regressions are checked
  # by scripts/selftest-ops.sh, which is cheap and needs no dsh session.
  bash "$ROOT/scripts/selftest-ops.sh" || return 1
  return 0
}

if [ "$SELFTEST" = "1" ]; then
  selftest
  exit $?
fi

# ---------------------------------------------------------------------------
# 1. build the suite
# ---------------------------------------------------------------------------
section "1/6 build the suite"
if [ "$DO_BUILD" = "1" ]; then
  bash "$ROOT/scripts/build-all.sh"
else
  info "--no-build: reusing packages/*/dist"
fi

# ---------------------------------------------------------------------------
# 2. isolated DSH_HOME + profile (idempotent: wipe + recreate)
# ---------------------------------------------------------------------------
section "2/6 isolated profile under $E2E_HOME"
if [ "$KEEP" = "1" ]; then
  info "--keep: keeping $E2E_HOME/logs and DSH_HOME (the WORKSPACE is still wiped)"
else
  rm -rf "$E2E_HOME"
fi
mkdir -p "$E2E_HOME/profiles/$PROFILE" "$E2E_HOME/profiles/node_modules" "$LOGS"
# The workspace is reset on EVERY run, --keep included: stale `.dsh/missions`,
# `.dsh/specs` and `.dsh/audit` from an earlier run satisfy the `ls -t … | head -1`
# assertions below, which is what let a no-op model report GREEN (audit C2).
reset_workspace "$WS" || { fail "could not reset the scratch workspace $WS"; exit 1; }

# The launcher rewrites this file on every boot; it only anchors the loader.
printf '[]\n' > "$E2E_HOME/profiles/$PROFILE/cordis.yml"

node - "$E2E_HOME/profiles/$PROFILE/package.json" "${SUITE[@]}" <<'JS'
const fs = require('node:fs')
const [target, ...suite] = process.argv.slice(2)
const manifest = {
  name: 'dsh-profile-e2e-headless',
  private: true,
  dependencies: {},
  dsh: {
    profile: {
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', ...suite],
      patchReload: 'startup',
    },
  },
}
fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`)
JS

# Profile patch layer: the documented §4 recipe (workspaces row + storage
# overrides) plus the overrides this verification needs. Each plugin keeps its
# own log inside $E2E_HOME — the defaults write to ~/.dsh, which is outside
# this run's sandbox boundary.
# One row per plugin, DERIVED from SUITE. Listing these by hand is how a plugin
# that assembled fine once got reported as "missing" (it wrote to its default
# ~/.dsh log, outside this run) — and how the rows then ended up DUPLICATED when
# a second mechanism was added, which stopped the whole profile from loading.
# Special configs are a small table here, so exactly one place knows the list.
PLUGIN_ROWS=""
QUALITY_ROW=""
for pkg in "${SUITE[@]}"; do
  short="${pkg#dsh-}"
  if [ "$short" = "quality-gate" ]; then
    # The command list is host configuration, never model input: one required
    # command that passes, so the gate's verdict is a genuine, complete PASS.
    QUALITY_ROW="- id: quality-gate
  config:
    logFile: '$LOGS/quality-gate.log'
    commands:
      - id: smoke
        name: 冒烟命令
        command: node -e \"process.exit(0)\"
        required: true
        phase: gate"
    continue
  fi
  extra=""
  case "$short" in
    # approval: auto — no approval channel exists in headless, so the spec would
    # otherwise stay unapproved forever (and every write would be denied).
    spec-gate) extra=", approval: auto, enforce: true" ;;
    impact-gate) extra=", testCommandTemplate: 'go test {files}'" ;;
  esac
  PLUGIN_ROWS="${PLUGIN_ROWS}- id: ${short}
  config: { logFile: '${LOGS}/${short}.log'${extra} }
"
done

cat > "$E2E_HOME/profiles/$PROFILE/cordis.patch.yml" <<YAML
# Generated by scripts/e2e-mission.sh — do not edit by hand.
- config:
    - id: storage-json
      config:
        root: !!js dshHomePath('storages')

    - id: storage-domain
      config:
        backend: json

- insert:
    - id: workspace
      name: '@deepseek-ai/dsh-workspace'

# --- the isolated profile's own overrides -----------------------------------
# No human is attached to a headless run: the session-title LLM call would be a
# second, unscripted request, so it is switched off.
- id: session-title-llm
  disabled: true

${PLUGIN_ROWS}${QUALITY_ROW}
YAML

# Module resolution: the shipped @deepseek-ai packages come from the real
# profile, the suite from this working tree. The launcher heals the rest.
ln -sfn "$HOME/.dsh/profiles/node_modules/@deepseek-ai" "$E2E_HOME/profiles/node_modules/@deepseek-ai"
for pkg in "${SUITE[@]}" dsh-eng-core; do
  ln -sfn "$ROOT/packages/$pkg" "$E2E_HOME/profiles/node_modules/$pkg"
done
info "profile: $E2E_HOME/profiles/$PROFILE (bundles: ${SUITE[*]})"

# ---------------------------------------------------------------------------
# 3. the scripted model
# ---------------------------------------------------------------------------
# Logs are evidence, so they must not survive a previous run: under `--keep`
# the profile/workspace are reused, and a stale `applied (` line would satisfy
# the mount check below even if a plugin failed to load this time.
rm -f "$LOGS"/*.log

section "3/6 scripted model"
cat > "$E2E_HOME/script.json" <<'JSON'
{
  "steps": [
    {
      "tool": "orchestrate",
      "arguments": { "action": "stages" },
      "note": "probe: the orchestrator answers and lists the mounted suite"
    },
    {
      "tool": "spec_create",
      "arguments": {
        "title": "为 scratch 工作区添加 health 模块",
        "background": "端到端验证：真实 harness + 脚本化模型，证明十一个插件在活会话里工作。",
        "requirements": [
          "src/health.mjs 导出 health()，返回 { status: 'ok' }",
          "test/health.test.mjs 用 node --test 覆盖 health()"
        ],
        "acceptanceCriteria": [
          "调用 health() 返回 { status: 'ok' }",
          "node --test test/health.test.mjs 退出码为 0"
        ],
        "fileBoundaries": ["src/**", "test/**"],
        "negativeConstraints": ["不得修改 .dsh/ 下的工程台账", "不得修改本仓库 packages/** 源码"],
        "testDesign": "### 正向场景\n\n| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |\n|--------|----------|----------|----------|--------------|\n| TC-001 | 已安装 node | 运行 node -e \"import('./src/health.mjs').then(m => console.log(m.health()))\" | 退出码 0 且输出包含 status: ok | AC-001 |\n\n### 异常场景\n\n| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |\n|--------|----------|----------|----------|--------------|\n| TC-002 | 模块被改名 | 运行 node --test test/health.test.mjs | 退出码非 0 且 stderr 报模块解析失败 | AC-002 |\n\n### 边界场景\n\n| 用例ID | 前置条件 | 操作步骤 | 预期结果 | 覆盖验收标准 |\n|--------|----------|----------|----------|--------------|\n| TC-003 | 重复调用 health() | 连续调用两次并比较返回值 | 两次都是 status: ok 且互不共享可变状态 | AC-001 |\n"
      },
      "note": "spec-gate: create the specification and bind the session's mission"
    },
    {
      "tool": "test_design_review",
      "arguments": {},
      "expectResultContains": ["测试设计评审通过"],
      "note": "test-design-gate: the three scenario classes must pass review"
    },
    {
      "tool": "write",
      "arguments": { "file_path": "src/health.mjs", "content": "export const health = () => ({ status: 'ok' })\n" },
      "expectResultContains": ["尚未审批"],
      "note": "probe: a write BEFORE approval must be refused by spec-gate"
    },
    {
      "tool": "spec_approve",
      "arguments": { "note": "测试设计已通过，规格可审批（headless: approval=auto）" },
      "note": "spec-gate: approval unlocks the write tools"
    },
    {
      "tool": "write",
      "arguments": { "file_path": "src/health.mjs", "content": "export const health = () => ({ status: 'ok' })\n" },
      "note": "the implementation file, written by the real write tool"
    },
    {
      "tool": "write",
      "arguments": {
        "file_path": "test/health.test.mjs",
        "content": "import assert from 'node:assert/strict'\nimport test from 'node:test'\nimport { health } from '../src/health.mjs'\n\ntest('health() reports ok', () => {\n    assert.deepEqual(health(), { status: 'ok' })\n})\n"
      },
      "note": "the node --test case the acceptance criteria name"
    },
    {
      "tool": "bash",
      "arguments": { "command": "node --test test/health.test.mjs", "description": "Run the health module test" },
      "expectResultContains": ["pass 1"],
      "note": "real bash tool: the next request asserts this result really carries the test output"
    },
    {
      "tool": "evidence_record",
      "arguments": {
        "kind": "test",
        "summary": "node --test test/health.test.mjs: 1 passed",
        "command": "node --test test/health.test.mjs",
        "exitCode": 0,
        "output": "ok 1 - health() reports ok\n# tests 1\n# pass 1\n# fail 0"
      },
      "note": "evidence-gate: a successful test row (required kind)"
    },
    {
      "tool": "bash",
      "arguments": {
        "command": "node -e \"import('./src/health.mjs').then(m => console.log('health status =', m.health().status))\"",
        "description": "Call health() and print its status"
      },
      "expectResultContains": ["health status = ok"],
      "note": "real bash tool: an independent check of AC-001"
    },
    {
      "tool": "evidence_record",
      "arguments": {
        "kind": "command",
        "summary": "import('./src/health.mjs').then(...): health status = ok",
        "command": "node -e \"import('./src/health.mjs').then(m => console.log('health status =', m.health().status))\"",
        "exitCode": 0,
        "output": "health status = ok"
      },
      "note": "evidence-gate: a successful command row (required kind)"
    },
    {
      "tool": "quality_gate_run",
      "arguments": { "reason": "交付前跑宿主配置的门禁命令" },
      "expectResultContains": ["PASS"],
      "note": "quality-gate: the host-configured smoke command decides the verdict"
    },
    {
      "tool": "mission_complete",
      "arguments": { "summary": "health 模块与用例已交付（e2e-mission.sh）" },
      "expectResultContains": ["✅"],
      "note": "evidence-gate: issue the immutable receipt"
    },
    {
      "say": "health 模块与 node --test 用例已实现，测试与门禁均通过，mission 已交付并签发回执。",
      "note": "the only text-only turn: the agent loop stops here"
    }
  ]
}
JSON

STUB_SCRIPT="$E2E_HOME/script.json" node "$ROOT/scripts/stub-llm.mjs" --check >/dev/null
info "script: $E2E_HOME/script.json (14 steps, validated)"

STUB_PID=""
cleanup() {
  if [ -n "$STUB_PID" ] && kill -0 "$STUB_PID" 2>/dev/null; then
    kill -TERM "$STUB_PID" 2>/dev/null || true
    wait "$STUB_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

STUB_SCRIPT="$E2E_HOME/script.json" STUB_PORT="$PORT" node "$ROOT/scripts/stub-llm.mjs" >"$STUB_LOG" 2>&1 &
STUB_PID=$!

ready=0
for _ in $(seq 1 50); do
  # Our stub is gone (EADDRINUSE, a bad script, a crash): stop waiting for a port
  # that some OTHER process is answering.
  if ! kill -0 "$STUB_PID" 2>/dev/null; then
    break
  fi
  # Readiness needs all three: our pid alive, OUR OWN log naming this port, and
  # the port answering. The fetch alone says yes to any listener (audit C1).
  if stub_owns_port "$STUB_PID" "$STUB_LOG" "$PORT" &&
    node -e "fetch('http://127.0.0.1:${PORT}/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 0.2
done
if [ "$ready" != "1" ]; then
  fail "stub-llm is NOT the listener on 127.0.0.1:$PORT (our own log never said 'listening on http://127.0.0.1:$PORT', pid $STUB_PID)"
  if grep -qi 'EADDRINUSE' "$STUB_LOG" 2>/dev/null; then
    printf '  ---- port %s is already taken by a foreign process: something answered /health, but it is not the stub of this run\n' "$PORT" >&2
  fi
  sed -n '1,40p' "$STUB_LOG" >&2 || true
  exit 1
fi
pass "stub-llm healthy on 127.0.0.1:$PORT (pid $STUB_PID; our own log confirms the listener)"

# Start of the run, for the "did THIS run write this artifact?" assertions.
# `ls -t … | head -1` and `find … | head -1` return an older file just as
# happily as a fresh one (audit C2).
RUN_START="$E2E_HOME/.run-start"
: > "$RUN_START"

# ---------------------------------------------------------------------------
# 4. scratch workspace (git — the quality/evidence gates take the git path)
# ---------------------------------------------------------------------------
section "4/6 scratch workspace"
(
  cd "$WS"
  git init -q
  git config user.email "e2e@example.com"
  git config user.name "dsh e2e"
  git config commit.gpgsign false
  printf '# e2e scratch workspace\n\nCreated by scripts/e2e-mission.sh.\n' > README.md
  git add -A
  git commit -qm "chore: scratch workspace"
)
info "workspace: $WS ($(cd "$WS" && git rev-parse --short HEAD) on $(cd "$WS" && git rev-parse --abbrev-ref HEAD))"

# ---------------------------------------------------------------------------
# 5. run the real harness against the stub
# ---------------------------------------------------------------------------
section "5/6 dsh --profile $PROFILE against the stub"
info "sandbox mode for the child run: $PERMISSION_MODE (see the SANDBOX note in this script's header)"
TASK="在 src/health.mjs 实现 health() 模块并补上 node --test 用例，然后按工程套件的流程交付。"

DSH_PID=""
watchdog() {
  sleep "$TIMEOUT_SECONDS"
  if kill -0 "$DSH_PID" 2>/dev/null; then
    echo "e2e-mission: WATCHDOG fired after ${TIMEOUT_SECONDS}s — killing dsh (pid $DSH_PID)" >&2
    kill -TERM "$DSH_PID" 2>/dev/null || true
    sleep 2
    kill -KILL "$DSH_PID" 2>/dev/null || true
  fi
}

set +e
(
  cd "$WS"
  DSH_HOME="$E2E_HOME" \
  DEEPSEEK_BASE_URL="$BASE_URL" \
  DEEPSEEK_API_KEY="stub-key-not-a-secret" \
  DEEPSEEK_ALLOW_INSECURE_HTTP=1 \
  DSH_PERMISSION_MODE="$PERMISSION_MODE" \
  dsh --profile "$PROFILE" "$TASK"
) >"$DSH_LOG" 2>&1 &
DSH_PID=$!
watchdog &
WATCHDOG_PID=$!
wait "$DSH_PID"
DSH_RC=$?
kill "$WATCHDOG_PID" 2>/dev/null || true
wait "$WATCHDOG_PID" 2>/dev/null || true
DSH_PID=""
set -e

info "dsh exit code: $DSH_RC"
info "dsh stdout/stderr: $(wc -l < "$DSH_LOG" | tr -d ' ') lines → $DSH_LOG"

# ---------------------------------------------------------------------------
# 6. assertions
# ---------------------------------------------------------------------------
section "6/6 assertions"

STUB_FATALS="$(grep -c 'STUB-FATAL' "$STUB_LOG" || true)"
if [ "$STUB_FATALS" = "0" ]; then
  pass "stub served every request without a protocol/script violation"
else
  fail "stub reported $STUB_FATALS STUB-FATAL line(s) — see $STUB_LOG"
fi

# The decision count used to be an informational line, which is exactly what made
# the port clash silent: the run reported a delivered mission while the suite's
# own model server had served ZERO requests (audit C1). Count the steps from the
# script itself — never a literal — and require this stub to have served them.
# `< steps` (not `!= steps`) so a legitimately extra harness request is not a
# false RED, while "stopped early" and "someone else served the model" both fail.
STEPS_TOTAL="$(node -e 'process.stdout.write(String((require(process.argv[1]).steps ?? []).length))' "$E2E_HOME/script.json" 2>/dev/null || echo 0)"
DECISIONS="$(grep -c 'DECIDE' "$STUB_LOG" || true)"
if [ "$DECISIONS" -gt 0 ]; then
  pass "our own stub served the scripted model: $DECISIONS decision(s)"
else
  fail "our own stub served 0 decisions (the plan has $STEPS_TOTAL steps) — the agent never reached THIS model server"
fi
if [ "$DECISIONS" -lt "$STEPS_TOTAL" ]; then
  fail "the plan has $STEPS_TOTAL steps but the stub decided only $DECISIONS time(s): the flow stopped early (see $STUB_LOG)"
fi

if [ "$DSH_RC" = "0" ]; then
  pass "dsh exited 0"
else
  fail "dsh exited $DSH_RC"
fi

DOT="$WS/.dsh"
MISSION_JSON="$(ls -t "$DOT"/missions/*/mission.json 2>/dev/null | head -1 || true)"
if [ -n "$MISSION_JSON" ]; then
  MISSION_DIR="$(dirname "$MISSION_JSON")"
  MISSION_ID="$(basename "$MISSION_DIR")"
  pass "mission record exists: .dsh/missions/$MISSION_ID/mission.json"
else
  MISSION_ID=""
  fail "no .dsh/missions/*/mission.json"
fi

# Every other artifact assertion hangs off the id picked above, and `ls -t`
# returns a PREVIOUS run's mission when this run wrote none (audit C2). The
# record must therefore postdate $RUN_START.
if [ -n "$MISSION_JSON" ]; then
  if postdates "$MISSION_JSON" "$RUN_START"; then
    pass "the mission record was written by THIS run (postdates $RUN_START)"
  else
    fail "the newest mission record predates this run: $MISSION_JSON — a stale artifact, not evidence of this run"
  fi
fi

read_field() { # read_field <file> <js-expression over `m`>
  node -e "const m=require(process.argv[1]);const v=($2);process.stdout.write(v===undefined?'':String(v))" "$1" 2>/dev/null || true
}

if [ -n "$MISSION_ID" ]; then
  SPEC="$DOT/specs/$MISSION_ID.md"
  if [ -f "$SPEC" ]; then
    if grep -q 'AC-001' "$SPEC" && grep -q '## 验收标准' "$SPEC"; then
      pass "spec artifact .dsh/specs/$MISSION_ID.md carries the acceptance criteria"
    else
      fail "spec artifact exists but carries no 验收标准 / AC-001"
    fi
  else
    fail "spec artifact .dsh/specs/$MISSION_ID.md is missing"
  fi

  STATUS="$(read_field "$MISSION_JSON" 'm.status')"
  case "$STATUS" in
    delivered|completed|retrospected|closed) pass "mission status: $STATUS" ;;
    *) fail "mission status is '$STATUS' (expected delivered or later)" ;;
  esac

  APPROVED_AT="$(read_field "$MISSION_JSON" 'm.spec && m.spec.approvedAt')"
  if [ -n "$APPROVED_AT" ]; then
    pass "spec.approvedAt recorded (by $(read_field "$MISSION_JSON" 'm.spec && m.spec.approvedBy'))"
  else
    fail "spec.approvedAt missing — the specification was never approved"
  fi

  DESIGN_PASSED="$(read_field "$MISSION_JSON" 'm.testDesign && m.testDesign.passed')"
  DESIGN_CASES="$(read_field "$MISSION_JSON" 'm.testDesign && m.testDesign.cases && m.testDesign.cases.length')"
  if [ "$DESIGN_PASSED" = "true" ]; then
    pass "testDesign.passed === true ($DESIGN_CASES cases)"
  else
    fail "testDesign.passed is '$DESIGN_PASSED' (expected true)"
  fi

  GATE_FILE="$(grep -rl '"state": *"PASS"' "$MISSION_DIR/gates" 2>/dev/null | head -1 || true)"
  if [ -n "$GATE_FILE" ]; then
    GATE_FULL="$(read_field "$GATE_FILE" 'm.scope && m.scope.full')"
    GATE_RESULTS="$(read_field "$GATE_FILE" 'm.results && m.results.length')"
    if [ "$GATE_FULL" = "true" ] && [ "$GATE_RESULTS" != "0" ] && [ -n "$GATE_RESULTS" ]; then
      pass "gate $(basename "$GATE_FILE"): state PASS, scope.full === true, $GATE_RESULTS result(s)"
    else
      fail "gate $(basename "$GATE_FILE") is PASS but scope.full=$GATE_FULL results=$GATE_RESULTS"
    fi
  else
    fail "no gates/*.json with state PASS"
  fi

  RECEIPT="$(find "$MISSION_DIR/receipts" -name 'RCP-*.json' 2>/dev/null | head -1 || true)"
  if [ -n "$RECEIPT" ]; then
    pass "receipt $(basename "$RECEIPT") issued"
  else
    fail "no receipts/RCP-*.json — the mission was not delivered"
  fi

  RETRO="$(find "$MISSION_DIR" -maxdepth 1 -name 'retrospective.json' 2>/dev/null | head -1 || true)"
  if [ -n "$RETRO" ]; then
    pass "retrospective.json exists ($(wc -c < "$RETRO" | tr -d ' ') bytes)"
  else
    info "retrospective.json absent — expected: this run drives the tools directly, not the orchestrator pipeline"
  fi
fi

AUDIT_FILE="$(find "$DOT/audit" -maxdepth 1 -name '*.jsonl' 2>/dev/null | head -1 || true)"
if [ -n "$AUDIT_FILE" ]; then
  PRE_ROWS="$(grep -c '"phase":"pre"' "$AUDIT_FILE" || true)"
  RESULT_ROWS="$(grep -c '"phase":"result"' "$AUDIT_FILE" || true)"
  if [ "$PRE_ROWS" -gt 0 ] && [ "$RESULT_ROWS" -gt 0 ]; then
    pass "audit trail $(basename "$AUDIT_FILE"): $PRE_ROWS pre / $RESULT_ROWS result rows"
  else
    fail "audit trail has pre=$PRE_ROWS result=$RESULT_ROWS (expected both > 0)"
  fi
  # The pre-approval write is the ONE expected failure: seeing it in the audit
  # trail is how this run proves the write guard really fired live. Any other
  # errored tool call is a regression the artifact assertions would not catch.
  AUDIT_ERRORS="$(node -e '
const fs = require("node:fs")
const rows = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map((line) => JSON.parse(line))
const errors = rows.filter((row) => row.phase === "result" && row.isError === true).map((row) => row.tool)
process.stdout.write(errors.join(","))
' "$AUDIT_FILE" 2>/dev/null || true)"
  if [ "$AUDIT_ERRORS" = "write" ]; then
    pass "audit trail: exactly one errored tool call (write before approval) — every other tool succeeded"
  else
    fail "audit trail errored tool calls: '${AUDIT_ERRORS:-<none>}' (expected exactly 'write')"
  fi
else
  fail "no .dsh/audit/*.jsonl"
fi

for file in src/health.mjs test/health.test.mjs; do
  if [ -f "$WS/$file" ] && grep -q 'health' "$WS/$file"; then
    pass "the write tool really wrote $file"
  else
    fail "$file missing or empty — the write tool did not write it"
  fi
done

MOUNTED=0
MOUNT_MISSING=""
for pkg in "${SUITE[@]}"; do
  # The profile overrides name each log by its entry id, which is the short
  # name (dsh-spec-gate → spec-gate.log). "applied (" is the plugin's own mount
  # line — a file that merely exists proves nothing, and a HALF-mounted plugin
  # logs `applied (tools: …; failed: tool)` / `apply failed:` yet still matched
  # the plain grep (audit C3). mount_ok() is the single judge here, and
  # --selftest proves it rejects both of those logs.
  if mount_ok "$LOGS/${pkg#dsh-}.log"; then
    MOUNTED=$((MOUNTED + 1))
  else
    MOUNT_MISSING="$MOUNT_MISSING ${pkg#dsh-}"
  fi
done
if [ "$MOUNTED" = "${#SUITE[@]}" ]; then
  pass "all ${#SUITE[@]} plugins logged their own COMPLETE 'applied (' mount line under $LOGS"
else
  fail "only $MOUNTED/${#SUITE[@]} plugins mounted completely (missing or half-mounted:$MOUNT_MISSING)"
fi

# ---------------------------------------------------------------------------
# summary
# ---------------------------------------------------------------------------
section "summary"
if [ "$FAILURES" = "0" ]; then
  printf '  \033[32mE2E GREEN\033[0m — the fourteen plugins ran a real mission in a live dsh session.\n'
  printf '  artifacts: %s\n' "$DOT"
  printf '  logs:      %s\n' "$LOGS"
  exit 0
fi

printf '  \033[31mE2E RED\033[0m — %s assertion(s) failed.\n' "$FAILURES"
if [ "${STUB_FATALS:-0}" != "0" ]; then
  printf '\n  \033[33mNOTE\033[0m the stub itself failed %s expectation/protocol check(s): this is a STUB\n' "$STUB_FATALS"
  printf '       mismatch (the scripted model did not see what it expected), not a harness\n'
  printf '       failure. The dsh TRANSPORT error below is the consequence of the stub\n'
  printf '       exiting to make the divergence loud. Fix the script/expectation, or read the\n'
  printf '       STUB-FATAL detail to see which harness behaviour actually differed.\n'
  grep -A 6 'STUB-FATAL' "$STUB_LOG" | head -30 || true
fi
printf '\n  --- stub-llm.log (tail) ---\n'
tail -n 40 "$STUB_LOG" || true
printf '\n  --- dsh.log (tail) ---\n'
tail -n 60 "$DSH_LOG" || true
exit 1
