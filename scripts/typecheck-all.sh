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
  #
  # The status of package-order.py is CHECKED on purpose (2026-09 adversarial
  # audit C10): `while … done < <(python3 …)` throws the producer's exit status
  # away, so a missing packages/ (or a host without python3) left `targets`
  # empty and the script exited 0 having type-checked NOTHING.
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
  printf 'FATAL: no packages to type-check under %s/packages — refusing to report success having done nothing\n' "$ROOT" >&2
  exit 1
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
