#!/usr/bin/env bash
# coverage.sh — produce an lcov report for every package, for `coverage_check`.
#
# usage: coverage.sh [report-path]        (default: coverage/lcov.info)
#
# Why a script instead of a command in the JSON config: `coverage_check` runs its
# command as argv WITHOUT a shell, so `packages/*/test/*.test.ts` would reach node
# unexpanded. The globbing lives here, in a reviewed file, rather than inside a
# JSON string that cannot be reviewed as code.
#
# Node's own reporter is used on purpose: this repository installs no coverage
# toolchain, and `node --test --experimental-test-coverage --test-reporter=lcov`
# emits exactly the format the gate parses (lcov / cobertura / go-cover /
# istanbul-json).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT="${1:-coverage/lcov.info}"
case "$REPORT" in
  /*) ;;
  *) REPORT="$ROOT/$REPORT" ;;
esac

mkdir -p "$(dirname "$REPORT")"
cd "$ROOT"

# ONE run for the whole workspace: every package in a separate run would emit its
# own lcov file, and the gate reads a single report.
node --test --experimental-test-coverage \
  --test-reporter=lcov --test-reporter-destination="$REPORT" \
  packages/*/test/*.test.ts >/dev/null

printf 'coverage: %s\n' "${REPORT#"$ROOT"/}"
