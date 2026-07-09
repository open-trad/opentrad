import { describe, expect, it } from "vitest";
import { ProfileRegistry } from "../src/profiles";

describe("ProfileRegistry", () => {
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
});
