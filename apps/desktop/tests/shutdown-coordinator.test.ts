import { describe, expect, it, vi } from "vitest";
import { createShutdownCoordinator } from "../src/main/services/shutdown-coordinator";

describe("desktop shutdown coordinator", () => {
  it("marks the app as quitting before cleanup can run", async () => {
    let releaseCleanup!: () => void;
    const cleanupBlocked = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const exit = vi.fn();
    const coordinator = createShutdownCoordinator({
      cleanup: () => cleanupBlocked,
      exit,
    });

    expect(coordinator.canCreateMainWindow()).toBe(true);

    const shutdown = coordinator.requestShutdown("window-close");

    expect(coordinator.isQuitting).toBe(true);
    expect(coordinator.canCreateMainWindow()).toBe(false);
    expect(exit).not.toHaveBeenCalled();

    releaseCleanup();
    await shutdown;
  });

  it("coalesces concurrent triggers into one ordered cleanup and exit", async () => {
    const events: string[] = [];
    const coordinator = createShutdownCoordinator({
      cleanup: async () => {
        events.push("cleanup");
      },
      exit: (code) => {
        events.push(`exit:${code}`);
      },
    });

    const fromWindow = coordinator.requestShutdown("window-close");
    const fromBeforeQuit = coordinator.requestShutdown("before-quit");
    const fromSignal = coordinator.requestShutdown("SIGTERM");

    expect(fromBeforeQuit).toBe(fromWindow);
    expect(fromSignal).toBe(fromWindow);
    await Promise.all([fromWindow, fromBeforeQuit, fromSignal]);

    expect(events).toEqual(["cleanup", "exit:0"]);
  });

  it("still exits with code zero when cleanup fails", async () => {
    const cleanupError = new Error("cleanup failed");
    const exit = vi.fn();
    const onCleanupError = vi.fn();
    const coordinator = createShutdownCoordinator({
      cleanup: async () => {
        throw cleanupError;
      },
      exit,
      onCleanupError,
    });

    await coordinator.requestShutdown("SIGINT");

    expect(onCleanupError).toHaveBeenCalledWith(cleanupError, "SIGINT");
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });
});
