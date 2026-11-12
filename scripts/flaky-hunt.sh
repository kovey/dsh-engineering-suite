#!/usr/bin/env bash
# flaky-hunt.sh — 把"下一次偶发失败"变成有名字的证据。
#
# usage: flaky-hunt.sh [--runs N] [--command <cmd>] [--keep]
#   --runs N        采样次数（默认 3；必须是 >= 1 的整数，0 或非数字是用法错误）
#   --command <cmd> 要重复执行的命令（默认 `bash scripts/verify.sh --quiet`；工作目录 = 仓库根）
#   --keep          默认就保留日志；--keep 把"保留"写成显式（行为相同，见下面的日志说明）
#   -h, --help      打印本段说明
#
# 为什么需要它：2026-11-12 的全量 verify 有 3 次偶发非零，其中两次定位到了具体用例
# （interaction-gate 的 40ms 超时预算、orchestrator metrics 的只读用例整树快照），
# 第三次在 v0.8.8 发版前失败，**输出里连 `✖` 都没有**——没有包名、没有用例名，等于没有证据。
# 没有证据的 flake 只能靠"再跑一次"安慰自己。本脚本把"下次失败"变成：
#   1) 一次运行的完整日志（不在报告里被截断，也不写进仓库）；
#   2) 失败包名（test-all.sh --quiet 的 `==> <pkg> (exit N)`）；
#   3) 失败用例名（node:test 的 `✖ <name>`；没有时回落到 TAP 的 `not ok`）；
#   4) 一层判据：对每个失败包**单独重跑** 3 次——单独不复现指向并发/资源竞争
#      （共享状态、实时钟、端口或临时目录），单独复现则是稳定失败。两种都要修，
#      但修法完全不同，这就是"先分单独/并发，再修"里的"分"。
#
# 判读顺序（与 docs/ARCHITECTURE.md §5.34 一致）：先抓名字 → 再分单独/并发 → 再修。
#   全绿（0）= 未复现，**不是**"不存在 flake"：3 次采样不足以排除低频失败。
#   任一次失败（1）= 有名字的证据（日志 + 包名 + 用例名），按上面的判据修。
#   参数错误（2）= 什么都没跑（`--runs 0` 也是这一类：0 次采样不是"通过"）。
#
# 日志：$TMPDIR/flaky-hunt-<stamp>-XXXXXX/（**绝不写进仓库**；落在仓库里会被拒绝）
#   run-<i>.log             第 i 次采样的完整输出
#   isolated-<pkg>-<j>.log  失败包单独重跑的第 j 次输出
# 失败日志永不删除，脚本结尾打印目录；默认保留全部日志（`--keep` 只是把这条写成显式）。
# 想清掉就自己删那个目录——删除它的决定不该由一个"取证"脚本替你做。
#
# 提示：默认命令的 `--quiet` 在失败时只回显 test-all 转录的前 8 KiB。如果日志里连
# `==> <pkg> (exit N)` 都找不到（恰恰是最需要证据的那类失败），改用
#   bash scripts/flaky-hunt.sh --command 'bash scripts/test-all.sh --quiet'
# 拿到每个包完整的失败转录——`✖` 行更可能在切片之外。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  # header 即帮助文本（与 verify.sh / standards-check.sh 同一写法）：只有一份，不会漂移。
  sed -n '2,/^set -euo pipefail$/p' "$0" | sed '$d'
}

# 单独重跑的次数固定为 3：规格里的判据就是"单独连跑 3 次"。
ISOLATED_RUNS=3
CASE_LIMIT=40

runs=3
command="bash scripts/verify.sh --quiet"
keep=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --runs)
      if [ "$#" -lt 2 ]; then
        printf 'flaky-hunt.sh: --runs 需要采样次数\n' >&2
        exit 2
      fi
      runs="$2"
      shift 2
      ;;
    --runs=*)
      runs="${1#--runs=}"
      shift
      ;;
    --command)
      if [ "$#" -lt 2 ]; then
        printf 'flaky-hunt.sh: --command 需要一条命令\n' >&2
        exit 2
      fi
      command="$2"
      shift 2
      ;;
    --command=*)
      command="${1#--command=}"
      shift
      ;;
    --keep)
      keep=1
      shift
      ;;
    *)
      printf 'flaky-hunt.sh: 未知参数：%s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# `--runs 0` 必须被拒绝：0 次采样的"全绿"是一个什么都没验证的绿色。
case "$runs" in
  ''|*[!0-9]*)
    printf 'flaky-hunt.sh: --runs 需要正整数，收到 %s\n' "$runs" >&2
    exit 2
    ;;
esac
if [ "$runs" -lt 1 ]; then
  printf 'flaky-hunt.sh: --runs 必须 >= 1（0 次采样不是"通过"）\n' >&2
  exit 2
fi

if [ -z "${command//[[:space:]]/}" ]; then
  printf 'flaky-hunt.sh: --command 不能为空\n' >&2
  exit 2
fi

# --- 日志目录：平台临时区，且必须在仓库之外 -------------------------------------
tmp_base="${TMPDIR:-/tmp}"
tmp_base="${tmp_base%/}"
if ! logdir="$(mktemp -d "$tmp_base/flaky-hunt-$(date +%Y%m%d-%H%M%S)-XXXXXX" 2>/dev/null)"; then
  printf 'flaky-hunt.sh: 无法在 %s 下创建日志目录（检查 TMPDIR）\n' "$tmp_base" >&2
  exit 2
fi
root_real="$(cd "$ROOT" && pwd -P)"
logdir_real="$(cd "$logdir" && pwd -P)"
case "$logdir_real/" in
  "$root_real"/*)
    printf 'flaky-hunt.sh: 日志目录落在仓库内（%s）——拒绝：采样日志不写进工作区\n' "$logdir_real" >&2
    rmdir "$logdir" 2>/dev/null || true
    exit 2
    ;;
esac

# --- 提取器：失败包 / 失败用例 / 失败阶段 ---------------------------------------
# 失败包：test-all.sh --quiet 对每个失败的包打印 `==> <pkg> (exit N)`。
# 通过是 `==> <pkg> ok`，没有测试是 `==> <pkg> (no tests)`，所以这个模式只命中失败。
packages_in() {
  grep -E '^==> [^[:space:]]+ \(exit [0-9]+\)$' "$1" 2>/dev/null \
    | sed -E 's/^==> ([^[:space:]]+) \(exit [0-9]+\)$/\1/' \
    | awk '!seen[$0]++' || true
}

# 失败用例：node:test 的 `✖ <name>`；没有 ✖（例如 --quiet 的 8 KiB 切片丢掉了）时
# 回落到 TAP 的 `not ok <n> - <name>`。去重并截断到 CASE_LIMIT 条，避免刷屏。
cases_in() {
  local log="$1" limit="${2:-$CASE_LIMIT}" raw
  raw="$(grep -F '✖' "$log" 2>/dev/null || true)"
  if [ -z "$raw" ]; then
    raw="$(grep -E '^[[:space:]]*not ok ' "$log" 2>/dev/null || true)"
  fi
  if [ -z "$raw" ]; then
    return 0
  fi
  # `✖ failing tests:` 是 node:test 的汇总小标题，不是用例名；留着它只会把真正的名字埋掉。
  printf '%s\n' "$raw" \
    | sed -E 's/^[[:space:]]+//' \
    | grep -v -E '^✖ failing tests:?$' \
    | awk -v limit="$limit" '!seen[$0]++ { print; if (++count >= limit) exit }' || true
}

# verify.sh --quiet 的失败阶段行（`printf '%-46s FAILED'`）：构建/类型检查阶段失败时
# 它没有包名，只有这一行——留着它，失败才不是"什么都没有"。
stages_in() {
  grep -E '^.{1,160}FAILED$' "$1" 2>/dev/null \
    | sed -E 's/[[:space:]]+$//' \
    | awk '!seen[$0]++' || true
}

# --- 采样 ----------------------------------------------------------------------
declare -a run_codes=()
declare -a failed_runs=()
failed_count=0

printf 'flaky-hunt: 命令：%s\n' "$command"
printf 'flaky-hunt: 工作目录：%s\n' "$ROOT"
printf 'flaky-hunt: 采样次数：%s；单独重跑：每个失败包 %s 次\n' "$runs" "$ISOLATED_RUNS"
printf 'flaky-hunt: 日志目录：%s\n\n' "$logdir_real"

for index in $(seq 1 "$runs"); do
  log="$logdir/run-$index.log"
  status=0
  started=$SECONDS
  # bash -c：`--command 'bash scripts/verify.sh --quiet'` 与 `--command 'true'` 都能用；
  # cwd 固定在仓库根，所以相对路径命令在哪个目录调用本脚本都一样。
  ( cd "$ROOT" && bash -c "$command" ) >"$log" 2>&1 || status=$?
  elapsed=$((SECONDS - started))
  run_codes[$index]="$status"
  if [ "$status" -eq 0 ]; then
    printf 'run %d/%d  ok       exit=0  %ss\n' "$index" "$runs" "$elapsed"
  else
    failed_runs+=("$index")
    failed_count=$((failed_count + 1))
    printf 'run %d/%d  FAILED   exit=%d  %ss  → %s\n' "$index" "$runs" "$status" "$elapsed" "$logdir_real/run-$index.log"
  fi
done

# --- 失败汇总：包名 + 用例名 ----------------------------------------------------
declare -a failing_packages=()
package_count=0
add_package() {
  local name="$1" existing
  for existing in ${failing_packages[@]+"${failing_packages[@]}"}; do
    if [ "$existing" = "$name" ]; then
      return 0
    fi
  done
  failing_packages+=("$name")
  package_count=$((package_count + 1))
}

if [ "$failed_count" -gt 0 ]; then
  printf '\n==== 失败汇总：%d 次采样中 %d 次失败 ====\n' "$runs" "$failed_count"
  for index in ${failed_runs[@]+"${failed_runs[@]}"}; do
    log="$logdir/run-$index.log"
    printf '\n--- run-%d.log（exit %s） ---\n' "$index" "${run_codes[$index]}"

    stages="$(stages_in "$log")"
    if [ -n "$stages" ]; then
      printf '失败阶段:\n'
      printf '%s\n' "$stages" | sed 's/^/  /'
    fi

    packages="$(packages_in "$log")"
    if [ -n "$packages" ]; then
      printf '失败包:\n'
      printf '%s\n' "$packages" | sed 's/^/  /'
      while IFS= read -r name; do
        if [ -n "$name" ]; then
          add_package "$name"
        fi
      done <<< "$packages"
    fi

    cases="$(cases_in "$log")"
    if [ -n "$cases" ]; then
      printf '失败用例（去重，最多 %d 条；完整转录见日志）:\n' "$CASE_LIMIT"
      printf '%s\n' "$cases" | sed 's/^/  /'
    fi

    if [ -z "$stages$packages$cases" ]; then
      printf '没有可识别的失败包/用例名——日志里既没有 `==> <pkg> (exit N)` 也没有 `✖`。\n'
      if [ -s "$log" ]; then
        printf '日志开头（前 12 行）:\n'
        sed -n '1,12p' "$log" | sed 's/^/  /'
      else
        printf '日志为空（命令没有输出就退出了）。\n'
      fi
    fi
    printf '日志：%s\n' "$logdir_real/run-$index.log"
  done
fi

# --- 单独重跑：区分"并发相关"与"稳定失败" --------------------------------------
if [ "$package_count" -gt 0 ]; then
  printf '\n==== 单独重跑：区分"并发相关"与"稳定失败" ====\n'
  if ! command -v node >/dev/null 2>&1; then
    printf 'node 不可用：跳过单独重跑（本次失败仍然成立，只看失败包名/用例名）。\n'
  else
    for name in ${failing_packages[@]+"${failing_packages[@]}"}; do
      if ! compgen -G "$ROOT/packages/$name/test/*.test.ts" >/dev/null; then
        printf '  %s: packages/%s/test/ 下没有 *.test.ts，无法单独重跑\n' "$name" "$name"
        continue
      fi
      reproductions=0
      for attempt in $(seq 1 "$ISOLATED_RUNS"); do
        log="$logdir/isolated-$name-$attempt.log"
        status=0
        ( cd "$ROOT" && node --test packages/"$name"/test/*.test.ts ) >"$log" 2>&1 || status=$?
        if [ "$status" -ne 0 ]; then
          reproductions=$((reproductions + 1))
          printf '  %s: 第 %d/%d 次单独运行 FAILED（exit %d）→ %s\n' \
            "$name" "$attempt" "$ISOLATED_RUNS" "$status" "$logdir_real/isolated-$name-$attempt.log"
          isolated_cases="$(cases_in "$log" 10)"
          if [ -n "$isolated_cases" ]; then
            printf '%s\n' "$isolated_cases" | sed 's/^/    /'
          fi
        fi
      done
      if [ "$reproductions" -eq 0 ]; then
        printf '  %s: 单独 %d 次全绿 → **单独不复现**：指向并发/资源竞争（共享状态、实时钟、端口或临时目录竞争）\n' \
          "$name" "$ISOLATED_RUNS"
      else
        printf '  %s: 单独 %d/%d 次失败 → **单独复现**：不是并发相关的偶发，先按稳定失败修\n' \
          "$name" "$reproductions" "$ISOLATED_RUNS"
      fi
    done
  fi
elif [ "$failed_count" -gt 0 ]; then
  printf '\n==== 单独重跑 ====\n'
  printf '失败日志里没有可识别的失败包——没有可单独重跑的对象（先看上面的失败阶段与日志全文）。\n'
fi

# --- 结论 ----------------------------------------------------------------------
printf '\n==== 结论 ====\n'
if [ "$failed_count" -eq 0 ]; then
  printf '未复现：%d 次采样全部通过（采样次数 %d，失败 0）。\n' "$runs" "$runs"
  printf '这是"未复现"，不是"不存在 flake"——%d 次采样不足以排除低频失败；\n' "$runs"
  printf '下次失败时再跑一次本脚本，包名/用例名会留在日志里。\n'
else
  printf '%d 次采样中 %d 次失败；失败包/用例名见上，单独重跑结论见"单独重跑"段落。\n' \
    "$runs" "$failed_count"
  printf '判读顺序：先看失败包与用例名 → 再看单独重跑（单独不复现 = 并发/资源竞争；单独复现 = 稳定失败）。\n'
fi
if [ "$keep" -eq 1 ]; then
  printf '日志（--keep 显式保留，未删除任何日志）：%s\n' "$logdir_real"
else
  printf '日志（默认保留，未删除任何日志）：%s\n' "$logdir_real"
fi

if [ "$failed_count" -eq 0 ]; then
  exit 0
fi
exit 1
