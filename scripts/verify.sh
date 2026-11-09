#!/usr/bin/env bash
# verify.sh — the whole suite's acceptance run: type-check, build, per-package
# test suites, the cross-package integration test, then the self-test of the
# verification tooling itself.
#
# usage: verify.sh [--quiet] [--changed]
#
# `--quiet` prints one line per stage (plus the failing stage's tail) instead of
# the full transcript. It is what the quality gate runs: a runner may bound the
# output a command may produce, and thousands of passing-test lines are a way to
# hit that bound for no benefit. The exit code and what counts as a failure are
# identical in both modes.
#
# `--changed` is the ITERATION mode: it derives the touched packages from the git
# working tree (tracked and untracked) and runs build/type-check/tests for those
# only. It exists because a full run costs ~2 minutes and an iteration loop that
# pays 2 minutes per edit gets abandoned — which is how a real regression ends up
# being found by the gate instead of by the author.
#
# `--changed` is NOT a delivery argument and says so in its first two lines: the
# quality gate keeps running the FULL command, and only that PASS can authorise a
# delivery. A partial run that cannot determine the change set (no git, not a
# repository) refuses with exit 2 rather than reporting a green nothing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

quiet=0
changed=0
for argument in "$@"; do
  case "$argument" in
    -q|--quiet) quiet=1 ;;
    --changed) changed=1 ;;
    *) printf 'unknown argument: %s\n' "$argument" >&2; exit 2 ;;
  esac
done

# --- --changed: derive the touched package set -------------------------------
changed_packages=()
cross_package=0
full_required=0
if [ "$changed" = "1" ]; then
  if ! command -v git >/dev/null 2>&1; then
    printf 'verify.sh --changed: git 不可用，无法判定改动集（拒绝，不是通过）\n' >&2
    exit 2
  fi
  if ! git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf 'verify.sh --changed: %s 不是 git 工作区，无法判定改动集（拒绝，不是通过）\n' "$ROOT" >&2
    exit 2
  fi
  # `--untracked-files=all` is load-bearing: without it git collapses a brand new
  # directory into one `?? packages/` line, so "someone added a whole package"
  # would be classified as "nothing changed" — a silent green in the one mode that
  # must never have one.
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    path="${line:3}"
    path="${path##* -> }"
    case "$path" in
      packages/*/*)
        name="${path#packages/}"
        name="${name%%/*}"
        found=0
        for existing in ${changed_packages[@]+"${changed_packages[@]}"}; do
          [ "$existing" = "$name" ] && found=1
        done
        [ "$found" = "0" ] && changed_packages+=("$name")
        ;;
      scripts/*|test/*)
        # The tooling and the cross-package test are what decide whether the rest
        # is trustworthy: a change there is not a "one package" change.
        full_required=1
        cross_package=1
        ;;
      *) : ;;
    esac
  done <<EOF
$(git -C "$ROOT" status --porcelain --untracked-files=all)
EOF
  if [ "$full_required" = "1" ]; then
    printf '** 检测到 scripts/ 或 test/ 改动：按全量处理（部分验收不适用于工具链自身）**\n'
    changed=0
  elif [ "${#changed_packages[@]}" -eq 0 ]; then
    printf '** verify.sh --changed：工作区没有包内改动——不跑任何包测试（这不是"验收通过"，只是没有可验的改动）**\n'
    exit 0
  else
    printf '** 部分验收（--changed）：只验证改动涉及的包 **\n'
    printf '** 交付依据是完整 `bash scripts/verify.sh --quiet`（quality-gate 跑的就是它）；本次结果不能作为交付依据 **\n'
    printf '   改动包: %s\n' "${changed_packages[*]}"
    if [ "${#changed_packages[@]}" -gt 1 ]; then
      cross_package=1
    fi
  fi
fi

run_stage() {
  local label="$1"
  shift
  if [ "$quiet" != "1" ]; then
    echo
    echo "### $label"
    "$@"
    return
  fi
  # Captured, not teed (a quiet stage must stay small even when it fails), and
  # no temp file: the target would have to be attributed to the workspace.
  local output
  if output="$("$@" 2>&1)"; then
    printf '%-46s ok\n' "$label"
    return
  fi
  printf '%-46s FAILED\n' "$label"
  # Whole transcript, head first: the failing package's detail is at the TOP of a
  # quiet run's output, so a tail would show only the packages that passed after
  # it — which is exactly how a gate failure became hard to diagnose once.
  printf '%s\n' "${output:0:8000}"
  printf 'environment: pwd=%s node=%s nproc=%s\n' "$(pwd)" "$(node --version 2>&1)" "$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo unknown)"
  return 1
}

# Build first: every plugin resolves `dsh-eng-core` through the workspace link,
# whose `types` point at the built `dist/` — a fresh clone (or CI) has none yet,
# so type-checking before the first build cannot resolve the imports.
if [ "${#changed_packages[@]}" -gt 0 ]; then
  run_stage "per-package build (changed: ${#changed_packages[@]})" bash "$ROOT/scripts/build-all.sh" "${changed_packages[@]}"
  run_stage "type-check (changed: ${#changed_packages[@]})" bash "$ROOT/scripts/typecheck-all.sh" "${changed_packages[@]}"
else
  run_stage "per-package build (dependency order)" bash "$ROOT/scripts/build-all.sh"
  run_stage "type-check (no emit)" bash "$ROOT/scripts/typecheck-all.sh"
fi
# Pass the flag DOWN: without it test-all prints thousands of passing lines, the
# failure marker lands past any sane slice, and the gate record shows only tests
# that passed — which is exactly how this failure hid for several runs.
if [ "${#changed_packages[@]}" -gt 0 ]; then
  run_stage "per-package tests (changed)" bash "$ROOT/scripts/test-all.sh" --quiet "${changed_packages[@]}"
elif [ "$quiet" = "1" ]; then
  run_stage "per-package tests" bash "$ROOT/scripts/test-all.sh" --quiet
else
  run_stage "per-package tests" bash "$ROOT/scripts/test-all.sh"
fi
if [ "$cross_package" = "1" ] || [ "${#changed_packages[@]}" -eq 0 ]; then
  run_stage "cross-package integration test" node --test "$ROOT/test/"*.test.ts
fi

# The scripts in this directory decide whether everything above is trustworthy:
# a false GREEN from one of them (a run that "passes" having checked nothing, or
# a checker whose needle matches a failure) is worse than a missing feature. This
# step drives their known-bad inputs — the ten findings of the 2026-09
# adversarial audit — and fails if any of them stops being refused.
run_stage "the tooling's own self-test (no dsh, no build, no network)" bash "$ROOT/scripts/e2e-mission.sh" --selftest

echo
echo "all green."
