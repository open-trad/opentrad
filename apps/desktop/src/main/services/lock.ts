// 单实例互斥锁。
// 在用户数据目录下写一个 .lock 文件，内容是 PID。
//
// 启动逻辑（开工前对齐 A2 + M1 #19 / #2 验收 6）：
// 1. 若 .lock 不存在 → 写入当前 PID
// 2. 若 .lock 存在：
//    - 读 PID，用 process.kill(pid, 0) 探活
//    - throw ESRCH（POSIX）/ Windows 同等错误 → 视为死进程，覆盖 .lock
//    - 探活通过 → 视为活进程，抛 AppLockHeldError 让调用方退出应用
// 3. 退出时只删自己写的 .lock（PID 校验）；防止崩溃残留 .lock 误删别人的
//
// 跨平台说明：
// - process.kill(pid, 0) 在 POSIX 是发 signal 0（不实际发，只查存在性）
// - Windows 上 Node 也实现了 signal 0 探活语义（但精度比 POSIX 略差）
// - M1 简化版够用；M2 如发现误判可上 pidusage 等第三方包

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { getLockPath, getUserDataDir } from "./db/paths";

export class AppLockHeldError extends Error {
  readonly code = "APP_LOCK_HELD" as const;
  constructor(public readonly heldByPid: number) {
    super(`OpenTrad is already running (PID=${heldByPid})`);
    this.name = "AppLockHeldError";
  }
}

export interface AppLock {
  release: () => void;
}

export function acquireAppLock(): AppLock {
  const lockPath = getLockPath();
  mkdirSync(getUserDataDir(), { recursive: true });

  if (existsSync(lockPath)) {
    const heldPid = readPidFromLock(lockPath);
    if (heldPid !== undefined && isProcessAlive(heldPid)) {
      throw new AppLockHeldError(heldPid);
    }
    // PID 不可解析 / 进程已死 → stale .lock，安全覆盖
  }

  writeFileSync(lockPath, String(process.pid), "utf-8");

  return {
    release: () => releaseLock(lockPath),
  };
}

function readPidFromLock(lockPath: string): number | undefined {
  try {
    const content = readFileSync(lockPath, "utf-8").trim();
    const pid = Number.parseInt(content, 10);
    if (Number.isFinite(pid) && pid > 0) return pid;
    return undefined; // 文件内容损坏 → 视为可覆盖
  } catch {
    return undefined; // 读不出来 → 视为可覆盖
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    // signal 0：仅检查进程是否存在，不实际发信号
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false; // 进程不存在
    if (code === "EPERM") return true; // 存在但无权限（cross-user）→ 保守视为活
    return true; // 未知错误 → 保守视为活，避免误覆盖
  }
}

function releaseLock(lockPath: string): void {
  try {
    if (!existsSync(lockPath)) return;
    const heldPid = readPidFromLock(lockPath);
    // 只删自己持有的 lock（PID 校验），保护并发场景下不误删他人
    if (heldPid === process.pid) {
      unlinkSync(lockPath);
    }
  } catch {
    // 静默：清理失败不应阻塞退出流程
  }
}
