// cc:* IPC handlers。对应 03-architecture.md §3 IPC channels + §4.1 Process Manager。
// 实现范围：
// - cc:status（Issue #7）：CC 安装 + 登录状态查询
// - cc:start-task（Issue #8）：spawn CC 任务，立刻返回 sessionId
// - cc:cancel-task（Issue #8）：按 sessionId 取消
// - cc:event（Issue #8）：main 向 renderer 推 domain CCEvent 流
//
// M0 阶段简化：prompt 硬编码 "Say hi in Chinese"，mcp-config 写一个空文件；
// skill 管理和真实 prompt composer 在 M1。

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CCManager, redactEmail } from "@opentrad/cc-adapter";
import {
  type CCCancelTaskRequest,
  type CCStartTaskResponse,
  type CCStatus,
  IpcChannels,
} from "@opentrad/shared";
import { ipcMain } from "electron";

export function registerCcHandlers(manager: CCManager): void {
  ipcMain.handle(IpcChannels.CCStatus, async (): Promise<CCStatus> => {
    return buildCcStatus(manager);
  });

  ipcMain.handle(IpcChannels.CCStartTask, async (event): Promise<CCStartTaskResponse> => {
    // M0：忽略 renderer 传的 skillId/inputs，固定 demo prompt。M1 接 skill runtime。
    const sessionId = randomUUID();
    const tmpDir = await mkdtemp(join(tmpdir(), "opentrad-m0-"));
    const mcpConfigPath = join(tmpDir, "mcp-config.json");
    await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: {} }));

    const handle = await manager.startTask({
      sessionId,
      prompt: "Say hi in Chinese",
      mcpConfigPath,
      allowedTools: [],
      model: "haiku",
    });

    // 异步把 events 推给这个 webContents；结束后清临时目录。
    // 不 await 这个 IIFE —— startTask 要立刻返回 sessionId 给 renderer。
    void (async () => {
      try {
        for await (const evt of handle.events) {
          if (event.sender.isDestroyed()) break;
          event.sender.send(IpcChannels.CCEvent, evt);
        }
      } catch (err) {
        console.error("[cc:event] stream error", err);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    })();

    return { sessionId };
  });

  ipcMain.handle(
    IpcChannels.CCCancelTask,
    async (_event, req: CCCancelTaskRequest): Promise<void> => {
      const handle = manager.activeTasks.get(req.sessionId);
      if (handle) await handle.cancel();
    },
  );
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
