// IPC channel 名常量。**纯 const，本文件不 import zod**。
//
// 设计动机（PR B / W1 抽查 bug 2 修复）：
// preload 脚本在 Electron sandbox 模式下不能 runtime require external module。
// 历史上 preload 从 @opentrad/shared 根 export 拿 IpcChannels，会触发 ipc.ts
// 顶部的 `import { z } from "zod"` evaluation chain → vite 在 preload bundle 里
// 留 require("zod") → sandbox 加载 preload 时 module not found 白屏。
//
// 修复（对齐 03-architecture.md §三 "contextBridge + typed IPC，不用 remote"
// 的 thin-preload 精神 + TD-002 #30 收益预提）：
// - 所有纯 const channel 名拆到本文件
// - shared/package.json 通过 exports 字段暴露 `@opentrad/shared/channels` 子路径
// - preload 走子路径 import，**完全不进入 zod 依赖链**
// - shared/index.ts 仍 re-export 这里的 const，main 进程 / 其他 packages 继续从根
//   拿到，零迁移成本
//
// 长期边界原则：**preload 永远只 import 本文件**（或 type-only import，编译时擦除）。
// preload 不做 zod 校验；所有 zod 校验在 main 进程的 IPC handlers 里做。

// -------- Renderer ↔ Main 主 IPC 通道 --------

export const IpcChannels = {
  CCStartTask: "cc:start-task",
  CCCancelTask: "cc:cancel-task",
  CCEvent: "cc:event",
  CCStatus: "cc:status",
  SkillList: "skill:list",
  SkillInstall: "skill:install",
  SessionList: "session:list",
  SessionGet: "session:get",
  SessionDelete: "session:delete",
  SessionResume: "session:resume",
  InstalledSkillList: "installed-skill:list",
  RiskGateConfirm: "risk-gate:confirm",
  RiskGateResponse: "risk-gate:response",
  SettingsGet: "settings:get",
  SettingsSet: "settings:set",
  PtySpawn: "pty:spawn",
  PtyWrite: "pty:write",
  PtyResize: "pty:resize",
  PtyKill: "pty:kill",
  PtyData: "pty:data",
  PtyExit: "pty:exit",
  InstallerRunCcInstall: "installer:run-cc-install",
  InstallerSupportsAutoInstall: "installer:supports-auto-install",
  CCDetectLoopStart: "cc:detect-loop-start",
  CCDetectLoopStop: "cc:detect-loop-stop",
  AuthStartLoginFlow: "auth:start-login-flow",
  ShellOpenExternal: "shell:open-external",
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];
