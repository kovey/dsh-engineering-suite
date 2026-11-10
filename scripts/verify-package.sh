#!/usr/bin/env bash
# verify-package.sh — assert the PUBLISHED artifact actually carries build output.
#
# usage: verify-package.sh
#
# Why this exists: v0.8.1 was published from a root manifest with no `files`
# whitelist, so `npm pack` fell back to `.gitignore` — which lists `dist/`. The
# tarball therefore contained `packages/*/src` but no `packages/*/dist`, while every
# package's `main` is `./dist/index.js`. Installing it produced a suite that could
# not load. The check below is the assertion that would have caught that release.
#
# It reads `npm pack --dry-run --json` and requires, for every workspace package,
# at least one `packages/<name>/dist/<file>.js` entry in the manifest.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CACHE_DIR="${TMPDIR:-/tmp}/dsh-pack-verify-$$"
trap 'rm -rf "$CACHE_DIR"' EXIT

# `--cache` keeps this read-only w.r.t. the user's ~/.npm (a sandboxed or
# read-only home turns a pack failure into a confusing permissions error).
MANIFEST="$(npm pack --dry-run --json --cache "$CACHE_DIR" 2>/dev/null)"
[ -n "$MANIFEST" ] || { printf 'verify-package: npm pack 没有输出清单（打包失败）\n' >&2; exit 1; }

printf '%s' "$MANIFEST" | node -e '
let raw = ""
process.stdin.on("data", (chunk) => { raw += chunk })
process.stdin.on("end", () => {
    const fs = require("node:fs")
    const path = require("node:path")
    let parsed
    try {
        parsed = JSON.parse(raw)
    } catch (error) {
        console.error(`verify-package: 清单不是合法 JSON（${error.message}）`)
        process.exit(1)
    }
    const files = (parsed[0] && parsed[0].files ? parsed[0].files : []).map((entry) => entry.path)
    const packages = fs.readdirSync(path.join(process.cwd(), "packages"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => fs.existsSync(path.join(process.cwd(), "packages", name, "package.json")))

    const missing = []
    let present = 0
    for (const name of packages) {
        const prefix = `packages/${name}/dist/`
        const hits = files.filter((file) => file.startsWith(prefix) && file.endsWith(".js"))
        if (hits.length === 0) missing.push(name)
        else present += hits.length
    }
    const sourceFiles = files.filter((file) => /^packages\/[^/]+\/(src|test)\//.test(file))

    if (missing.length > 0) {
        console.error(`verify-package: ${missing.length} 个包在打包产物里没有 dist（main 指向 ./dist/index.js，装上去无法加载）：`)
        for (const name of missing) console.error(`  - packages/${name}`)
        console.error("下一步：确认根 package.json 的 files 白名单包含 packages（当前用目录 + 否选，npm 不支持 packages/*/dist/ 这种嵌套 glob），然后重新构建并重打包。")
        process.exit(1)
    }
    if (sourceFiles.length > 0) {
        console.error(`verify-package: 产物里混进了 ${sourceFiles.length} 个 src/test 文件（发布不该带源码与测试）`)
        process.exit(1)
    }
    console.log(`verify-package: ${packages.length} 个包全部带 dist（共 ${present} 个 .js），未夹带 src/test ✓`)
})
'
