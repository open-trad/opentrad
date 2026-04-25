// installer:* + cc:detect-loop-* IPC handlers（M1 #21 / open-trad/opentrad#21）。
//
// 流程：
// 1. renderer 进入 OnboardingStep1 → installer:supports-auto-install 探平台
// 2. supports=true（macOS/Linux）→ "一键安装" → installer:run-cc-install
//    主进程通过 PtyManager spawn `bash -c 'curl ... | bash'`，返回 ptyId
//    给 renderer 渲染 TerminalPane
// 3. supports=false（Windows）→ UI 显示 docs.claude.com 链接 + "我已装好"
// 4. 安装结束 / 用户点"重新检测" → cc:detect-loop-start 启动后台轮询
//    主进程每 3s 跑 detectInstallation()，通过 cc:status 推 renderer
//    检测到 installed=true 自动停 + renderer 切到 LoginStep（M1 #22）

import {
  type CCDetectLoopStartRequest,
  CCDetectLoopStartRequestSchema,
  type InstallerRunCcInstallResponse,
  type InstallerSupportsAutoInstallResponse,
  IpcChannels,
} from "@opentrad/shared";
import { ipcMain } from "electron";
import type { DetectLoopRegistry } from "../services/cc-detect-loop";
import { getAutoInstallCommand, getPlatformInstallSupport } from "../services/installer";
import type { PtyManager } from "../services/pty-manager";

export interface InstallerHandlerDeps {
  pty: PtyManager;
  detectLoop: DetectLoopRegistry;
}

export function registerInstallerHandlers(deps: InstallerHandlerDeps): void {
  const { pty, detectLoop } = deps;

  ipcMain.handle(
    IpcChannels.InstallerSupportsAutoInstall,
    async (): Promise<InstallerSupportsAutoInstallResponse> => {
      return getPlatformInstallSupport();
    },
  );

  ipcMain.handle(
    IpcChannels.InstallerRunCcInstall,
    async (event): Promise<InstallerRunCcInstallResponse> => {
      const support = getPlatformInstallSupport();
      if (!support.supportsAutoInstall) {
        throw new Error(
          `auto-install not supported on ${support.platform}; use ${support.manualInstallUrl}`,
        );
      }
      const cmd = getAutoInstallCommand();
      const ptyId = pty.spawn({
        command: cmd.command,
        args: cmd.args,
      });
      // PTY 输出已通过 #20 的 PtyData / PtyExit 事件路由到 renderer
      // （renderer 用 TerminalPane 订阅同款 ptyId）
      // webContents 销毁时 #20 会自动 kill 该 PTY，无需在此重复
      void event;
      return { ptyId };
    },
  );

  ipcMain.handle(IpcChannels.CCDetectLoopStart, async (event, raw: unknown): Promise<void> => {
    const req: CCDetectLoopStartRequest = CCDetectLoopStartRequestSchema.parse(raw ?? {});
    detectLoop.start(event.sender, {
      intervalMs: req.intervalMs,
      maxDurationMs: req.maxDurationMs,
    });
    // sender 销毁时清 timer
    event.sender.once("destroyed", () => detectLoop.stop(event.sender));
  });

  ipcMain.handle(IpcChannels.CCDetectLoopStop, async (event): Promise<void> => {
    detectLoop.stop(event.sender);
  });
}
