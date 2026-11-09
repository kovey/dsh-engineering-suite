#!/usr/bin/env bash
# check-host-api.sh — do the host APIs we depend on still exist?
#
# WHY: this suite has already been broken twice by an API that a harness upgrade
# deleted (`subagents.start`, gone in 0.2.1) while our hand-written structural
# interface kept compiling. Nothing in the build could see it: the method existed
# in our type, not in the host. Five call sites had each invented their own copy.
# The repair was one shared seam; this script is the other half — it makes the
# ASSUMPTIONS checkable, so the next rename fails here instead of in production.
#
# The table below is the audit, written down: for each service we reach through
# `ctx.get(...)`, the package that declares it and the members we actually use.
# Optional entries are marked `optional:` and their absence is reported but does
# not fail — everything else is a dependency.
#
# usage:
#   check-host-api.sh [--harness-root <dir>] [--quiet]
#
#   --harness-root  the @deepseek-ai directory holding the installed packages.
#                   Default: located from `dsh` on PATH.
#   --quiet         one line per failure / the summary only.
#
# exit: 0 all dependencies present · 1 something is missing or unreadable ·
#       2 usage error (no host tree).
set -euo pipefail

harness_root=''
quiet=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --harness-root) shift; harness_root="${1:-}" ;;
        --quiet) quiet=1 ;;
        -h|--help)
            printf 'usage: %s [--harness-root <dir>] [--quiet]\n' "$(basename "$0")"
            exit 0
            ;;
        *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
    esac
    shift
done

resolve_harness_root() {
    local bin resolved dir
    bin="$(command -v dsh || true)"
    if [ -z "$bin" ]; then return 1; fi
    resolved="$(readlink -f "$bin" 2>/dev/null || printf '%s' "$bin")"
    dir="$(cd "$(dirname "$resolved")" && pwd)"
    while [ "$dir" != "/" ] && [ "$(basename "$dir")" != "dsh" ]; do dir="$(dirname "$dir")"; done
    if [ "$dir" = "/" ]; then return 1; fi
    printf '%s' "$(dirname "$dir")"
}

if [ -z "$harness_root" ]; then
    if ! harness_root="$(resolve_harness_root)"; then
        printf 'FATAL: no `dsh` on PATH; pass --harness-root <.../node_modules/@deepseek-ai>\n' >&2
        exit 2
    fi
fi
if [ ! -d "$harness_root" ]; then
    printf 'FATAL: not a directory: %s\n' "$harness_root" >&2
    exit 2
fi

# Accept either the @deepseek-ai directory that CONTAINS dsh/, or the one holding
# the packages themselves: a global install nests them one level deeper
# (`dsh/node_modules/@deepseek-ai`), and a pnpm store nests them elsewhere again.
packages_dir="$harness_root"
if [ -d "$harness_root/dsh/node_modules/@deepseek-ai" ]; then
    packages_dir="$harness_root/dsh/node_modules/@deepseek-ai"
elif [ -d "$harness_root/node_modules/@deepseek-ai" ]; then
    packages_dir="$harness_root/node_modules/@deepseek-ai"
fi

version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$harness_root/dsh/package.json" 2>/dev/null | head -1)"
printf 'host: %s (dsh %s)\n' "${harness_root}" "${version:-(unknown)}"
printf 'packages: %s\n' "${packages_dir}"

# service|package|member[,member…]|optional?
# A member is written as `name` for a method/property declaration. Members we use
# only when present are listed under a package line ending in `|optional`.
TABLE='
approval|dsh-user-approval|request
subprocess|dsh-subprocess|spawn
subagents|dsh-subagent|startActivation,getProvider,list,registerProvider,prompt,sendMessage
agentPresets|dsh-agent-preset-registry|register,mount
userQuestions|dsh-user-questions|ask,askTimed
workspaceChanges|dsh-workspace-changes|summary,diff
agentTeams|dsh-experimental-agent-team|spawnTeammate|optional
'

failures=0
checked=0
report_fail() {
    failures=$((failures + 1))
    printf '  FAIL %s\n' "$1"
}

while IFS='|' read -r service package members optional; do
    [ -n "$service" ] || continue
    checked=$((checked + 1))
    pkg_dir="$packages_dir/$package"
    types_dir="$pkg_dir/lib/types"
    if [ ! -d "$types_dir" ]; then
        # An optional package that is not installed is a documented gap, not a
        # failure; a required one is exactly the case this script exists for.
        if [ "$optional" = "optional" ]; then
            [ "$quiet" = 1 ] || printf '  SKIP %-18s %s 未安装（可选）\n' "$service" "$package"
            continue
        fi
        report_fail "$service: 包未安装或没有 lib/types（${package} → ${types_dir}）"
        continue
    fi
    missing=''
    for member in $(printf '%s' "$members" | tr ',' ' '); do
        # Match a declaration: `member(`, `member?:`, `readonly member`, `member:`.
        if ! grep -rqE "(^|[^A-Za-z0-9_])${member}(\s*\(|\??\s*:|\s*<)" "$types_dir"/*.d.ts 2>/dev/null; then
            missing="$missing $member"
        fi
    done
    if [ -n "$missing" ]; then
        if [ "$optional" = "optional" ]; then
            [ "$quiet" = 1 ] || printf '  SKIP %-18s 缺可选成员:%s\n' "$service" "$missing"
            continue
        fi
        report_fail "$service: 缺少成员${missing}（宿主可能删除或改名了它；先查 $package 的 lib/types 再改我们的结构类型）"
        continue
    fi
    [ "$quiet" = 1 ] || printf '  ok   %-18s %s\n' "$service" "$members"
done <<< "$TABLE"

printf '\n%d 条服务假设，%d 条不成立。\n' "$checked" "$failures"
if [ "$failures" -gt 0 ]; then
    printf '这不是"版本太新"：我们的结构类型手写了宿主的方法名，缺一个就是运行时 TypeError（已发生过两次：subagents.start 与它的五个副本）。\n' >&2
    exit 1
fi
printf '宿主 API 与我们的假设一致。\n'
