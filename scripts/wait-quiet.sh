#!/usr/bin/env bash
# wait-quiet.sh — block until a set of paths has stopped changing.
#
# usage: wait-quiet.sh <quiet-seconds> [max-seconds] [paths...]
#
# Why this exists: the delivery gate compares the working-tree fingerprint it
# observed with the one at `mission_complete` time, and refuses when they differ
# (correctly — "the tree I gated" must be "the tree I delivered"). When a
# delegated agent is still writing, gating early produces exactly that mismatch
# and the whole acceptance run has to happen again. Two minutes per collision,
# and the collision is entirely predictable: nobody was watching for quiescence.
#
# Semantics: exit 0 when NO file under the given paths has been modified for
# <quiet-seconds>; exit 1 when that never happens within [max-seconds]
# (default: 10x quiet, capped at 120s). Exit 2 on bad usage.
#
# The paths default to the workspace root. `node_modules`, `.git`, `dist` and
# `.dsh` are excluded: build output and ledgers change while nothing is being
# authored, and treating them as "the agent is still writing" would never settle.
set -euo pipefail

usage() {
  printf 'usage: wait-quiet.sh <quiet-seconds> [max-seconds] [paths...]\n' >&2
  exit 2
}

[ "$#" -ge 1 ] || usage
case "$1" in
  ''|*[!0-9]*) usage ;;
esac
quiet_seconds="$1"
shift

max_seconds=$((quiet_seconds * 10))
if [ "$quiet_seconds" -gt 12 ]; then max_seconds=120; fi
if [ "$#" -ge 1 ]; then
  case "$1" in
    ''|*[!0-9]*) : ;;
    *) max_seconds="$1"; shift ;;
  esac
fi

if [ "$#" -eq 0 ]; then
  set -- "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

for path in "$@"; do
  if [ ! -e "$path" ]; then
    printf 'wait-quiet.sh: 路径不存在：%s\n' "$path" >&2
    exit 2
  fi
done

# A sentinel in the platform temp area: writing it must not itself count as a
# workspace change (and it must not land inside the tree we are watching).
sentinel="$(mktemp -t wait-quiet.XXXXXX)"
trap 'rm -f "$sentinel"' EXIT

started=$SECONDS
while :; do
  touch "$sentinel"
  sleep "$quiet_seconds"
  # `-newer` is portable (BSD and GNU both have it); `-newermt` is not.
  changed="$(
    find "$@" -type f -newer "$sentinel" \
      -not -path '*/node_modules/*' \
      -not -path '*/.git/*' \
      -not -path '*/dist/*' \
      -not -path '*/.dsh/*' \
      -print 2>/dev/null | head -n 5 || true
  )"
  if [ -z "$changed" ]; then
    printf 'wait-quiet.sh: 静默 %ss（路径：%s）\n' "$quiet_seconds" "$*"
    exit 0
  fi
  if [ $((SECONDS - started)) -ge "$max_seconds" ]; then
    printf 'wait-quiet.sh: 等待 %ss 后仍在变动（上限 %ss）：\n' "$quiet_seconds" "$max_seconds" >&2
    printf '%s\n' "$changed" >&2
    printf '下一步：等写入方结束（或让它汇报完成）再继续；抢跑门禁会因为"门禁观测的树 ≠ 交付时的树"被拒绝。\n' >&2
    exit 1
  fi
done
