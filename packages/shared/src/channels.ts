// IPC channel 名常量。**纯 const,本文件不 import zod**。
//
// 设计动机(PR B / W1 抽查 bug 2 修复):
// preload 脚本在 Electron sandbox 模式下不能 runtime require external module。
// 历史上 preload 从 @opentrad/shared 根 export 拿 IpcChannels,会触发 ipc.ts
// 顶部的 `import { z } from "zod"` evaluation chain → vite 在 preload bundle 里
// 留 require("zod") → sandbox 加载 preload 时 module not found 白屏。
//
// 修复(对齐 03-architecture.md §三 "contextBridge + typed IPC,不用 remote"
// 的 thin-preload 精神 + TD-002 #30 收益预提):
// - 所有纯 const channel 名拆到本文件
// - shared/package.json 通过 exports 字段暴露 `@opentrad/shared/channels` 子路径
// - preload 走子路径 import,**完全不进入 zod 依赖链**
// - shared/index.ts 仍 re-export 这里的 const,main 进程 / 其他 packages 继续从根
//   拿到,零迁移成本
//
// **M1 #30 Part C TD-002 完整化**:channels 内部按 domain 拆分到 `./channels/`
// 子目录,本文件聚合 re-export 维持 IpcChannels 向后兼容(preload import 路径
// `@opentrad/shared/channels` 不变)。新加 channel 时按 domain 添加到对应子文件,
// 不再单文件膨胀。
//
// 长期边界原则:**preload 永远只 import 本文件**(或 type-only import,编译时擦除)。
// preload 不做 zod 校验;所有 zod 校验在 main 进程的 IPC handlers 里做。

import { AuthChannels } from "./channels/auth";
import { CCChannels } from "./channels/cc";
import { InstallerChannels } from "./channels/installer";
import { PtyChannels } from "./channels/pty";
import { RiskGateChannels } from "./channels/risk-gate";
import { SessionChannels } from "./channels/session";
import { SettingsChannels } from "./channels/settings";
import { SkillChannels } from "./channels/skill";

// 向后兼容聚合常量:消费方 `import { IpcChannels } from "@opentrad/shared/channels"` 不变。
// 新写代码可按需 import 单个 domain const(`import { CCChannels } from ...`);存量
// 代码沿用 IpcChannels 不必迁移。
export const IpcChannels = {
  ...CCChannels,
  ...SkillChannels,
  ...SessionChannels,
  ...RiskGateChannels,
  ...SettingsChannels,
  ...InstallerChannels,
  ...PtyChannels,
  ...AuthChannels,
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];

// 各 domain const 也直接 re-export(按 domain 选择性 import 的入口)
export {
  AuthChannels,
  CCChannels,
  InstallerChannels,
  PtyChannels,
  RiskGateChannels,
  SessionChannels,
  SettingsChannels,
  SkillChannels,
};
