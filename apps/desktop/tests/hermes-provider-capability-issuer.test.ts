import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createHermesProviderCapabilityIssuer,
  HermesProviderCapabilityError,
  type HermesProviderProfileSecrets,
} from "../src/main/services/hermes/provider-capability-issuer";
import type { HermesSidecarBinding } from "../src/main/services/hermes/sidecar-manager";

const deepSeekBinding: HermesSidecarBinding = {
  taskId: "task-123",
  runId: "run-456",
  profileId: "profile-deepseek",
  providerSlug: "deepseek",
  authMode: "api_key",
  model: "deepseek-chat",
  apiMode: "chat_completions",
  executionBackend: "local",
};

const chatGptBinding: HermesSidecarBinding = {
  taskId: "task-789",
  runId: "run-012",
  profileId: "profile-chatgpt",
  providerSlug: "openai-codex",
  authMode: "oauth",
  model: "gpt-5.2-codex",
  apiMode: "codex_responses",
  executionBackend: "local",
};

describe("createHermesProviderCapabilityIssuer", () => {
  it("writes one exact native DeepSeek profile bootstrap payload to FD3", async () => {
    const profileSecrets = {
      apiKey: "sk-deepseek-test-key",
      baseUrl: "https://api.deepseek.com/v1",
    } satisfies HermesProviderProfileSecrets;
    const acquireProfileSecrets = vi.fn(async (binding: HermesSidecarBinding) => {
      expect(binding).toEqual(deepSeekBinding);
      expect(Object.isFrozen(binding)).toBe(true);
      return profileSecrets;
    });
    const issuer = createHermesProviderCapabilityIssuer({ acquireProfileSecrets });

    const lease = await issuer(deepSeekBinding);
    const output = new CapturingWritable();
    await lease.transmit(output);

    expect(acquireProfileSecrets).toHaveBeenCalledOnce();
    expect(Object.keys(lease).sort()).toEqual(["revoke", "transmit"]);
    expect(JSON.stringify(lease)).toBe("{}");
    expect(JSON.parse(output.copy.toString("utf8"))).toEqual({
      v: 1,
      profileId: "profile-deepseek",
      providerSlug: "deepseek",
      authMode: "api_key",
      apiMode: "chat_completions",
      executionBackend: "local",
      model: "deepseek-chat",
      apiKey: "sk-deepseek-test-key",
      baseUrl: "https://api.deepseek.com/v1",
    });
    expect(output.original?.every((byte) => byte === 0)).toBe(true);
  });

  it("writes an OAuth bootstrap without API key or base URL", async () => {
    const issuer = createHermesProviderCapabilityIssuer({
      acquireProfileSecrets: async () => ({ apiKey: null, baseUrl: null }),
    });

    const lease = await issuer(chatGptBinding);
    const output = new CapturingWritable();
    await lease.transmit(output);

    expect(JSON.parse(output.copy.toString("utf8"))).toEqual({
      v: 1,
      profileId: "profile-chatgpt",
      providerSlug: "openai-codex",
      authMode: "oauth",
      apiMode: "codex_responses",
      executionBackend: "local",
      model: "gpt-5.2-codex",
      apiKey: null,
      baseUrl: null,
    });
  });

  it("passes a validated custom endpoint through the native bootstrap", async () => {
    const customBinding = {
      ...deepSeekBinding,
      profileId: "profile-custom",
      providerSlug: "custom:profile-custom",
      executionBackend: "docker",
    } satisfies HermesSidecarBinding;
    const issuer = createHermesProviderCapabilityIssuer({
      acquireProfileSecrets: async () => ({
        apiKey: "custom-provider-key",
        baseUrl: "https://llm.example.test/v1",
      }),
    });

    const lease = await issuer(customBinding);
    const output = new CapturingWritable();
    await lease.transmit(output);

    expect(JSON.parse(output.copy.toString("utf8"))).toMatchObject({
      profileId: "profile-custom",
      providerSlug: "custom:profile-custom",
      executionBackend: "docker",
      apiKey: "custom-provider-key",
      baseUrl: "https://llm.example.test/v1",
    });
  });

  it.each([
    {
      name: "OAuth API key",
      binding: chatGptBinding,
      secrets: { apiKey: "must-not-cross-fd3", baseUrl: null },
    },
    {
      name: "OAuth base URL",
      binding: chatGptBinding,
      secrets: { apiKey: null, baseUrl: "https://oauth.example.test/v1" },
    },
    {
      name: "missing API key",
      binding: deepSeekBinding,
      secrets: { apiKey: null, baseUrl: "https://api.deepseek.com/v1" },
    },
    {
      name: "empty API key",
      binding: deepSeekBinding,
      secrets: { apiKey: "", baseUrl: "https://api.deepseek.com/v1" },
    },
    {
      name: "non-ASCII API key",
      binding: deepSeekBinding,
      secrets: { apiKey: "secret-密钥", baseUrl: "https://api.deepseek.com/v1" },
    },
    {
      name: "control character in API key",
      binding: deepSeekBinding,
      secrets: { apiKey: "secret\nkey", baseUrl: "https://api.deepseek.com/v1" },
    },
    {
      name: "oversized API key",
      binding: deepSeekBinding,
      secrets: { apiKey: "a".repeat(2_049), baseUrl: "https://api.deepseek.com/v1" },
    },
    {
      name: "malformed URL",
      binding: deepSeekBinding,
      secrets: { apiKey: "valid-key", baseUrl: "not a URL" },
    },
    {
      name: "non-HTTP URL",
      binding: deepSeekBinding,
      secrets: { apiKey: "valid-key", baseUrl: "file:///tmp/provider" },
    },
    {
      name: "URL with credentials",
      binding: deepSeekBinding,
      secrets: { apiKey: "valid-key", baseUrl: "https://user:pass@example.test/v1" },
    },
    {
      name: "missing custom URL",
      binding: { ...deepSeekBinding, providerSlug: "custom:profile-deepseek" },
      secrets: { apiKey: "valid-key", baseUrl: null },
    },
  ])("rejects $name with one sanitized error", async ({ binding, secrets }) => {
    const issuer = createHermesProviderCapabilityIssuer({
      acquireProfileSecrets: async () => secrets,
    });

    const error = await issuer(binding).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(HermesProviderCapabilityError);
    expect(String(error)).toBe(
      "HermesProviderCapabilityError: Hermes provider capability is unavailable",
    );
    if (secrets.apiKey) expect(String(error)).not.toContain(secrets.apiKey);
    if (secrets.baseUrl) expect(String(error)).not.toContain(secrets.baseUrl);
  });

  it("sanitizes secret source failures", async () => {
    const issuer = createHermesProviderCapabilityIssuer({
      acquireProfileSecrets: async () => {
        throw new Error("safe-storage-secret-canary");
      },
    });

    const error = await issuer(deepSeekBinding).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(HermesProviderCapabilityError);
    expect(String(error)).not.toContain("canary");
  });

  it("allows one transmission only and zeroes the payload after success", async () => {
    const lease = await createApiKeyIssuer()(deepSeekBinding);
    const first = new CapturingWritable();

    await lease.transmit(first);
    await expect(lease.transmit(new CapturingWritable())).rejects.toBeInstanceOf(
      HermesProviderCapabilityError,
    );

    expect(first.original?.every((byte) => byte === 0)).toBe(true);
    expect(JSON.stringify(lease)).not.toContain("api-key-canary");
  });

  it("revokes and zeroes before transmission", async () => {
    const lease = await createApiKeyIssuer()(deepSeekBinding);

    lease.revoke();
    lease.revoke();
    const error = await lease.transmit(new CapturingWritable()).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(HermesProviderCapabilityError);
    expect(String(error)).not.toContain("api-key-canary");
  });

  it("zeroes the payload when FD3 transmission fails", async () => {
    const lease = await createApiKeyIssuer()(deepSeekBinding);
    const output = new FailingWritable();

    await expect(lease.transmit(output)).rejects.toBeInstanceOf(HermesProviderCapabilityError);

    expect(output.original?.every((byte) => byte === 0)).toBe(true);
    await expect(lease.transmit(new CapturingWritable())).rejects.toBeInstanceOf(
      HermesProviderCapabilityError,
    );
  });

  it("destroys and rejects an in-flight FD3 write when synchronously revoked", async () => {
    const lease = await createApiKeyIssuer()(deepSeekBinding);
    const output = new StalledWritable();
    const transmitting = lease.transmit(output);
    await vi.waitFor(() => expect(output.original).toBeDefined());

    lease.revoke();
    const error = await transmitting.catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(HermesProviderCapabilityError);
    expect(output.destroyed).toBe(true);
    expect(output.original?.every((byte) => byte === 0)).toBe(true);
  });

  it("rejects a payload larger than the fixed FD3 budget and does not open a pipe", async () => {
    const binding = {
      ...deepSeekBinding,
      model: `model-${"m".repeat(121)}`,
    } satisfies HermesSidecarBinding;
    const issuer = createHermesProviderCapabilityIssuer({
      acquireProfileSecrets: async () => ({
        apiKey: "k".repeat(2_048),
        baseUrl: `https://example.test/${"p".repeat(1_900)}`,
      }),
    });

    const error = await issuer(binding).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(HermesProviderCapabilityError);
  });
});

function createApiKeyIssuer() {
  return createHermesProviderCapabilityIssuer({
    acquireProfileSecrets: async () => ({
      apiKey: "api-key-canary",
      baseUrl: "https://api.deepseek.com/v1",
    }),
  });
}

class CapturingWritable extends Writable {
  original: Buffer | undefined;
  copy = Buffer.alloc(0);

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error) => void) {
    this.original = chunk;
    this.copy = Buffer.from(chunk);
    callback();
  }
}

class StalledWritable extends Writable {
  original: Buffer | undefined;

  override _write(chunk: Buffer, _encoding: BufferEncoding, _callback: (error?: Error) => void) {
    this.original = chunk;
  }
}

class FailingWritable extends Writable {
  original: Buffer | undefined;

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error) => void) {
    this.original = chunk;
    callback(new Error("fd3-write-canary"));
  }
}
