# OpenTrad 技术债务清单

记录已知但**暂时按下不表**的技术权衡。每条必须标注"触发时机"——到了这个时机就必须决策不能再拖。

格式：
- **条目 ID**：`TD-NNN`
- **标题**：一句话摘要
- **来源**：谁/哪次讨论提出
- **触发时机**：什么里程碑/事件发生时必须解决
- **详情**：背景、选项、倾向
- **状态**：`open` / `deciding` / `resolved`

---

## TD-001 Playwright Chromium：打包 vs 首次下载

**来源**：Claude Code 在 kickoff 问答时提出（2026-04-24），发起人标记归档

**触发时机**：**M1 开工前必须决策**（M0 不触）

**状态**：`open`

**详情**：

`03-architecture.md` ADR-007 的立场是"打包时 bundle Chromium，用户零等待"，但跟性能目标"macOS `.dmg` ≤ 300MB（含 Chromium）"冲突：

- Electron 34 自身打包体积 ~180-220MB
- Playwright Chromium 本体 ~150MB
- 再加 MCP server 依赖、better-sqlite3 原生模块等

合计实测很可能突破 300MB 目标。

**选项**：

1. **A. 照 ADR-007 打包**：用户零等待，但 `.dmg` 可能到 350-400MB。调整性能目标上限到 450MB。
2. **B. 首次运行下载**：应用体积 180-220MB，首启时后台下载 Chromium 并展示进度。离线场景（外贸商家出差）体验差。
3. **C. 折中**：默认不打包，但打包一个"离线安装包"变体供下载站提供。

**倾向**：M1 开始做 browser_open 工具时再实测体积，按真实数据选方案 A 或 B。方案 C 运维成本高不推荐。

**不要在 M0 阶段解决**：M0 连 Playwright 都不引入，过早决策没依据。

## TD-002 preload bundle 含 zod（138KB）

**来源**：Issue #7 IPC 实现时观察（2026-04-24）

**触发时机**：**M1 性能打磨时决策**（可延后）

**状态**：`open`

**详情**：

preload 脚本 `import { IpcChannels } from '@opentrad/shared'` 会把整个 `@opentrad/shared` 模块图 bundle 进来——包括所有 zod schema（`WireCCEventSchema` / `CCEventSchema` 等），导致 preload 产出 138KB（其中 100KB+ 是 zod）。

问题：preload 每次 BrowserWindow 启动都加载，体积直接影响窗口首次渲染速度。M0 性能目标里"UI 响应（点击 → 反馈）≤ 100ms"对此敏感。

**选项**：

1. **A. `src/common/ipc-channels.ts` 本地定义 IpcChannels**（架构文档 §2 就是这么设计的），preload 不 import `@opentrad/shared`。优点：preload bundle 降到 <10KB；缺点：IpcChannels 常量要在两处维护（shared 和 common，但 shared 是源头 common 抄）。
2. **B. 改 `@opentrad/shared` 拆两个 entry**：`@opentrad/shared/ipc` 只导出 IPC 常量（纯数据），`@opentrad/shared` 原路径含 zod schema。
3. **C. 配 vite `build.rollupOptions.output.manualChunks` 手工分离 zod**：让 preload 只打包用到的代码。vite 7+ 的 tree-shake 对 re-export chain 处理不完美，可能需要 explicit 配置。

**倾向**：**A**，和架构文档 §2 目录结构一致（`src/common/ipc-channels.ts` 本就规划存在）。M1 实现。

**不要在 M0 阶段解决**：功能正确优先；preload 138KB 对 dev/build 流程无影响，只是 window 启动多耗 ~10ms。
