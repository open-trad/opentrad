// Preload 脚本：contextBridge 暴露 typed IPC API 给 renderer。
// 对应 03-architecture.md §2 apps/desktop/src/main/preload.ts + §3 IPC 协议。
//
// sandbox:true 下 preload 的能力受限：
// - 可用：contextBridge、ipcRenderer（Electron 白名单）
// - 不可用：任意 require、fs、child_process 等 Node API
// 这是 03-architecture.md §9 安全边界的一部分。

import type { CCStatus } from "@opentrad/shared";
import { IpcChannels } from "@opentrad/shared";
import { contextBridge, ipcRenderer } from "electron";

// 对 renderer 暴露的 API。每个 domain 对应一个子对象。
const api = {
  cc: {
    status(): Promise<CCStatus> {
      return ipcRenderer.invoke(IpcChannels.CCStatus);
    },
  },
  // skill / session / settings / risk-gate 后续补
} as const;

export type OpenTradApi = typeof api;

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("api", api);
  } catch (err) {
    console.error("[preload] contextBridge exposeInMainWorld failed", err);
  }
} else {
  // contextIsolation 被关闭时的降级（生产不走这里）
  window.api = api;
}
