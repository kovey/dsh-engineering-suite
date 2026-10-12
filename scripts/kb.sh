#!/usr/bin/env bash
# kb.sh — 项目知识库的人/CI 入口（与插件 kb_index/kb_search/kb_status 共用同一份实现）。
#
#   bash scripts/kb.sh index  [<repo>] [--force] [--source <id>]
#   bash scripts/kb.sh search "<问题关键词>" [<repo>] [--limit N] [--kind spec]
#   bash scripts/kb.sh status [<repo>]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$ROOT/scripts/kb.mjs" "$@"
