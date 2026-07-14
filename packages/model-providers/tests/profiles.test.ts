import { describe, expect, it } from "vitest";
import { ProfileRegistry } from "../src/profiles";
import { ProviderProfileSchema, requiresHermesRelogin } from "../src/types";

describe("ProfileRegistry", () => {
  it("uses the same filesystem-safe identifier contract for profile ids and Hermes slugs", () => {
    const valid = ProviderProfileSchema.safeParse({
      id: "profile.alpha:1",
      displayName: "Profile",
      kind: "openai",
      model: "gpt-5.4",
      hermes: {
        providerSlug: "custom:provider.alpha-1",
        authMode: "api_key",
        apiMode: "chat_completions",
        executionBackend: "local",
      },
    });
    expect(valid.success).toBe(true);

    for (const unsafe of ["", ".hidden", "../escape", "provider/escape", "provider space"]) {
      expect(
        ProviderProfileSchema.safeParse({
          id: unsafe,
          displayName: "Profile",
          kind: "openai",
          model: "gpt-5.4",
        }).success,
      ).toBe(false);
      expect(
        ProviderProfileSchema.safeParse({
          id: "safe-profile",
          displayName: "Profile",
          kind: "openai",
          model: "gpt-5.4",
          hermes: {
            providerSlug: unsafe,
            authMode: "oauth",
            apiMode: "codex_responses",
            executionBackend: "local",
          },
        }).success,
      ).toBe(false);
    }
  });

  it("derives deterministic custom provider slugs that remain safe after prefixing", () => {
    const colonProfile = ProviderProfileSchema.parse({
      id: "Partner:North.America",
      displayName: "Partner endpoint",
      kind: "openai-compatible",
      baseUrl: "https://llm.example.test/v1",
      model: "partner-chat",
    });
    expect(colonProfile.hermes.providerSlug).toBe("custom:partner-north.america");

    const firstId = `A${"b".repeat(127)}`;
    const secondId = `A${"b".repeat(126)}c`;
    const parse = (id: string) =>
      ProviderProfileSchema.parse({
        id,
        displayName: "Long endpoint",
        kind: "openai-compatible",
        baseUrl: "https://llm.example.test/v1",
        model: "partner-chat",
      }).hermes.providerSlug;
    const first = parse(firstId);
    const second = parse(secondId);

    expect(first).toBe(parse(firstId));
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(128);
    expect(first).toMatch(/^custom:[A-Za-z0-9][A-Za-z0-9._-]*$/u);
    expect(() =>
      ProviderProfileSchema.parse({
        id: firstId,
        displayName: "Round trip",
        kind: "openai-compatible",
        baseUrl: "https://llm.example.test/v1",
        model: "partner-chat",
        hermes: {
          providerSlug: first,
          authMode: "api_key",
          apiMode: "chat_completions",
          executionBackend: "local",
        },
      }),
    ).not.toThrow();
  });
  it("注册并读取 profile", () => {
    const registry = new ProfileRegistry();
    registry.register({
      id: "deepseek-chat",
      displayName: "DeepSeek（选品）",
      kind: "openai-compatible",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      credentialRef: "provider.deepseek.apiKey",
      pricing: { inputPerMTokUsd: 0.27, outputPerMTokUsd: 1.1 },
    });
    expect(registry.get("deepseek-chat")?.kind).toBe("openai-compatible");
    expect(registry.list()).toHaveLength(1);
  });

  it("openai-compatible 缺 baseUrl 拒绝", () => {
    const registry = new ProfileRegistry();
    expect(() =>
      registry.register({
        id: "bad",
        displayName: "bad",
        kind: "openai-compatible",
        model: "x",
        credentialRef: "r",
      }),
    ).toThrow(/baseUrl/);
  });

  it("claude-subscription 无需凭证（复用 CLI 登录态）", () => {
    const registry = new ProfileRegistry();
    const profile = registry.register({
      id: "claude-sub",
      displayName: "Claude 订阅（实验）",
      kind: "claude-subscription",
      model: "claude-sonnet-5",
    });
    expect(profile.credentialRef).toBeUndefined();
    expect(profile.pricing).toBeNull();
  });

  it.each([
    [
      "Anthropic API key",
      { kind: "anthropic", model: "claude-sonnet-5" },
      {
        providerSlug: "anthropic",
        authMode: "api_key",
        apiMode: "chat_completions",
        executionBackend: "local",
      },
    ],
    [
      "OpenAI API key",
      { kind: "openai", model: "gpt-5.6" },
      {
        providerSlug: "openai-api",
        authMode: "api_key",
        apiMode: "codex_responses",
        executionBackend: "local",
      },
    ],
    [
      "DeepSeek legacy compatible endpoint",
      {
        kind: "openai-compatible",
        baseUrl: "https://api.deepseek.com/v1/",
        model: "deepseek-chat",
      },
      {
        providerSlug: "deepseek",
        authMode: "api_key",
        apiMode: "chat_completions",
        executionBackend: "local",
      },
    ],
    [
      "unknown compatible endpoint",
      {
        kind: "openai-compatible",
        baseUrl: "https://llm.example.test/v1",
        model: "example-chat",
      },
      {
        providerSlug: "custom:legacy-profile",
        authMode: "api_key",
        apiMode: "chat_completions",
        executionBackend: "local",
      },
    ],
  ] as const)("旧 profile 自动归一化 Hermes 元数据：%s", (_label, legacy, expectedHermes) => {
    const profile = ProviderProfileSchema.parse({
      id: "legacy-profile",
      displayName: "Legacy",
      credentialRef: "apikey:legacy-profile",
      pricing: null,
      ...legacy,
    });

    expect(profile.hermes).toEqual(expectedHermes);
    expect(Object.keys(profile.hermes).sort()).toEqual([
      "apiMode",
      "authMode",
      "executionBackend",
      "providerSlug",
    ]);
  });

  it("显式 Hermes 元数据通过严格校验且不被旧 kind 覆盖", () => {
    const profile = ProviderProfileSchema.parse({
      id: "chatgpt-subscription",
      displayName: "ChatGPT",
      kind: "openai",
      model: "gpt-5.6",
      pricing: null,
      hermes: {
        providerSlug: "openai-codex",
        authMode: "oauth",
        apiMode: "codex_responses",
        executionBackend: "docker",
      },
    });

    expect(profile.hermes).toEqual({
      providerSlug: "openai-codex",
      authMode: "oauth",
      apiMode: "codex_responses",
      executionBackend: "docker",
    });
    expect(() =>
      ProviderProfileSchema.parse({
        ...profile,
        hermes: { ...profile.hermes, token: "must-not-be-part-of-profile" },
      }),
    ).toThrow();
  });

  it("旧 claude-subscription 归一化为 Anthropic OAuth，并明确要求 Hermes 重新登录", () => {
    const profile = ProviderProfileSchema.parse({
      id: "claude-sub",
      displayName: "Claude 订阅（旧）",
      kind: "claude-subscription",
      model: "claude-sonnet-5",
    });

    expect(profile.hermes).toEqual({
      providerSlug: "anthropic",
      authMode: "oauth",
      apiMode: "chat_completions",
      executionBackend: "local",
    });
    expect(requiresHermesRelogin(profile)).toBe(true);

    const nativeOAuth = ProviderProfileSchema.parse({
      ...profile,
      kind: "anthropic",
    });
    expect(requiresHermesRelogin(nativeOAuth)).toBe(false);
  });
});
