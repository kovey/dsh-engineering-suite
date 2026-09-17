#!/usr/bin/env bash
# test-all.sh — build, then run every package's node:test suite.
#
# usage: test-all.sh [package …]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bash "$ROOT/scripts/build-all.sh" "$@"

targets=()
if [ "$#" -gt 0 ]; then
  for name in "$@"; do targets+=("$ROOT/packages/$name"); done
else
  # Dependency order: the plugins compile against dsh-eng-core's built `dist/`,
  # which a fresh clone (and CI) does not have yet.
  while IFS= read -r dir; do targets+=("$dir"); done < <(python3 "$ROOT/scripts/package-order.py" "$ROOT")
fi

failed=0
for dir in "${targets[@]}"; do
  name="$(basename "$dir")"
  if ! compgen -G "$dir/test/*.test.ts" > /dev/null; then
    printf '==> %s (no tests)\n' "$name"
    continue
  fi
  printf '==> %s\n' "$name"
  if ! (cd "$dir" && node --test test/*.test.ts); then
    failed=1
    printf 'FAILED: %s\n' "$name" >&2
  fi
done
exit "$failed"
