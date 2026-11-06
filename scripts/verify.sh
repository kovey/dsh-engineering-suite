#!/usr/bin/env bash
# verify.sh — the whole suite's acceptance run: type-check, build, per-package
# test suites, the cross-package integration test, then the self-test of the
# verification tooling itself.
#
# usage: verify.sh [--quiet]
#
# `--quiet` prints one line per stage (plus the failing stage's tail) instead of
# the full transcript. It is what the quality gate runs: a runner may bound the
# output a command may produce, and thousands of passing-test lines are a way to
# hit that bound for no benefit. The exit code and what counts as a failure are
# identical in both modes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

quiet=0
for argument in "$@"; do
  case "$argument" in
    -q|--quiet) quiet=1 ;;
    *) printf 'unknown argument: %s\n' "$argument" >&2; exit 2 ;;
  esac
done

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
run_stage "per-package build (dependency order)" bash "$ROOT/scripts/build-all.sh"
run_stage "type-check (no emit)" bash "$ROOT/scripts/typecheck-all.sh"
# Pass the flag DOWN: without it test-all prints thousands of passing lines, the
# failure marker lands past any sane slice, and the gate record shows only tests
# that passed — which is exactly how this failure hid for several runs.
if [ "$quiet" = "1" ]; then
  run_stage "per-package tests" bash "$ROOT/scripts/test-all.sh" --quiet
else
  run_stage "per-package tests" bash "$ROOT/scripts/test-all.sh"
fi
run_stage "cross-package integration test" node --test "$ROOT/test/"*.test.ts

# The scripts in this directory decide whether everything above is trustworthy:
# a false GREEN from one of them (a run that "passes" having checked nothing, or
# a checker whose needle matches a failure) is worse than a missing feature. This
# step drives their known-bad inputs — the ten findings of the 2026-09
# adversarial audit — and fails if any of them stops being refused.
run_stage "the tooling's own self-test (no dsh, no build, no network)" bash "$ROOT/scripts/e2e-mission.sh" --selftest

echo
echo "all green."
