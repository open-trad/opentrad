// Preload 脚本：contextBridge 暴露 typed IPC API 给 renderer。
// 对应 03-architecture.md §2 apps/desktop/src/main/preload.ts + §3 IPC 协议。
//
// sandbox:true 下 preload 的能力受限：
// - 可用：contextBridge、ipcRenderer（Electron 白名单）
// - 不可用：任意 require、fs、child_process 等 Node API
// 这是 03-architecture.md §9 安全边界的一部分。
//
// **重要：本文件只允许从 "@opentrad/shared/channels" 拿运行时常量**。
// 从 "@opentrad/shared" 根 export 拿任何 value 会触发 zod evaluation chain
// （ipc.ts / db.ts 等模块顶部 import zod），vite 会在 preload bundle 里留
// require("zod")，sandbox 模式 require 拒绝 → 白屏 bug。
// type imports 编译时擦除，不影响运行时，从根 export 拿 type 没问题。
// 详见 packages/shared/src/channels.ts module-level 注释。

import type {
  AuthStartLoginFlowRequest,
  AuthStartLoginFlowResponse,
  CCCancelTaskRequest,
  CCEvent,
  CCStartTaskRequest,
  CCStartTaskResponse,
  CCStatus,
  InstallerRunCcInstallResponse,
  InstallerSupportsAutoInstallResponse,
  PtyDataEvent,
  PtyExitEvent,
  PtyKillRequest,
  PtyResizeRequest,
  PtySpawnRequest,
  PtySpawnResponse,
  PtyWriteRequest,
  RiskGateConfirmPayload,
  RiskGateResponsePayload,
  ShellOpenExternalRequest,
  SkillManifest,
} from "@opentrad/shared";
import { IpcChannels } from "@opentrad/shared/channels";
import { contextBridge, ipcRenderer } from "electron";

// 对 renderer 暴露的 API。每个 domain 对应一个子对象。
const api = {
  cc: {
    status(): Promise<CCStatus> {
      return ipcRenderer.invoke(IpcChannels.CCStatus);
    },
    startTask(req: CCStartTaskRequest): Promise<CCStartTaskResponse> {
      return ipcRenderer.invoke(IpcChannels.CCStartTask, req);
    },
    cancelTask(req: CCCancelTaskRequest): Promise<void> {
      return ipcRenderer.invoke(IpcChannels.CCCancelTask, req);
    },
    // 订阅 CC 事件流。返回 unsubscribe 函数，renderer 在 useEffect 清理时调用。
    onEvent(handler: (evt: CCEvent) => void): () => void {
      const listener = (_event: unknown, evt: CCEvent): void => handler(evt);
      ipcRenderer.on(IpcChannels.CCEvent, listener);
      return () => {
        ipcRenderer.removeListener(IpcChannels.CCEvent, listener);
      };
    },
    onStatus(handler: (status: CCStatus) => void): () => void {
      const listener = (_event: unknown, status: CCStatus): void => handler(status);
      ipcRenderer.on(IpcChannels.CCStatus, listener);
      return () => {
        ipcRenderer.removeListener(IpcChannels.CCStatus, listener);
      };
    },
    detectLoopStart(req: { intervalMs?: number; maxDurationMs?: number } = {}): Promise<void> {
      return ipcRenderer.invoke(IpcChannels.CCDetectLoopStart, req);
    },
    detectLoopStop(): Promise<void> {
      return ipcRenderer.invoke(IpcChannels.CCDetectLoopStop);
    },
  },
  installer: {
    supportsAutoInstall(): Promise<InstallerSupportsAutoInstallResponse> {
      return ipcRenderer.invoke(IpcChannels.InstallerSupportsAutoInstall);
    },
    runCcInstall(): Promise<InstallerRunCcInstallResponse> {
      return ipcRenderer.invoke(IpcChannels.InstallerRunCcInstall);
    },
  },
  pty: {
    spawn(req: PtySpawnRequest): Promise<PtySpawnResponse> {
      return ipcRenderer.invoke(IpcChannels.PtySpawn, req);
    },
    write(req: PtyWriteRequest): Promise<void> {
      return ipcRenderer.invoke(IpcChannels.PtyWrite, req);
    },
    resize(req: PtyResizeRequest): Promise<void> {
      return ipcRenderer.invoke(IpcChannels.PtyResize, req);
    },
    kill(req: PtyKillRequest): Promise<void> {
      return ipcRenderer.invoke(IpcChannels.PtyKill, req);
    },
    onData(handler: (evt: PtyDataEvent) => void): () => void {
      const listener = (_event: unknown, evt: PtyDataEvent): void => handler(evt);
      ipcRenderer.on(IpcChannels.PtyData, listener);
      return () => {
        ipcRenderer.removeListener(IpcChannels.PtyData, listener);
      };
    },
    onExit(handler: (evt: PtyExitEvent) => void): () => void {
      const listener = (_event: unknown, evt: PtyExitEvent): void => handler(evt);
      ipcRenderer.on(IpcChannels.PtyExit, listener);
      return () => {
        ipcRenderer.removeListener(IpcChannels.PtyExit, listener);
      };
    },
  },
  settings: {
    get(key: string): Promise<unknown> {
      return ipcRenderer.invoke(IpcChannels.SettingsGet, { key });
    },
    set(key: string, value: unknown): Promise<void> {
      return ipcRenderer.invoke(IpcChannels.SettingsSet, { key, value });
    },
  },
  auth: {
    startLoginFlow(req: AuthStartLoginFlowRequest): Promise<AuthStartLoginFlowResponse> {
      return ipcRenderer.invoke(IpcChannels.AuthStartLoginFlow, req);
    },
  },
  shell: {
    openExternal(req: ShellOpenExternalRequest): Promise<void> {
      return ipcRenderer.invoke(IpcChannels.ShellOpenExternal, req);
    },
  },
  skill: {
    list(): Promise<SkillManifest[]> {
      return ipcRenderer.invoke(IpcChannels.SkillList);
    },
  },
  riskGate: {
    onConfirm(handler: (payload: RiskGateConfirmPayload) => void): () => void {
      const listener = (_event: unknown, payload: RiskGateConfirmPayload): void => handler(payload);
      ipcRenderer.on(IpcChannels.RiskGateConfirm, listener);
      return () => {
        ipcRenderer.removeListener(IpcChannels.RiskGateConfirm, listener);
      };
    },
    sendResponse(payload: RiskGateResponsePayload): Promise<void> {
      return ipcRenderer.invoke(IpcChannels.RiskGateResponse, payload);
    },
  },
  // session 后续补
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
