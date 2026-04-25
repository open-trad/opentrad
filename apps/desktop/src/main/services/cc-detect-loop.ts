// CC 安装状态后台轮询（M1 #21 / open-trad/opentrad#21）。
//
// renderer 在 install 流程触发后调 cc:detect-loop-start，主进程每
// intervalMs 跑一次 detectInstallation()，通过 cc:status push 给 renderer。
// 5 分钟（默认 maxDurationMs）后自动停止防空跑（avoid 跑了 5 分钟还没装好的
// 死循环）。
//
// 单例 per webContents：每个 renderer 同时只能有一个 detect loop（多次
// start 时 stop 旧的）。stop / sender destroyed → 立刻清 timer。

import type { CCManager, redactEmail as redactEmailFn } from "@opentrad/cc-adapter";
import { type CCStatus, IpcChannels } from "@opentrad/shared";
import type { WebContents } from "electron";

export interface DetectLoopOptions {
  intervalMs: number;
  maxDurationMs: number;
}

export class DetectLoopRegistry {
  private readonly loops = new Map<number, NodeJS.Timeout>();
  private readonly stopAt = new Map<number, number>();

  constructor(
    private readonly manager: CCManager,
    private readonly redactEmail: typeof redactEmailFn,
  ) {}

  start(sender: WebContents, opts: DetectLoopOptions): void {
    this.stop(sender); // 重启前先清旧的

    const senderId = sender.id;
    this.stopAt.set(senderId, Date.now() + opts.maxDurationMs);

    const tick = async (): Promise<void> => {
      if (sender.isDestroyed()) {
        this.stop(sender);
        return;
      }
      // 超时自动停
      const deadline = this.stopAt.get(senderId);
      if (deadline !== undefined && Date.now() > deadline) {
        this.stop(sender);
        return;
      }

      try {
        const status = await this.buildStatus();
        if (!sender.isDestroyed()) {
          sender.send(IpcChannels.CCStatus, status);
        }
        // 检测到 installed=true 自动停（renderer 收到后切到 LoginStep）
        if (status.installed) {
          this.stop(sender);
        }
      } catch {
        // 不抛；下一次 tick 再试
      }
    };

    // 立刻跑一次（不等 interval）
    void tick();
    const timer = setInterval(tick, opts.intervalMs);
    this.loops.set(senderId, timer);
  }

  stop(sender: WebContents): void {
    const senderId = sender.id;
    const timer = this.loops.get(senderId);
    if (timer) {
      clearInterval(timer);
      this.loops.delete(senderId);
    }
    this.stopAt.delete(senderId);
  }

  cleanupAll(): void {
    for (const [, timer] of this.loops) clearInterval(timer);
    this.loops.clear();
    this.stopAt.clear();
  }

  // 跟 ipc/cc.ts 的 buildCcStatus 同款逻辑（detect + auth）。
  // 复用而非 import 避免循环依赖（cc.ts 也持有 manager）。
  private async buildStatus(): Promise<CCStatus> {
    try {
      const detected = await this.manager.detectInstallation();
      if (!detected.installed) {
        return { installed: false, error: detected.error };
      }
      let loggedIn = false;
      let email: string | undefined;
      let authMethod: "subscription" | "api_key" | undefined;
      let authError: string | undefined;
      try {
        const auth = await this.manager.getAuthStatus();
        loggedIn = auth.loggedIn;
        authMethod = auth.method;
        email = auth.email ? this.redactEmail(auth.email) : undefined;
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
}
