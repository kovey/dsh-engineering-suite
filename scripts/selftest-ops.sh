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

# make_path_without <dir> <tool…>: a PATH that is THIS machine's PATH minus the
# named tools. A branch guarded by `command -v <tool>` cannot be exercised on a
# machine where that tool is installed, so "the branch exists" used to mean "read
# it and trust it". Handing the script a PATH where that one name cannot be
# resolved runs the branch for its own reason; everything else stays usable, so a
# failure means the branch misbehaves rather than the box being bare.
make_path_without() {
  local dir="$1" entry name target
  shift
  local omit=" $* "
  rm -rf "$dir"
  mkdir -p "$dir"
  local IFS=:
  for entry in $PATH; do
    [ -d "$entry" ] || continue
    for target in "$entry"/*; do
      [ -f "$target" ] && [ -x "$target" ] || continue
      name="${target##*/}"
      case "$omit" in *" $name "*) continue ;; esac
      [ -e "$dir/$name" ] && continue
      ln -s "$target" "$dir/$name"
    done
  done
}

# Three "this machine, minus one tool" fixtures, shared by the sections below.
# Eager on purpose: each is a plain directory of symlinks (no network, no build),
# and a missing/broken fixture should fail loudly at the top rather than halfway
# through whichever section happens to use it first.
NO_DSH_BIN="$TMP/bin-no-dsh"
NO_NODE_BIN="$TMP/bin-no-node"
NO_GIT_BIN="$TMP/bin-no-git"
make_path_without "$NO_DSH_BIN" dsh
make_path_without "$NO_NODE_BIN" node
make_path_without "$NO_GIT_BIN" git

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
# C11 — repair-profile-closure: the shared profile closure is a farm of symlinks
# into the installed dsh tree, and upgrading dsh renames packages, so the farm
# dangles. This script must (a) write NOTHING without --apply, (b) never replace
# a real directory with a link, (c) converge, and (d) fail when a root is wrong
# instead of reporting "0 dangling" from a tree it never read.
section "C11 — repair-profile-closure: dry-run writes nothing, apply converges, real dirs are safe"
CLOSURE="$TMP/closure"
TREE="$TMP/tree"
mkdir -p "$CLOSURE" "$TREE"
# three real packages in the tree
for name in alpha beta gamma; do mkdir -p "$TREE/$name"; printf '{"name":"%s"}' "$name" > "$TREE/$name/package.json"; done
# closure: one good link, one dangling link, one MISSING (no entry), one real dir
ln -s "$TREE/alpha" "$CLOSURE/alpha"
ln -s "$TREE/gone" "$CLOSURE/gone"
mkdir -p "$CLOSURE/beta"   # a real directory where a link belongs: must be left alone
printf 'keep me' > "$CLOSURE/beta/keep.txt"
BEFORE="$(ls -a "$CLOSURE" | sort | tr '\n' ' ')"
run_rc bash "$ROOT/scripts/repair-profile-closure.sh" --closure "$CLOSURE" --dsh-root "$TMP/fake-dsh"
[ "$LAST_RC" = "2" ] && pass "a tree that is not there is a usage error (exit 2)" || fail "a missing tree must exit 2, got $LAST_RC — $LAST_OUT"
AFTER="$(ls -a "$CLOSURE" | sort | tr '\n' ' ')"
[ "$BEFORE" = "$AFTER" ] && pass "the refused run touched nothing" || fail "the refused run changed the closure: $LAST_OUT"
# Build a fake dsh tree layout so the script can resolve it end to end.
mkdir -p "$TMP/fake-dsh/dsh/node_modules/@deepseek-ai"
cp -R "$TREE/." "$TMP/fake-dsh/dsh/node_modules/@deepseek-ai/"
run_rc bash "$ROOT/scripts/repair-profile-closure.sh" --closure "$CLOSURE" --dsh-root "$TMP/fake-dsh"
[ "$LAST_RC" = "1" ] && pass "dry-run reports work to do (exit 1)" || fail "dry-run with dangling links must exit 1, got $LAST_RC — $LAST_OUT"
AFTER="$(ls -a "$CLOSURE" | sort | tr '\n' ' ')"
[ "$BEFORE" = "$AFTER" ] && pass "dry-run wrote nothing" || fail "dry-run changed the closure: $LAST_OUT"
expect_rc 0 "apply converges" bash "$ROOT/scripts/repair-profile-closure.sh" --closure "$CLOSURE" --dsh-root "$TMP/fake-dsh" --apply
[ -d "$CLOSURE/beta" ] && [ -f "$CLOSURE/beta/keep.txt" ] && pass "a real directory is never replaced by a link" || fail "apply destroyed the real beta/ directory"
[ -e "$CLOSURE/gone" ] && fail "the dangling link was not removed" || pass "the dangling link is gone"
[ -e "$CLOSURE/gamma" ] && pass "the missing package was linked" || fail "gamma was not linked"
expect_rc 0 "a second apply is a no-op" bash "$ROOT/scripts/repair-profile-closure.sh" --closure "$CLOSURE" --dsh-root "$TMP/fake-dsh" --apply
# AC-003 of the host-audit-skip mission: the script's `command -v dsh` branch (used
# when --dsh-root is omitted) had no counter-test. On a machine without `dsh` it
# must refuse with exit 2 — "0 dangling" from a tree it could not locate is the
# false green this whole file exists to prevent.
expect_rc 2 "repair-profile-closure: no dsh on PATH is a usage error (exit 2), never '0 dangling'" \
  env PATH="$NO_DSH_BIN" bash "$ROOT/scripts/repair-profile-closure.sh" --closure "$CLOSURE"
case "$LAST_OUT" in
  *'no `dsh` on PATH'*) pass "repair-profile-closure: the no-dsh refusal names the missing dsh" ;;
  *) fail "repair-profile-closure: the no-dsh refusal does not explain itself — $LAST_OUT" ;;
esac

# ---------------------------------------------------------------------------
# C12 — check-host-api: an assumption table is only worth having if a missing
# member FAILS. A wrong tree must be a usage error, never "everything is fine".
section "C12 — check-host-api: a deleted host member is a failure, not a footnote"
HOST_TREE="$TMP/host-packages"
mkdir -p "$HOST_TREE/dsh/lib/types" "$HOST_TREE/dsh-user-approval/lib/types"
printf '{"version":"9.9.9"}' > "$HOST_TREE/dsh/package.json"
printf 'export interface S { request(r: R): Promise<O>; }\n' > "$HOST_TREE/dsh-user-approval/lib/types/index.d.ts"
expect_rc 1 "a member that the host does not declare fails the check" bash "$ROOT/scripts/check-host-api.sh" --harness-root "$HOST_TREE"
# Same tree, but now the member exists: the required rows we can satisfy must pass.
for pkg in dsh-subprocess dsh-subagent dsh-agent-preset-registry dsh-user-questions dsh-workspace-changes dsh-agent-team; do mkdir -p "$HOST_TREE/$pkg/lib/types"; done
printf 'export declare class R { spawn(s: never): never; }\n' > "$HOST_TREE/dsh-subprocess/lib/types/index.d.ts"
# listDescendants, not the pre-0.2.2 `list`: the fixture tracks the surface the
# host really declares, otherwise this test would pin our stale memory instead.
printf 'export declare class R { startActivation(s: never): never; getProvider(n: string): unknown; listDescendants(r: never, s?: never): never; registerProvider(p: never): unknown; prompt(r: never, s: never): never; sendMessage(a: never, b: never, c: never, d: never): never; }\n' > "$HOST_TREE/dsh-subagent/lib/types/index.d.ts"
printf 'export declare class R { register(d: unknown): unknown; mount(c: never, i: string): never; }\n' > "$HOST_TREE/dsh-agent-preset-registry/lib/types/index.d.ts"
printf 'export declare class R { ask(r: never): never; askTimed(r: never): never; }\n' > "$HOST_TREE/dsh-user-questions/lib/types/index.d.ts"
printf 'export interface W { summary: string; diff: string; }\n' > "$HOST_TREE/dsh-workspace-changes/lib/types/index.d.ts"
# The optional row: the package exists and its six members are audited like any
# other. An optional row that is never exercised is how `dsh-experimental-agent-team`
# stayed SKIP across the rc.2 → rc.4 check while we called a method it did not have.
AGENT_TEAM_OK='export declare class R { isEnabled(c: never): boolean; setEnabled(c: never, e: boolean): never; createTask(c: never, r: never): never; getTask(c: never, i: never): never; listTasks(c: never): never; updateTask(c: never, r: never): never; }'
AGENT_TEAM_SHORT='export declare class R { isEnabled(c: never): boolean; setEnabled(c: never, e: boolean): never; createTask(c: never, r: never): never; getTask(c: never, i: never): never; listTasks(c: never): never; }'
printf '%s\n' "$AGENT_TEAM_OK" > "$HOST_TREE/dsh-agent-team/lib/types/index.d.ts"
run_rc bash "$ROOT/scripts/check-host-api.sh" --harness-root "$HOST_TREE" --quiet
[ "$LAST_RC" = "0" ] && pass "a fully-declared host passes (exit 0)" || fail "a declared host should pass, got $LAST_RC — $LAST_OUT"
# `optional` excuses "not installed", never "renamed": with the package present, a
# member we call but the host no longer declares must fail AND name the member.
printf '%s\n' "$AGENT_TEAM_SHORT" > "$HOST_TREE/dsh-agent-team/lib/types/index.d.ts"
run_rc bash "$ROOT/scripts/check-host-api.sh" --harness-root "$HOST_TREE" --quiet
if [ "$LAST_RC" = "1" ] && printf '%s' "$LAST_OUT" | grep -q 'updateTask'; then
  pass "an installed optional package is still audited (renamed member → exit 1, named)"
else
  fail "a renamed member in an installed optional package must exit 1 and name it, got $LAST_RC — $LAST_OUT"
fi
# The other half of `optional`: a package that is NOT installed is a skip, not a
# failure (the real profile may not ship it).
rm -rf "$HOST_TREE/dsh-agent-team"
run_rc bash "$ROOT/scripts/check-host-api.sh" --harness-root "$HOST_TREE" --quiet
[ "$LAST_RC" = "0" ] && pass "an optional package that is not installed is skipped, not failed" || fail "a missing optional package must not fail, got $LAST_RC — $LAST_OUT"
printf 'export declare class R { startActivation(s: never): never; }\n' > "$HOST_TREE/dsh-subagent/lib/types/index.d.ts"
expect_rc 1 "one renamed member (the real 0.2.1 incident) fails the whole check" bash "$ROOT/scripts/check-host-api.sh" --harness-root "$HOST_TREE" --quiet
expect_rc 2 "a tree that does not exist is a usage error (exit 2)" bash "$ROOT/scripts/check-host-api.sh" --harness-root "$TMP/no-such-tree"
# AC-003 of the host-audit-skip mission: the OTHER `command -v dsh` branch (no
# --harness-root given) had no counter-test. With no dsh to locate the host with,
# "could not look" must be exit 2 — never 0 with zero assumptions checked.
expect_rc 2 "check-host-api: no dsh on PATH and no --harness-root is a usage error (exit 2)" \
  env PATH="$NO_DSH_BIN" bash "$ROOT/scripts/check-host-api.sh" --quiet
case "$LAST_OUT" in
  *'no `dsh` on PATH'*) pass "check-host-api: the no-dsh refusal names the missing dsh" ;;
  *) fail "check-host-api: the no-dsh refusal does not explain itself — $LAST_OUT" ;;
esac

# ---------------------------------------------------------------------------
# C13 — verify.sh --changed: the iteration mode must SELECT the touched packages,
# keep the full command intact, and refuse when it cannot tell what changed. A
# partial run that silently reports green would be worse than no fast path.
section "C13 — verify.sh --changed: selects the touched package, refuses without git"
# A stub workspace: verify.sh derives ROOT from its own location, so a copy in a
# temp tree runs against stubs and never touches the real repository.
CHANGED_TREE="$TMP/changed-tree"
mkdir -p "$CHANGED_TREE/scripts" "$CHANGED_TREE/packages/dsh-alpha/src" "$CHANGED_TREE/packages/dsh-beta/src"
cp "$ROOT/scripts/verify.sh" "$CHANGED_TREE/scripts/verify.sh"
for stub in build-all typecheck-all test-all; do
  printf '#!/usr/bin/env bash\nprintf "%%s %%s\\n" "%s" "$*"\n' "$stub" > "$CHANGED_TREE/scripts/$stub.sh"
  chmod +x "$CHANGED_TREE/scripts/$stub.sh"
done
mkdir -p "$CHANGED_TREE/test"
printf 'export {};\n' > "$CHANGED_TREE/test/noop.test.ts"
(cd "$CHANGED_TREE" && git init -q . && git config user.email selftest@example.com && git config user.name selftest && \
  git add -A >/dev/null 2>&1 && git commit -qm base >/dev/null 2>&1 && printf 'x\n' > packages/dsh-alpha/src/index.ts)
changed_out="$(cd "$CHANGED_TREE" && bash scripts/verify.sh --changed 2>&1 || true)"
case "$changed_out" in
  *"部分验收"*) pass "changed: prints the partial-run banner" ;;
  *) fail "changed: the banner is missing" "$changed_out" ;;
esac
case "$changed_out" in
  *"交付依据是完整"*) pass "changed: states that it is not a delivery argument" ;;
  *) fail "changed: the disclaimer is missing" "$changed_out" ;;
esac
case "$changed_out" in
  *"test-all --quiet dsh-alpha"*) pass "changed: only the touched package reaches the runner" ;;
  *) fail "changed: the runner did not receive exactly the touched package" "$changed_out" ;;
esac
case "$changed_out" in
  *dsh-beta*) fail "changed: an untouched package was run" "$changed_out" ;;
  *) pass "changed: untouched packages are skipped" ;;
esac
# No changes at all: a fast, loud no-op — never a green "verified".
# The touched file is UNTRACKED, so `checkout -- .` cannot remove it; clean it.
(cd "$CHANGED_TREE" && git clean -qfd 2>/dev/null || true; git checkout -q -- . 2>/dev/null || true)
nochange_out="$(cd "$CHANGED_TREE" && bash scripts/verify.sh --changed 2>&1 || true)"
case "$nochange_out" in
  *"没有包内改动"*) pass "changed: an empty change set says so instead of passing" ;;
  *) fail "changed: an empty change set did not report itself" "$nochange_out" ;;
esac
# Not a git work tree: refuse (exit 2), never print green.
rm -rf "$CHANGED_TREE/.git"
expect_rc 2 "changed: a tree without git is refused" bash "$CHANGED_TREE/scripts/verify.sh" --changed
# AC-003 of the host-audit-skip mission: the `command -v git` probe above needs its own
# counter-test too — the case just above removes .git, which is a different refusal.
# No git BINARY at all must still be exit 2 with a reason, never "no changes, exit 0".
expect_rc 2 "changed: no git binary on PATH is a refusal (exit 2), not 'no changes'" \
  env PATH="$NO_GIT_BIN" bash "$ROOT/scripts/verify.sh" --changed
case "$LAST_OUT" in
  *"无法判定改动集"*) pass "changed: the no-git-binary refusal explains itself" ;;
  *) fail "changed: the no-git-binary refusal does not explain itself — $LAST_OUT" ;;
esac

# C14 — wait-quiet: quiescence detection is what stops the "gate while the agent
# is still writing" collision (a 2-minute acceptance run thrown away).
section "C14 — wait-quiet: a settling tree passes, a moving one times out"
QUIET_DIR="$TMP/quiet-dir"
mkdir -p "$QUIET_DIR"
expect_rc 0 "wait-quiet: a still tree passes" bash "$ROOT/scripts/wait-quiet.sh" 1 5 "$QUIET_DIR"
# A writer that keeps touching a file: the wait must refuse rather than claim quiet.
( for _ in 1 2 3 4 5 6 7 8 9 10; do printf 'tick\n' >> "$QUIET_DIR/moving.txt"; sleep 0.4; done ) &
writer=$!
expect_rc 1 "wait-quiet: a moving tree times out instead of claiming quiet" bash "$ROOT/scripts/wait-quiet.sh" 1 3 "$QUIET_DIR"
wait "$writer" 2>/dev/null || true
expect_rc 2 "wait-quiet: a missing path is a usage error" bash "$ROOT/scripts/wait-quiet.sh" 1 5 "$TMP/definitely-absent"

# C15 — migrate-to-engineering-suite: dry-run must not move anything, apply must
# be reversible and idempotent, and a conflict must stop BEFORE any move. The
# point of the migration is that OTHER plugins' runtime files stay where they are.
section "C15 — migrate-to-engineering-suite: dry-run, apply, idempotent, conflict-safe"
MIG="$TMP/migrate"
mkdir -p "$MIG/.dsh/missions" "$MIG/.dsh/specs" "$MIG/.dsh/chat-history" "$MIG/.dsh/feishu-cards"
printf '{"commands":[]}' > "$MIG/.dsh/quality-gate.json"
printf '{"app":1}' > "$MIG/.dsh/feishu-app.json"
printf '{"messages":1}' > "$MIG/.dsh/chat-history/oc_x.json"
printf 'x\n' > "$MIG/.dsh/releases.jsonl"
printf 'spec\n' > "$MIG/.dsh/specs/m.md"

expect_rc 1 "dry-run reports work to do" bash "$ROOT/scripts/migrate-to-engineering-suite.sh" --workspace "$MIG"
test -d "$MIG/.dsh/engineering-suite" && fail "dry-run created the target directory" || pass "dry-run moved nothing"

expect_rc 0 "apply migrates" bash "$ROOT/scripts/migrate-to-engineering-suite.sh" --workspace "$MIG" --apply
test -f "$MIG/.dsh/engineering-suite/quality-gate.json" && pass "a suite config moved into the namespace" || fail "the config did not move"
test -f "$MIG/.dsh/engineering-suite/releases.jsonl" && pass "a suite ledger moved into the namespace" || fail "the ledger did not move"
test -f "$MIG/.dsh/chat-history/oc_x.json" && pass "another plugin's runtime file stayed put" || fail "the script moved a foreign file"
test -f "$MIG/.dsh/feishu-app.json" && pass "a foreign top-level file stayed put" || fail "the script moved a foreign top-level file"

expect_rc 0 "a second apply is a no-op" bash "$ROOT/scripts/migrate-to-engineering-suite.sh" --workspace "$MIG" --apply

# Conflict: the same name on both sides must stop the run before moving anything.
CONFLICT="$TMP/migrate-conflict"
mkdir -p "$CONFLICT/.dsh/engineering-suite"
printf 'old\n' > "$CONFLICT/.dsh/releases.jsonl"
printf 'new\n' > "$CONFLICT/.dsh/engineering-suite/releases.jsonl"
expect_rc 2 "a conflict refuses instead of overwriting" bash "$ROOT/scripts/migrate-to-engineering-suite.sh" --workspace "$CONFLICT" --apply
[ "$(cat "$CONFLICT/.dsh/releases.jsonl")" = "old" ] && pass "the conflict left the source untouched" || fail "the conflict modified the source"

# C17 — standards-check.sh: 结构规范检查必须能被质量门禁当命令调用。它不重新实现规则，
# 而是调 dist 里的引擎；这里钉住三个方向：脚本存在且语法正确、脚手架只在目标仓库真的
# 能跑它时才装配、以及退出码的两个方向（无新增 → 0；新增/缺基线/缺规范 → 非 0）。
# 夹具放在 mktemp 目录里：脚本按自身位置推导仓库根，所以一个复制品只会测那个临时树。
section "C17 — standards-check.sh: 棘轮退出码 + project-config 的装配条件"
STANDARDS_CHECK="$ROOT/scripts/standards-check.sh"
if [ -f "$STANDARDS_CHECK" ]; then
  pass "standards-check: scripts/standards-check.sh exists"
else
  fail "standards-check: scripts/standards-check.sh is missing"
fi
expect_rc 0 "standards-check: the script parses (bash -n)" bash -n "$STANDARDS_CHECK"
if grep -q 'bash scripts/standards-check.sh --quiet' "$ROOT/scripts/project-config.sh" && \
   grep -q '"id": "standards"' "$ROOT/scripts/project-config.sh"; then
  pass "project-config: carries the standards command template"
else
  fail "project-config: the standards command template is missing"
fi

# 临时仓库：引擎通过符号链接可达（node 解析真实路径后从本仓库的 node_modules 找
# dsh-eng-core），而 walkWorkspace 不跟随目录符号链接，所以引擎不会被当成被测代码。
FIX="$TMP/c17"
rm -rf "$FIX"
mkdir -p "$FIX/scripts" "$FIX/src" "$FIX/.dsh/engineering-suite"
cp "$STANDARDS_CHECK" "$FIX/scripts/standards-check.sh"
chmod +x "$FIX/scripts/standards-check.sh"
ln -s "$ROOT/packages" "$FIX/packages"
printf '{"name":"demo","scripts":{"test":"node --test"}}\n' > "$FIX/package.json"
printf 'export const alpha = 1\n' > "$FIX/src/small.ts"
cat > "$FIX/.dsh/engineering-suite/standards.json" <<'JSON'
{"languages": {"ts": {"maxFileLines": 300, "maxFunctionLines": 60, "maxDepth": 4, "maxIfBlockLines": 20, "maxParams": 5, "maxExports": 15}}}
JSON
printf '{"version":1,"frozenAt":"2026-11-11T00:00:00.000Z","accepted":[]}\n' > "$FIX/.dsh/engineering-suite/standards-baseline.json"

expect_rc 0 "standards-check: a clean tree passes (exit 0)" bash "$FIX/scripts/standards-check.sh" --quiet
case "$LAST_OUT" in
  *"PASS"*) pass "standards-check: --quiet prints a PASS summary" ;;
  *) fail "standards-check: --quiet did not report PASS — $LAST_OUT" ;;
esac
# AC-003 of the host-audit-skip mission: the `command -v node` branch had no
# counter-test. Without node the engine cannot be measured at all, so the verdict
# must be exit 1 ("无法检查"), never 0 — a skipped check is not a pass.
expect_rc 1 "standards-check: no node on PATH is exit 1 (cannot check is not a pass)" \
  env PATH="$NO_NODE_BIN" bash "$STANDARDS_CHECK" --quiet
case "$LAST_OUT" in
  *"找不到 node"*) pass "standards-check: the no-node failure names the missing node" ;;
  *) fail "standards-check: the no-node failure does not explain itself — $LAST_OUT" ;;
esac

# 一行一个数组元素：只触发 maxFileLines（不额外触发导出面/函数行数），让计数可断言。
{ printf 'export const values = [\n'; for index in $(seq 1 320); do printf '  %s,\n' "$index"; done; printf ']\n'; } > "$FIX/src/big.ts"
expect_rc 1 "standards-check: a new violation fails (exit 1)" bash "$FIX/scripts/standards-check.sh" --quiet
case "$LAST_OUT" in
  *"新增 1 项"*) pass "standards-check: the failure names the new-violation count" ;;
  *) fail "standards-check: the failure did not name the count — $LAST_OUT" ;;
esac

# observe 规则：同一个违规，规则标了 observe 就只能记录（"影子"），不得让命令失败——
# 这是 rules 映射与插件共用的 applyRuleModes 语义，脚本不能自己发明第二种解释。
cp "$FIX/.dsh/engineering-suite/standards.json" "$TMP/c17-standards.json"
cat > "$FIX/.dsh/engineering-suite/standards.json" <<'JSON'
{"languages": {"ts": {"maxFileLines": 300}}, "rules": {"maxFileLines": "observe"}}
JSON
expect_rc 0 "standards-check: an observe rule reports without blocking (exit 0)" bash "$FIX/scripts/standards-check.sh" --quiet
case "$LAST_OUT" in
  *observe*) pass "standards-check: the shadow verdict is still reported as observe" ;;
  *) fail "standards-check: the observe rule was not reported — $LAST_OUT" ;;
esac
cp "$TMP/c17-standards.json" "$FIX/.dsh/engineering-suite/standards.json"

rm -f "$FIX/.dsh/engineering-suite/standards-baseline.json"
expect_rc 1 "standards-check: a missing baseline fails instead of passing silently" bash "$FIX/scripts/standards-check.sh" --quiet
case "$LAST_OUT" in
  *"没有基线"*) pass "standards-check: the missing baseline is stated explicitly" ;;
  *) fail "standards-check: the missing baseline was not stated — $LAST_OUT" ;;
esac

rm -f "$FIX/.dsh/engineering-suite/standards.json"
expect_rc 1 "standards-check: a missing standards file is a failure (exit 1)" bash "$FIX/scripts/standards-check.sh" --quiet
case "$LAST_OUT" in
  *standards_bootstrap*) pass "standards-check: the missing standards file names the next step" ;;
  *) fail "standards-check: the missing standards file did not name standards_bootstrap — $LAST_OUT" ;;
esac

# C17b — 同一份夹具上，脚本的三种计数必须等于插件函数路径的三种计数。
#
# 为什么需要它：脚本和插件曾经给出 574 / 568 两个"已接受"（2026-11-11），那次是引擎
# 构建不同源；但同样形状的分叉也会来自"比较逻辑只改一处"——例如脚本自己拼 standards
# 对象、自己定义键、自己数 bucket。这里把脚本路径与插件路径（loadStandards →
# measureWorkspace → readBaseline → compareViolations，全在同一份 dist）并排跑，
# 任何一边单独改动都会让两种计数不等，且失败信息会把两个值都点出来。
PARITY="$TMP/c17-parity"
rm -rf "$PARITY"
mkdir -p "$PARITY/scripts" "$PARITY/src" "$PARITY/.dsh/engineering-suite"
cp "$STANDARDS_CHECK" "$PARITY/scripts/standards-check.sh"
chmod +x "$PARITY/scripts/standards-check.sh"
ln -s "$ROOT/packages" "$PARITY/packages"
printf '{"name":"parity-demo"}\n' > "$PARITY/package.json"
cat > "$PARITY/.dsh/engineering-suite/standards.json" <<'JSON'
{"languages": {"ts": {"maxFileLines": 100}}}
JSON
# 三个文件各只触发 maxFileLines，让三种计数各为 1：
#   known.ts  120 行，基线接受 130 → known（在基线的尺度以内）
#   worse.ts  200 行，基线接受 150 → worsened（旧债变大）
#   added.ts  150 行，基线里没有   → added（新债）
node -e '
  const fs = require("node:fs")
  const dir = process.argv[1]
  const lines = (count) =>
    `export const values = [\n${Array.from({ length: count - 2 }, (_, index) => `  ${index},`).join("\n")}\n]\n`
  fs.writeFileSync(`${dir}/src/known.ts`, lines(120))
  fs.writeFileSync(`${dir}/src/worse.ts`, lines(200))
  fs.writeFileSync(`${dir}/src/added.ts`, lines(150))
  const key = (file) => `maxFileLines|src/${file}.ts|(file)`
  const baseline = {
    version: 1,
    frozenAt: "2026-11-11T00:00:00.000Z",
    accepted: [key("known"), key("worse")],
    entries: [
      { key: key("known"), actual: 130, limit: 100 },
      { key: key("worse"), actual: 150, limit: 100 },
    ],
  }
  fs.writeFileSync(`${dir}/.dsh/engineering-suite/standards-baseline.json`, `${JSON.stringify(baseline, null, 2)}\n`)
' "$PARITY"

# 插件路径：与脚本逐字对齐的一串调用（同样的 config 解析、同样四个函数）。
plugin_counts="$(node --input-type=module - "$ROOT" "$PARITY" <<'NODE'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.argv[2]
const fixture = process.argv[3]
const load = (pkg, file) => import(pathToFileURL(path.join(root, 'packages', pkg, 'dist', file)).href)

const { measureWorkspace } = await load('dsh-eng-core', 'metrics.js')
const { resolveLayout } = await load('dsh-eng-core', 'paths.js')
const configModule = await load('dsh-standards-gate', 'config.js')
const { readBaseline, compareViolations } = await load('dsh-standards-gate', 'baseline.js')
const tools = await load('dsh-standards-gate', 'tools.js')
const { resolveEffectiveConfig } = await load('dsh-standards-gate', 'index.js')

const config = resolveEffectiveConfig(configModule.resolveConfig({}), resolveLayout(fixture, {}), {
  warn: () => {},
}).config
const standardsRel = configModule.standardsFileOf(fixture, config)
const loaded = tools.loadStandards(fixture, standardsRel)
if (loaded.standards === undefined) {
  console.error(`plugin path cannot read the fixture standards: ${loaded.problem ?? 'unknown'}`)
  process.exit(2)
}
const result = measureWorkspace({
  cwd: fixture,
  standards: loaded.standards,
  maxFiles: config.maxFiles,
  maxFileBytes: config.maxFileBytes,
})
const baseline = readBaseline(tools.artifactPathOf(fixture, configModule.baselineFileOf(fixture, config)))
const comparison = compareViolations(result.violations, baseline)
process.stdout.write(`${comparison.known.length} ${comparison.added.length} ${comparison.worsened.length}\n`)
NODE
)"

run_rc bash "$PARITY/scripts/standards-check.sh" --quiet
PARITY_RC="$LAST_RC"
# quiet 摘要的固定形状：`新增 A 项、恶化 W 项规范违规（基线已接受 K 项）`；
# 重排成插件路径的 `known added worsened` 再比较。
PARITY_SCRIPT_COUNTS="$(printf '%s\n' "$LAST_OUT" | sed -n 's/.*新增 \([0-9][0-9]*\) 项、恶化 \([0-9][0-9]*\) 项规范违规（基线已接受 \([0-9][0-9]*\) 项）.*/\3 \1 \2/p' | head -n 1)"

if [ "$plugin_counts" = "1 1 1" ]; then
  pass "standards-check parity: the fixture exercises all three buckets (1 1 1)"
else
  fail "standards-check parity: the fixture no longer covers accepted/added/worsened — the plugin path says [$plugin_counts], expected [1 1 1]"
fi
if [ "$PARITY_RC" = "1" ]; then
  pass "standards-check parity: the script blocks on an added violation (exit 1)"
else
  fail "standards-check parity: expected exit 1 from the script, got $PARITY_RC — $LAST_OUT"
fi
if [ "$PARITY_SCRIPT_COUNTS" = "$plugin_counts" ]; then
  pass "standards-check parity: the script and the plugin's own comparison agree ($PARITY_SCRIPT_COUNTS)"
else
  fail "standards-check parity: the script says [$PARITY_SCRIPT_COUNTS] but the plugin's own comparison says [$plugin_counts] — the two judgments have diverged"
fi

expect_rc 0 "project-config: scaffolding works on a repo that has the script" bash "$ROOT/scripts/project-config.sh" --workspace "$FIX" --json
case "$LAST_OUT" in
  *'"id": "standards"'*'"required": true'*) pass "project-config: the generated config carries id=standards + required" ;;
  *) fail "project-config: the generated config has no standards command — $LAST_OUT" ;;
esac

NOFIX="$TMP/c17-nofix"
rm -rf "$NOFIX"
mkdir -p "$NOFIX"
printf '{"name":"demo","scripts":{"test":"node --test"}}\n' > "$NOFIX/package.json"
expect_rc 0 "project-config: a repo without the script still scaffolds" bash "$ROOT/scripts/project-config.sh" --workspace "$NOFIX" --json
case "$LAST_OUT" in
  *'"id": "standards"'*) fail "project-config: scaffolded a command whose script does not exist" ;;
  *) pass "project-config: no standards command when the script is absent" ;;
esac
bash "$ROOT/scripts/project-config.sh" --workspace "$NOFIX" > "$TMP/c17-nofix.out" 2>&1 || true
if grep -q 'standards : 跳过' "$TMP/c17-nofix.out"; then
  pass "project-config: prints why the standards command was skipped"
else
  fail "project-config: the skip reason is missing — $(cat "$TMP/c17-nofix.out")"
fi

# C18 — flaky-hunt.sh: 一次偶发失败的价值全在"名字"上。只留下 "exit 1" 的失败，下一次
# 还是只能靠重跑；所以这里钉住：脚本存在/语法可解析、--help 能跑、--runs 的边界被拒
# （0 次采样不是"通过"），以及两条最小行为——全绿必须写"未复现 + 采样次数"，失败必须
# exit 1 并把 TMPDIR 下的日志目录打印出来（日志不写进仓库）。采样命令用 true/false，
# 日志落在本 self-test 自己的临时目录里，跑完随 $TMP 一起消失，不在仓库或系统临时区留垃圾。
section "C18 — flaky-hunt.sh: 采样、退出码与 --runs 的边界"
FLAKY_HUNT="$ROOT/scripts/flaky-hunt.sh"
if [ -f "$FLAKY_HUNT" ]; then
  pass "flaky-hunt: scripts/flaky-hunt.sh exists"
else
  fail "flaky-hunt: scripts/flaky-hunt.sh is missing"
fi
expect_rc 0 "flaky-hunt: the script parses (bash -n)" bash -n "$FLAKY_HUNT"
expect_rc 0 "flaky-hunt: --help exits 0" bash "$FLAKY_HUNT" --help
case "$LAST_OUT" in
  *"--runs N"*"--command"*) pass "flaky-hunt: --help documents --runs/--command" ;;
  *) fail "flaky-hunt: --help does not document the flags — $LAST_OUT" ;;
esac
expect_rc 2 "flaky-hunt: --runs 0 is a usage error (0 samples is not a pass)" bash "$FLAKY_HUNT" --runs 0
expect_rc 2 "flaky-hunt: a non-numeric --runs is a usage error" bash "$FLAKY_HUNT" --runs abc

HUNT_LOGS="$TMP/c18-logs"
mkdir -p "$HUNT_LOGS"
HUNT_LOGS_REAL="$(cd "$HUNT_LOGS" && pwd -P)"
expect_rc 0 "flaky-hunt: --runs 1 --command true is green (exit 0)" env TMPDIR="$HUNT_LOGS" bash "$FLAKY_HUNT" --runs 1 --command true
case "$LAST_OUT" in
  *"未复现"*"1 次采样"*) pass "flaky-hunt: a green sample says 未复现 + the sample count" ;;
  *) fail "flaky-hunt: a green sample did not report 未复现 with the sample count — $LAST_OUT" ;;
esac
expect_rc 1 "flaky-hunt: --runs 1 --command false fails (exit 1)" env TMPDIR="$HUNT_LOGS" bash "$FLAKY_HUNT" --runs 1 --command false
case "$LAST_OUT" in
  *"没有可识别的失败包"*) pass "flaky-hunt: a nameless failure says so instead of inventing a name" ;;
  *) fail "flaky-hunt: the nameless failure was not reported — $LAST_OUT" ;;
esac
case "$LAST_OUT" in
  *"$HUNT_LOGS_REAL"*) pass "flaky-hunt: the log directory under TMPDIR is printed (nothing lands in the repo)" ;;
  *) fail "flaky-hunt: the log path was not printed — $LAST_OUT" ;;
esac
# AC-003 of the host-audit-skip mission: the `command -v node` branch ("node 不可用：
# 跳过单独重跑") had no counter-test. It is a diagnostic skip, not a verdict, so
# the failure conclusion must survive it — exit 1 and "本次失败仍然成立" (a missing
# tool must never turn a failed sample into a pass).
expect_rc 1 "flaky-hunt: without node the isolated rerun is skipped, the failure still exits 1" \
  env TMPDIR="$HUNT_LOGS" PATH="$NO_NODE_BIN" bash "$FLAKY_HUNT" --runs 1 \
  --command "printf '==> dsh-alpha (exit 1)\\n'; exit 1"
case "$LAST_OUT" in
  *"node 不可用：跳过单独重跑"*) pass "flaky-hunt: the no-node skip is announced with its reason" ;;
  *) fail "flaky-hunt: the no-node skip was silent — $LAST_OUT" ;;
esac
case "$LAST_OUT" in
  *"本次失败仍然成立"*) pass "flaky-hunt: the skip keeps the failure conclusion (never a pass)" ;;
  *) fail "flaky-hunt: the skip does not keep the failure conclusion — $LAST_OUT" ;;
esac

# C19 — migrate-layout.sh: 迁移一个仓库的布局是"数据搬家"，所以这里钉住的不是"搬成功了"
# 而是四条边界：
#   1. 默认 dry-run 一个字节都不写；
#   2. 只搬白名单，其它插件的数据（memory/、chat-interaction/、probe-*）原地不动；
#   3. 目标已有同名条目 → 拒绝该条、不覆盖、退出码 1（其余条目照常搬，不是整仓放弃）；
#   4. 无 .dsh 的仓库报"无可迁移"并 exit 0；rename 失败时 copy+校验+删除，
#      副本校验不通过时**源必须还在**（不得删除未成功迁移的数据）。
# 夹具全部在 $TMP 里；库里只读脚本本身。
section "C19 — migrate-layout.sh: dry-run 零写盘、白名单、冲突拒绝、无可迁移、回滚"
MIGRATE_LAYOUT="$ROOT/scripts/migrate-layout.sh"
if [ -f "$MIGRATE_LAYOUT" ]; then
  pass "migrate-layout: scripts/migrate-layout.sh exists"
else
  fail "migrate-layout: scripts/migrate-layout.sh is missing"
fi
expect_rc 0 "migrate-layout: the script parses (bash -n)" bash -n "$MIGRATE_LAYOUT"
expect_rc 0 "migrate-layout: --help exits 0" bash "$MIGRATE_LAYOUT" --help
case "$LAST_OUT" in
  *"--repo <path>"*"--apply"*"--rollback"*) pass "migrate-layout: --help documents --repo/--apply/--rollback" ;;
  *) fail "migrate-layout: --help does not document the flags — $LAST_OUT" ;;
esac
expect_rc 2 "migrate-layout: no --repo is a usage error (never defaults to cwd)" bash "$MIGRATE_LAYOUT"
expect_rc 2 "migrate-layout: --repo with no value is a usage error" bash "$MIGRATE_LAYOUT" --repo
expect_rc 2 "migrate-layout: an unknown flag is a usage error" bash "$MIGRATE_LAYOUT" --repo "$TMP" --nope
expect_rc 2 "migrate-layout: a repo path that does not exist is a usage error" bash "$MIGRATE_LAYOUT" --repo "$TMP/c19-absent"

LEGACY="$TMP/c19-legacy"
mkdir -p "$LEGACY/.dsh/specs" "$LEGACY/.dsh/missions/M1" "$LEGACY/.dsh/memory" "$LEGACY/.dsh/chat-interaction"
printf '{}\n' > "$LEGACY/.dsh/quality-gate.json"
printf 'spec\n' > "$LEGACY/.dsh/specs/M1.md"
printf 'mission\n' > "$LEGACY/.dsh/missions/M1/mission.json"
printf 'row\n' > "$LEGACY/.dsh/plan.jsonl"
printf 'keep-memory\n' > "$LEGACY/.dsh/memory/s.json"
printf 'keep-chat\n' > "$LEGACY/.dsh/chat-interaction/c.json"
printf 'keep-probe\n' > "$LEGACY/.dsh/probe-task-active"

expect_rc 1 "migrate-layout: a dry run with work to do exits 1" bash "$MIGRATE_LAYOUT" --repo "$LEGACY"
if [ -e "$LEGACY/.dsh/engineering-suite" ]; then
  fail "migrate-layout: the dry run created the target namespace"
else
  pass "migrate-layout: the dry run wrote nothing"
fi
case "$LAST_OUT" in
  *"将迁移 4 项"*"保持不动 3 项"*"冲突 0 项"*)
    pass "migrate-layout: the dry run classifies 4 suite entries vs 3 foreign ones" ;;
  *) fail "migrate-layout: the dry-run plan is wrong — $LAST_OUT" ;;
esac

expect_rc 0 "migrate-layout: --apply migrates" bash "$MIGRATE_LAYOUT" --repo "$LEGACY" --apply
if [ -f "$LEGACY/.dsh/engineering-suite/quality-gate.json" ] && \
   [ -f "$LEGACY/.dsh/engineering-suite/specs/M1.md" ] && \
   [ -f "$LEGACY/.dsh/engineering-suite/missions/M1/mission.json" ] && \
   [ -f "$LEGACY/.dsh/engineering-suite/plan.jsonl" ]; then
  pass "migrate-layout: every whitelisted entry moved into .dsh/engineering-suite"
else
  fail "migrate-layout: a whitelisted entry did not move — $(find "$LEGACY/.dsh" -mindepth 1 | tr '\n' ' ')"
fi
if [ ! -e "$LEGACY/.dsh/quality-gate.json" ] && [ ! -e "$LEGACY/.dsh/specs" ] && [ ! -e "$LEGACY/.dsh/plan.jsonl" ]; then
  pass "migrate-layout: the migrated entries left the legacy root"
else
  fail "migrate-layout: migrated entries were left behind in .dsh/"
fi
if [ "$(cat "$LEGACY/.dsh/memory/s.json")" = "keep-memory" ] && \
   [ "$(cat "$LEGACY/.dsh/chat-interaction/c.json")" = "keep-chat" ] && \
   [ "$(cat "$LEGACY/.dsh/probe-task-active")" = "keep-probe" ]; then
  pass "migrate-layout: another plugin's data (memory/, chat-interaction/, probe-*) stayed put"
else
  fail "migrate-layout: the migration touched a foreign entry"
fi
expect_rc 0 "migrate-layout: a second --apply is a no-op" bash "$MIGRATE_LAYOUT" --repo "$LEGACY" --apply

expect_rc 1 "migrate-layout: --rollback is a dry run by default" bash "$MIGRATE_LAYOUT" --repo "$LEGACY" --rollback
if [ -f "$LEGACY/.dsh/engineering-suite/quality-gate.json" ]; then
  pass "migrate-layout: the rollback dry run moved nothing"
else
  fail "migrate-layout: the rollback dry run moved data"
fi
expect_rc 0 "migrate-layout: --rollback --apply moves the suite entries back" bash "$MIGRATE_LAYOUT" --repo "$LEGACY" --rollback --apply
if [ -f "$LEGACY/.dsh/quality-gate.json" ] && [ -f "$LEGACY/.dsh/specs/M1.md" ] && [ ! -d "$LEGACY/.dsh/engineering-suite" ]; then
  pass "migrate-layout: rollback restored .dsh/ and removed the now-empty namespace"
else
  fail "migrate-layout: rollback did not restore the legacy layout"
fi
if [ -f "$LEGACY/.dsh/memory/s.json" ] && [ -f "$LEGACY/.dsh/chat-interaction/c.json" ]; then
  pass "migrate-layout: rollback left the foreign entries untouched"
else
  fail "migrate-layout: rollback touched a foreign entry"
fi
expect_rc 0 "migrate-layout: a second --rollback --apply is a no-op" bash "$MIGRATE_LAYOUT" --repo "$LEGACY" --rollback --apply
expect_rc 0 "migrate-layout: migrating again after a rollback works" bash "$MIGRATE_LAYOUT" --repo "$LEGACY" --apply

# Conflict: same name on both sides must be refused ENTRY BY ENTRY (not merged, not
# overwritten), while the rest of the repo still migrates; exit code stays non-zero.
CONFLICT19="$TMP/c19-conflict"
mkdir -p "$CONFLICT19/.dsh/engineering-suite"
printf 'legacy releases\n' > "$CONFLICT19/.dsh/releases.jsonl"
printf 'migrated releases\n' > "$CONFLICT19/.dsh/engineering-suite/releases.jsonl"
printf '{}\n' > "$CONFLICT19/.dsh/quality-gate.json"
expect_rc 1 "migrate-layout: a conflict makes --apply exit 1" bash "$MIGRATE_LAYOUT" --repo "$CONFLICT19" --apply
if [ "$(cat "$CONFLICT19/.dsh/releases.jsonl")" = "legacy releases" ] && \
   [ "$(cat "$CONFLICT19/.dsh/engineering-suite/releases.jsonl")" = "migrated releases" ]; then
  pass "migrate-layout: the conflicting entry was neither overwritten nor merged"
else
  fail "migrate-layout: the conflict modified one of the two files"
fi
if [ -f "$CONFLICT19/.dsh/engineering-suite/quality-gate.json" ] && [ ! -e "$CONFLICT19/.dsh/quality-gate.json" ]; then
  pass "migrate-layout: a non-conflicting entry still migrated in the same run"
else
  fail "migrate-layout: a conflict aborted the whole repo instead of refusing one entry"
fi
case "$LAST_OUT" in
  *"冲突 1 项"*"已存在"*) pass "migrate-layout: the conflict is listed with its target path" ;;
  *) fail "migrate-layout: the conflict was not listed — $LAST_OUT" ;;
esac

# No .dsh at all: "nothing to migrate" and exit 0 — not an error, and not a silent pass.
NODSH="$TMP/c19-no-dsh"
mkdir -p "$NODSH"
expect_rc 0 "migrate-layout: a repo without .dsh exits 0" bash "$MIGRATE_LAYOUT" --repo "$NODSH"
case "$LAST_OUT" in
  *"无可迁移"*) pass "migrate-layout: a repo without .dsh says 无可迁移" ;;
  *) fail "migrate-layout: the no-.dsh repo was not reported — $LAST_OUT" ;;
esac

# Cross-device rename failure → copy+verify+delete. The self-test cannot create a
# second filesystem, so a fake `mv` (always failing) selects the fallback path; a
# fake `cp` that copies NOTHING then proves the source survives a failed verify.
COPY="$TMP/c19-copy"
mkdir -p "$COPY/.dsh/specs" "$COPY/.dsh/missions/M1"
printf 'spec-body\n' > "$COPY/.dsh/specs/M1.md"
printf 'mission\n' > "$COPY/.dsh/missions/M1/mission.json"
FAKE_MV="$TMP/c19-fake-mv"
mkdir -p "$FAKE_MV"
printf '#!/bin/sh\nexit 1\n' > "$FAKE_MV/mv"
chmod +x "$FAKE_MV/mv"
expect_rc 0 "migrate-layout: rename failure falls back to copy+verify+delete" env PATH="$FAKE_MV:$PATH" bash "$MIGRATE_LAYOUT" --repo "$COPY" --apply
if [ -f "$COPY/.dsh/engineering-suite/specs/M1.md" ] && [ ! -e "$COPY/.dsh/specs" ] && \
   [ "$(cat "$COPY/.dsh/engineering-suite/missions/M1/mission.json")" = "mission" ]; then
  pass "migrate-layout: the copy fallback preserved the data and removed the source"
else
  fail "migrate-layout: the copy fallback lost or duplicated data"
fi

BADCOPY="$TMP/c19-bad-copy"
mkdir -p "$BADCOPY/.dsh/specs"
printf 'must-survive\n' > "$BADCOPY/.dsh/specs/M9.md"
FAKE_CP="$TMP/c19-fake-cp"
mkdir -p "$FAKE_CP"
printf '#!/bin/sh\nexit 1\n' > "$FAKE_CP/mv"
printf '#!/bin/sh\nexit 0\n' > "$FAKE_CP/cp"
chmod +x "$FAKE_CP/mv" "$FAKE_CP/cp"
expect_rc 1 "migrate-layout: a copy that does not verify is a failure (exit 1)" env PATH="$FAKE_CP:$PATH" bash "$MIGRATE_LAYOUT" --repo "$BADCOPY" --apply
if [ "$(cat "$BADCOPY/.dsh/specs/M9.md" 2>/dev/null)" = "must-survive" ]; then
  pass "migrate-layout: an unverified copy never deletes its source"
else
  fail "migrate-layout: a failed copy deleted the source (data loss)"
fi
if [ ! -d "$BADCOPY/.dsh/engineering-suite" ]; then
  pass "migrate-layout: a failed migration removes the empty namespace it created"
else
  fail "migrate-layout: an empty namespace was left behind (resolveLayout would point at it)"
fi

# Several --repo values in one invocation: each repo gets its own section, and a
# clean repo plus a no-.dsh repo is still exit 0.
expect_rc 0 "migrate-layout: multiple --repo values are all processed" bash "$MIGRATE_LAYOUT" --repo "$LEGACY" --repo "$NODSH"
if [ "$(printf '%s\n' "$LAST_OUT" | grep -c '^=== ')" = "2" ]; then
  pass "migrate-layout: one report section per repo"
else
  fail "migrate-layout: expected 2 repo sections — $LAST_OUT"
fi

# ---------------------------------------------------------------------------
# C20 — fix-profile-install: the 0.8.13 incident was an install that exited 0
# with zero dist. Three things must hold: the config is repaired (placeholder ->
# explicit boolean, `strictDepBuilds: false` removed, the suite's repo-URL
# approval kept), the repair is a fixed point (a second run writes nothing), and
# the acceptance checks refuse a profile whose artifacts are missing — exit 0 is
# never evidence that dist exists.
section "C20 — fix-profile-install: config converges, no dist is a failure"
FIX_INSTALL="$ROOT/scripts/fix-profile-install.mjs"
PROFILE20="$TMP/c20-profile"
SUITE20="$PROFILE20/node_modules/dsh-engineering-suite"
mkdir -p "$SUITE20/packages/dsh-alpha/dist" "$PROFILE20/node_modules/dsh-spec-gate"
printf '{"name":"dsh-engineering-suite","version":"9.9.9"}\n' > "$SUITE20/package.json"
printf '{"name":"dsh-alpha"}\n' > "$SUITE20/packages/dsh-alpha/package.json"
printf 'export {}\n' > "$SUITE20/packages/dsh-alpha/dist/index.js"
printf '{"name":"dsh-spec-gate","main":"index.js"}\n' > "$PROFILE20/node_modules/dsh-spec-gate/package.json"
printf 'module.exports = {}\n' > "$PROFILE20/node_modules/dsh-spec-gate/index.js"
printf '{"name":"dsh-profile-fake","private":true}\n' > "$PROFILE20/package.json"
cat > "$PROFILE20/pnpm-workspace.yaml" <<'YAML'
packages:
  - .

nodeLinker: hoisted
allowBuilds:
  'dsh-engineering-suite@git+https://github.com/kovey/dsh-engineering-suite.git': true
  protobufjs: set this to true or false
strictDepBuilds: false
YAML
BEFORE20="$(cat "$PROFILE20/pnpm-workspace.yaml")"
expect_rc 0 "fix-profile-install: a dry run plans the fix without writing" node "$FIX_INSTALL" --profile "$PROFILE20"
if [ "$(cat "$PROFILE20/pnpm-workspace.yaml")" = "$BEFORE20" ]; then
  pass "fix-profile-install: the dry run left the config byte-identical"
else
  fail "fix-profile-install: the dry run wrote to pnpm-workspace.yaml"
fi
if printf '%s\n' "$LAST_OUT" | grep -qF 'protobufjs: set this to true or false'; then
  pass "fix-profile-install: the dry run names the placeholder it will replace"
else
  fail "fix-profile-install: the dry run did not report the placeholder — $LAST_OUT"
fi
expect_rc 0 "fix-profile-install: --apply --skip-install converges (checks run, pnpm skipped)" \
  node "$FIX_INSTALL" --profile "$PROFILE20" --apply --skip-install
CFG20="$(cat "$PROFILE20/pnpm-workspace.yaml")"
printf '%s\n' "$CFG20" | grep -qx '  protobufjs: false' \
  && pass "fix-profile-install: the placeholder became an explicit false" \
  || fail "fix-profile-install: protobufjs is not an explicit boolean — $CFG20"
printf '%s\n' "$CFG20" | grep -q '^strictDepBuilds' \
  && fail "fix-profile-install: strictDepBuilds survived (it silences the blocked build)" \
  || pass "fix-profile-install: strictDepBuilds is gone (pnpm default true restored)"
printf '%s\n' "$CFG20" | grep -qF "'dsh-engineering-suite@git+https://github.com/kovey/dsh-engineering-suite.git': true" \
  && pass "fix-profile-install: the suite's repository-URL approval is kept" \
  || fail "fix-profile-install: the suite's allowBuilds entry was dropped — $CFG20"
case "$LAST_OUT" in
  *"dist 1/1"*) pass "fix-profile-install: the acceptance checks ran and passed on the fixture" ;;
  *) fail "fix-profile-install: the three checks did not report dist 1/1 — $LAST_OUT" ;;
esac
BAK20="$(ls "$PROFILE20"/pnpm-workspace.yaml.bak-* 2>/dev/null | wc -l | tr -d ' ')"
expect_rc 0 "fix-profile-install: a second --apply --skip-install is a no-op" \
  node "$FIX_INSTALL" --profile "$PROFILE20" --apply --skip-install
if [ "$(ls "$PROFILE20"/pnpm-workspace.yaml.bak-* 2>/dev/null | wc -l | tr -d ' ')" = "$BAK20" ]; then
  pass "fix-profile-install: the second run wrote no new backup (a fixed point)"
else
  fail "fix-profile-install: the second run rewrote the config"
fi
expect_rc 0 "fix-profile-install: --check passes on a complete profile" node "$FIX_INSTALL" --profile "$PROFILE20" --check
rm "$SUITE20/packages/dsh-alpha/dist/index.js"
expect_rc 1 "fix-profile-install: a profile without dist can never pass" node "$FIX_INSTALL" --profile "$PROFILE20" --check
case "$LAST_OUT" in
  *"dist 0/1"*) pass "fix-profile-install: the failure names the missing dist" ;;
  *) fail "fix-profile-install: the no-dist failure did not name the count — $LAST_OUT" ;;
esac
expect_rc 1 "fix-profile-install: --skip-install still refuses a profile without dist" \
  node "$FIX_INSTALL" --profile "$PROFILE20" --apply --skip-install
printf 'export {}\n' > "$SUITE20/packages/dsh-alpha/dist/index.js"
expect_rc 1 "fix-profile-install: --expect-version catches a stale install" \
  node "$FIX_INSTALL" --profile "$PROFILE20" --check --expect-version 0.0.0
rm -rf "$PROFILE20/node_modules/dsh-spec-gate"
mkdir -p "$TMP/c20-external"
printf '{"name":"dsh-spec-gate","main":"index.js"}\n' > "$TMP/c20-external/package.json"
printf 'module.exports = {}\n' > "$TMP/c20-external/index.js"
ln -s "$TMP/c20-external" "$PROFILE20/node_modules/dsh-spec-gate"
expect_rc 1 "fix-profile-install: a bundle resolving outside the profile is a failure" \
  node "$FIX_INSTALL" --profile "$PROFILE20" --check
# The explicit prepare must be what creates dist: a fake pnpm (no network here)
# exits 0 and builds nothing, a stub prepare-install.mjs writes the artifact.
PROFILE20C="$TMP/c20-explicit-prepare"
SUITE20C="$PROFILE20C/node_modules/dsh-engineering-suite"
mkdir -p "$SUITE20C/scripts" "$SUITE20C/packages/dsh-alpha" "$PROFILE20C/node_modules/dsh-spec-gate"
printf '{"name":"dsh-engineering-suite","version":"9.9.9"}\n' > "$SUITE20C/package.json"
printf '{"name":"dsh-alpha"}\n' > "$SUITE20C/packages/dsh-alpha/package.json"
cat > "$SUITE20C/scripts/prepare-install.mjs" <<'JS'
import fs from 'node:fs'
import path from 'node:path'
const dist = path.join(import.meta.dirname, '..', 'packages', 'dsh-alpha', 'dist')
fs.mkdirSync(dist, { recursive: true })
fs.writeFileSync(path.join(dist, 'index.js'), 'export {}\n')
console.log('stub prepare-install: built 1 package')
JS
printf '{"name":"dsh-spec-gate","main":"index.js"}\n' > "$PROFILE20C/node_modules/dsh-spec-gate/package.json"
printf 'module.exports = {}\n' > "$PROFILE20C/node_modules/dsh-spec-gate/index.js"
printf '{"name":"dsh-profile-fake","private":true}\n' > "$PROFILE20C/package.json"
printf "allowBuilds:\n  'dsh-engineering-suite@git+https://github.com/kovey/dsh-engineering-suite.git': true\n" > "$PROFILE20C/pnpm-workspace.yaml"
FAKE_PNPM="$TMP/c20-bin"
mkdir -p "$FAKE_PNPM"
printf '#!/bin/sh\nprintf "fake pnpm %%s\\n" "$*"\nexit 0\n' > "$FAKE_PNPM/pnpm"
chmod +x "$FAKE_PNPM/pnpm"
expect_rc 0 "fix-profile-install: the explicit prepare is what creates dist" \
  env PATH="$FAKE_PNPM:$PATH" node "$FIX_INSTALL" --profile "$PROFILE20C" --apply
case "$LAST_OUT" in
  *"fake pnpm install"*) pass "fix-profile-install: pnpm install really ran (not silently skipped)" ;;
  *) fail "fix-profile-install: pnpm install was not invoked — $LAST_OUT" ;;
esac
if [ -f "$SUITE20C/packages/dsh-alpha/dist/index.js" ]; then
  pass "fix-profile-install: dist exists even though pnpm built nothing"
else
  fail "fix-profile-install: dist was not created by the explicit prepare-install.mjs"
fi
printf '#!/bin/sh\nprintf "fake pnpm: registry unreachable\\n" >&2\nexit 1\n' > "$FAKE_PNPM/pnpm"
rm -f "$SUITE20C/packages/dsh-alpha/dist/index.js"
expect_rc 1 "fix-profile-install: a failed install stops before prepare (exit non-zero)" \
  env PATH="$FAKE_PNPM:$PATH" node "$FIX_INSTALL" --profile "$PROFILE20C" --apply
if [ -f "$SUITE20C/packages/dsh-alpha/dist/index.js" ]; then
  fail "fix-profile-install: prepare ran after a failed install and reported dist anyway"
else
  pass "fix-profile-install: prepare did not run after a failed install"
fi
case "$LAST_OUT" in
  *"回滚"*) pass "fix-profile-install: the failure carries the rollback hint" ;;
  *) fail "fix-profile-install: no rollback hint on failure — $LAST_OUT" ;;
esac
# A fresh profile may have no pnpm-workspace.yaml at all: creating it must work,
# and the created file must still approve the suite's build.
PROFILE20D="$TMP/c20-created-config"
cp -R "$PROFILE20C" "$PROFILE20D"
rm -f "$PROFILE20D/pnpm-workspace.yaml" "$PROFILE20D"/pnpm-workspace.yaml.bak-*
printf '#!/bin/sh\nprintf "fake pnpm %%s\\n" "$*"\nexit 0\n' > "$FAKE_PNPM/pnpm"
expect_rc 0 "fix-profile-install: a profile without pnpm-workspace.yaml gets one" \
  env PATH="$FAKE_PNPM:$PATH" node "$FIX_INSTALL" --profile "$PROFILE20D" --apply
if grep -qF "'dsh-engineering-suite@git+" "$PROFILE20D/pnpm-workspace.yaml"; then
  pass "fix-profile-install: the created config approves the suite build"
else
  fail "fix-profile-install: the created config does not approve the suite — $(cat "$PROFILE20D/pnpm-workspace.yaml")"
fi
PROFILE20B="$TMP/c20-no-allowbuilds"
mkdir -p "$PROFILE20B"
printf '{"name":"dsh-profile-fake","private":true}\n' > "$PROFILE20B/package.json"
printf 'nodeLinker: hoisted\n' > "$PROFILE20B/pnpm-workspace.yaml"
expect_rc 0 "fix-profile-install: a missing allowBuilds block is planned, not refused" \
  node "$FIX_INSTALL" --profile "$PROFILE20B"
if grep -qF "'dsh-engineering-suite@git+" "$PROFILE20B/pnpm-workspace.yaml"; then
  fail "fix-profile-install: the dry run created the block it was only supposed to plan"
else
  pass "fix-profile-install: the missing block stays unwritten in a dry run"
fi
expect_rc 2 "fix-profile-install: --apply with --check is a usage error" \
  node "$FIX_INSTALL" --profile "$PROFILE20B" --apply --check

# ---------------------------------------------------------------------------
# C21 — host-audit-stage.sh: the SKIP branch has to be PROVEN, not trusted.
# verify.sh used to decide inline whether it could run check-host-api.sh, and no
# test ever executed the "there is no dsh" side: deleting the probe, or rewriting
# the skip as a green, would have changed the acceptance run's meaning silently.
# The stage is now scripts/host-audit-stage.sh, and this section drives it:
#   ① no `dsh` on PATH          → exit 0, first line `SKIP host API audit:` + reason;
#   ② a `dsh` whose audit FAILS → non-zero, and the audit's OWN code (1 / 2) passes
#                                 through unchanged — a 0 here is the swallowed
#                                 verdict this file exists to prevent;
#   ③ the skip sentence must say it is NOT a pass (`这不是通过`), never ok/PASS;
# plus the verify.sh side — run_stage's quiet capture must print that sentence as
# SKIP, not hide it behind `ok`.
section "C21 — host-audit-stage.sh: SKIP is announced, an audit failure is not swallowed"
HOST_AUDIT_STAGE="$ROOT/scripts/host-audit-stage.sh"
if [ -f "$HOST_AUDIT_STAGE" ]; then
  pass "host-audit-stage: scripts/host-audit-stage.sh exists"
else
  fail "host-audit-stage: scripts/host-audit-stage.sh is missing"
fi
expect_rc 0 "host-audit-stage: the script parses (bash -n)" bash -n "$HOST_AUDIT_STAGE"
# Fixture sanity first: if the "no dsh" PATH still resolved dsh, ① would run the
# audit instead of the skip branch, still exit 0, and prove nothing.
if (PATH="$NO_DSH_BIN"; command -v dsh >/dev/null 2>&1); then
  fail "host-audit-stage fixture: $NO_DSH_BIN still resolves dsh (case ① would prove nothing)"
else
  pass "host-audit-stage fixture: no dsh is resolvable under $NO_DSH_BIN"
fi

# ① PATH without dsh: exit 0 (a skip is not a failure) with the reason on the
# FIRST line, because that is the line run_stage keys on.
run_rc env PATH="$NO_DSH_BIN" bash "$HOST_AUDIT_STAGE"
if [ "$LAST_RC" = "0" ]; then
  pass "host-audit-stage: no dsh is exit 0 (skip is not a failure)"
else
  fail "host-audit-stage: no dsh must exit 0, got $LAST_RC — $LAST_OUT"
fi
case "$LAST_OUT" in
  'SKIP host API audit:'*) pass "host-audit-stage: the first line is the SKIP sentence" ;;
  *) fail "host-audit-stage: output does not start with 'SKIP host API audit:' — $LAST_OUT" ;;
esac
case "$LAST_OUT" in
  *"command -v dsh 为空"*) pass "host-audit-stage: the skip carries its reason (no dsh on PATH)" ;;
  *) fail "host-audit-stage: the skip reason is missing — $LAST_OUT" ;;
esac

# ③ The skip must read as "not checked", never as a pass. This is the wording
# regression the whole case exists for: SKIP rewritten as ok/PASS stays green.
case "$LAST_OUT" in
  *"这不是通过"*) pass "host-audit-stage: the skip says it is NOT a pass" ;;
  *) fail "host-audit-stage: the skip does not say it is not a pass — $LAST_OUT" ;;
esac
if printf '%s\n' "$LAST_OUT" | grep -qiE '(^|[[:space:]])(ok|pass)([[:space:]]|$)'; then
  fail "host-audit-stage: the skip output marks ok/PASS — $LAST_OUT"
else
  pass "host-audit-stage: the skip output marks no ok/PASS"
fi

# ② A fake dsh makes the audit run; an incomplete host tree makes it fail. The
# stage must pass that FAILURE through. A wrapper returning 0 here would be
# "looked, did not like the answer, reported green".
C21_HOST="$TMP/c21-host"
mkdir -p "$C21_HOST/node_modules/@deepseek-ai/dsh/bin"
printf '#!/bin/sh\nexit 0\n' > "$C21_HOST/node_modules/@deepseek-ai/dsh/bin/dsh"
chmod +x "$C21_HOST/node_modules/@deepseek-ai/dsh/bin/dsh"
printf '{"version":"0.0.0-fake"}\n' > "$C21_HOST/node_modules/@deepseek-ai/dsh/package.json"
run_rc env PATH="$C21_HOST/node_modules/@deepseek-ai/dsh/bin:$NO_DSH_BIN" bash "$HOST_AUDIT_STAGE"
if [ "$LAST_RC" = "1" ]; then
  pass "host-audit-stage: a fake dsh whose audit fails exits 1 (the audit's own code)"
else
  fail "host-audit-stage: a failing audit under a fake dsh must exit 1, got $LAST_RC — $LAST_OUT"
fi
case "$LAST_OUT" in
  *"条服务假设"*) pass "host-audit-stage: the audit really ran (its summary is in the output)" ;;
  *) fail "host-audit-stage: the output does not look like a real audit — $LAST_OUT" ;;
esac
# The other passthrough: dsh exists but no host tree can be resolved above it.
# check-host-api exits 2; the stage must hand verify.sh that 2 (not 1, not 0).
C21_BARE="$TMP/c21-bare-dsh"
mkdir -p "$C21_BARE/bin"
printf '#!/bin/sh\nexit 0\n' > "$C21_BARE/bin/dsh"
chmod +x "$C21_BARE/bin/dsh"
run_rc env PATH="$C21_BARE/bin:$NO_DSH_BIN" bash "$HOST_AUDIT_STAGE"
if [ "$LAST_RC" = "2" ]; then
  pass "host-audit-stage: an unresolvable host tree passes the audit's exit 2 through"
else
  fail "host-audit-stage: expected the audit's exit 2 passthrough, got $LAST_RC — $LAST_OUT"
fi

# verify.sh side (AC-001): the stage is called through run_stage, and run_stage's
# quiet capture must not eat the SKIP sentence. A stub tree — same trick as C13 —
# runs the real verify.sh with no `dsh`; only the host-audit stage is real.
C21_TREE="$TMP/c21-verify-tree"
mkdir -p "$C21_TREE/scripts" "$C21_TREE/packages/dsh-alpha/src" "$C21_TREE/test"
cp "$ROOT/scripts/verify.sh" "$C21_TREE/scripts/verify.sh"
cp "$HOST_AUDIT_STAGE" "$C21_TREE/scripts/host-audit-stage.sh"
for stub in build-all typecheck-all test-all e2e-mission; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$C21_TREE/scripts/$stub.sh"
done
printf 'export {};\n' > "$C21_TREE/test/noop.test.ts"
(cd "$C21_TREE" && git init -q . && git config user.email selftest@example.com && git config user.name selftest && \
  git add -A >/dev/null 2>&1 && git commit -qm base >/dev/null 2>&1 && printf 'x\n' > packages/dsh-alpha/src/index.ts)
run_rc env PATH="$NO_DSH_BIN" bash "$C21_TREE/scripts/verify.sh" --changed --quiet
if [ "$LAST_RC" = "0" ]; then
  pass "host-audit-stage in verify: the no-dsh run stays green (skip != failure)"
else
  fail "host-audit-stage in verify: the no-dsh run must be green, got $LAST_RC — $LAST_OUT"
fi
case "$LAST_OUT" in
  *"SKIP host API audit:"*) pass "host-audit-stage in verify: the SKIP sentence survives run_stage" ;;
  *) fail "host-audit-stage in verify: run_stage swallowed the SKIP sentence — $LAST_OUT" ;;
esac
if printf '%s\n' "$LAST_OUT" | grep -q '^host API audit *SKIP$'; then
  pass "host-audit-stage in verify: the stage line says SKIP"
else
  fail "host-audit-stage in verify: the stage line does not say SKIP — $LAST_OUT"
fi
if printf '%s\n' "$LAST_OUT" | grep -q '^host API audit *ok$'; then
  fail "host-audit-stage in verify: the skipped stage is reported as ok — $LAST_OUT"
else
  pass "host-audit-stage in verify: the skipped stage is never reported as ok"
fi

section "summary"
if [ "$FAILURES" = "0" ]; then
  printf '  \033[32mOPS SELFTEST GREEN\033[0m — every finding above is still refused.\n'
  exit 0
fi
printf '  \033[31mOPS SELFTEST RED\033[0m — %s check(s) regressed.\n' "$FAILURES"
exit 1
