// settings:* IPC handlers。
// value 是任意 JSON 值（service 内部 JSON.stringify / JSON.parse）。
// renderer 应在自己侧用 zod 校验具体 key 的 value 形态。

import {
  IpcChannels,
  type SettingsGetRequest,
  SettingsGetRequestSchema,
  type SettingsSetRequest,
  SettingsSetRequestSchema,
} from "@opentrad/shared";
import { ipcMain } from "electron";
import type { DbServices } from "../services/db";

export function registerSettingsHandlers(db: DbServices): void {
  ipcMain.handle(IpcChannels.SettingsGet, async (_event, raw: unknown): Promise<unknown> => {
    const req: SettingsGetRequest = SettingsGetRequestSchema.parse(raw);
    return db.settings.get(req.key) ?? null;
  });

  ipcMain.handle(IpcChannels.SettingsSet, async (_event, raw: unknown): Promise<void> => {
    const req: SettingsSetRequest = SettingsSetRequestSchema.parse(raw);
    db.settings.set(req.key, req.value);
  });
}
