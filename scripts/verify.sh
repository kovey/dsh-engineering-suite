#!/usr/bin/env bash
# verify.sh — the whole suite's acceptance run: type-check, build, per-package
# test suites, then the cross-package integration test.
#
# usage: verify.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "### type-check (no emit)"
bash "$ROOT/scripts/typecheck-all.sh"

echo
echo "### per-package build + tests"
bash "$ROOT/scripts/test-all.sh"

echo
echo "### cross-package integration test"
node --test "$ROOT/test/"*.test.ts

echo
echo "all green."
