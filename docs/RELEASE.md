# 发布与安装

本仓库的发布物**只有源码与 tag**：`dist/` 不入库（见 `.gitignore`），构建产物在**安装时**由
`prepare` 钩子生成。这样做的原因很直接——把 `dist` 提交进仓库，等于每次改代码都附带一堆
机器生成的文件 diff；而不生成 `dist`，从 `github:` 安装来的包又根本跑不起来。`prepare` 是
这两者之间的桥。

## 一、安装方（消费端）看到什么

```
profile/
└── node_modules/
    ├── dsh-engineering-suite/        ← github:kovey/dsh-engineering-suite#v0.8.9
    │   ├── packages/*/dist/          ← 安装时由 prepare 生成
    │   └── scripts/prepare-install.mjs
    ├── typescript/                   ← 本包的 devDependency，pnpm 为 git 依赖安装
    └── dsh-spec-gate -> dsh-engineering-suite/packages/dsh-spec-gate
```

`prepare` 依次做三件事：

1. **包间链接**：给每个包建 `packages/<x>/node_modules/dsh-<y>`（源码里有 148 处
   `from 'dsh-eng-core'`，干净检出没有这些链接就编不过）；
2. **构建**：按 `scripts/package-order.py` 的依赖顺序，用安装到的 `typescript` 编译 16 个包的
   `dist/`；

   > 编译器与类型声明都是 **devDependency**（`typescript` + `@types/node`）：`tsconfig.base.json`
   > 声明了 `types: ["node"]`，pnpm 安装 git 依赖时只装 devDependencies、不装仓库根
   > `node_modules` 里的其它东西。缺 `typescript` 会立刻报"找不到编译器"，缺 `@types/node`
   > 会以 `TS2688: Cannot find type definition file for 'node'` 让 16 个包全部编译失败——
   > 两者都属于安装失败，不是警告。
3. **bundle 链接**：当本包位于某个 profile 的 `node_modules` 下时，为 16 个包名在**同级**
   `node_modules` 里建软链——dsh 的 bundle 是按裸名解析的。

失败语义是硬的：找不到 `typescript` 或任一包编译失败 → **非零退出**，并删掉本次新建的
`dist/`，避免留下"看起来构建过"的半成品。

## 二、pnpm 10 的构建脚本限制

pnpm 10 默认**不执行依赖的构建脚本**，`prepare` 会被跳过（表现为：装完没有 `dist`）。
安装前在 profile 的 `package.json` 里声明：

```json
{
  "pnpm": {
    "onlyBuiltDependencies": ["dsh-engineering-suite"]
  }
}
```

或单次安装时 `pnpm add github:kovey/dsh-engineering-suite#v0.8.9 --allow-build=dsh-engineering-suite`。

## 三、发布流程（本仓库）

```bash
bash scripts/verify.sh --quiet          # 全量验收
bash scripts/standards-check.sh --quiet # 结构规范
# 升版本：17 个 manifest + README 抬头 + CHANGELOG（未发布 → 版本号）
git commit -am "chore(release): vX.Y.Z"
git tag -a vX.Y.Z -m "dsh-engineering-suite vX.Y.Z"
git push origin main && git push origin vX.Y.Z
```

**不要**提交 `dist/`。tag 上的源码 + `prepare` 就是发布物。

## 四、本机开发（不经过安装）

- 仓库内直接 `node scripts/prepare-install.mjs`（或 `bash scripts/build-all.sh`）只做第 1、2 步，
  **不碰任何 profile**；
- 需要把工作树挂进 profile 做真机验证时用 `scripts/install-into-dsh.sh`（它默认**拒绝**操作
  `tui`：生产面只消费发布版；本地测试用 `nvim-tui`）；
- 已安装的 profile 想换到某个 tag：`scripts/install-into-dsh.sh --allow-tui` 之后重装依赖，或直接
  `pnpm add github:kovey/dsh-engineering-suite#<tag>`。

## 五、安装方最稳的姿势：由 profile 的 postinstall 触发构建

依赖自身的 `prepare` 在 pnpm 里有两道坎：**pnpm 10 直接拒绝执行**
（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`），**pnpm ≥11 需要 `allowBuilds` 放行**，而且 git 依赖
不能用裸包名——必须写仓库 URL：

```yaml
allowBuilds:
  'dsh-engineering-suite@git+https://github.com/kovey/dsh-engineering-suite.git': true
```

即便放行，pnpm 的副作用缓存也可能让后续安装**跳过** `prepare`，装完仍然没有 `dist`。
所以安装方最稳的做法是**由 profile 自己触发构建**（根项目的生命周期脚本永远执行、不需要放行、
不会被依赖缓存吃掉），并把编译器与类型声明放在 profile 的 devDependencies 里：

```json
// ~/.dsh/profiles/<name>/package.json
{
  "devDependencies": { "typescript": "^5.9.3", "@types/node": "^26.6.6" },
  "scripts": { "postinstall": "node node_modules/dsh-engineering-suite/scripts/prepare-install.mjs" }
}
```

实测（pnpm 12.18.0 + `nodeLinker: hoisted` + 上面这份 profile 配置，从 GitHub 装 `#main`）：
**16 个 `dist/index.js` 全部生成**、`require.resolve('dsh-spec-gate')` 指向
`node_modules/dsh-engineering-suite/packages/dsh-spec-gate/dist/index.js`、
`node_modules` 下出现 **16 条 bundle 软链**（含套件包本身共 17 个 `dsh-*` 条目）。

## 六、装完之后：确认 `dist` 真的存在

**症状**（2026-11-17 的真实故障）：`dsh plugin --profile tui update` 升到 0.8.13 后，包在、bundle 软链在，
`packages/*/dist` 却是 **0 个**，启动报"找不到 10 多个内部插件"——而安装本身的**退出码是 0**。
手动执行一次 `node node_modules/dsh-engineering-suite/scripts/prepare-install.mjs` 后，16 个 `dist` 立刻生成。

**为什么不能靠"安装成功"，也不能靠 `strictDepBuilds: false`**：当时 profile 的 `pnpm-workspace.yaml`
里有这样两行——

```yaml
allowBuilds:
  'dsh-engineering-suite@git+https://github.com/kovey/dsh-engineering-suite.git': true
  protobufjs: set this to true or false   # pnpm 自动插入、没人填写的占位值
strictDepBuilds: false                    # 把"构建被拦"降级成一条警告
```

`allowBuilds` 里的占位值**不是批准**（pnpm 无法判断这个构建脚本该不该执行）；`strictDepBuilds: false`
则让"套件的 `prepare` 被拦"只剩一条警告。两者叠加的结果是**安装成功、工件为零**，而日志里没有任何一行说失败。
`strictDepBuilds` 的默认值是 `true`：被拦的构建必须让安装**失败并点名**那个依赖，这才是能发现问题的行为。
所以不要用 `false` 换"安装能过"；同理也不要让 `allowBuilds` 留占位符。

**三条确认（缺一条就是没有装好）**：

```bash
PROFILE=~/.dsh/profiles/tui
ls "$PROFILE"/node_modules/dsh-engineering-suite/packages/*/dist/index.js | wc -l   # 期望 16
node -e "console.log(require.resolve('dsh-spec-gate', {paths:['$PROFILE']}))"     # 必须落在 $PROFILE/node_modules 下
node "$PROFILE"/node_modules/dsh-engineering-suite/scripts/prepare-install.mjs     # 期望 exit 0（幂等，可随时重跑）
```

**一条命令做完全部**（默认 dry-run，`--apply` 才写；`--check` 只读）：

```bash
node scripts/fix-profile-install.mjs --profile ~/.dsh/profiles/tui            # 先看修复计划与当前状态
node scripts/fix-profile-install.mjs --profile ~/.dsh/profiles/tui --apply    # 改配置 → pnpm install → prepare → 三条验收
node scripts/fix-profile-install.mjs --profile ~/.dsh/profiles/tui --check    # 只读验收
```

它做的事与失败语义：

- 修正 `pnpm-workspace.yaml`：`allowBuilds` 里任何非布尔值改成显式布尔（套件的仓库 URL 条目保持 `true`，
  其它未知依赖一律 `false`，并在输出里点名"这些依赖不会被构建"）、删除 `strictDepBuilds` 行
  （恢复默认 `true`）、保留（缺了就补上）套件的仓库 URL 条目。写入前备份
  `pnpm-workspace.yaml.bak-<时间戳>`；已是目标状态时不写文件，修复结果会被再规划一次以证明幂等。
- `pnpm install` 之后**显式**执行一次 `prepare-install.mjs`：不依赖 pnpm 是否执行了依赖的 `prepare`，
  也不依赖根 `postinstall` 是否被缓存跳过。
- 三条验收（版本 / `packages/*/dist/index.js` 数量 = 包数 / `dsh-spec-gate` 解析在 profile 内）任一不过
  → **非零退出**，并打印备份路径与回滚命令：
  `cp <备份> <profile>/pnpm-workspace.yaml && cd <profile> && pnpm install`。
  没有 `dist` 的安装不会被当成成功——这是本脚本存在的理由。

