import { IpcChannels } from "@opentrad/shared";
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

beforeEach(async () => {
  vi.resetModules();
  electron.ipcRenderer.invoke.mockReset();
  (globalThis as { window?: unknown }).window = {};
  await import("../src/preload");
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("agent Profile preload API", () => {
  it("sends Profile metadata and its write-only credential through one IPC invoke", async () => {
    const profile = {
      id: "profile-1",
      displayName: "DeepSeek",
      kind: "openai-compatible" as const,
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      credentialRef: "apikey:profile-1",
      pricing: null,
      hermes: {
        providerSlug: "deepseek",
        authMode: "api_key" as const,
        apiMode: "chat_completions" as const,
        executionBackend: "local" as const,
      },
    };
    const credential = { ref: "apikey:profile-1", secret: "test-only-secret" };

    await (globalThis as { window: Window }).window.api.agent.saveProfile(profile, credential);

    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.AgentProfilesSave, {
      profile,
      credential,
    });
    expect("setCredential" in (globalThis as { window: Window }).window.api.agent).toBe(false);
    expect("deleteCredential" in (globalThis as { window: Window }).window.api.agent).toBe(false);
  });
});
