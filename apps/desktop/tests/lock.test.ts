// 单实例互斥锁测试。
// 重点：开工前对齐 A2 的 stale PID 处理 — process.kill(pid, 0) 探活语义跨平台正确。
// 不实际启动两个 OpenTrad 进程；通过控制 .lock 文件内容（PID）来模拟各种状态。

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as paths from "../src/main/services/db/paths";
import { AppLockHeldError, acquireAppLock } from "../src/main/services/lock";

describe("AppLock", () => {
  let tempDir: string;
  let lockPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "opentrad-lock-test-"));
    lockPath = join(tempDir, ".lock");
    vi.spyOn(paths, "getUserDataDir").mockReturnValue(tempDir);
    vi.spyOn(paths, "getLockPath").mockReturnValue(lockPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("无 .lock 时：写入当前 PID", () => {
    expect(existsSync(lockPath)).toBe(false);
    const lock = acquireAppLock();
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf-8")).toBe(String(process.pid));
    lock.release();
  });

  it("release：删除 .lock", () => {
    const lock = acquireAppLock();
    expect(existsSync(lockPath)).toBe(true);
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("stale .lock（PID 已死）：覆盖并继续启动", () => {
    // 找一个已经不存在的 PID。max int 32-bit signed 通常没有进程；用 999999 作 best-effort
    const deadPid = 999999;
    writeFileSync(lockPath, String(deadPid), "utf-8");

    const lock = acquireAppLock();
    // 覆盖成功 → .lock 内容变成当前进程 PID
    expect(readFileSync(lockPath, "utf-8")).toBe(String(process.pid));
    lock.release();
  });

  it("活的 .lock（同进程 PID）：抛 AppLockHeldError", () => {
    // 写入当前进程的 PID，模拟"另一个 OpenTrad 实例"
    writeFileSync(lockPath, String(process.pid), "utf-8");
    expect(() => acquireAppLock()).toThrow(AppLockHeldError);
    try {
      acquireAppLock();
    } catch (err) {
      expect(err).toBeInstanceOf(AppLockHeldError);
      expect((err as AppLockHeldError).heldByPid).toBe(process.pid);
      expect((err as AppLockHeldError).code).toBe("APP_LOCK_HELD");
    }
  });

  it("损坏的 .lock（PID 不可解析）：视为可覆盖", () => {
    writeFileSync(lockPath, "not-a-number", "utf-8");
    const lock = acquireAppLock();
    expect(readFileSync(lockPath, "utf-8")).toBe(String(process.pid));
    lock.release();
  });

  it("release：只删自己持有的 lock（PID 校验）", () => {
    const lock = acquireAppLock();
    // 模拟另一个进程 acquire（写入别的 PID）— release 不应误删
    writeFileSync(lockPath, "999999", "utf-8");
    lock.release();
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf-8")).toBe("999999");
  });
});
