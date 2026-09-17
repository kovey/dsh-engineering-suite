#!/usr/bin/env bash
# verify.sh — the whole suite's acceptance run: type-check, build, per-package
# test suites, then the cross-package integration test.
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
echo "all green."
