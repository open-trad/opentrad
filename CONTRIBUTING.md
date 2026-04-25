# 贡献指南

感谢你对 OpenTrad 感兴趣。这份文档说明如何给项目贡献。

## v1 阶段的治理模式

OpenTrad v1 处于 BDFL（Benevolent Dictator For Life）阶段，项目发起人（yrjm）作为唯一 maintainer，核心架构决策由其单人决定。这不是因为社区不重要，而是早期项目需要集中决策保证方向一致。

v2 之后，如果社区规模起来，会过渡到技术委员会 + RFC 流程。

## 可以怎样贡献

### 报告 bug

在 [Issues](https://github.com/open-trad/opentrad/issues) 提交 bug 报告，附上：
- 操作系统和版本
- OpenTrad 版本（在"关于"里查看）
- Claude Code 版本（`claude --version`）
- 复现步骤
- 期望行为 vs 实际行为
- 截图或日志（记得脱敏）

### 提建议

在 [Discussions](https://github.com/open-trad/opentrad/discussions) 提功能建议，**不要直接提 PR 加新功能**——先讨论方向。

### 贡献代码

1. 先在 Issues 或 Discussions 讨论，确认方向被接受
2. Fork 仓库，创建 feature branch（命名：`feat/xxx` 或 `fix/xxx`）
3. 按 [开发指南](#开发指南)本地跑通
4. 提交 PR 到 `main` 分支，PR 描述说明：改了什么、为什么、怎么测试的
5. CI 通过 + maintainer review → 合并

### 贡献 skill

Skill 是独立的 markdown + yaml 包，贡献到 [open-trad/skills](https://github.com/open-trad/skills) repo，不是这个主仓库。

### 贡献文档

文档在 [open-trad/docs](https://github.com/open-trad/docs)。

## 开发指南

### 环境要求

- Node.js ≥ 20.18.0
- pnpm ≥ 10.0.0
- macOS / Linux / Windows 都支持

### 安装

```bash
pnpm install
```

`pnpm install` 自动跑两个 postinstall:
- `scripts/fix-node-pty-perms.cjs` 给 node-pty 的 spawn-helper 加 +x(prebuild 没设)
- `apps/desktop` 下 `electron-rebuild` 把 better-sqlite3 / node-pty 重新编译为 Electron 的 ABI

完成后即可 `pnpm dev`,**新机器 / 新贡献者第一次开就能跑**,无需手动 rebuild。

### 常用命令

```bash
pnpm dev          # 启动 desktop 应用(Electron)
pnpm test         # 跑全 monorepo 单测
pnpm typecheck    # 全 monorepo TypeScript 校验
pnpm lint         # biome check
pnpm format       # biome format --write
```

### Electron / Node ABI 切换

`better-sqlite3` 和 `node-pty` 是 native module,Electron 和系统 Node 的 ABI(NODE_MODULE_VERSION)不同,共存需要切换:

| 场景 | 当前 ABI | 切换命令 |
|---|---|---|
| `pnpm install` 后默认 | Electron ABI | (无需操作,可直接 `pnpm dev`) |
| 跑 `pnpm dev` / `pnpm build` | 需要 Electron ABI | `pnpm --filter @opentrad/desktop rebuild:electron` |
| 跑 `pnpm test` / vitest | 需要 Node ABI | `pnpm --filter @opentrad/desktop rebuild:node` |

**典型报错信号**:加载 `better-sqlite3` 或 `node-pty` 时报 `NODE_MODULE_VERSION X vs Y`,跑对应的 rebuild 命令切换即可。CI fresh checkout 永远是干净状态,不会撞这个坑。

## 提交规范

Conventional Commits：

- `feat: 新功能`
- `fix: 修 bug`
- `docs: 文档修改`
- `chore: 杂项（依赖升级、配置调整）`
- `refactor: 重构，不改外部行为`
- `test: 加测试`
- `perf: 性能优化`

## 行为准则

对他人友善，讨论技术不讨论立场。违反者 maintainer 有权锁讨论或拉黑。

## License

贡献到本仓库的代码默认以 [AGPL-3.0](LICENSE) 授权。
