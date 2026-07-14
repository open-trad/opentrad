import { describe, expect, it, vi } from "vitest";
import { PtyManager } from "../src/main/services/pty-manager";
import { PtySubscriberRouter } from "../src/main/services/pty-subscriber-router";

function fakeWebContents() {
  let destroyed = false;
  let onDestroyed: (() => void) | undefined;
  return {
    api: {
      isDestroyed: () => destroyed,
      send: vi.fn(),
      once: vi.fn((event: string, listener: () => void) => {
        if (event === "destroyed") onDestroyed = listener;
      }),
    },
    destroy() {
      destroyed = true;
      onDestroyed?.();
    },
  };
}

describe("PtySubscriberRouter", () => {
  it("replays early data and exit in order only after the bound renderer attaches", () => {
    const manager = new PtyManager();
    const router = new PtySubscriberRouter(manager);
    const owner = fakeWebContents();

    manager.emit("data", { ptyId: "pty-oauth", data: "first" });
    router.bind("pty-oauth", owner.api as never, { deferUntilAttach: true });
    manager.emit("data", { ptyId: "pty-oauth", data: "second" });
    manager.emit("exit", { ptyId: "pty-oauth", exitCode: 0 });

    expect(owner.api.send).not.toHaveBeenCalled();
    expect(router.has("pty-oauth")).toBe(true);

    router.attach("pty-oauth", owner.api as never);

    expect(owner.api.send.mock.calls.map((call) => call[1])).toEqual([
      { ptyId: "pty-oauth", data: "firstsecond" },
      { ptyId: "pty-oauth", exitCode: 0, signal: undefined },
    ]);
    expect(router.has("pty-oauth")).toBe(false);
  });

  it("rejects attach from a different renderer and keeps the backlog private", () => {
    const manager = new PtyManager();
    const router = new PtySubscriberRouter(manager);
    const owner = fakeWebContents();
    const attacker = fakeWebContents();

    router.bind("pty-oauth", owner.api as never, { deferUntilAttach: true });
    manager.emit("data", { ptyId: "pty-oauth", data: "private login output" });

    expect(() => router.attach("pty-oauth", attacker.api as never)).toThrowError(
      "PTY attach is unavailable",
    );
    expect(attacker.api.send).not.toHaveBeenCalled();
    expect(owner.api.send).not.toHaveBeenCalled();

    router.attach("pty-oauth", owner.api as never);
    expect(owner.api.send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ data: "private login output" }),
    );
  });

  it("authorizes PTY write and resize operations only for the bound renderer", () => {
    const manager = new PtyManager();
    const router = new PtySubscriberRouter(manager);
    const owner = fakeWebContents();
    const attacker = fakeWebContents();

    router.bind("pty-oauth", owner.api as never, { deferUntilAttach: true });

    expect(() => router.assertOwner("pty-oauth", owner.api as never)).not.toThrow();
    expect(() => router.assertOwner("pty-oauth", attacker.api as never)).toThrowError(
      "PTY ownership mismatch",
    );
    expect(() => router.assertOwner("missing", owner.api as never)).toThrowError(
      "PTY ownership mismatch",
    );
  });

  it("kills a newly spawned PTY when owner binding fails", () => {
    const manager = new PtyManager();
    vi.spyOn(manager, "spawn").mockReturnValue("pty-unbound");
    const kill = vi.spyOn(manager, "kill").mockImplementation(() => undefined);
    const router = new PtySubscriberRouter(manager);
    const destroyedOwner = fakeWebContents();
    destroyedOwner.destroy();

    expect(() => router.spawnAndBind({}, destroyedOwner.api as never)).toThrowError(
      "PTY attach is unavailable",
    );
    expect(kill).toHaveBeenCalledWith("pty-unbound");
  });

  it("bounds transient pre-attach output while preserving its earliest bytes and exit order", () => {
    const manager = new PtyManager();
    const router = new PtySubscriberRouter(manager, {
      maxBacklogCharacters: 5,
      maxPendingPtys: 2,
      pendingTtlMs: 1_000,
    });
    const owner = fakeWebContents();

    manager.emit("data", { ptyId: "pty-oauth", data: "1234" });
    manager.emit("data", { ptyId: "pty-oauth", data: "56789" });
    manager.emit("exit", { ptyId: "pty-oauth", exitCode: 7 });
    router.bind("pty-oauth", owner.api as never, { deferUntilAttach: true });
    router.attach("pty-oauth", owner.api as never);

    expect(owner.api.send.mock.calls.map((call) => call[1])).toEqual([
      { ptyId: "pty-oauth", data: "12345" },
      { ptyId: "pty-oauth", exitCode: 7, signal: undefined },
    ]);
  });

  it("expires unowned transient output instead of retaining it", () => {
    vi.useFakeTimers();
    const manager = new PtyManager();
    const router = new PtySubscriberRouter(manager, {
      maxBacklogCharacters: 64,
      maxPendingPtys: 2,
      pendingTtlMs: 100,
    });
    const owner = fakeWebContents();

    manager.emit("data", { ptyId: "pty-oauth", data: "expired" });
    vi.advanceTimersByTime(101);
    expect(() =>
      router.bind("pty-oauth", owner.api as never, { deferUntilAttach: true }),
    ).toThrowError("PTY attach is unavailable");

    expect(owner.api.send).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("把受管 PTY 输出和退出只发回绑定窗口", () => {
    const manager = new PtyManager();
    const router = new PtySubscriberRouter(manager);
    const owner = fakeWebContents();

    router.bind("pty-oauth", owner.api as never);
    manager.emit("data", { ptyId: "pty-oauth", data: "login url" });
    manager.emit("data", { ptyId: "other", data: "not yours" });
    manager.emit("exit", { ptyId: "pty-oauth", exitCode: 0 });

    expect(owner.api.send).toHaveBeenCalledTimes(2);
    expect(owner.api.send.mock.calls[0]?.[1]).toEqual({
      ptyId: "pty-oauth",
      data: "login url",
    });
    expect(owner.api.send.mock.calls[1]?.[1]).toEqual({
      ptyId: "pty-oauth",
      exitCode: 0,
      signal: undefined,
    });
    expect(router.has("pty-oauth")).toBe(false);
  });

  it("窗口销毁时解除绑定并终止它拥有的 PTY", () => {
    const manager = new PtyManager();
    const kill = vi.spyOn(manager, "kill").mockImplementation(() => undefined);
    const router = new PtySubscriberRouter(manager);
    const owner = fakeWebContents();

    router.bind("pty-oauth", owner.api as never);
    owner.destroy();

    expect(kill).toHaveBeenCalledWith("pty-oauth");
    expect(router.has("pty-oauth")).toBe(false);
  });

  it("旧窗口销毁不会终止已重新绑定给新窗口的 PTY", () => {
    const manager = new PtyManager();
    const kill = vi.spyOn(manager, "kill").mockImplementation(() => undefined);
    const router = new PtySubscriberRouter(manager);
    const oldOwner = fakeWebContents();
    const newOwner = fakeWebContents();

    router.bind("pty-oauth", oldOwner.api as never);
    router.bind("pty-oauth", newOwner.api as never);
    oldOwner.destroy();

    expect(kill).not.toHaveBeenCalled();
    expect(router.has("pty-oauth")).toBe(true);
  });

  it("ignores delayed exit and data events after an owner closes the PTY", () => {
    const manager = new PtyManager();
    const router = new PtySubscriberRouter(manager);
    const owner = fakeWebContents();

    router.bind("pty-oauth", owner.api as never);
    router.close("pty-oauth", owner.api as never);
    manager.emit("exit", { ptyId: "pty-oauth", exitCode: 0 });
    manager.emit("data", { ptyId: "pty-oauth", data: "late output" });

    expect(router.has("pty-oauth")).toBe(false);
    expect(owner.api.send).not.toHaveBeenCalled();
  });
});
