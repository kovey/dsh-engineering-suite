#!/usr/bin/env bash
# test-all.sh — build, then run every package's node:test suite.
#
# usage: test-all.sh [--quiet] [package …]
#
# `--quiet` prints one line per package plus the failure detail of the packages
# that failed, and nothing else. It exists because a gate runner may bound how
# much output a command may produce: the full node:test transcript (thousands of
# lines) can fill that bound and take the producer down with it, which then looks
# like a test failure in whichever packages happened to be running. The exit code
# and the set of failures are identical in both modes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

quiet=0
args=()
for argument in "$@"; do
  case "$argument" in
    -q|--quiet) quiet=1 ;;
    *) args+=("$argument") ;;
  esac
done

if [ "$quiet" = "1" ]; then
  bash "$ROOT/scripts/build-all.sh" ${args[@]+"${args[@]}"} > /dev/null
else
  bash "$ROOT/scripts/build-all.sh" ${args[@]+"${args[@]}"}
fi

targets=()
if [ "${#args[@]}" -gt 0 ]; then
  for name in ${args[@]+"${args[@]}"}; do targets+=("$ROOT/packages/$name"); done
else
  # Dependency order: the plugins compile against dsh-eng-core's built `dist/`,
  # which a fresh clone (and CI) does not have yet.
  #
  # The status of package-order.py is CHECKED on purpose (2026-09 adversarial
  # audit C10): `while … done < <(python3 …)` throws the producer's exit status
  # away, so a missing packages/ (or a host without python3) left `targets`
  # empty and the script exited 0 having tested NOTHING.
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
  printf 'FATAL: no packages to test under %s/packages — refusing to report success having done nothing\n' "$ROOT" >&2
  exit 1
fi

failed=0
for dir in "${targets[@]}"; do
  name="$(basename "$dir")"
  if ! compgen -G "$dir/test/*.test.ts" > /dev/null; then
    printf '==> %s (no tests)\n' "$name"
    continue
  fi
  if [ "$quiet" = "1" ]; then
    # Captured, not teed: a quiet run must stay small even when a package fails
    # loudly, and the first failing lines are what names the cases.
    status=0
    output="$( (cd "$dir" && node --test test/*.test.ts) 2>&1 )" || status=$?
    if [ "$status" -ne 0 ]; then
      failed=1
      printf '==> %s (exit %s)\n' "$name" "$status"
      # Head AND a grep: a failing file's lines come first, and a summary that
      # says "fail 0" while the process exited non-zero is exactly the case a
      # tail would hide.
      # Only the failing lines, and no pipe: `printf … | head` makes printf die of
      # SIGPIPE, and `set -o pipefail` then rewrites the exit status to 141 — the
      # diagnostic would eat the very failure it is meant to report. A slice of
      # the transcript is no good either: the failure sits past 8 KiB in the
      # largest package, so everything printed before it passed.
      printed=0
      while IFS= read -r line; do
        case "$line" in
          ✖*|"not ok"*|*"AssertionError"*|*"Error:"*|*"error:"*|"ℹ fail "[1-9]*|"ℹ tests "*)
            printf '%s\n' "$line"
            printed=$((printed + 1))
            [ "$printed" -ge 30 ] && break
            ;;
        esac
      done <<< "$output"
      if [ "$printed" -eq 0 ]; then
        # Nothing matched: the process was probably killed (a signal leaves no
        # TAP failure line). A short head names what it was doing.
        printf '--- head ---\n%s\n' "${output:0:800}"
      fi
      printf 'FAILED: %s (exit %s)\n' "$name" "$status" >&2
      continue
    fi
    printf '==> %s ok\n' "$name"
    continue
    printf '==> %s ok\n' "$name"
    continue
  fi
  printf '==> %s\n' "$name"
  if ! (cd "$dir" && node --test test/*.test.ts); then
    failed=1
    printf 'FAILED: %s\n' "$name" >&2
  fi
done
exit "$failed"
