// IPC channels 主入口(M1 #30 Part C TD-002 拆分后的 index)。
//
// **历史**:M1 #35 PR B 把 channels 从 ipc.ts 拆出独立文件 `src/channels.ts`(避免
// preload 拉 zod evaluation chain)。M1 #30 Part C 进一步按 domain 拆 8 个子文件,
// 把主入口从 `src/channels.ts` 移到 `src/channels/index.ts`(本文件)。
//
// **dev-time bug 修法**(发起人 dev 模式起不来的根因):
// 同时保留 `src/channels.ts` 文件 + `src/channels/` 目录会让 vite resolver 含糊,
// 触发 `Cannot find module './channels'` 在 ESM resolution 严格模式下。修法:
// 删旧 `channels.ts` 文件,channels 改为目录形式(本文件即目录入口),
// shared/package.json `exports."./channels"` 路径同步更新为 `./src/channels/index.ts`。
//
// preload `import { IpcChannels } from "@opentrad/shared/channels"` 路径不变
// (走 package exports 字段 → 解析到本文件)。

import { AuthChannels } from "./auth";
import { CCChannels } from "./cc";
import { InstallerChannels } from "./installer";
import { PtyChannels } from "./pty";
import { RiskGateChannels } from "./risk-gate";
import { SessionChannels } from "./session";
import { SettingsChannels } from "./settings";
import { SkillChannels } from "./skill";

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
