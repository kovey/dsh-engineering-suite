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
