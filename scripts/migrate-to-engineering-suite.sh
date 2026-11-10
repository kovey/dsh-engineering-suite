#!/usr/bin/env bash
# migrate-to-engineering-suite.sh — move this suite's artifacts into its own
# namespace directory.
#
# usage: migrate-to-engineering-suite.sh [--apply] [--workspace DIR]
#
# Why: everything this suite writes lived directly in `<repo>/.dsh/`, which it
# SHARES with other plugins — chat-interaction keeps `chat-history/`,
# `feishu-cards/`, lease files and `feishu-*.json` there. Those are runtime
# STATE, but the trust-root fingerprint hashed them as policy, so every incoming
# chat message changed `policyVersion` and made every mission's mandate stale.
# The suite now resolves `<repo>/.dsh/engineering-suite/` when it exists, which
# makes the trust root unambiguous: everything inside belongs to the suite.
#
# The script ONLY moves entries it recognises (the suite's own directories and
# gate configs). Anything else under `.dsh/` is left where it is — that is the
# point. Nothing is deleted, and a conflict stops the run before any move.
#
# Dry-run by default. Exit codes: 0 = nothing left to do, 1 = work remains
# (dry-run), 2 = usage error or conflict.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="$ROOT"
APPLY=0
# `while`+`shift`, not `for argument in "$@"`: a loop over the expanded list keeps
# iterating after a `shift`, so the value of `--workspace` was parsed twice.
while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --workspace)
      shift
      WORKSPACE="${1:-}"
      [ -n "$WORKSPACE" ] || { printf 'migrate: --workspace 需要一个目录\n' >&2; exit 2; }
      shift
      ;;
    -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'migrate: 未知参数 %s\n' "$1" >&2; exit 2 ;;
  esac
done

SOURCE="$WORKSPACE/.dsh"
TARGET="$SOURCE/engineering-suite"

if [ ! -d "$SOURCE" ]; then
  printf 'migrate: %s 不存在——这个工作区还没有本套件的台账，无需迁移\n' "$SOURCE"
  exit 0
fi

# The suite owns these directories and files. A name that is not listed here is
# somebody else's (chat-interaction's runtime state, an operator's scratch file)
# and is deliberately left alone.
DIRS=(specs missions audit state kb media interaction deploy roles)
CONFIGS=(
  quality-gate.json spec-gate.json test-design-gate.json evidence-gate.json
  supply-chain-gate.json interaction-gate.json impact-gate.json coverage-gate.json
  audit-trail.json deploy-gate.json standards.json standards-baseline.json
  secret-allow.json kb.json doctor.json suite-doctor.json
)
LEDGERS=(releases.jsonl plan.jsonl deployments.jsonl evidence.jsonl)

pending=()
for name in "${DIRS[@]}" "${CONFIGS[@]}" "${LEDGERS[@]}"; do
  [ -e "$SOURCE/$name" ] || continue
  if [ -e "$TARGET/$name" ]; then
    printf 'migrate: 冲突——%s 与 %s 同时存在，拒绝覆盖\n' "$SOURCE/$name" "$TARGET/$name" >&2
    printf '下一步：先由人合并这两处内容（脚本不替你决定谁是对的），删掉其中一份后重跑\n' >&2
    exit 2
  fi
  pending+=("$name")
done

if [ "${#pending[@]}" -eq 0 ]; then
  if [ -d "$TARGET" ]; then
    printf 'migrate: 已迁移（%s 下没有遗留的套件条目）\n' "$SOURCE"
  else
    printf 'migrate: %s 下没有本套件的条目，无需迁移\n' "$SOURCE"
  fi
  exit 0
fi

printf 'migrate: 将从 %s 迁入 %s：\n' "$SOURCE" "${TARGET#"$WORKSPACE"/}"
for name in "${pending[@]}"; do
  printf '  %s\n' "$name"
done

if [ "$APPLY" != "1" ]; then
  printf '\n这是 dry-run，什么都没有移动。加 --apply 执行。\n'
  exit 1
fi

mkdir -p "$TARGET"
for name in "${pending[@]}"; do
  mv "$SOURCE/$name" "$TARGET/$name"
done

printf '\n已迁移 %d 项到 %s\n' "${#pending[@]}" "${TARGET#"$WORKSPACE"/}"
printf '回滚（按相反方向移动即可）：\n'
for name in "${pending[@]}"; do
  printf '  mv %s %s\n' "${TARGET#"$WORKSPACE"/}/$name" "${SOURCE#"$WORKSPACE"/}/$name"
done
printf '未列入清单的条目（例如 chat-interaction 的 chat-history/、feishu-*.json）已原地保留。\n'
