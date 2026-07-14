import { IpcChannels } from "@opentrad/shared";
import { describe, expect, it, vi } from "vitest";
import { createHermesRuntimeInstallProgressBroadcaster } from "../src/main/services/hermes/runtime-install-progress";

function fakeWindow(options: { windowDestroyed?: boolean; contentsDestroyed?: boolean } = {}) {
  return {
    isDestroyed: vi.fn(() => options.windowDestroyed ?? false),
    webContents: {
      isDestroyed: vi.fn(() => options.contentsDestroyed ?? false),
      send: vi.fn(),
    },
  };
}

describe("Hermes runtime install progress broadcaster", () => {
  it("broadcasts the strict display-safe payload to every live BrowserWindow", () => {
    const first = fakeWindow();
    const second = fakeWindow();
    const broadcast = createHermesRuntimeInstallProgressBroadcaster(() => [first, second]);

    broadcast({ phase: "downloading", artifact: "hermes-wheel" });

    for (const win of [first, second]) {
      expect(win.webContents.send).toHaveBeenCalledWith(IpcChannels.HermesRuntimeInstallProgress, {
        phase: "downloading",
        artifact: "hermes-wheel",
      });
    }
  });

  it("skips destroyed windows and web contents", () => {
    const destroyedWindow = fakeWindow({ windowDestroyed: true });
    const destroyedContents = fakeWindow({ contentsDestroyed: true });
    const live = fakeWindow();
    const broadcast = createHermesRuntimeInstallProgressBroadcaster(() => [
      destroyedWindow,
      destroyedContents,
      live,
    ]);

    broadcast({ phase: "checking" });

    expect(destroyedWindow.webContents.send).not.toHaveBeenCalled();
    expect(destroyedContents.webContents.send).not.toHaveBeenCalled();
    expect(live.webContents.send).toHaveBeenCalledTimes(1);
  });

  it("contains per-window send failures and continues broadcasting", () => {
    const failed = fakeWindow();
    failed.webContents.send.mockImplementation(() => {
      throw new Error("renderer disappeared");
    });
    const live = fakeWindow();
    const broadcast = createHermesRuntimeInstallProgressBroadcaster(() => [failed, live]);

    expect(() => broadcast({ phase: "ready" })).not.toThrow();
    expect(live.webContents.send).toHaveBeenCalledWith(IpcChannels.HermesRuntimeInstallProgress, {
      phase: "ready",
    });
  });

  it("drops malformed progress without reflecting secret or URL fields", () => {
    const win = fakeWindow();
    const broadcast = createHermesRuntimeInstallProgressBroadcaster(() => [win]);

    broadcast({
      phase: "downloading",
      artifact: "hermes-wheel",
      secret: "never-cross-ipc",
      url: "https://example.invalid/private",
    });

    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});
