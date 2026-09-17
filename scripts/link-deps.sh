#!/usr/bin/env bash
# link-deps.sh — make this monorepo self-sufficient on a machine where the npm
# registry is unusable but the harness is already installed.
#
# It materialises `node_modules/` at the workspace root from two sources:
#   1. the harness packages under $DSH_HOME/profiles/node_modules/@deepseek-ai
#      (the exact build the local dsh runs, so plugins compile against reality);
#   2. this workspace's own packages (dsh-eng-core …), so `import 'dsh-eng-core'`
#      resolves from any package without a full install.
#
# With a working registry `pnpm install` produces the same layout from the
# manifests and this script is unnecessary.
#
# usage: link-deps.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
HARNESS="$DSH_HOME_DIR/profiles/node_modules"
NODE24="${NODE24:-$DSH_HOME_DIR/profiles/node_modules}"

HARNESS_PACKAGES=(
  cordis schemastery
  dsh-tools dsh-llm dsh-agent dsh-session dsh-scope dsh-util-values dsh-brand
  dsh-system-prompt dsh-user-approval dsh-subagent dsh-commands dsh-subprocess
  dsh-jobs dsh-code-runtime dsh-session-projection dsh-invariants
)

mkdir -p "$ROOT/node_modules/@deepseek-ai" "$ROOT/node_modules/@types"

for name in "${HARNESS_PACKAGES[@]}"; do
  source="$HARNESS/@deepseek-ai/$name"
  if [ -e "$source" ]; then
    ln -sfn "$source" "$ROOT/node_modules/@deepseek-ai/$name"
  else
    echo "warn: harness package @deepseek-ai/$name not found (skipped)" >&2
  fi
done

for scope in @types; do
  for name in node; do
    source="$HARNESS/$scope/$name"
    [ -e "$source" ] || source="$(ls -d "$HOME"/.nvm/versions/node/*/lib/node_modules/*/node_modules/@types/$name 2>/dev/null | head -1 || true)"
    if [ -n "${source:-}" ] && [ -e "$source" ]; then
      ln -sfn "$source" "$ROOT/node_modules/$scope/$name"
    fi
  done
done

# TypeScript, taken from any sibling checkout that has it installed.
if [ ! -e "$ROOT/node_modules/typescript" ]; then
  for candidate in \
    "$HOME/workspace/deepseek/dsh-memory/node_modules/typescript" \
    "$HOME/workspace/deepseek/neovim-tui/node_modules/typescript"; do
    if [ -d "$candidate" ]; then
      ln -sfn "$candidate" "$ROOT/node_modules/typescript"
      break
    fi
  done
fi

# Workspace packages publish themselves under their package name.
for dir in "$ROOT"/packages/*/; do
  [ -f "$dir/package.json" ] || continue
  name="$(node -e "process.stdout.write(require('$dir/package.json').name)")"
  ln -sfn "$dir" "$ROOT/node_modules/$name"
  echo "linked workspace package $name"
done

echo "node_modules ready at $ROOT/node_modules"
