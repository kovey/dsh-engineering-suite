#!/usr/bin/env bash
# selftest-ops.sh — regression self-test for the verification/ops scripts
# themselves (not for the suite's packages).
#
# WHY: these scripts decide whether everything else is trustworthy, so a false
# GREEN from one of them is worse than a missing feature. The 2026-09 adversarial
# audit reproduced ten findings, and every one of them was a script reporting
# success (exit 0) while it had done nothing, the wrong thing, or had destroyed
# data:
#
#   C4  archive-missions: unknown flags ignored  → `--dryrun` (typo) really
#       archived missions, exit 0; `--workspace` with no value crashed with a
#       raw node TypeError
#   C5  archive-missions: no containment check   → `.dsh/missions` symlinked to
#       an external store had its missions MOVED into the repo archive; a missing
#       ledger reported "0 archived", exit 0
#   C6  doctor: dangling `--workspace` fell back to cwd → exit 0 "all green" for
#       a directory the user never asked about; `--workspace=<p>` was ignored
#   C7  project-config: appending to a `.gitignore` whose last line had no
#       newline concatenated the patterns (`node_modules` → `node_modules.dsh/…`)
#   C8  install-into-dsh: `ln -sfn` onto a real directory nested the link, so the
#       loader kept resolving the RELEASED build while the script said "done"
#   C9  install-into-dsh: `--profiles "a, b"` was not trimmed → everything was
#       silently "skipped", exit 0 with "done" (and the padding dodged the
#       production-tui guard); `--only typo` selected nothing, exit 0
#   C10 build/test/typecheck-all: a package-order.py failure was swallowed by the
#       process substitution → empty target list, exit 0 having checked nothing
#
# This script asserts the REFUSALS: each finding's input must now produce a
# non-zero exit and must not touch the thing it used to touch. It runs in a
# couple of seconds, touches only a mktemp directory, and never needs a build, a
# dsh session or the network.
#
# usage: bash scripts/selftest-ops.sh
# exit:  0 = every script still refuses its known-bad input; 1 = something regressed
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILURES=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
section() { printf '\n=== %s\n' "$*"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

LAST_OUT=""
LAST_RC=0
# run_rc <command…>: capture output+status without letting `set -e` kill the run.
run_rc() {
  if LAST_OUT="$("$@" 2>&1)"; then LAST_RC=0; else LAST_RC=$?; fi
}

# expect_rc <exit-code> <description> <command…>
expect_rc() {
  local want="$1" what="$2"
  shift 2
  run_rc "$@"
  if [ "$LAST_RC" = "$want" ]; then
    pass "$what (exit $LAST_RC)"
  else
    fail "$what: expected exit $want, got $LAST_RC — $LAST_OUT"
  fi
}

# A workspace with one delivered, archivable mission (the C4/C5 fixture).
make_missions_ws() { # make_missions_ws <dir>
  local ws="$1"
  rm -rf "$ws"
  mkdir -p "$ws/.dsh/missions/M-old/receipts"
  git -C "$ws" init -q
  node -e "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ id: 'M-old', title: '旧 mission', createdAt: Date.now() - 90 * 86400000, status: 'completed' }))" "$ws/.dsh/missions/M-old/mission.json"
  printf '{}\n' > "$ws/.dsh/missions/M-old/receipts/R-1.json"
}

ARCHIVE="$ROOT/scripts/archive-missions.mjs"
DOCTOR="$ROOT/scripts/doctor.mjs"

# ---------------------------------------------------------------------------
section "C4 — archive-missions: an unrecognised argument must not mutate"
# ---------------------------------------------------------------------------
WS="$TMP/c4"
make_missions_ws "$WS"
expect_rc 2 "a typo'd flag (--dryrun) is rejected" node "$ARCHIVE" --workspace "$WS" --dryrun --keep 0
if [ -d "$WS/.dsh/missions/M-old" ] && [ ! -e "$WS/.dsh/archive" ]; then
  pass "the rejected run moved nothing (mission still in missions/, no archive/)"
else
  fail "a rejected invocation still moved data: $(ls -R "$WS/.dsh" | tr '\n' ' ')"
fi
expect_rc 2 "--workspace with no value is a usage error (not a TypeError)" node "$ARCHIVE" --workspace
expect_rc 2 "--keep with a flag as its value is a usage error" node "$ARCHIVE" --keep --json
expect_rc 2 "--keep with a non-number is a usage error" node "$ARCHIVE" --keep abc
expect_rc 2 "two positional workspaces are a usage error" node "$ARCHIVE" "$TMP" "$TMP"
expect_rc 0 "--help still exits 0" node "$ARCHIVE" --help
expect_rc 0 "--dry-run --json still reports without moving" node "$ARCHIVE" --workspace "$WS" --dry-run --json --keep 0
if [ -d "$WS/.dsh/missions/M-old" ] && [ ! -e "$WS/.dsh/archive" ]; then
  pass "the dry run moved nothing"
else
  fail "a dry run moved data"
fi

# ---------------------------------------------------------------------------
section "C5 — archive-missions: the ledger must be inside the workspace"
# ---------------------------------------------------------------------------
WS="$TMP/c5"
EXT="$TMP/c5-external"
rm -rf "$WS" "$EXT"
mkdir -p "$WS/.dsh" "$EXT/M-ext/receipts"
git -C "$WS" init -q
node -e "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ id: 'M-ext', title: '外部台账', createdAt: Date.now() - 90 * 86400000, status: 'completed' }))" "$EXT/M-ext/mission.json"
ln -s "$EXT" "$WS/.dsh/missions"
expect_rc 1 "a missions dir that is a symlink out of the workspace is refused" node "$ARCHIVE" --workspace "$WS" --keep 0
if [ -d "$EXT/M-ext" ] && [ ! -e "$WS/.dsh/archive" ]; then
  pass "the external store is untouched (no mission moved out of it)"
else
  fail "the external ledger was modified by the refused archive"
fi
EMPTY="$TMP/c5-empty"
rm -rf "$EMPTY"
mkdir -p "$EMPTY"
git -C "$EMPTY" init -q
expect_rc 1 "a workspace without a ledger says so loudly (not '0 archived')" node "$ARCHIVE" --workspace "$EMPTY"
case "$LAST_OUT" in
  *还没有台账*) pass "the refusal names the missing ledger" ;;
  *) fail "the refusal does not explain the missing ledger: $LAST_OUT" ;;
esac

# ---------------------------------------------------------------------------
section "C6 — doctor: a dangling --workspace must not check the cwd"
# ---------------------------------------------------------------------------
expect_rc 2 "doctor --workspace with no value is a usage error" node "$DOCTOR" --workspace
expect_rc 2 "doctor --workspace= (empty) is a usage error" node "$DOCTOR" --workspace=
expect_rc 2 "doctor rejects an unknown flag" node "$DOCTOR" --nope
expect_rc 1 "doctor --workspace=<missing dir> inspects THAT path" node "$DOCTOR" --workspace="$TMP/nowhere-at-all"
case "$LAST_OUT" in
  *nowhere-at-all*) pass "the report names the requested workspace (the flag is honoured)" ;;
  *) fail "--workspace=<p> was ignored: $LAST_OUT" ;;
esac
# The old ordering bug must not come back: --json + positional + --workspace <p>
# in any order, all naming the same (missing) workspace.
for form in "--json --workspace=$TMP/nowhere-at-all" "--workspace $TMP/nowhere-at-all --json"; do
  expect_rc 1 "doctor accepts: $form" node "$DOCTOR" $form
  case "$LAST_OUT" in
    *nowhere-at-all*) pass "   …and it reports the requested workspace" ;;
    *) fail "   …but it reported something else: $LAST_OUT" ;;
  esac
done

# ---------------------------------------------------------------------------
section "C7 — project-config: appending to a .gitignore must not concatenate"
# ---------------------------------------------------------------------------
WS="$TMP/c7"
rm -rf "$WS"
mkdir -p "$WS"
git -C "$WS" init -q
printf '{"name":"c7","private":true}\n' > "$WS/package.json"
printf 'node_modules' > "$WS/.gitignore" # deliberately no trailing newline
expect_rc 0 "project-config --write succeeds" bash "$ROOT/scripts/project-config.sh" --workspace "$WS" --write --test "node --test"
if [ "$(head -1 "$WS/.gitignore")" = "node_modules" ]; then
  pass "the human's last line survives intact (no concatenation)"
else
  fail "the human's pattern was destroyed: $(head -1 "$WS/.gitignore")"
fi
if git -C "$WS" check-ignore -q node_modules; then
  pass "node_modules is still ignored"
else
  fail "node_modules is no longer ignored"
fi
if git -C "$WS" check-ignore -q .dsh/missions/; then
  pass "the runtime ledger is ignored"
else
  fail "the runtime ledger is NOT ignored"
fi

# ---------------------------------------------------------------------------
section "C8/C9 — install-into-dsh: no nesting, no silently skipped names"
# ---------------------------------------------------------------------------
INSTALL="$ROOT/scripts/install-into-dsh.sh"
HOME_FAKE="$TMP/dsh-home"
rm -rf "$HOME_FAKE"
mkdir -p "$HOME_FAKE/profiles/node_modules/dsh-role-guard/dist" "$HOME_FAKE/profiles/headless"
printf '{"name":"dsh-role-guard","version":"9.9.9-released"}\n' > "$HOME_FAKE/profiles/node_modules/dsh-role-guard/package.json"
printf '{"name":"p","dsh":{"profile":{"bundles":[]}}}\n' > "$HOME_FAKE/profiles/headless/package.json"

expect_rc 1 "a REAL directory in node_modules is refused" env DSH_HOME="$HOME_FAKE" bash "$INSTALL" --profiles headless --only dsh-role-guard
if [ -L "$HOME_FAKE/profiles/node_modules/dsh-role-guard" ]; then
  fail "the released build was replaced instead of refused"
elif [ -e "$HOME_FAKE/profiles/node_modules/dsh-role-guard/dsh-role-guard" ]; then
  fail "a link was nested inside the real directory (the loader still resolves the released build)"
else
  pass "nothing was nested or deleted; the released build is intact"
fi
case "$LAST_OUT" in
  *"rm -rf '$HOME_FAKE/profiles/node_modules/dsh-role-guard'"*)
    pass "the refusal hands over the exact rm -rf command" ;;
  *) fail "the refusal does not print the exact rm -rf command: $LAST_OUT" ;;
esac

expect_rc 2 "a padded profile name is trimmed and then reported as missing (hard error)" env DSH_HOME="$HOME_FAKE" bash "$INSTALL" --profiles "headless, nvim-tui" --only dsh-role-guard
expect_rc 2 "--profiles with no value is a usage error" env DSH_HOME="$HOME_FAKE" bash "$INSTALL" --profiles
expect_rc 3 "a padded ' tui' still hits the production-profile guard" env DSH_HOME="$HOME_FAKE" bash "$INSTALL" --profiles "headless, tui" --only dsh-role-guard
expect_rc 2 "--only with an unknown package name is a usage error (not a no-op)" env DSH_HOME="$HOME_FAKE" bash "$INSTALL" --profiles headless --only "dsh-role-guard, dsh-nope"
rm -rf "$HOME_FAKE/profiles/node_modules/dsh-role-guard"
expect_rc 0 "the happy path still links and appends" env DSH_HOME="$HOME_FAKE" bash "$INSTALL" --profiles headless --only dsh-role-guard
if [ -L "$HOME_FAKE/profiles/node_modules/dsh-role-guard" ]; then
  pass "the working tree is linked once the real directory is gone"
else
  fail "the happy path did not create the symlink"
fi

# ---------------------------------------------------------------------------
section "C10 — build/test/typecheck-all: an empty target list is a failure"
# ---------------------------------------------------------------------------
# A fake root with a `tsc` but no `packages/`: package-order.py fails, and the
# scripts must refuse instead of exiting 0 having checked nothing.
FAKE_ROOT="$TMP/fake-root"
mkdir -p "$FAKE_ROOT/scripts" "$FAKE_ROOT/node_modules/typescript/bin"
cp "$ROOT/scripts/package-order.py" "$FAKE_ROOT/scripts/"
: > "$FAKE_ROOT/node_modules/typescript/bin/tsc"
for script in build-all.sh typecheck-all.sh test-all.sh; do
  cp "$ROOT/scripts/$script" "$FAKE_ROOT/scripts/"
  expect_rc 1 "$script refuses an empty target list" bash "$FAKE_ROOT/scripts/$script"
done
# Even with python3 missing entirely (the other half of the finding).
expect_rc 1 "build-all.sh refuses when python3 is missing" env PATH=/usr/bin:/bin bash "$FAKE_ROOT/scripts/build-all.sh"

# ---------------------------------------------------------------------------
section "summary"
if [ "$FAILURES" = "0" ]; then
  printf '  \033[32mOPS SELFTEST GREEN\033[0m — every finding above is still refused.\n'
  exit 0
fi
printf '  \033[31mOPS SELFTEST RED\033[0m — %s check(s) regressed.\n' "$FAILURES"
exit 1
