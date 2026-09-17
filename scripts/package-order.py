#!/usr/bin/env python3
"""Print the workspace packages in build order (dependencies first).

Every plugin imports `dsh-eng-core`'s *built* `dist/index.d.ts`, so a plain
alphabetical walk fails on a fresh clone (`dist/` is git-ignored and
`dsh-eng-core` sorts fifth). This resolves the workspace dependency graph from
each `package.json` and emits a topological order with alphabetical tie-breaks,
so the order is deterministic.

usage: package-order.py <repo-root>
"""

from __future__ import annotations

import json
import pathlib
import sys


def load(root: pathlib.Path) -> dict[str, dict]:
    packages: dict[str, dict] = {}
    for directory in sorted((root / "packages").iterdir()):
        manifest = directory / "package.json"
        if not directory.is_dir() or not manifest.is_file():
            continue
        data = json.loads(manifest.read_text())
        name = data.get("name") or directory.name
        dependencies = set(data.get("dependencies") or {}) | set(data.get("devDependencies") or {})
        packages[name] = {"dir": directory, "deps": dependencies}
    return packages


def order(packages: dict[str, dict]) -> list[str]:
    """Kahn's algorithm; ready nodes are taken in alphabetical order."""
    names = set(packages)
    pending = {name: {dep for dep in entry["deps"] if dep in names} for name, entry in packages.items()}
    ordered: list[str] = []
    while pending:
        ready = sorted(name for name, deps in pending.items() if not deps)
        if not ready:
            # A dependency cycle: emit what is left alphabetically rather than
            # hanging the build, and say so on stderr.
            print(f"package-order: dependency cycle among {', '.join(sorted(pending))}", file=sys.stderr)
            ordered.extend(sorted(pending))
            break
        for name in ready:
            ordered.append(name)
            del pending[name]
        for deps in pending.values():
            deps.difference_update(ready)
    return ordered


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    root = pathlib.Path(sys.argv[1]).resolve()
    packages = load(root)
    if not packages:
        print(f"package-order: no packages under {root}/packages", file=sys.stderr)
        return 1
    for name in order(packages):
        print(packages[name]["dir"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
