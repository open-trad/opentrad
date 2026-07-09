// CCManager：Claude Code 子进程的生命周期管理入口。
// 对应 03-architecture.md §4.1。
//
// 设计不变量：
// - 每个 CCTaskOptions → 1 个子进程 + 1 个 CCTaskHandle，唯一 sessionId 索引
// - startTask 返回前子进程已 spawn（pid 可用）；事件流通过 handle.events 消费
// - cleanup() 幂等；应用正常/异常退出时通过 installProcessHandlers() 兜底
// - 不读取 ~/.claude/ 目录；Claude 凭证由 CC 自己管理（kickoff 硬约束）

import type { ChildProcessByStdio } from "node:child_process";
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { CCTaskHandle, CCTaskOptions } from "@opentrad/shared";
import type { AuthStatus } from "./auth";
import { getAuthStatus } from "./auth";
import type { DetectInstallationResult } from "./detect";
import { detectInstallation } from "./detect";
import { CCTaskHandleImpl } from "./handle";

export interface CCManagerOptions {
  // claude 可执行文件路径（默认从 PATH 找）
  binary?: string;
  // 是否自动注册 SIGINT/SIGTERM/exit handler（默认 true；单元测试里关掉）
  installExitHandlers?: boolean;
}

export class CCManager {
  private readonly binary: string;
  private readonly tasks = new Map<string, CCTaskHandleImpl>();
  private exitHandlersInstalled = false;
  private cleaningUp = false;

  constructor(opts: CCManagerOptions = {}) {
    this.binary = opts.binary ?? "claude";
    if (opts.installExitHandlers !== false) {
      this.installExitHandlers();
    }
  }

  async detectInstallation(): Promise<DetectInstallationResult> {
    return detectInstallation(this.binary);
  }

  async getAuthStatus(): Promise<AuthStatus> {
    return getAuthStatus(this.binary);
  }

  get activeTasks(): ReadonlyMap<string, CCTaskHandle> {
    return this.tasks;
  }

  async startTask(opts: CCTaskOptions): Promise<CCTaskHandle> {
    if (this.tasks.has(opts.sessionId)) {
      throw new Error(`CCManager: sessionId ${opts.sessionId} already has an active task`);
    }

    const args = buildClaudeArgs(opts);
    const child = spawn(this.binary, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // detached: false 让子进程随父进程一起死（Unix 默认；Windows 下通过
      // taskkill 或 process group 兜底——M0 先靠 cleanup() + exit handler）
      detached: false,
    }) as unknown as ChildProcessByStdio<Writable | null, Readable, Readable>;

    const handle = new CCTaskHandleImpl({
      sessionId: opts.sessionId,
      child,
      onTerminated: (sid) => {
        this.tasks.delete(sid);
      },
    });

    this.tasks.set(opts.sessionId, handle);
    return handle;
  }

  async cleanup(): Promise<void> {
    if (this.cleaningUp) return;
    this.cleaningUp = true;
    try {
      const pending = [...this.tasks.values()].map((h) => h.cancel());
      await Promise.allSettled(pending);
      this.tasks.clear();
    } finally {
      this.cleaningUp = false;
    }
  }

  // 注册进程级 handler 兜底：用户按 Ctrl-C 或 IDE 强杀主进程时，尽力清理子进程。
  private installExitHandlers(): void {
    if (this.exitHandlersInstalled) return;
    this.exitHandlersInstalled = true;
    const onSignal = (signal: NodeJS.Signals) => {
      // 同步 kill 所有子进程（此处不能 await，Node 的 signal handler 是同步的）
      for (const handle of this.tasks.values()) {
        try {
          process.kill(handle.pid, signal);
        } catch {
          // ignore: process may already be gone
        }
      }
    };
    process.once("SIGINT", () => onSignal("SIGINT"));
    process.once("SIGTERM", () => onSignal("SIGTERM"));
    process.once("exit", () => {
      // 进程真正退出前的最后一跳；同步 kill
      for (const handle of this.tasks.values()) {
        try {
          process.kill(handle.pid, "SIGKILL");
        } catch {
          // ignore
        }
      }
    });
  }
}

// 根据 CCTaskOptions 组装 claude CLI 参数。
export function buildClaudeArgs(opts: CCTaskOptions): string[] {
  const args: string[] = ["-p", "--output-format", "stream-json", "--verbose"];

  args.push("--session-id", opts.sessionId);

  if (opts.model && opts.model !== "default") {
    args.push("--model", opts.model);
  }
  if (opts.permissionMode && opts.permissionMode !== "default") {
    args.push("--permission-mode", opts.permissionMode);
  }
  if (opts.allowedTools.length > 0) {
    args.push("--allowedTools", ...opts.allowedTools);
  } else {
    // 显式传空字符串以禁用全部工具，避免被全局 settings 注入
    args.push("--tools", "");
  }
  if (opts.mcpConfigPath) {
    args.push("--mcp-config", opts.mcpConfigPath, "--strict-mcp-config");
  }
  if (opts.resume) {
    args.push("--resume");
  }

  // prompt 放最后（CC 位置参数）
  args.push(opts.prompt);
  return args;
}
