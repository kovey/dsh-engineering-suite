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
  # Dependency order: the plugins compile against dsh-eng-core's built `dist/`,
  # which a fresh clone (and CI) does not have yet.
  #
  # The status of package-order.py is CHECKED on purpose (2026-09 adversarial
  # audit C10): `while … done < <(python3 …)` throws the producer's exit status
  # away, so a missing packages/ (or a host without python3) left `targets`
  # empty and the script exited 0 having built NOTHING. On bash >= 4.4
  # `"${targets[@]}"` under `set -u` is even legal, so the empty list was
  # completely silent — "all green" for an empty set.
  order="$(python3 "$ROOT/scripts/package-order.py" "$ROOT")" || {
    printf 'FATAL: scripts/package-order.py failed (no packages/, or python3 missing) — refusing to continue\n' >&2
    exit 1
  }
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    targets+=("$dir")
  done <<< "$order"
fi

if [ "${#targets[@]}" -eq 0 ]; then
  printf 'FATAL: no packages to build under %s/packages — refusing to report success having done nothing\n' "$ROOT" >&2
  exit 1
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
