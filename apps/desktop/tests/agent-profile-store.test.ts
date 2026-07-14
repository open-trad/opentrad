import type { ProviderProfile } from "@opentrad/model-providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type AgentStoreModule = typeof import("../src/renderer/stores/agent");

const saveProfile = vi.fn(async () => PROFILE);
const listProfiles = vi.fn(async () => [PROFILE]);
const deleteProfile = vi.fn(async () => {});

let module: AgentStoreModule;

beforeEach(async () => {
  vi.resetModules();
  saveProfile.mockClear();
  listProfiles.mockClear();
  deleteProfile.mockClear();
  (globalThis as { window?: unknown }).window = {
    api: {
      installer: { onHermesRuntimeInstallProgress: vi.fn(() => vi.fn()) },
      agent: {
        onEvent: vi.fn(() => vi.fn()),
        saveProfile,
        listProfiles,
        deleteProfile,
      },
    },
  };
  module = await import("../src/renderer/stores/agent");
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("AgentStore Profile mutation", () => {
  it("does not split an API key rotation into a credential IPC and a Profile IPC", async () => {
    await module.useAgentStore.getState().saveProfile(PROFILE, "test-only-secret");

    expect(saveProfile).toHaveBeenCalledWith(PROFILE, {
      ref: "apikey:profile-1",
      secret: "test-only-secret",
    });
    expect(listProfiles).toHaveBeenCalledOnce();
  });

  it("lets main delete the Profile and its credential in one mutation", async () => {
    await module.useAgentStore.getState().loadProfiles();

    await module.useAgentStore.getState().deleteProfile(PROFILE.id);

    expect(deleteProfile).toHaveBeenCalledWith({ id: PROFILE.id });
  });
});

const PROFILE: ProviderProfile = {
  id: "profile-1",
  displayName: "DeepSeek",
  kind: "openai-compatible",
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
  credentialRef: "apikey:profile-1",
  pricing: null,
  hermes: {
    providerSlug: "deepseek",
    authMode: "api_key",
    apiMode: "chat_completions",
    executionBackend: "local",
  },
};
