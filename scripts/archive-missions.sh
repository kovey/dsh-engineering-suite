#!/usr/bin/env bash
# archive-missions.sh — 归档旧的 mission（人/CI 入口，与 core 的 archiveMissions 同一份实现）。
#
#   bash scripts/archive-missions.sh --dry-run              # 只看会搬什么
#   bash scripts/archive-missions.sh --keep 20 --days 90    # 执行
#   bash scripts/archive-missions.sh ~/workspace/repo --json
#
# 参数解析是严格的（未知参数/缺值 → 用法 + 退出码 2，绝不"猜你的意思"地执行）；
# 台账必须真的在工作区内（`.dsh/missions` 指向外部共享台账时拒绝，退出码 1）。
# exit: 0 = 完成（含 dry-run）；1 = 拒绝/失败；2 = 用法错误
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$ROOT/scripts/archive-missions.mjs" "$@"
