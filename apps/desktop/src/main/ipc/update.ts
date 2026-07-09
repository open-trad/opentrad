// update:* IPC handlers（M0.5：检查更新 + 打开下载页）。

import { IpcChannels, type UpdateCheckResult } from "@opentrad/shared";
import { app, ipcMain, shell } from "electron";
import { checkForUpdate } from "../services/update-service";

export function registerUpdateHandlers(): void {
  ipcMain.handle(IpcChannels.UpdateCheck, async (): Promise<UpdateCheckResult> => {
    // 未打包（dev）时版本号无意义，不检查
    if (!app.isPackaged) {
      return { hasUpdate: false, current: app.getVersion(), latest: null, url: null };
    }
    return checkForUpdate(app.getVersion());
  });

  ipcMain.handle(IpcChannels.UpdateOpenReleasePage, async (_e, raw: unknown): Promise<void> => {
    const url =
      typeof raw === "object" && raw && typeof (raw as { url?: unknown }).url === "string"
        ? (raw as { url: string }).url
        : "https://github.com/open-trad/opentrad/releases/latest";
    await shell.openExternal(url);
  });
}
