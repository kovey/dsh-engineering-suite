#!/usr/bin/env bash
# build-all.sh — type-check and compile every package in the suite.
#
# usage: build-all.sh [package …]     (default: every packages/* directory)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TSC="$ROOT/node_modules/typescript/bin/tsc"

if [ ! -f "$TSC" ]; then
  echo "typescript not found at $TSC — run scripts/link-deps.sh first" >&2
  exit 1
fi

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
  if (cd "$dir" && node "$TSC" -p tsconfig.json); then
    :
  else
    failed=1
    printf 'FAILED: %s\n' "$name" >&2
  fi
done
exit "$failed"
