#!/usr/bin/env bash
# install-into-dsh.sh — mount the engineering suite into local dsh profiles.
#
# For every package in this workspace it does exactly two things, idempotently:
#   1. links `packages/<name>` into $DSH_HOME/profiles/node_modules/<name>
#      (bundles and their `dsh-eng-core` dependency resolve through the
#      workspace's own node_modules, created by scripts/link-deps.sh);
#   2. appends `<name>` to `dsh.profile.bundles` of the target profiles
#      (a .bak copy is written before each edit).
#
# It never touches a profile's cordis.patch.yml: `insert` is pure-append and the
# loader rejects duplicate entry ids, so each bundle's own patch owns its row.
#
# usage: install-into-dsh.sh [--dry-run] [--profiles headless,web] [--only a,b]
#        [--allow-tui] [--uninstall]
#
# POLICY — `tui` is the human's production profile and must never receive a
# working tree; it consumes released builds. Passing tui requires --allow-tui.
#
# exit: 0 = 成功；1 = 拒绝执行（真实目录挡路等，人工处理后才可能成功）；
#       2 = 用法/参数错误；3 = 拒绝写生产 profile `tui`
#
# TWO SILENT-SUCCESS CLASSES FIXED HERE (2026-09 adversarial audit C8/C9) — both
# printed "done" while doing nothing (or the wrong thing):
#   * `ln -sfn` onto an existing REAL directory nests the link
#     (`node_modules/<pkg>/<pkg>`), so the loader keeps resolving the RELEASED
#     build while the script reports the package as linked. The pre-flight below
#     refuses and prints the exact `rm -rf` for the human — this script never
#     deletes a directory itself.
#   * `--profiles "headless, nvim-tui"` was not trimmed: both names missed and
#     were reported as "skipped (no package.json)" with exit 0 — and the same
#     padding dodged the production-`tui` guard. Names are trimmed now, a named
#     profile without a manifest is a hard error (2), never a skip, and a `tui`
#     that only differs by whitespace still hits the guard.
set -euo pipefail

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILES="headless,nvim-tui"
ONLY=""
DRY_RUN=0
ALLOW_TUI=0
UNINSTALL=0

# The value of an option: a missing value, or another flag in the value's place,
# is a usage error — never "the default" (same class as audit C4/C6).
need_value() { # need_value <flag> <value-or-empty>
  local flag="$1" value="${2:-}"
  if [ -z "$value" ] || [ "${value#-}" != "$value" ]; then
    echo "install-into-dsh: $flag 需要一个值" >&2
    exit 2
  fi
  printf '%s' "$value"
}

# Comma lists are trimmed: the padding used to be the whole bug (audit C9).
trim() { # trim <string>
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

split_names() { # split_names <comma-list> — trims, drops empty entries, prints one name per line
  local raw name
  local -a parts
  IFS=',' read -r -a parts <<< "$1"
  for raw in "${parts[@]}"; do
    name="$(trim "$raw")"
    [ -n "$name" ] || continue
    printf '%s\n' "$name"
  done
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --profiles) PROFILES="$(need_value "$1" "${2:-}")"; shift 2 ;;
    --only) ONLY="$(need_value "$1" "${2:-}")"; shift 2 ;;
    --allow-tui) ALLOW_TUI=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY_RUN" = "1" ]; then say "  [dry-run] $*"; else "$@"; fi; }

PROFILE_NAMES=()
while IFS= read -r name; do PROFILE_NAMES+=("$name"); done < <(split_names "$PROFILES")
if [ "${#PROFILE_NAMES[@]}" -eq 0 ]; then
  echo "install-into-dsh: --profiles 没有给出任何 profile 名" >&2
  exit 2
fi

ONLY_NAMES=()
if [ -n "$ONLY" ]; then
  while IFS= read -r name; do ONLY_NAMES+=("$name"); done < <(split_names "$ONLY")
  if [ "${#ONLY_NAMES[@]}" -eq 0 ]; then
    echo "install-into-dsh: --only 没有给出任何包名" >&2
    exit 2
  fi
fi

# The production-profile guard runs on the NORMALISED list, so `--profiles "headless, tui"`
# can no longer slip past it as a profile literally named " tui" (audit C9).
if [ "$ALLOW_TUI" != "1" ]; then
  for profile in "${PROFILE_NAMES[@]}"; do
    if [ "$profile" = "tui" ]; then
      say "refusing: 'tui' is the production profile and takes released builds, not this working tree."
      say "          local testing uses nvim-tui / web / headless (pass --allow-tui to override)."
      exit 3
    fi
  done
fi

# A named profile must exist: silently skipping every requested profile and
# printing "done" is how a typo / a padded name looked like a successful install
# (audit C9). Checked BEFORE anything is linked or edited.
for profile in "${PROFILE_NAMES[@]}"; do
  if [ ! -f "$DSH_HOME_DIR/profiles/$profile/package.json" ]; then
    printf 'install-into-dsh: profile %s 的 manifest 不存在：%s\n' "$profile" "$DSH_HOME_DIR/profiles/$profile/package.json" >&2
    printf '  名字拼错了？%s/profiles 下现有：%s\n' "$DSH_HOME_DIR" "$(ls "$DSH_HOME_DIR/profiles" 2>/dev/null | tr '\n' ' ')" >&2
    exit 2
  fi
done

# --- collect packages --------------------------------------------------------
packages=()
for dir in "$ROOT"/packages/*/; do
  [ -f "$dir/package.json" ] || continue
  name="$(node -e "process.stdout.write(require('$dir/package.json').name)")"
  if [ "${#ONLY_NAMES[@]}" -gt 0 ]; then
    selected=0
    for wanted in "${ONLY_NAMES[@]}"; do [ "$wanted" = "$name" ] && selected=1; done
    [ "$selected" = "1" ] || continue
  fi
  # dsh-eng-core is a library, not a bundle: it is linked, never added to bundles.
  packages+=("$name")
done

# `--only typo` used to select nothing and still exit 0 (audit C9, same class).
if [ "${#ONLY_NAMES[@]}" -gt 0 ]; then
  for wanted in "${ONLY_NAMES[@]}"; do
    found=0
    for name in ${packages[@]+"${packages[@]}"}; do [ "$name" = "$wanted" ] && found=1; done
    if [ "$found" != "1" ]; then
      printf 'install-into-dsh: --only 里的 %s 不是本仓库的包名（packages/ 下没有它）\n' "$wanted" >&2
      exit 2
    fi
  done
fi

say "dsh home : $DSH_HOME_DIR"
say "workspace: $ROOT"
say "profiles : ${PROFILE_NAMES[*]}"
say "packages : ${packages[*]:-}"
say ""

# --- 1. module links ---------------------------------------------------------
# Pre-flight, BEFORE any change: a link target that exists and is NOT a symlink
# makes `ln -sfn` nest the link inside it (audit C8). Refuse, name the exact
# command for the human, and never delete it ourselves.
CONFLICTS=()
if [ "$UNINSTALL" != "1" ]; then
  for name in ${packages[@]+"${packages[@]}"}; do
    link="$DSH_HOME_DIR/profiles/node_modules/$name"
    if [ -e "$link" ] && [ ! -L "$link" ]; then CONFLICTS+=("$link"); fi
  done
fi

say "[1/2] module links"
if [ "${#CONFLICTS[@]}" -gt 0 ]; then
  for link in "${CONFLICTS[@]}"; do
    say "  refusing: $link 是真实目录/文件，不是符号链接。"
    say "            直接 ln -sfn 会把链接塞进它内部（$link/$(basename "$link")），"
    say "            加载器仍会解析已发布的构建，而脚本会报成功。"
  done
  say ""
  say "  本脚本不删目录。确认后人工删除，再重跑："
  for link in "${CONFLICTS[@]}"; do say "    rm -rf '$link'"; done
  exit 1
fi

for name in ${packages[@]+"${packages[@]}"}; do
  link="$DSH_HOME_DIR/profiles/node_modules/$name"
  if [ "$UNINSTALL" = "1" ]; then
    if [ -L "$link" ]; then run rm -f "$link"; say "  unlinked $name"; fi
    continue
  fi
  say "  $name -> $link"
  run mkdir -p "$DSH_HOME_DIR/profiles/node_modules"
  # The pre-flight guarantees this is either absent or a symlink: replacing a
  # symlink is a rename, replacing a directory would be a nest.
  if [ -L "$link" ]; then run rm -f "$link"; fi
  run ln -sfn "$ROOT/packages/$name" "$link"
done

# --- 2. bundle lists ---------------------------------------------------------
say "[2/2] bundle lists"
FAILED=0
for profile in "${PROFILE_NAMES[@]}"; do
  manifest="$DSH_HOME_DIR/profiles/$profile/package.json"
  # Checked before the links; a manifest that vanished mid-run is an error too —
  # never the silent "skipped (no package.json)" this used to print.
  if [ ! -f "$manifest" ]; then
    say "  $profile: ERROR manifest is gone: $manifest"
    FAILED=1
    continue
  fi
  for name in ${packages[@]+"${packages[@]}"}; do
    [ "$name" = "dsh-eng-core" ] && continue
    if [ "$DRY_RUN" = "1" ]; then
      PKG="$name" python3 - "$manifest" <<'PY'
import json, os, sys
path = sys.argv[1]
pkg = os.environ["PKG"]
with open(path) as fh:
    data = json.load(fh)
bundles = data.get("dsh", {}).get("profile", {}).get("bundles", [])
print(f"  {path}: {pkg} " + ("already present" if pkg in bundles else "would be appended"))
PY
      continue
    fi
    PKG="$name" UNINSTALL="$UNINSTALL" python3 - "$manifest" <<'PY'
import json, os, shutil, sys, time
path = sys.argv[1]
pkg = os.environ["PKG"]
uninstall = os.environ.get("UNINSTALL") == "1"
with open(path) as fh:
    data = json.load(fh)
profile = data.setdefault("dsh", {}).setdefault("profile", {})
bundles = profile.setdefault("bundles", [])
changed = False
if uninstall:
    if pkg in bundles:
        bundles.remove(pkg)
        changed = True
else:
    if pkg not in bundles:
        bundles.append(pkg)
        changed = True
if not changed:
    print(f"  {path}: {pkg} already in the desired state")
    sys.exit(0)
shutil.copy2(path, f"{path}.bak.{time.strftime('%Y%m%d%H%M%S')}")
with open(path, "w") as fh:
    json.dump(data, fh, indent=2)
    fh.write("\n")
print(f"  {path}: {'removed' if uninstall else 'added'} {pkg} -> {bundles}")
PY
  done
done

say ""
if [ "$FAILED" = "1" ]; then
  say "FAILED: at least one profile could not be updated (see above)."
  exit 1
fi
if [ "$DRY_RUN" = "1" ]; then
  say "dry run complete — nothing was changed."
else
  say "done. Restart the surfaces (nvim-tui / web / headless) to load the bundles."
  say "verify: /plugins in the TUI, or check the per-plugin log under \$DSH_HOME."
fi
