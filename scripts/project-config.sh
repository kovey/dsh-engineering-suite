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
#   --interaction on|skip  → 写 <root>/interaction-gate.json（交互层骨架）
#   --deploy on|skip       → 写 <root>/deploy-gate.json（环境清单骨架，默认空 = 拒绝部署）
#   --test-design on|skip  → 写 <root>/test-design-gate.json（评审严度）
#   --supply-chain on|skip → 写 <root>/supply-chain-gate.json（清单 + 审计命令；无锁文件时显式留空）
#   --coverage on|skip     → 写 <root>/coverage-gate.json（调用 scripts/coverage.sh 出 lcov）
#   --impact on|skip       → 写 <root>/impact-gate.json（最小回归命令模板）
#   --evidence on|skip     → 写 <root>/evidence-gate.json（必填证据类型与门禁来源）
#
# <root> 是本套件的布局根：`.dsh/engineering-suite/`（已迁移，目录存在即用它）或 `.dsh/`。
#   --no-gitignore        不自动补 .dsh 运行时忽略规则（见下）
#   --json       只打印将写入的内容
#   --print      只打印检测结果（kind=/test=/lint= 三行，不写任何文件），
#                供脚本和测试断言；检测不到测试命令时仍以 3 退出
#
# 结构规范检查（`scripts/standards-check.sh`）：目标仓库根存在**可执行**的该脚本时，
# quality-gate.json 会自动多一条 required 的命令（id=standards、phase=gate、--quiet）：
#   - 它检查什么：仓库自己声明的结构阈值（`.dsh/standards.json`：文件/函数行数、嵌套深度、
#     if 块行数、参数个数、导出面、分层依赖、导入环），并与基线棘轮比较——只有**新增或恶化**
#     的违规才失败（exit 1）；基线里已接受的存量债务不挡门禁；
#   - 如何豁免：优先改代码；确有理由（生成代码、表格型代码、大 switch）由人在 `.dsh/standards.json`
#     里加 `exempt` 或按语言/目录放宽阈值；存量债务确实要带着走，则由人在会话里执行
#     `standards_check({ accept: true, note: "原因" })`——放宽基线需要人工批准，模型改不了 `.dsh/**`；
#   - 为什么 required：结构债和测试失败一样会让下一次改动变贵，门禁默认要挡住它；不需要时由人把它
#     从 quality-gate.json 里删掉（配置属于信任根）；
#   - 脚本不存在或不可执行时**不写**这条命令：一条必然失败的命令比没有命令更糟。
#
# 写入时会顺带保证 `.gitignore` 忽略**运行时台账**（.dsh/missions/、audit/、state/、
# specs/ 以及已存在的根级 *.jsonl）：不忽略的话，每次门禁运行都会改动工作区，
# 交付时的 requireCleanTree 会报"与门禁观测的指纹不一致"（两个 diff 摘要不同）。
# 配置类文件（.dsh/*.json、roles/）属于信任根，**不**会被忽略，请照常提交评审。
set -euo pipefail

WS="$PWD"
WRITE=0
FORCE=0
JSON_ONLY=0
PRINT_ONLY=0
SPEC="skip"
STANDARDS="skip"
INTERACTION="skip"
DEPLOY="skip"
TEST_DESIGN="skip"
SUPPLY_CHAIN="skip"
COVERAGE="skip"
IMPACT="skip"
EVIDENCE="skip"
GITIGNORE=1
TEST_CMD=""
LINT_CMD=""

while [ $# -gt 0 ]; do
  case "$1" in
    --workspace) WS="${2:-}"; shift 2 ;;
    --write) WRITE=1; shift ;;
    --force) FORCE=1; shift ;;
    --json) JSON_ONLY=1; shift ;;
    --print) PRINT_ONLY=1; shift ;;
    --spec) SPEC="${2:-skip}"; shift 2 ;;
    --standards) STANDARDS="${2:-skip}"; shift 2 ;;
    --interaction) INTERACTION="${2:-skip}"; shift 2 ;;
    --deploy) DEPLOY="${2:-skip}"; shift 2 ;;
    --test-design) TEST_DESIGN="${2:-skip}"; shift 2 ;;
    --supply-chain) SUPPLY_CHAIN="${2:-skip}"; shift 2 ;;
    --coverage) COVERAGE="${2:-skip}"; shift 2 ;;
    --impact) IMPACT="${2:-skip}"; shift 2 ;;
    --evidence) EVIDENCE="${2:-skip}"; shift 2 ;;
    --no-gitignore) GITIGNORE=0; shift ;;
    --test) TEST_CMD="${2:-}"; shift 2 ;;
    --lint) LINT_CMD="${2:-}"; shift 2 ;;
    -h|--help) sed -n '3,/^set -euo pipefail$/p' "$0" | sed '$d'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -d "$WS" ] || { echo "workspace not found: $WS" >&2; exit 1; }
WS="$(cd "$WS" && pwd)"

# --- where does THIS suite read its config? --------------------------------
# Since v0.8.0 the layout root is `<workspace>/.dsh/engineering-suite/` when that
# directory exists, else `<workspace>/.dsh/`. Writing to the legacy path in a
# migrated repository would produce files nobody reads — the config would look
# "present" on disk and have no effect at all.
DSH="$WS/.dsh"
if [ -d "$DSH/engineering-suite" ]; then DSH="$DSH/engineering-suite"; fi
DSH_REL="${DSH#"$WS"/}"

# --- detect the project type ------------------------------------------------
# One precedence list, one place: `DETECTED_TEST` and `DETECTED_KIND` are set
# together so the `project :` line can never disagree with the command written.
# Precedence = "the manifest that names its own runner wins"; package manifests
# come before the generic build files, and the Makefile is the LAST resort (it
# is a convenience wrapper, not a toolchain). Keep this list in step with
# `recognizeTestCommand` (packages/dsh-eng-core/src/test-commands.ts): the
# cross-side test in packages/dsh-eng-core/test/test-commands.test.ts runs this
# script per manifest and feeds the output to the recogniser.
DETECTED_KIND="unknown"
DETECTED_TEST=""

detect() {
  if [ -f "$WS/composer.json" ]; then
    DETECTED_KIND="php"; DETECTED_TEST="vendor/bin/phpunit"
  elif [ -f "$WS/Gemfile" ]; then
    DETECTED_KIND="ruby"; DETECTED_TEST="bundle exec rspec"
  elif [ -f "$WS/mix.exs" ]; then
    DETECTED_KIND="elixir"; DETECTED_TEST="mix test"
  elif [ -f "$WS/Package.swift" ]; then
    DETECTED_KIND="swift"; DETECTED_TEST="swift test"
  elif [ -f "$WS/build.gradle" ] || [ -f "$WS/build.gradle.kts" ]; then
    DETECTED_KIND="jvm"; DETECTED_TEST="./gradlew test"
  elif [ -f "$WS/pom.xml" ]; then
    DETECTED_KIND="jvm"; DETECTED_TEST="mvn test"
  elif [ -f "$WS/Cargo.toml" ]; then
    DETECTED_KIND="rust"; DETECTED_TEST="cargo test"
  elif [ -f "$WS/go.mod" ]; then
    DETECTED_KIND="go"; DETECTED_TEST="go test ./..."
  elif [ -f "$WS/pyproject.toml" ] || [ -f "$WS/pytest.ini" ] || [ -f "$WS/tox.ini" ] || [ -d "$WS/tests" ]; then
    DETECTED_KIND="python"; DETECTED_TEST="pytest -q"
  elif [ -f "$WS/pnpm-lock.yaml" ]; then
    DETECTED_KIND="node"; DETECTED_TEST="pnpm test"
  elif [ -f "$WS/yarn.lock" ]; then
    DETECTED_KIND="node"; DETECTED_TEST="yarn test"
  elif [ -f "$WS/package.json" ]; then
    DETECTED_KIND="node"; DETECTED_TEST="npm test"
  elif [ -f "$WS/CMakeLists.txt" ]; then
    DETECTED_KIND="cpp"; DETECTED_TEST="ctest"
  else
    # .NET has no single manifest name; check the project/solution files. An
    # unmatched glob stays literal, so `[ -f ]` is false and nothing is claimed.
    for dotnet_project in "$WS"/*.csproj "$WS"/*.sln; do
      if [ -f "$dotnet_project" ]; then
        DETECTED_KIND="dotnet"; DETECTED_TEST="dotnet test"; break
      fi
    done
    if [ -z "$DETECTED_TEST" ] && [ -f "$WS/Makefile" ] && grep -qE '^test:' "$WS/Makefile"; then
      DETECTED_KIND="make"; DETECTED_TEST="make test"
    fi
  fi
  # An explicit --test wins over detection; the kind still reports what the
  # repository is (same as before this list grew).
  if [ -n "$TEST_CMD" ]; then DETECTED_TEST="$TEST_CMD"; fi
}

# lint 默认值：按 detect() 已经判定的 `$KIND` 分支，而不是再查一遍文件——
# "检测到哪种生态"和"该生态的 lint 是什么"必须由同一个事实决定，否则两份清单
# 迟早各说各话（eng-core 的 suggestCommands 是同一张表的 TypeScript 副本，
# 两侧由 packages/dsh-eng-core/test/test-commands.test.ts 的 manifest 表钉住）。
#
# 有约定 linter 的生态才给命令：cpp / make（以及将来新增但还没约定的生态）**明确
# 返回空**（报告里显示 `(无)`），不编一条。理由见 header：一条跑不起来的 lint
# 会让 `--write` 生成一份必然失败的门禁（lint 不阻断，但会一直 WARN），比空着更糟。
# `--lint` 仍然最优先：显式给的命令永远赢过任何检测。
detect_lint() {
  if [ -n "$LINT_CMD" ]; then echo "$LINT_CMD"; return; fi
  case "$KIND" in
    rust) echo "cargo clippy -- -D warnings" ;;
    go) echo "go vet ./..." ;;
    # python 没有统一 linter：只有 pyproject.toml 自己声明了 ruff 才建议，否则留空。
    python)
      if [ -f "$WS/pyproject.toml" ] && grep -q "ruff" "$WS/pyproject.toml" 2>/dev/null; then
        echo "ruff check ."
      fi ;;
    # node 的 lint 脚本由 package.json 提供，锁文件决定用哪个包管理器调用它。
    node)
      if [ -f "$WS/pnpm-lock.yaml" ]; then echo "pnpm run lint"
      elif [ -f "$WS/package.json" ]; then echo "npm run lint"
      fi ;;
    php) echo "vendor/bin/phpcs" ;;
    ruby) echo "bundle exec rubocop" ;;
    swift) echo "swiftlint" ;;
    # jvm 的 kind 不区分 maven/gradle：lint 按实际存在的构建文件二选一。
    jvm)
      if [ -f "$WS/build.gradle" ] || [ -f "$WS/build.gradle.kts" ]; then echo "./gradlew detekt"
      else echo "mvn -q -DskipTests verify"
      fi ;;
    dotnet) echo "dotnet format --verify-no-changes" ;;
    elixir) echo "mix format --check-formatted" ;;
    # cpp / make：没有默认 linter（clang-tidy 之类要项目自己配置），明确留空。
    cpp|make|unknown) ;;
  esac
  echo ""
}

detect
TEST="$DETECTED_TEST"
KIND="$DETECTED_KIND"
LINT="$(detect_lint)"

# Machine-readable detection for scripts (and the cross-side agreement test):
# three lines, no headers, nothing written.
if [ "$PRINT_ONLY" = "1" ]; then
  printf 'kind=%s\ntest=%s\nlint=%s\n' "$KIND" "$TEST" "$LINT"
  [ -n "$TEST" ] || exit 3
  exit 0
fi

if [ -z "$TEST" ]; then
  echo "无法识别项目类型（${WS}）：没有 composer.json / Gemfile / mix.exs / Package.swift / build.gradle(.kts) / pom.xml / Cargo.toml / go.mod / pyproject.toml / tox.ini / package.json / CMakeLists.txt / *.csproj / *.sln / Makefile:test。" >&2
  echo "请显式指定：--test \"<命令>\" [--lint \"<命令>\"]" >&2
  exit 3
fi

# --- 结构规范检查（可选，棘轮） ---------------------------------------------
# 只有目标仓库真的能跑它时才装配：`bash scripts/…` 只需要读权限，可执行位是"这个仓库
# 确实把它当作入口"的信号，两者都满足才写。一条指向不存在脚本的 required 命令会让每次
# 交付都 BLOCK 在一个跑不起来的东西上——比不配置更糟（见 header 的同一条理由）。
STANDARDS_CHECK=0
if [ -x "$WS/scripts/standards-check.sh" ]; then STANDARDS_CHECK=1; fi

# --- build the JSON ---------------------------------------------------------
QUALITY="$(TEST="$TEST" LINT="$LINT" KIND="$KIND" STANDARDS_CHECK="$STANDARDS_CHECK" python3 - <<'PY'
import json, os
commands = [{"id": "test", "name": "单元测试", "command": os.environ["TEST"], "required": True, "phase": "gate"}]
lint = os.environ.get("LINT", "")
if lint:
    # Non-required on purpose: a missing lint script must not block delivery.
    commands.append({"id": "lint", "name": "lint", "command": lint, "required": False, "phase": "lint"})
# 结构规范（棘轮）：目标仓库有可执行的 scripts/standards-check.sh 才装配；required 的理由见
# 脚本 header（结构债和测试失败一样会让下次改动变贵）。id 已存在时不重复添加。
if os.environ.get("STANDARDS_CHECK") == "1" and not any(command["id"] == "standards" for command in commands):
    commands.append({
        "id": "standards",
        "name": "结构规范（棘轮）",
        "command": "bash scripts/standards-check.sh --quiet",
        "phase": "gate",
        "required": True,
    })
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

# --- the remaining gates ----------------------------------------------------
# A config naming a command that cannot run is worse than no config: the gate then
# fails with a confusing error instead of saying "not configured". Each block below
# only names what the repository can actually execute.
TEST_DESIGN_JSON=""
case "$TEST_DESIGN" in
  on) TEST_DESIGN_JSON='{
  "strict": false,
  "minTextLength": 4,
  "allowDanglingCase": false,
  "requireAllScenarios": true
}' ;;
  skip) ;;
  *) echo "--test-design 只能是 on / skip" >&2; exit 2 ;;
esac

SUPPLY_CHAIN_JSON=""
case "$SUPPLY_CHAIN" in
  on)
    # `auditCommands` stays EMPTY on purpose: a repository with no lockfile and no
    # runtime dependencies cannot produce an audit report. The gate then says
    # "manifests changed but nobody audited" (WARN), which is the truth; naming a
    # command that cannot run would be a BLOCK for no reason.
    SUPPLY_CHAIN_JSON='{
  "deps": {
    "manifests": ["package.json"],
    "auditCommands": []
  },
  "secretScan": { "scanWholeTree": false }
}' ;;
  skip) ;;
  *) echo "--supply-chain 只能是 on / skip" >&2; exit 2 ;;
esac

COVERAGE_JSON=""
case "$COVERAGE" in
  on)
    # The gate runs its command as argv (no shell), so a glob cannot be expanded
    # by the caller: the reviewed script owns the globbing and the report path.
    #
    # Only `total` is declared. This repository's tests execute BUILD OUTPUT
    # (`dist/*.js`), which is what node instruments, while a change lands in
    # `src/*.ts` — without a sourcemap for coverage there is no honest way to map
    # one to the other, and a `changed` threshold here would simply be unjudgeable
    # on every change (reported as "cannot judge", never as a pass). Declaring what
    # CAN be measured is the point of having a threshold at all.
    COVERAGE_JSON='{
  "coverageCommand": "bash scripts/coverage.sh {reportFile}",
  "reportFile": "coverage/lcov.info",
  "thresholds": { "total": 70 }
}' ;;
  skip) ;;
  *) echo "--coverage 只能是 on / skip" >&2; exit 2 ;;
esac

IMPACT_JSON=""
case "$IMPACT" in
  on) IMPACT_JSON='{
  "testCommandTemplate": "node --test {files}",
  "defaultBase": "HEAD"
}' ;;
  skip) ;;
  *) echo "--impact 只能是 on / skip" >&2; exit 2 ;;
esac

EVIDENCE_JSON=""
case "$EVIDENCE" in
  on) EVIDENCE_JSON='{
  "requireGate": true,
  "gateSource": "dsh-quality-gate",
  "requiredEvidenceKinds": ["command", "test"],
  "requireCleanTree": true
}' ;;
  skip) ;;
  *) echo "--evidence 只能是 on / skip" >&2; exit 2 ;;
esac

# --- interaction / deploy (optional skeletons) ------------------------------
INTERACTION_JSON=""
case "$INTERACTION" in
  on) INTERACTION_JSON='{
  "askTimeoutMs": 900000,
  "requireApproverList": false,
  "preferredChannels": []
}' ;;
  skip) ;;
  *) echo "--interaction 只能是 on / skip" >&2; exit 2 ;;
esac

DEPLOY_JSON=""
case "$DEPLOY" in
  on) DEPLOY_JSON='{
  "environments": []
}' ;;
  skip) ;;
  *) echo "--deploy 只能是 on / skip" >&2; exit 2 ;;
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
  [ -n "$INTERACTION_JSON" ] && report "interaction-gate.json" "$INTERACTION_JSON"
  [ -n "$DEPLOY_JSON" ] && report "deploy-gate.json" "$DEPLOY_JSON"
  [ -n "$TEST_DESIGN_JSON" ] && report "test-design-gate.json" "$TEST_DESIGN_JSON"
  [ -n "$SUPPLY_CHAIN_JSON" ] && report "supply-chain-gate.json" "$SUPPLY_CHAIN_JSON"
  [ -n "$COVERAGE_JSON" ] && report "coverage-gate.json" "$COVERAGE_JSON"
  [ -n "$IMPACT_JSON" ] && report "impact-gate.json" "$IMPACT_JSON"
  [ -n "$EVIDENCE_JSON" ] && report "evidence-gate.json" "$EVIDENCE_JSON"
  exit 0
fi

echo "workspace : $WS"
echo "config    : $DSH_REL"
echo "project   : $KIND"
echo "test      : $TEST"
echo "lint      : ${LINT:-(无)}"
echo "spec-gate : $SPEC"
if [ "$STANDARDS_CHECK" = "1" ]; then
  echo "standards : 已装配（新增/恶化的结构违规 → exit 1；存量债务在基线里，豁免由人改 .dsh/standards.json 的 exempt/阈值）"
else
  echo "standards : 跳过（scripts/standards-check.sh 不存在或不可执行）——不生成必然失败的命令"
fi
report "$DSH/quality-gate.json" "$QUALITY"
[ -n "$SPEC_JSON" ] && report "$DSH/spec-gate.json" "$SPEC_JSON"
[ -n "$STANDARDS_JSON" ] && report "$DSH/standards.json" "$STANDARDS_JSON"
[ -n "$INTERACTION_JSON" ] && report "$DSH/interaction-gate.json" "$INTERACTION_JSON"
[ -n "$DEPLOY_JSON" ] && report "$DSH/deploy-gate.json" "$DEPLOY_JSON"
[ -n "$TEST_DESIGN_JSON" ] && report "$DSH/test-design-gate.json" "$TEST_DESIGN_JSON"
[ -n "$SUPPLY_CHAIN_JSON" ] && report "$DSH/supply-chain-gate.json" "$SUPPLY_CHAIN_JSON"
[ -n "$COVERAGE_JSON" ] && report "$DSH/coverage-gate.json" "$COVERAGE_JSON"
[ -n "$IMPACT_JSON" ] && report "$DSH/impact-gate.json" "$IMPACT_JSON"
[ -n "$EVIDENCE_JSON" ] && report "$DSH/evidence-gate.json" "$EVIDENCE_JSON"

if [ "$WRITE" != "1" ]; then
  printf '\n(dry-run：加 --write 才会写入 %s/)\n' "$DSH_REL"
  exit 0
fi

mkdir -p "$DSH"
write_one() {
  local target="$1" body="$2"
  if [ -f "$target" ] && [ "$FORCE" != "1" ]; then
    echo "跳过（已存在，加 --force 覆盖）：$target"
    return
  fi
  printf '%s\n' "$body" > "$target"
  echo "已写入：$target"
}
write_one "$DSH/quality-gate.json" "$QUALITY"
[ -n "$SPEC_JSON" ] && write_one "$DSH/spec-gate.json" "$SPEC_JSON"
[ -n "$STANDARDS_JSON" ] && write_one "$DSH/standards.json" "$STANDARDS_JSON"
[ -n "$INTERACTION_JSON" ] && write_one "$DSH/interaction-gate.json" "$INTERACTION_JSON"
[ -n "$DEPLOY_JSON" ] && write_one "$DSH/deploy-gate.json" "$DEPLOY_JSON"
[ -n "$TEST_DESIGN_JSON" ] && write_one "$DSH/test-design-gate.json" "$TEST_DESIGN_JSON"
[ -n "$SUPPLY_CHAIN_JSON" ] && write_one "$DSH/supply-chain-gate.json" "$SUPPLY_CHAIN_JSON"
[ -n "$COVERAGE_JSON" ] && write_one "$DSH/coverage-gate.json" "$COVERAGE_JSON"
[ -n "$IMPACT_JSON" ] && write_one "$DSH/impact-gate.json" "$IMPACT_JSON"
[ -n "$EVIDENCE_JSON" ] && write_one "$DSH/evidence-gate.json" "$EVIDENCE_JSON"
if [ -n "$DEPLOY_JSON" ]; then
  echo "注意：deploy-gate.json 的 environments 为空 → deploy_plan / deploy_run 会拒绝执行（fail closed）；"
  echo "      声明了环境与命令之后才可能部署，生产环境默认需要人工批准。"
fi

# --- .gitignore：只忽略运行时台账 -------------------------------------------
if [ "$GITIGNORE" = "1" ] && [ -d "$WS/.git" ]; then
  ADDED=()
  # Ignore RUNTIME paths under the root this suite actually reads ($DSH), not the
  # legacy `.dsh/` literals: in a migrated repository `.dsh/missions/` matches
  # nothing, so the old list silently stopped ignoring the real ledgers (and the
  # config files, which must be committed, were the only thing left mentioned).
  for target in "missions" "audit" "state" "kb"; do
    if ! git -C "$WS" check-ignore -q "$DSH_REL/$target/" 2>/dev/null; then ADDED+=("$DSH_REL/$target/"); fi
  done
  if [ "$DSH_REL" != ".dsh" ] && [ -d "$DSH" ]; then
    if ! git -C "$WS" check-ignore -q "$DSH_REL/*.jsonl" 2>/dev/null; then ADDED+=("$DSH_REL/*.jsonl"); fi
  fi
  # 已存在但未忽略的根级台账（只处理真实存在的文件，避免给每个仓库塞四行）
  if [ -d "$DSH" ]; then
    while IFS= read -r ledger; do
      [ -n "$ledger" ] || continue
      if ! git -C "$WS" check-ignore -q "$DSH_REL/$ledger" 2>/dev/null; then ADDED+=("$DSH_REL/$ledger"); fi
    done < <(cd "$DSH" && ls *.jsonl 2>/dev/null || true)
  fi
  if [ "${#ADDED[@]}" -gt 0 ]; then
    if [ ! -f "$WS/.gitignore" ]; then printf '' > "$WS/.gitignore"; fi
    # Append-only, and only onto a COMPLETE line (2026-09 adversarial audit C7):
    # a human's `.gitignore` whose last line has no trailing newline used to be
    # concatenated with our first pattern — `node_modules` became
    # `node_modules.dsh/missions/`, which both destroyed their pattern and
    # silently failed to ignore the runtime ledger. `printf '%s\n'` supplies the
    # newline AFTER our line, never before it.
    if [ -s "$WS/.gitignore" ]; then
      last_byte="$(tail -c 1 "$WS/.gitignore" | od -An -t u1 | tr -d ' \n')"
      if [ "$last_byte" != "10" ]; then printf '\n' >> "$WS/.gitignore"; fi
    fi
    printf '%s\n' "${ADDED[@]}" >> "$WS/.gitignore"
    echo "已补 .gitignore 运行时忽略：${ADDED[*]}"
    echo "（配置类文件不会被忽略：它们是信任根，请提交评审。加 --no-gitignore 可跳过本步骤。）"
  fi
fi

echo
echo "这些文件属于信任根（.dsh/** 对写类工具关闭），请提交到仓库；插件会在下一次门禁运行时读取。"
