#!/usr/bin/env bash
# host-audit-stage.sh — the acceptance run's host-API stage, SKIP included.
#
# `check-host-api.sh` audits the table of host members we call; this stage decides
# whether the machine can be audited at all. It is a separate script instead of a
# few lines inside verify.sh for one reason: **the SKIP branch needs a
# counter-proof**. Inline, the only way to execute "there is no `dsh` on PATH" was
# to copy verify.sh; as a file, scripts/selftest-ops.sh C21 drives both branches —
# a PATH without `dsh` (must print the SKIP sentence and exit 0) and a fake `dsh`
# whose audit must fail (must exit non-zero). Deleting the probe, or turning the
# skip into a green, now fails C21 instead of passing quietly.
#
# usage: host-audit-stage.sh       (no arguments; invoke it WITH a path, as
#                                   verify.sh does: it finds check-host-api.sh
#                                   next to itself)
#
# exit:
#   0       SKIP: no `dsh` on PATH. The FIRST output line starts with
#           `SKIP host API audit:` and says why, because verify.sh's run_stage
#           prints that sentence as SKIP instead of swallowing it behind `ok`.
#           A skip is exit 0 by contract (a machine without the host installed
#           must still pass acceptance) and is never silent.
#   0       audit ran and every claimed host member exists (check-host-api's 0).
#   1 / 2   audit ran and failed / could not locate the host tree: passed
#           THROUGH unchanged from check-host-api.sh. "We looked and it was
#           wrong" and "we could not look" are never folded into 0 here.
#
# The SKIP path deliberately needs no external command: on a machine without the
# host install, `command -v` (a builtin) is the whole check.
set -euo pipefail

if [ -z "$(command -v dsh || true)" ]; then
    printf 'SKIP host API audit: 没有检测到 dsh 安装（command -v dsh 为空），无法定位宿主包——这不是通过\n'
    exit 0
fi

# `dirname` would be this script's only coreutils dependency; parameter expansion
# does the same job and keeps the SKIP path free of any external command.
case "${BASH_SOURCE[0]}" in
    */*) here="${BASH_SOURCE[0]%/*}" ;;
    *) here=. ;;
esac

# exec, not a subshell: the audit's exit code must reach verify.sh unchanged (1 =
# a member is gone, 2 = the host tree could not be located). A wrapper that
# re-mapped it would turn "could not look" back into silence.
exec bash "$here/check-host-api.sh" --quiet
