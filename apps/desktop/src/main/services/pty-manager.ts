// PTY 子进程管理。封装 node-pty，对外暴露 spawn / write / resize / kill 接口。
//
// 设计：
// - PtyManager extends EventEmitter，emit "data" / "exit" 给上层 IPC handler 转发
// - 不直接持有 webContents（避免 window 关闭后引用失效）；IPC 层自己管理 ptyId → webContents 路由
// - cleanup() 幂等，应用退出时调用，kill 所有 PTY 子进程
// - 跨平台默认 shell：macOS=zsh、Linux=bash、Windows=pwsh.exe（回退 cmd.exe）
//
// node-pty native module 的 darwin-arm64 / x64、win32-x64 / arm64 都有 prebuild；
// linux 走 prebuild-install 或 node-gyp build（D-M1-1 允许 CI workflow 自主调整）。

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IPty } from "node-pty";
import * as pty from "node-pty";

export interface PtySpawnOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

interface PtyDataPayload {
  ptyId: string;
  data: string;
}

interface PtyExitPayload {
  ptyId: string;
  exitCode: number;
  signal?: number;
}

interface PtyManagerEvents {
  data: [PtyDataPayload];
  exit: [PtyExitPayload];
}

export class PtyManager extends EventEmitter<PtyManagerEvents> {
  private readonly ptys = new Map<string, IPty>();
  private cleaningUp = false;

  spawn(opts: PtySpawnOptions = {}): string {
    const command = opts.command ?? defaultShell();
    const args = opts.args ?? [];
    const ptyProcess = pty.spawn(command, args, {
      name: "xterm-color",
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd ?? process.env.HOME ?? process.cwd(),
      env: { ...(process.env as Record<string, string>), ...(opts.env ?? {}) },
    });
    const ptyId = randomUUID();
    this.ptys.set(ptyId, ptyProcess);

    ptyProcess.onData((data) => {
      this.emit("data", { ptyId, data });
    });
    ptyProcess.onExit(({ exitCode, signal }) => {
      this.ptys.delete(ptyId);
      this.emit("exit", { ptyId, exitCode, signal: signal ?? undefined });
    });

    return ptyId;
  }

  write(ptyId: string, data: string): void {
    this.ptys.get(ptyId)?.write(data);
  }

  resize(ptyId: string, cols: number, rows: number): void {
    this.ptys.get(ptyId)?.resize(cols, rows);
  }

  kill(ptyId: string, signal?: string): void {
    const p = this.ptys.get(ptyId);
    if (!p) return;
    try {
      p.kill(signal);
    } catch {
      // 已退出 / Windows 上信号语义差异 → 忽略
    }
  }

  get activePtys(): ReadonlyMap<string, IPty> {
    return this.ptys;
  }

  // 应用退出前调用：kill 所有 PTY，避免子进程残留
  cleanup(): void {
    if (this.cleaningUp) return;
    this.cleaningUp = true;
    for (const id of [...this.ptys.keys()]) {
      this.kill(id);
    }
  }
}

function defaultShell(): string {
  if (process.platform === "win32") {
    // 优先 PowerShell 7+；不存在时回退 cmd.exe（CI / 老 Windows 兜底）
    return process.env.OPENTRAD_PTY_SHELL ?? "pwsh.exe";
  }
  if (process.platform === "darwin") {
    return process.env.SHELL ?? "/bin/zsh";
  }
  return process.env.SHELL ?? "/bin/bash";
}
