import type { CredentialStore } from "@opentrad/model-providers";
import { describe, expect, it, vi } from "vitest";
import {
  createHermesProfileSecretSource,
  HermesProfileSecretSourceError,
} from "../src/main/services/hermes/profile-secret-source";
import type { HermesSidecarBinding } from "../src/main/services/hermes/sidecar-manager";

describe("Hermes Profile secret source", () => {
  it("migrates a persisted DeepSeek Profile and reads its safeStorage reference once", async () => {
    const credentials = fakeCredentials("deepseek-secret");
    const source = createHermesProfileSecretSource({
      listProfiles: () => [deepSeekProfile()],
      credentials: credentials.store,
    });

    await expect(source(binding())).resolves.toEqual({
      apiKey: "deepseek-secret",
      baseUrl: "https://api.deepseek.com/v1",
    });
    expect(credentials.get).toHaveBeenCalledWith("apikey:deepseek");
    expect(credentials.get).toHaveBeenCalledTimes(1);
  });

  it("never reads OAuth tokens and returns an empty FD3 secret payload", async () => {
    const credentials = fakeCredentials("must-not-be-read");
    const source = createHermesProfileSecretSource({
      listProfiles: () => [
        {
          id: "chatgpt",
          displayName: "ChatGPT",
          kind: "openai",
          model: "gpt-5",
          pricing: null,
          hermes: {
            providerSlug: "openai-codex",
            authMode: "oauth",
            apiMode: "codex_responses",
            executionBackend: "local",
          },
        },
      ],
      credentials: credentials.store,
    });

    await expect(
      source(
        binding({
          profileId: "chatgpt",
          providerSlug: "openai-codex",
          authMode: "oauth",
          apiMode: "codex_responses",
          model: "gpt-5",
        }),
      ),
    ).resolves.toEqual({ apiKey: null, baseUrl: null });
    expect(credentials.get).not.toHaveBeenCalled();
  });

  it("fails closed on stale bindings, missing keys, and corrupt profiles without reflection", async () => {
    const credentials = fakeCredentials(null);
    const source = createHermesProfileSecretSource({
      listProfiles: () => [{ id: "corrupt" }, deepSeekProfile()],
      credentials: credentials.store,
    });

    for (const value of [binding(), binding({ model: "secret-model-canary" })]) {
      const error = await source(value).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(HermesProfileSecretSourceError);
      expect(error).toMatchObject({ code: "HERMES_PROFILE_AUTH_UNAVAILABLE" });
      expect(JSON.stringify(error)).not.toContain("secret-model-canary");
    }
  });
});

function deepSeekProfile(): Record<string, unknown> {
  return {
    id: "deepseek",
    displayName: "DeepSeek",
    kind: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    credentialRef: "apikey:deepseek",
    pricing: null,
  };
}

function binding(overrides: Partial<HermesSidecarBinding> = {}): HermesSidecarBinding {
  return {
    taskId: "task-1",
    runId: "run-1",
    profileId: "deepseek",
    providerSlug: "deepseek",
    authMode: "api_key",
    model: "deepseek-chat",
    apiMode: "chat_completions",
    executionBackend: "local",
    ...overrides,
  };
}

function fakeCredentials(secret: string | null): {
  store: CredentialStore;
  get: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn(async () => secret);
  return {
    get,
    store: {
      get,
      set: async () => {},
      delete: async () => {},
    },
  };
}
