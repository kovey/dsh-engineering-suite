#!/usr/bin/env bash
# typecheck-all.sh — type-check only (no emit), for CI-style verification.
#
# On a fresh clone run `scripts/build-all.sh` first: the plugins import
# `dsh-eng-core` through the workspace link, whose types live in the built
# `dist/`. `scripts/verify.sh` does that for you, in dependency order.
#
# usage: typecheck-all.sh [package …]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TSC="$ROOT/node_modules/typescript/bin/tsc"

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
  printf '==> %s\n' "$name"
  if ! (cd "$dir" && node "$TSC" -p tsconfig.json --noEmit); then
    failed=1
  fi
done
exit "$failed"
