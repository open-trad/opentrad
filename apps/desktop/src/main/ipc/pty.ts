// pty:* IPC handlers。把 PtyManager 的 EventEmitter 接到 renderer 的 webContents。
// 路由策略：每个 ptyId 绑定 spawn 时的 webContents（请求者），onData / onExit 只推给它。
// 多窗口场景：每个窗口的 PTY 独立（ptyId 不冲突，因为是 UUID）。

import {
  IpcChannels,
  type PtyDataEvent,
  type PtyExitEvent,
  type PtyKillRequest,
  PtyKillRequestSchema,
  type PtyResizeRequest,
  PtyResizeRequestSchema,
  type PtySpawnRequest,
  PtySpawnRequestSchema,
  type PtySpawnResponse,
  type PtyWriteRequest,
  PtyWriteRequestSchema,
} from "@opentrad/shared";
import { ipcMain, type WebContents } from "electron";
import type { PtyManager } from "../services/pty-manager";

export function registerPtyHandlers(manager: PtyManager): void {
  // ptyId → spawn 时的 webContents。webContents 销毁时清理。
  const subscribers = new Map<string, WebContents>();

  manager.on("data", ({ ptyId, data }) => {
    const wc = subscribers.get(ptyId);
    if (!wc || wc.isDestroyed()) return;
    const payload: PtyDataEvent = { ptyId, data };
    wc.send(IpcChannels.PtyData, payload);
  });

  manager.on("exit", ({ ptyId, exitCode, signal }) => {
    const wc = subscribers.get(ptyId);
    subscribers.delete(ptyId);
    if (!wc || wc.isDestroyed()) return;
    const payload: PtyExitEvent = { ptyId, exitCode, signal };
    wc.send(IpcChannels.PtyExit, payload);
  });

  ipcMain.handle(IpcChannels.PtySpawn, async (event, raw: unknown): Promise<PtySpawnResponse> => {
    const req: PtySpawnRequest = PtySpawnRequestSchema.parse(raw ?? {});
    const ptyId = manager.spawn(req);
    subscribers.set(ptyId, event.sender);
    // webContents 被关闭时自动清 + kill 该 PTY，避免子进程残留
    event.sender.once("destroyed", () => {
      subscribers.delete(ptyId);
      manager.kill(ptyId);
    });
    return { ptyId };
  });

  ipcMain.handle(IpcChannels.PtyWrite, async (_event, raw: unknown): Promise<void> => {
    const req: PtyWriteRequest = PtyWriteRequestSchema.parse(raw);
    manager.write(req.ptyId, req.data);
  });

  ipcMain.handle(IpcChannels.PtyResize, async (_event, raw: unknown): Promise<void> => {
    const req: PtyResizeRequest = PtyResizeRequestSchema.parse(raw);
    manager.resize(req.ptyId, req.cols, req.rows);
  });

  ipcMain.handle(IpcChannels.PtyKill, async (_event, raw: unknown): Promise<void> => {
    const req: PtyKillRequest = PtyKillRequestSchema.parse(raw);
    manager.kill(req.ptyId, req.signal);
  });
}
