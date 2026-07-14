// pty:* IPC handlers。把 PtyManager 的 EventEmitter 接到 renderer 的 webContents。
// 路由策略：每个 ptyId 绑定 spawn 时的 webContents（请求者），onData / onExit 只推给它。
// 多窗口场景：每个窗口的 PTY 独立（ptyId 不冲突，因为是 UUID）。

import {
  IpcChannels,
  type PtyAttachRequest,
  PtyAttachRequestSchema,
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
import { ipcMain } from "electron";
import type { PtyManager } from "../services/pty-manager";
import { PtySubscriberRouter } from "../services/pty-subscriber-router";

export function registerPtyHandlers(manager: PtyManager): PtySubscriberRouter {
  const router = new PtySubscriberRouter(manager);

  ipcMain.handle(IpcChannels.PtySpawn, async (event, raw: unknown): Promise<PtySpawnResponse> => {
    const req: PtySpawnRequest = PtySpawnRequestSchema.parse(raw ?? {});
    const ptyId = router.spawnAndBind(req, event.sender);
    return { ptyId };
  });

  ipcMain.handle(IpcChannels.PtyWrite, async (event, raw: unknown): Promise<void> => {
    const req: PtyWriteRequest = PtyWriteRequestSchema.parse(raw);
    router.assertOwner(req.ptyId, event.sender);
    manager.write(req.ptyId, req.data);
  });

  ipcMain.handle(IpcChannels.PtyAttach, async (event, raw: unknown): Promise<void> => {
    const req: PtyAttachRequest = PtyAttachRequestSchema.parse(raw);
    router.attach(req.ptyId, event.sender);
  });

  ipcMain.handle(IpcChannels.PtyResize, async (event, raw: unknown): Promise<void> => {
    const req: PtyResizeRequest = PtyResizeRequestSchema.parse(raw);
    router.assertOwner(req.ptyId, event.sender);
    manager.resize(req.ptyId, req.cols, req.rows);
  });

  ipcMain.handle(IpcChannels.PtyKill, async (event, raw: unknown): Promise<void> => {
    const req: PtyKillRequest = PtyKillRequestSchema.parse(raw);
    router.close(req.ptyId, event.sender);
    manager.kill(req.ptyId, req.signal);
  });

  return router;
}
