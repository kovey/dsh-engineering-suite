#!/usr/bin/env bash
# archive-missions.sh — 归档旧的 mission（人/CI 入口，与 core 的 archiveMissions 同一份实现）。
#
#   bash scripts/archive-missions.sh --dry-run              # 只看会搬什么
#   bash scripts/archive-missions.sh --keep 20 --days 90    # 执行
#   bash scripts/archive-missions.sh ~/workspace/repo --json
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$ROOT/scripts/archive-missions.mjs" "$@"
