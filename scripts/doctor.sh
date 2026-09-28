#!/usr/bin/env bash
# doctor.sh — 套件自检入口（人/CI）。
#
# 与插件 `suite_status` 共用同一份判定：脚本报离线可判定的部分，插件在会话里
# 补运行时事实（插件挂载、当前阶段、待审批、通道能力）。
#
# usage:
#   bash scripts/doctor.sh                  # 检查当前目录
#   bash scripts/doctor.sh ~/workspace/repo # 检查指定仓库
#   bash scripts/doctor.sh --json           # 机器可读
#
# exit: 0 = 必需项全部就绪；1 = 有必需项未就绪；2 = 用法错误（缺值/不认识的参数）
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 参数原样透传：doctor.mjs 自己解析 --json / --workspace <p> / 位置参数（任意顺序、可组合）
exec node "$ROOT/scripts/doctor.mjs" "$@"
