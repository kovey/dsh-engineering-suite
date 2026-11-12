#!/usr/bin/env bash
# migrate-layout.sh — 把遗留仓库 `.dsh/` 根下的**套件归属条目**搬进套件命名空间
# `.dsh/engineering-suite/`（`--rollback` 反向搬回）。
#
# 为什么需要它：`resolveLayout()`（packages/dsh-eng-core/src/paths.ts:123）在
# `<repo>/.dsh/engineering-suite/` **存在**时把 rootDir 指向它，否则回退 `<repo>/.dsh`。
# 迁移前，套件的台账与别的插件的运行时状态挤在同一个 `.dsh/` 根下，信任根指纹把它们
# 一起当成"策略"：一条飞书消息改了 `chat-history/` 就换 policyVersion，所有 mission 的
# mandate 立刻过期。迁移把"策略"与"运行时状态"分开——命名空间里只有本套件的东西。
#
# 只搬白名单（见下方 SUITE_FILES / SUITE_DIRS 的出处注释）；不认识的条目原地不动并
# 单独列出。绝不覆盖、绝不合并：目标已有同名条目就记为冲突、跳过该条、退出码非零。
# 跨设备（rename 失败）时退化为 copy+校验+删除，**源在副本校验通过前绝不被删**。
#
# usage: migrate-layout.sh --repo <path> [--repo <path>...] [--apply] [--rollback]
#   --repo <path>  要迁移的仓库根（可重复；**必填**——默认当前目录等于给"把工具自己
#                  的仓库搬了"留一个入口）
#   --apply        真正执行；缺省是 dry-run（零写盘）
#   --rollback     反向：把命名空间里的套件条目搬回 `.dsh/` 根（同样默认 dry-run）
#
# exit: 0 = 无需迁移 / 所有请求的条目都搬成功（dry-run 时表示没有待办）
#       1 = 有冲突或移动失败（逐条列出），或 dry-run 还有待办
#       2 = 用法错误
set -euo pipefail

APPLY=0
ROLLBACK=0
REPOS=()

usage() { sed -n '2,/^set -euo pipefail$/p' "$0" | sed '$d'; }
usage_error() {
  printf 'migrate-layout: %s\n' "$*" >&2
  printf '用法: bash scripts/migrate-layout.sh --repo <path> [--repo <path>...] [--apply] [--rollback]\n' >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      shift
      [ "$#" -gt 0 ] && [ -n "$1" ] || usage_error "--repo 需要一个目录"
      REPOS+=("$1")
      shift
      ;;
    --apply) APPLY=1; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage_error "未知参数 $1" ;;
  esac
done
[ "${#REPOS[@]}" -gt 0 ] || usage_error "至少需要一个 --repo <path>（不默认当前目录）"

# ---------------------------------------------------------------------------
# 白名单：本套件在 `.dsh/` 根下写的东西。每一条都能在代码里指到出处（2026-11-12 核对），
# 不是凭印象列的：
#
#   *-gate.json / standards*.json / secret-allow.json / budgets.json /
#   flaky-quarantine.json / plan.jsonl / releases.jsonl / deployments.jsonl
#       各插件的布局根默认值（relativeRootFile(cwd, '<name>') 或等价写法）。逐项出处：
#         plan.jsonl              dsh-spec-gate/src/plan-ledger.ts:101
#         releases.jsonl          dsh-evidence-gate/src/config.ts:198
#         deployments.jsonl       dsh-deploy-gate/src/config.ts:616
#         budgets.json            dsh-quality-gate/src/budget.ts:781
#         flaky-quarantine.json   dsh-impact-gate/src/flaky.ts:961
#         secret-allow.json       dsh-supply-chain-gate/src/config.ts:291
#         standards.json          dsh-standards-gate/src/config.ts:137
#         standards-baseline.json dsh-standards-gate/src/config.ts:142
#       其余 *-gate.json 是同一模式的项目级配置（每个插件一份，读取规则见
#       dsh-eng-core/src/project-config.ts）。
#
#   目录（来源：dsh-eng-core/src/writers.ts 的 WRITERS / KNOWN_STATE_DIRS，以及各插件
#   的布局根默认值）：
#         specs/       规格 markdown              paths.ts:110 / MissionStore.writeSpec
#         missions/    mission 台账                paths.ts:111
#         audit/       工具调用审计                dsh-audit-trail/src/config.ts:104
#         state/       会话 ↔ mission 绑定         paths.ts:112
#         roles/       仓库自带角色文件            dsh-role-guard/src/loader.ts
#         adr/         架构决策记录                dsh-spec-gate/src/adr.ts:111
#         gates/       遗留布局里的根级门禁目录（现役代码写在 missions/<id>/gates/；
#                      列它是为了不把遗留数据留在原地）
#         kb/          知识库索引                  dsh-knowledge-base/src/config.ts:275
#         releases/    发布说明渲染产物            dsh-evidence-gate/src/config.ts:203
#         interaction/ 提问/注意力/outbox          dsh-interaction-gate/src/config.ts:718
#
# 这份表就是"套件归属"的唯一定义。**不在表里的一律不动**，包括别的插件的数据：
#   memory/           dsh-memory 插件的运行时数据
#   chat-interaction/ dsh-chat-interaction 插件的运行时数据
#   probe-*           探针文件（属于运行中的会话，不属于台账）
#   feishu-*.json / chat-history/ / lease 文件 ……
# writers.ts 的 KNOWN_STATE_DIRS 还列了 deploy/ media/ archive/ bootstrap/，orchestrator 还写
# retrospectives.jsonl（retrospective.ts:245）：它们是本套件的其它产物，但**不在本次已审批的
# 白名单里**（规格 AC-001 逐项枚举），所以原地不动、会出现在"保持不动"清单里。要搬它们需要
# 改规格，不是改这里。
# ---------------------------------------------------------------------------
SUITE_FILES=(
  spec-gate.json quality-gate.json test-design-gate.json evidence-gate.json
  coverage-gate.json impact-gate.json supply-chain-gate.json deploy-gate.json
  interaction-gate.json standards.json standards-baseline.json secret-allow.json
  budgets.json flaky-quarantine.json
  plan.jsonl releases.jsonl deployments.jsonl
)
SUITE_DIRS=(specs missions audit state roles adr gates kb releases interaction)

MOVED=0
CONFLICTS=0
FAILURES=0
PENDING=0
REPOS_PROCESSED=0

in_list() { # in_list <needle> <candidates…>
  local needle="$1"
  shift
  local candidate
  for candidate in ${@+"$@"}; do
    [ "$candidate" = "$needle" ] && return 0
  done
  return 1
}

is_suite_entry() {
  in_list "$1" "${SUITE_FILES[@]}" || in_list "$1" "${SUITE_DIRS[@]}"
}

# entry_signature <path> → "<条目数> <普通文件总字节> <符号链接数>"
# 副本校验用：逻辑字节数由文件内容决定，与目标文件系统的块大小无关（du 会因块大小
# 不同而误报），条目数与链接数补上"少拷/多拷文件"和"链接被解引用"两类错误。
entry_signature() {
  local path="$1"
  local entries links bytes
  entries="$(find "$path" -print 2>/dev/null | wc -l | tr -d ' ')"
  links="$(find "$path" -type l 2>/dev/null | wc -l | tr -d ' ')"
  if [ -f "$path" ] && [ ! -d "$path" ]; then
    bytes="$(wc -c < "$path" | tr -d ' ')"
  else
    bytes="$(find "$path" -type f -exec wc -c {} + 2>/dev/null | awk 'END { print ($1 == "" ? 0 : $1 + 0) }')"
  fi
  printf '%s %s %s\n' "$entries" "${bytes:-0}" "$links"
}

# move_entry <src-dir> <dst-dir> <name> — 搬一项，成功 0、失败 1（失败时源必须还在）。
#
# 先试 rename：同文件系统时原子且 O(1)。rename 失败（跨设备 EXDEV、或文件系统不支持）
# 才退化为 copy+校验+删除——`mv` 自带的跨设备拷贝不做校验，这里不依赖它。
move_entry() {
  local src="$1" dst="$2" name="$3"
  local before after

  if mv "$src/$name" "$dst/$name" 2>/dev/null; then
    return 0
  fi

  # rename 报错后源可能已经被删掉（极少数文件系统在 unlink 阶段失败）。不猜、
  # 不删任何东西：报告失败让人核对两个位置。
  if [ ! -e "$src/$name" ] && [ ! -L "$src/$name" ]; then
    printf '  失败: %s 的 rename 返回非零，但源已不存在——请人工核对 %s\n' "$name" "$dst/$name" >&2
    return 1
  fi

  # mv 可能在目标留下半成品（"未成功迁移的数据"，不是源数据）：删掉半成品重做完整副本。
  if [ -e "$dst/$name" ] || [ -L "$dst/$name" ]; then
    rm -rf "$dst/$name" || return 1
  fi
  if ! cp -a "$src/$name" "$dst/$name"; then
    rm -rf "$dst/$name" 2>/dev/null || true
    return 1
  fi

  before="$(entry_signature "$src/$name")"
  after="$(entry_signature "$dst/$name")"
  if [ "$before" != "$after" ]; then
    printf '  失败: %s 的副本校验不一致（源 [%s] / 目标 [%s]），源已保留\n' "$name" "$before" "$after" >&2
    rm -rf "$dst/$name" || true
    return 1
  fi

  # 只有校验通过之后才删源。删除失败也算失败（两个位置都在，数据没丢，但迁移未完成）。
  if ! rm -rf "$src/$name"; then
    printf '  失败: %s 已完整复制到 %s，但删除源失败——请人工删除源\n' "$name" "$dst/$name" >&2
    return 1
  fi
  return 0
}

# process_repo <repo>
#   0 = 干净（无需迁移，或 apply 全部成功）
#   1 = 有冲突/失败（硬问题，任何模式都退出码非零）
#   2 = dry-run 还有待办（不是失败，但退出码同样非零，沿用 migrate-to-engineering-suite 的约定）
process_repo() {
  REPOS_PROCESSED=$((REPOS_PROCESSED + 1))
  printf '\n=== %s\n' "$1"

  local repo legacy ns src dst
  repo="$(cd "$1" && pwd -P)"
  legacy="$repo/.dsh"
  ns="$repo/.dsh/engineering-suite"

  if [ ! -e "$legacy" ]; then
    printf '无可迁移：%s 没有 .dsh（这个仓库还没有本套件的台账）\n' "$repo"
    return 0
  fi
  if [ ! -d "$legacy" ]; then
    printf '错误：%s 存在但不是目录——拒绝在它上面做任何事\n' "$legacy" >&2
    FAILURES=$((FAILURES + 1))
    return 1
  fi

  if [ "$ROLLBACK" = "1" ]; then
    printf '方向: 回滚（命名空间 → .dsh/ 根）\n'
    src="$ns"
    dst="$legacy"
    if [ ! -d "$ns" ]; then
      printf '无可回滚：%s 不存在（这个仓库没迁移过）\n' "${ns#"$repo"/}"
      return 0
    fi
  else
    printf '方向: 迁移（.dsh/ 根 → 命名空间）\n'
    src="$legacy"
    dst="$ns"
  fi
  printf '目标路径: %s\n' "${dst#"$repo"/}"

  # 类别：将迁移 / 保持不动 / 冲突。`engineering-suite` 本身在迁移方向上是目标目录，
  # 不是"待搬的套件条目"，也不是"别人的东西"。
  local -a movable=() kept=() conflicts=()
  local path name entry
  # Listing first, then classifying: a find that fails (unreadable directory) must NOT
  # look like "nothing to migrate" — that would be a false green in the one script
  # whose whole job is not losing data.
  local listing
  if ! listing="$(find "$src" -mindepth 1 -maxdepth 1 -print 2>/dev/null)"; then
    printf '错误：无法读取 %s——不做任何移动\n' "${src#"$repo"/}" >&2
    FAILURES=$((FAILURES + 1))
    return 1
  fi
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    name="$(basename "$path")"
    if [ "$ROLLBACK" != "1" ] && [ "$name" = "engineering-suite" ]; then
      continue
    fi
    if is_suite_entry "$name"; then
      if [ -e "$dst/$name" ] || [ -L "$dst/$name" ]; then
        conflicts+=("$name")
      else
        movable+=("$name")
      fi
    else
      kept+=("$name")
    fi
  done <<EOF
$listing
EOF

  printf '将迁移 %d 项\n' "${#movable[@]}"
  for entry in ${movable[@]+"${movable[@]}"}; do printf '    - %s\n' "$entry"; done
  printf '保持不动 %d 项\n' "${#kept[@]}"
  for entry in ${kept[@]+"${kept[@]}"}; do printf '    - %s（不属于套件：原地保留）\n' "$entry"; done
  printf '冲突 %d 项\n' "${#conflicts[@]}"
  for entry in ${conflicts[@]+"${conflicts[@]}"}; do
    printf '    - %s（%s 已存在：拒绝覆盖/合并）\n' "$entry" "${dst#"$repo"/}/$entry"
  done

  CONFLICTS=$((CONFLICTS + ${#conflicts[@]}))
  if [ "${#movable[@]}" -eq 0 ] && [ "${#conflicts[@]}" -eq 0 ]; then
    if [ "$ROLLBACK" = "1" ]; then
      printf '没有待回滚的套件条目。\n'
    else
      printf '已迁移（没有遗留的套件条目）。\n'
    fi
    return 0
  fi

  if [ "$APPLY" != "1" ]; then
    PENDING=$((PENDING + ${#movable[@]}))
    printf '\n这是 dry-run，什么都没有移动。加 --apply 执行。\n'
    if [ "${#conflicts[@]}" -gt 0 ]; then return 1; fi
    return 2
  fi

  # 目标存在但不是目录（例如一个同名文件）：一条都搬不了，整仓报告失败。
  if [ -e "$dst" ] && [ ! -d "$dst" ]; then
    printf '错误：目标 %s 存在但不是目录——不执行任何移动\n' "${dst#"$repo"/}" >&2
    FAILURES=$((FAILURES + 1))
    return 1
  fi
  mkdir -p "$dst"

  local moved_here=0 failed_here=0
  for entry in ${movable[@]+"${movable[@]}"}; do
    if move_entry "$src" "$dst" "$entry"; then
      moved_here=$((moved_here + 1))
      MOVED=$((MOVED + 1))
    else
      failed_here=$((failed_here + 1))
      FAILURES=$((FAILURES + 1))
    fi
  done

  printf '\n已迁移 %d 项到 %s\n' "$moved_here" "${dst#"$repo"/}"
  if [ "$failed_here" -gt 0 ]; then
    printf '失败 %d 项（见上面的逐条原因；源数据未被删除）\n' "$failed_here"
  fi

  # 迁移方向：若命名空间最终为空（一项都没搬成、之前也不存在），移除它——一个空目录
  # 会让 resolveLayout 认为"已迁移"，而数据其实还在 .dsh/ 根下，读方会什么也找不到。
  if [ "$ROLLBACK" != "1" ] && [ -d "$dst" ] && [ -z "$(find "$dst" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    if rmdir "$dst" 2>/dev/null; then
      printf '注意：没有搬成任何条目，已移除空命名空间 %s（resolveLayout 仍指向 .dsh/）\n' "${dst#"$repo"/}"
    fi
  fi

  # 回滚后若命名空间已空，移除它——否则 resolveLayout 仍会优先选中这个空目录，
  # "回滚"就只搬了文件、没恢复行为。rmdir 只在空目录上成功，绝不递归删除。
  if [ "$ROLLBACK" = "1" ] && [ -d "$ns" ]; then
    if rmdir "$ns" 2>/dev/null; then
      printf '命名空间已空，已移除 %s（resolveLayout 回到 .dsh/）\n' "${ns#"$repo"/}"
    else
      printf '注意：%s 仍存在且非空（里面有非套件条目或冲突条目），resolveLayout 仍指向它\n' "${ns#"$repo"/}"
    fi
  fi

  if [ "$failed_here" -gt 0 ] || [ "${#conflicts[@]}" -gt 0 ]; then
    return 1
  fi
  return 0
}

PENDING_REPOS=0
for repo in ${REPOS[@]+"${REPOS[@]}"}; do
  if [ ! -d "$repo" ]; then
    usage_error "找不到仓库目录: $repo"
  fi
  repo_rc=0
  process_repo "$repo" || repo_rc=$?
  if [ "$repo_rc" = "2" ]; then
    PENDING_REPOS=$((PENDING_REPOS + 1))
  fi
done

printf '\n--- 汇总（%d 个仓库）---\n' "$REPOS_PROCESSED"
if [ "$APPLY" = "1" ]; then
  printf '已迁移 %d 项、冲突 %d 项、失败 %d 项\n' "$MOVED" "$CONFLICTS" "$FAILURES"
  if [ "$CONFLICTS" -gt 0 ] || [ "$FAILURES" -gt 0 ]; then
    printf '结论：仍有冲突或失败条目（见上），退出码 1。冲突必须由人决定保留哪一份，脚本不替你选。\n' >&2
    exit 1
  fi
  printf '结论：全部完成。\n'
  exit 0
fi

printf 'dry-run：将迁移 %d 项、冲突 %d 项、失败 %d 项（零写盘）\n' "$PENDING" "$CONFLICTS" "$FAILURES"
if [ "$CONFLICTS" -gt 0 ] || [ "$FAILURES" -gt 0 ]; then
  printf '结论：有冲突或失败，先处理它们（见上），退出码 1。\n' >&2
  exit 1
fi
if [ "$PENDING" -gt 0 ]; then
  printf '结论：%d 个仓库还有 %d 项待迁移，加 --apply 执行。\n' "$PENDING_REPOS" "$PENDING"
  exit 1
fi
printf '结论：没有待迁移的条目。\n'
exit 0
