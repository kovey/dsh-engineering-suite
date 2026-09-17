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
set -euo pipefail

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILES="headless,nvim-tui"
ONLY=""
DRY_RUN=0
ALLOW_TUI=0
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --profiles) PROFILES="${2:-}"; shift 2 ;;
    --only) ONLY="${2:-}"; shift 2 ;;
    --allow-tui) ALLOW_TUI=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY_RUN" = "1" ]; then say "  [dry-run] $*"; else "$@"; fi; }

if [ "$ALLOW_TUI" != "1" ]; then
  case ",$PROFILES," in
    *,tui,*)
      say "refusing: 'tui' is the production profile and takes released builds, not this working tree."
      say "          local testing uses nvim-tui / web / headless (pass --allow-tui to override)."
      exit 3
      ;;
  esac
fi

# --- collect packages --------------------------------------------------------
packages=()
for dir in "$ROOT"/packages/*/; do
  [ -f "$dir/package.json" ] || continue
  name="$(node -e "process.stdout.write(require('$dir/package.json').name)")"
  if [ -n "$ONLY" ]; then
    case ",$ONLY," in *,*"$name"*,) ;; *) continue ;; esac
  fi
  # dsh-eng-core is a library, not a bundle: it is linked, never added to bundles.
  packages+=("$name")
done

say "dsh home : $DSH_HOME_DIR"
say "workspace: $ROOT"
say "profiles : $PROFILES"
say "packages : ${packages[*]}"
say ""

# --- 1. module links ---------------------------------------------------------
say "[1/2] module links"
for name in "${packages[@]}"; do
  link="$DSH_HOME_DIR/profiles/node_modules/$name"
  if [ "$UNINSTALL" = "1" ]; then
    if [ -L "$link" ]; then run rm -f "$link"; say "  unlinked $name"; fi
    continue
  fi
  say "  $name -> $link"
  run mkdir -p "$DSH_HOME_DIR/profiles/node_modules"
  run ln -sfn "$ROOT/packages/$name" "$link"
done

# --- 2. bundle lists ---------------------------------------------------------
say "[2/2] bundle lists"
IFS=',' read -r -a names <<< "$PROFILES"
for profile in "${names[@]}"; do
  manifest="$DSH_HOME_DIR/profiles/$profile/package.json"
  if [ ! -f "$manifest" ]; then
    say "  $profile: skipped (no package.json)"
    continue
  fi
  for name in "${packages[@]}"; do
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
if [ "$DRY_RUN" = "1" ]; then
  say "dry run complete — nothing was changed."
else
  say "done. Restart the surfaces (nvim-tui / web / headless) to load the bundles."
  say "verify: /plugins in the TUI, or check the per-plugin log under \$DSH_HOME."
fi
