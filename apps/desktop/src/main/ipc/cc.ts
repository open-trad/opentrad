// cc:* IPC handlers。对应 03-architecture.md §3 IPC channels + §4.1 Process Manager。
// M0 范围：只实现 cc:status（Issue #7 验收要求）。
// 后续里程碑：cc:start-task / cc:cancel-task / cc:event（Issue #8 + M1）。

import { type CCManager, redactEmail } from "@opentrad/cc-adapter";
import { type CCStatus, IpcChannels } from "@opentrad/shared";
import { ipcMain } from "electron";

export function registerCcHandlers(manager: CCManager): void {
  ipcMain.handle(IpcChannels.CCStatus, async (): Promise<CCStatus> => {
    return buildCcStatus(manager);
  });
}

// 合成 CCStatus：detectInstallation + getAuthStatus 两步的合并视图。
// 任一失败时把原因塞到 error 字段返回（不 throw，IPC 永远成功）。
export async function buildCcStatus(manager: CCManager): Promise<CCStatus> {
  try {
    const detected = await manager.detectInstallation();
    if (!detected.installed) {
      return {
        installed: false,
        error: detected.error,
      };
    }

    let loggedIn = false;
    let email: string | undefined;
    let authMethod: "subscription" | "api_key" | undefined;
    let authError: string | undefined;

    try {
      const auth = await manager.getAuthStatus();
      loggedIn = auth.loggedIn;
      authMethod = auth.method;
      email = auth.email ? redactEmail(auth.email) : undefined;
      authError = auth.error;
    } catch (err) {
      authError = err instanceof Error ? err.message : String(err);
    }

    return {
      installed: true,
      version: detected.version,
      loggedIn,
      email,
      authMethod,
      error: authError,
    };
  } catch (err) {
    return {
      installed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
