#!/usr/bin/env bash
# typecheck-all.sh — type-check only (no emit), for CI-style verification.
#
# usage: typecheck-all.sh [package …]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TSC="$ROOT/node_modules/typescript/bin/tsc"

targets=()
if [ "$#" -gt 0 ]; then
  for name in "$@"; do targets+=("$ROOT/packages/$name"); done
else
  for dir in "$ROOT"/packages/*/; do targets+=("$dir"); done
fi

failed=0
for dir in "${targets[@]}"; do
  name="$(basename "$dir")"
  printf '==> %s\n' "$name"
  if ! (cd "$dir" && node "$TSC" -p tsconfig.json --noEmit); then
    failed=1
  fi
done
exit "$failed"
