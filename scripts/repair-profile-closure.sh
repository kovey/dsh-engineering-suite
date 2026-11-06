#!/usr/bin/env bash
# repair-profile-closure.sh — reconcile the shared profile closure with the
# installed dsh tree.
#
# The profiles resolve `@deepseek-ai/*` through ONE shared closure
# (`~/.dsh/profiles/node_modules/@deepseek-ai`), a farm of symlinks into the
# globally installed dsh tree. Upgrading the global install renames and splits
# packages (0.2.2-rc.1 turned `dsh-agent-presets` into `dsh-agent-preset` +
# `dsh-agent-preset-registry`, and `dsh-subagent-in-process-driver` into
# `-spawn-in-process` / `-fork-in-process`), which leaves the farm pointing at
# paths that no longer exist. A dangling link is not harmless: it is a package
# a plugin can no longer resolve, and nothing reports it.
#
# This script only ever touches SYMLINKS. A real directory or file with a
# colliding name is reported as a conflict and left alone — the closure is
# shared, so replacing a real directory would be destructive.
#
# usage:
#   repair-profile-closure.sh [--apply] [--closure <dir>] [--dsh-root <dir>]
#
#   (no flags)   report only: dangling, missing, conflicts. Writes nothing.
#   --apply      remove dangling links, create missing ones, print every action.
#
# exit: 0 when the closure agrees with the tree (or after a successful
#       --apply), 1 when anything is left to fix, 2 on a usage/root error.
set -euo pipefail

closure="$HOME/.dsh/profiles/node_modules/@deepseek-ai"
dsh_root=''
apply=0

while [ "$#" -gt 0 ]; do
    case "$1" in
        --apply) apply=1 ;;
        --closure) shift; closure="${1:-}" ;;
        --dsh-root) shift; dsh_root="${1:-}" ;;
        -h|--help)
            printf 'usage: %s [--apply] [--closure <dir>] [--dsh-root <dir>]\n' "$(basename "$0")"
            exit 0
            ;;
        *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
    esac
    shift
done

# --- locate the installed dsh tree --------------------------------------
if [ -z "$dsh_root" ]; then
    dsh_bin="$(command -v dsh || true)"
    if [ -z "$dsh_bin" ]; then
        printf 'FATAL: no `dsh` on PATH; pass --dsh-root <.../node_modules/@deepseek-ai>\n' >&2
        exit 2
    fi
    # Walk up to the package root instead of assuming the bin/lib depth: a global
    # install, a pnpm store and an nvm prefix all nest differently.
    resolved="$(readlink -f "$dsh_bin" 2>/dev/null || printf '%s' "$dsh_bin")"
    dir="$(cd "$(dirname "$resolved")" && pwd)"
    while [ "$dir" != "/" ] && [ "$(basename "$dir")" != "dsh" ]; do dir="$(dirname "$dir")"; done
    if [ "$dir" = "/" ]; then
        printf 'FATAL: cannot find the dsh package root above %s\n' "$dsh_bin" >&2
        exit 2
    fi
    dsh_root="$(dirname "$dir")"
fi
tree="$dsh_root/dsh/node_modules/@deepseek-ai"
if [ ! -d "$tree" ]; then
    printf 'FATAL: the dsh tree is not where it is expected: %s\n' "$tree" >&2
    printf 'hint: pass --dsh-root pointing at the @deepseek-ai directory that CONTAINS dsh/\n' >&2
    exit 2
fi
if [ ! -d "$closure" ]; then
    printf 'FATAL: the shared closure does not exist: %s\n' "$closure" >&2
    printf 'hint: this machine has no profile closure yet; start dsh once to create it\n' >&2
    exit 2
fi

printf 'closure: %s\n' "$closure"
printf 'tree:    %s (dsh %s)\n' "$tree" "$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$dsh_root/dsh/package.json" 2>/dev/null | head -1)"
printf 'mode:    %s\n\n' "$([ "$apply" = 1 ] && echo 'APPLY' || echo 'dry-run（不写盘；加 --apply 生效）')"

dangling=()
missing=()
conflicts=()
ok=0

# Names that are published but were never part of the closure are NOT missing:
# the closure mirrors the dsh tree, nothing else. So "missing" means "present in
# the tree, absent from the closure" — never "present in the registry".
for entry in "$closure"/*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name="$(basename "$entry")"
    if [ -L "$entry" ]; then
        if [ -e "$entry" ]; then ok=$((ok + 1)); else dangling+=("$name"); fi
        continue
    fi
    if [ -e "$tree/$name" ]; then
        # A real copy where the tree has the truth: leave it, but say so.
        conflicts+=("${name}（真实条目，非符号链接）")
    fi
done

for entry in "$tree"/*; do
    name="$(basename "$entry")"
    target="$closure/$name"
    if [ ! -e "$target" ] && [ ! -L "$target" ]; then
        missing+=("$name")
    fi
done

printf '== 断链（链接仍在，目标已不存在）: %d ==\n' "${#dangling[@]}"
if [ "${#dangling[@]}" -gt 0 ]; then
    for name in "${dangling[@]}"; do printf '  - %s → %s\n' "$name" "$(readlink "$closure/$name")"; done
fi
printf '\n== 缺失（dsh 树里有，闭包里没有）: %d ==\n' "${#missing[@]}"
if [ "${#missing[@]}" -gt 0 ]; then
    for name in "${missing[@]}"; do printf '  + %s\n' "$name"; done
fi
printf '\n== 冲突（同名但非符号链接，脚本不会覆盖）: %d ==\n' "${#conflicts[@]}"
if [ "${#conflicts[@]}" -gt 0 ]; then
    for name in "${conflicts[@]}"; do printf '  ! %s\n' "$name"; done
fi
printf '\n== 正常: %d ==\n' "$ok"

if [ "$apply" != 1 ]; then
    printf '\n未写盘。要修复请重跑并加 --apply。\n'
    if [ "${#dangling[@]}" -gt 0 ] || [ "${#missing[@]}" -gt 0 ]; then exit 1; fi
    exit 0
fi

printf '\n== 应用 ==\n'
if [ "${#dangling[@]}" -gt 0 ]; then
    for name in "${dangling[@]}"; do
        rm -f "$closure/$name"
        printf '  removed dangling: %s\n' "$name"
    done
fi
if [ "${#missing[@]}" -gt 0 ]; then
    for name in "${missing[@]}"; do
        if [ -e "$closure/$name" ] || [ -L "$closure/$name" ]; then continue; fi
        ln -s "$tree/$name" "$closure/$name"
        printf '  linked: %s\n' "$name"
    done
fi

# Re-read the state instead of trusting the plan: an apply that did not converge
# must fail here rather than report success from its own intentions.
left=0
# bash 3.2 (macOS) errors on expanding an EMPTY array under `set -u`, so each
# array is walked behind its own length guard rather than merged first.
if [ "${#dangling[@]}" -gt 0 ]; then
    for name in "${dangling[@]}"; do
        target="$closure/$name"
        if [ -L "$target" ] && [ ! -e "$target" ]; then left=$((left + 1)); fi
    done
fi
if [ "${#missing[@]}" -gt 0 ]; then
    for name in "${missing[@]}"; do
        target="$closure/$name"
        if [ ! -e "$target" ] && [ ! -L "$target" ]; then left=$((left + 1)); fi
    done
fi
if [ "$left" -gt 0 ]; then
    printf '\n仍残留 %d 项，修复未收敛。\n' "$left" >&2
    exit 1
fi
printf '\n闭包已与 dsh 树一致（再跑一次 dry-run 应为 0/0）。\n'
