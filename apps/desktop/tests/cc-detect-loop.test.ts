// DetectLoopRegistry 测试：start / stop / cleanupAll，超时自动停。
// 用 vi.useFakeTimers 控制 setInterval 触发节奏。

import type { CCManager, DetectInstallationResult } from "@opentrad/cc-adapter";
import { IpcChannels } from "@opentrad/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DetectLoopRegistry } from "../src/main/services/cc-detect-loop";

interface FakeWebContents {
  id: number;
  isDestroyed(): boolean;
  send: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
}

function makeFakeSender(id: number): FakeWebContents {
  return {
    id,
    isDestroyed: () => false,
    send: vi.fn(),
    once: vi.fn(),
  };
}

function makeFakeManager(detect: () => Promise<DetectInstallationResult>): CCManager {
  return {
    detectInstallation: detect,
    getAuthStatus: vi.fn().mockResolvedValue({ loggedIn: false }),
  } as unknown as CCManager;
}

describe("DetectLoopRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("start 触发即时一次 + 按 intervalMs 周期推送 cc:status", async () => {
    const detectFn = vi.fn().mockResolvedValue({ installed: false, error: "not yet" });
    const manager = makeFakeManager(detectFn);
    const registry = new DetectLoopRegistry(manager, (e) => e);
    const sender = makeFakeSender(1);

    registry.start(sender as unknown as Electron.WebContents, {
      intervalMs: 3000,
      maxDurationMs: 60_000,
    });

    // 立即触发一次
    await vi.advanceTimersByTimeAsync(0);
    expect(detectFn).toHaveBeenCalledTimes(1);

    // 3s 后第二次
    await vi.advanceTimersByTimeAsync(3000);
    expect(detectFn).toHaveBeenCalledTimes(2);

    // 6s 后第三次
    await vi.advanceTimersByTimeAsync(3000);
    expect(detectFn).toHaveBeenCalledTimes(3);

    // 每次都通过 cc:status 推 sender
    expect(sender.send).toHaveBeenCalledWith(IpcChannels.CCStatus, expect.any(Object));

    registry.stop(sender as unknown as Electron.WebContents);
  });

  it("检测到 installed=true 时自动停（不再继续轮询）", async () => {
    let calls = 0;
    const detectFn = vi.fn(async () => {
      calls++;
      // 第三次返回 installed=true
      return calls >= 3
        ? ({ installed: true, version: "2.1.119" } as DetectInstallationResult)
        : ({ installed: false, error: "not yet" } as DetectInstallationResult);
    });
    const manager = makeFakeManager(detectFn);
    const registry = new DetectLoopRegistry(manager, (e) => e);
    const sender = makeFakeSender(2);

    registry.start(sender as unknown as Electron.WebContents, {
      intervalMs: 100,
      maxDurationMs: 60_000,
    });

    // 跑 5 个周期：第 3 次会返回 installed=true 并自动停
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(100);
    }

    // 第 3 次后应停止：calls 不会超过 3-4（取决于 timer 触发时序）
    expect(calls).toBeLessThanOrEqual(4);
  });

  it("超过 maxDurationMs 后自动停（避免空跑死循环）", async () => {
    const detectFn = vi.fn().mockResolvedValue({ installed: false, error: "not yet" });
    const manager = makeFakeManager(detectFn);
    const registry = new DetectLoopRegistry(manager, (e) => e);
    const sender = makeFakeSender(3);

    registry.start(sender as unknown as Electron.WebContents, {
      intervalMs: 1000,
      maxDurationMs: 5000,
    });

    // 跑 8 秒
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }

    // 5 秒超时后停 → calls 不会持续到 8
    const callsAt5s = detectFn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(detectFn.mock.calls.length).toBe(callsAt5s);
  });

  it("stop 立即清 timer", async () => {
    const detectFn = vi.fn().mockResolvedValue({ installed: false, error: "..." });
    const manager = makeFakeManager(detectFn);
    const registry = new DetectLoopRegistry(manager, (e) => e);
    const sender = makeFakeSender(4);

    registry.start(sender as unknown as Electron.WebContents, {
      intervalMs: 1000,
      maxDurationMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    const callsBeforeStop = detectFn.mock.calls.length;

    registry.stop(sender as unknown as Electron.WebContents);
    await vi.advanceTimersByTimeAsync(5000);

    expect(detectFn.mock.calls.length).toBe(callsBeforeStop);
  });

  it("cleanupAll 清所有 sender 的 loop", async () => {
    const detectFn = vi.fn().mockResolvedValue({ installed: false, error: "..." });
    const manager = makeFakeManager(detectFn);
    const registry = new DetectLoopRegistry(manager, (e) => e);
    const s1 = makeFakeSender(5);
    const s2 = makeFakeSender(6);

    registry.start(s1 as unknown as Electron.WebContents, {
      intervalMs: 1000,
      maxDurationMs: 60_000,
    });
    registry.start(s2 as unknown as Electron.WebContents, {
      intervalMs: 1000,
      maxDurationMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(0);

    registry.cleanupAll();
    const callsAfterCleanup = detectFn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(detectFn.mock.calls.length).toBe(callsAfterCleanup);
  });

  it("同一 sender 第二次 start 替换前一次（避免重复 timer）", async () => {
    const detectFn = vi.fn().mockResolvedValue({ installed: false, error: "..." });
    const manager = makeFakeManager(detectFn);
    const registry = new DetectLoopRegistry(manager, (e) => e);
    const sender = makeFakeSender(7);

    registry.start(sender as unknown as Electron.WebContents, {
      intervalMs: 1000,
      maxDurationMs: 60_000,
    });
    registry.start(sender as unknown as Electron.WebContents, {
      intervalMs: 1000,
      maxDurationMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(0);

    // 应该只跑 1 次（最近的 start;旧 timer 被 stop）
    // 立即触发一次 + 第二次 start 立即触发 = 2 次。但不会因 timer 累积变 4 次。
    await vi.advanceTimersByTimeAsync(1000);
    expect(detectFn.mock.calls.length).toBeLessThanOrEqual(3);

    registry.stop(sender as unknown as Electron.WebContents);
  });
});
