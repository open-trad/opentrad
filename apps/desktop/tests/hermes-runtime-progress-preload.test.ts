import { type HermesRuntimeInstallProgress, IpcChannels } from "@opentrad/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock("electron", () => electron);

beforeEach(() => {
  vi.resetModules();
  electron.ipcRenderer.on.mockReset();
  electron.ipcRenderer.removeListener.mockReset();
  (globalThis as { window?: unknown }).window = {};
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("Hermes runtime progress preload API", () => {
  it("subscribes on the fixed channel, forwards progress, and returns an unsubscribe", async () => {
    await import("../src/preload");
    const exposed = (globalThis as { window: Window }).window.api;
    const handler = vi.fn<(progress: HermesRuntimeInstallProgress) => void>();

    const unsubscribe = exposed.installer.onHermesRuntimeInstallProgress(handler);

    expect(electron.ipcRenderer.on).toHaveBeenCalledTimes(1);
    const [channel, listener] = electron.ipcRenderer.on.mock.calls[0] as [
      string,
      (event: unknown, progress: HermesRuntimeInstallProgress) => void,
    ];
    expect(channel).toBe(IpcChannels.HermesRuntimeInstallProgress);

    listener({}, { phase: "installing" });
    expect(handler).toHaveBeenCalledWith({ phase: "installing" });

    unsubscribe();
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(
      IpcChannels.HermesRuntimeInstallProgress,
      listener,
    );
  });
});
