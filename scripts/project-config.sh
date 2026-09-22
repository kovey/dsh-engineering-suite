#!/usr/bin/env bash
# project-config.sh — write the per-repository gate configuration for a dsh
# workspace (see docs/ARCHITECTURE.md §5.2).
#
# A dsh profile serves several repositories at once, so "which commands verify
# this repo" belongs in the repo: this script detects the project type and
# writes `<workspace>/.dsh/quality-gate.json` (and optionally
# `<workspace>/.dsh/spec-gate.json`), which the plugins read per session
# workspace. Existing files are never overwritten without --force.
#
# usage:
#   bash scripts/project-config.sh                      # dry-run for $PWD
#   bash scripts/project-config.sh --write              # write into $PWD
#   bash scripts/project-config.sh --workspace ~/repo --write
#   bash scripts/project-config.sh --write --test "pnpm vitest run" --lint "pnpm eslint ."
#   bash scripts/project-config.sh --write --spec off   # 试验仓库：不拦写
#     --spec on   → {"enforce": true}（显式声明，便于 review）
#     --spec skip → 不写 spec-gate.json（默认）
#   --force      覆盖同名文件（默认拒绝）
#   --json       只打印将写入的内容
set -euo pipefail

WS="$PWD"
WRITE=0
FORCE=0
JSON_ONLY=0
SPEC="skip"
STANDARDS="skip"
TEST_CMD=""
LINT_CMD=""

while [ $# -gt 0 ]; do
  case "$1" in
    --workspace) WS="${2:-}"; shift 2 ;;
    --write) WRITE=1; shift ;;
    --force) FORCE=1; shift ;;
    --json) JSON_ONLY=1; shift ;;
    --spec) SPEC="${2:-skip}"; shift 2 ;;
    --standards) STANDARDS="${2:-skip}"; shift 2 ;;
    --test) TEST_CMD="${2:-}"; shift 2 ;;
    --lint) LINT_CMD="${2:-}"; shift 2 ;;
    -h|--help) sed -n '3,29p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -d "$WS" ] || { echo "workspace not found: $WS" >&2; exit 1; }
WS="$(cd "$WS" && pwd)"

# --- detect the project type ------------------------------------------------
detect() {
  if [ -n "$TEST_CMD" ]; then echo "$TEST_CMD"; return; fi
  if [ -f "$WS/Cargo.toml" ]; then echo "cargo test"; return; fi
  if [ -f "$WS/go.mod" ]; then echo "go test ./..."; return; fi
  if [ -f "$WS/pyproject.toml" ] || [ -f "$WS/pytest.ini" ] || [ -d "$WS/tests" ]; then echo "pytest -q"; return; fi
  if [ -f "$WS/pnpm-lock.yaml" ]; then echo "pnpm test"; return; fi
  if [ -f "$WS/yarn.lock" ]; then echo "yarn test"; return; fi
  if [ -f "$WS/package.json" ]; then echo "npm test"; return; fi
  if [ -f "$WS/Makefile" ] && grep -qE '^test:' "$WS/Makefile"; then echo "make test"; return; fi
  echo ""
}

detect_lint() {
  if [ -n "$LINT_CMD" ]; then echo "$LINT_CMD"; return; fi
  if [ -f "$WS/Cargo.toml" ]; then echo "cargo clippy -- -D warnings"; return; fi
  if [ -f "$WS/pyproject.toml" ] && grep -q "ruff" "$WS/pyproject.toml" 2>/dev/null; then echo "ruff check ."; return; fi
  if [ -f "$WS/pnpm-lock.yaml" ]; then echo "pnpm run lint"; return; fi
  if [ -f "$WS/package.json" ]; then echo "npm run lint"; return; fi
  echo ""
}

TEST="$(detect)"
LINT="$(detect_lint)"

if [ -z "$TEST" ]; then
  echo "无法识别项目类型（${WS}）：没有 Cargo.toml / go.mod / pyproject.toml / package.json / Makefile:test。" >&2
  echo "请显式指定：--test \"<命令>\" [--lint \"<命令>\"]" >&2
  exit 3
fi

KIND="unknown"
if [ -f "$WS/Cargo.toml" ]; then KIND="rust"
elif [ -f "$WS/go.mod" ]; then KIND="go"
elif [ -f "$WS/pyproject.toml" ] || [ -d "$WS/tests" ]; then KIND="python"
elif [ -f "$WS/package.json" ]; then KIND="node"
fi

# --- build the JSON ---------------------------------------------------------
QUALITY="$(TEST="$TEST" LINT="$LINT" KIND="$KIND" python3 - <<'PY'
import json, os
commands = [{"id": "test", "name": "单元测试", "command": os.environ["TEST"], "required": True, "phase": "gate"}]
lint = os.environ.get("LINT", "")
if lint:
    # Non-required on purpose: a missing lint script must not block delivery.
    commands.append({"id": "lint", "name": "lint", "command": lint, "required": False, "phase": "lint"})
print(json.dumps({"commands": commands}, ensure_ascii=False, indent=2))
PY
)"

SPEC_JSON=""
case "$SPEC" in
  off) SPEC_JSON='{
  "enforce": false
}' ;;
  on) SPEC_JSON='{
  "enforce": true
}' ;;
  skip) ;;
  *) echo "--spec 只能是 on / off / skip" >&2; exit 2 ;;
esac

# --- standards (optional) ---------------------------------------------------
# The thresholds are the repository's decision, so this generator only offers a
# starting point: the target values the suite recommends, per language it can see
# in the workspace, plus the exemptions that keep generated and test code from
# teaching people to ignore the gate. `standards_bootstrap` in a session is the
# better path when a human can look at the distribution first.
STANDARDS_JSON=""
case "$STANDARDS" in
  skip) ;;
  on)
    STANDARDS_JSON="$(
      WS="$WS" python3 - <<'PY2'
import json, os, pathlib

root = pathlib.Path(os.environ["WS"])
languages = {}
def has(*names):
    return any((root / name).exists() for name in names)

targets = {
    "go": {"maxFileLines": 400, "maxFunctionLines": 80, "maxDepth": 4, "maxIfBlockLines": 20, "maxParams": 5, "maxExports": 20},
    "ts": {"maxFileLines": 300, "maxFunctionLines": 60, "maxDepth": 4, "maxIfBlockLines": 20, "maxParams": 5, "maxExports": 15},
    "python": {"maxFileLines": 400, "maxFunctionLines": 60, "maxDepth": 4, "maxIfBlockLines": 20, "maxParams": 5, "maxExports": 20},
}
if has("go.mod"):
    languages["go"] = targets["go"]
if has("package.json", "tsconfig.json"):
    languages["ts"] = targets["ts"]
    languages["js"] = targets["ts"]
if has("pyproject.toml", "setup.py", "requirements.txt"):
    languages["python"] = targets["python"]
if not languages:
    languages["default"] = targets["go"]

print(json.dumps({
    "languages": languages,
    "forbidCycles": True,
    "exempt": [
        "**/*_test.go", "**/*.test.ts", "**/*.spec.ts", "**/testdata/**", "**/vendor/**",
        "**/*.pb.go", "**/*_gen.go", "**/*.gen.go", "**/*.generated.*", "**/mocks/**", "**/__mocks__/**",
        "**/dist/**", "**/build/**",
    ],
}, indent=2, ensure_ascii=False))
PY2
    )" ;;
  *) echo "--standards 只能是 on / skip" >&2; exit 2 ;;
esac

# --- report / write ---------------------------------------------------------
report() {
  local target="$1" body="$2"
  if [ "$JSON_ONLY" = "1" ]; then printf '%s\n' "$body"; return; fi
  printf '\n== %s (%s)\n%s\n' "$target" "$( [ -f "$target" ] && echo '已存在' || echo '将创建' )" "$body"
}

if [ "$JSON_ONLY" = "1" ]; then
  report "quality-gate.json" "$QUALITY"
  [ -n "$SPEC_JSON" ] && report "spec-gate.json" "$SPEC_JSON"
  [ -n "$STANDARDS_JSON" ] && report "standards.json" "$STANDARDS_JSON"
  exit 0
fi

echo "workspace : $WS"
echo "project   : $KIND"
echo "test      : $TEST"
echo "lint      : ${LINT:-(无)}"
echo "spec-gate : $SPEC"
report "$WS/.dsh/quality-gate.json" "$QUALITY"
[ -n "$SPEC_JSON" ] && report "$WS/.dsh/spec-gate.json" "$SPEC_JSON"
[ -n "$STANDARDS_JSON" ] && report "$WS/.dsh/standards.json" "$STANDARDS_JSON"

if [ "$WRITE" != "1" ]; then
  printf '\n(dry-run：加 --write 才会写入 .dsh/)\n'
  exit 0
fi

mkdir -p "$WS/.dsh"
write_one() {
  local target="$1" body="$2"
  if [ -f "$target" ] && [ "$FORCE" != "1" ]; then
    echo "跳过（已存在，加 --force 覆盖）：$target"
    return
  fi
  printf '%s\n' "$body" > "$target"
  echo "已写入：$target"
}
write_one "$WS/.dsh/quality-gate.json" "$QUALITY"
[ -n "$SPEC_JSON" ] && write_one "$WS/.dsh/spec-gate.json" "$SPEC_JSON"
[ -n "$STANDARDS_JSON" ] && write_one "$WS/.dsh/standards.json" "$STANDARDS_JSON"
echo
echo "这些文件属于信任根（.dsh/** 对写类工具关闭），请提交到仓库；插件会在下一次门禁运行时读取。"
