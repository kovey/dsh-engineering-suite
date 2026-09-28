#!/usr/bin/env bash
# verify.sh — the whole suite's acceptance run: type-check, build, per-package
# test suites, the cross-package integration test, then the self-test of the
# verification tooling itself.
#
# usage: verify.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Build first: every plugin resolves `dsh-eng-core` through the workspace link,
# whose `types` point at the built `dist/` — a fresh clone (or CI) has none yet,
# so type-checking before the first build cannot resolve the imports.
echo "### per-package build (dependency order)"
bash "$ROOT/scripts/build-all.sh"

echo
echo "### type-check (no emit)"
bash "$ROOT/scripts/typecheck-all.sh"

echo
echo "### per-package tests"
bash "$ROOT/scripts/test-all.sh"

echo
echo "### cross-package integration test"
node --test "$ROOT/test/"*.test.ts

echo
echo "### the tooling's own self-test (no dsh, no build, no network)"
# The scripts in this directory decide whether everything above is trustworthy:
# a false GREEN from one of them (a run that "passes" having checked nothing, or
# a checker whose needle matches a failure) is worse than a missing feature. This
# step drives their known-bad inputs — the ten findings of the 2026-09
# adversarial audit — and fails if any of them stops being refused.
bash "$ROOT/scripts/e2e-mission.sh" --selftest

echo
echo "all green."
