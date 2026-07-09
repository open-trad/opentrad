// auth-login service 测试(M1 #22):命令拼装 + URL 提取。
// IPC handler 集成单测 desktop 不在 M1 #19 scope 之外,只测纯函数。

import { describe, expect, it } from "vitest";
import {
  extractClaudeAiUrl,
  getApiKeyLoginCommand,
  getClaudeAiLoginCommand,
} from "../src/main/services/auth-login";

describe("getClaudeAiLoginCommand", () => {
  it("默认 binary 'claude' + claudeai 模式参数", () => {
    expect(getClaudeAiLoginCommand()).toEqual({
      command: "claude",
      args: ["auth", "login", "--claudeai"],
    });
  });

  it("自定义 binary 路径透传", () => {
    expect(getClaudeAiLoginCommand("/opt/cc/claude")).toEqual({
      command: "/opt/cc/claude",
      args: ["auth", "login", "--claudeai"],
    });
  });
});

describe("getApiKeyLoginCommand", () => {
  it("apiKey 透传到 --apiKey 参数", () => {
    expect(getApiKeyLoginCommand("sk-ant-xxx")).toEqual({
      command: "claude",
      args: ["auth", "login", "--apiKey", "sk-ant-xxx"],
    });
  });

  it("空字符串 apiKey 抛错", () => {
    expect(() => getApiKeyLoginCommand("")).toThrow(/apiKey is required/);
    expect(() => getApiKeyLoginCommand("   ")).toThrow(/apiKey is required/);
  });
});

describe("extractClaudeAiUrl", () => {
  it("提取裸 URL", () => {
    const text = "Open this URL in your browser: https://claude.ai/oauth/authorize?token=abc123";
    expect(extractClaudeAiUrl(text)).toBe("https://claude.ai/oauth/authorize?token=abc123");
  });

  it("提取多行输出中的 URL", () => {
    const text = `Login required.

Visit https://claude.ai/oauth/...?state=xyz to authorize.

Waiting for response...`;
    expect(extractClaudeAiUrl(text)).toContain("https://claude.ai/oauth/");
  });

  it("无 URL 返回 undefined", () => {
    expect(extractClaudeAiUrl("Login complete")).toBeUndefined();
    expect(extractClaudeAiUrl("")).toBeUndefined();
  });

  it("多个 URL 取第一个", () => {
    const text = "Primary https://claude.ai/a?x=1 fallback https://claude.ai/b?y=2";
    expect(extractClaudeAiUrl(text)).toBe("https://claude.ai/a?x=1");
  });

  it("不匹配非 claude.ai 域名", () => {
    expect(extractClaudeAiUrl("https://anthropic.com/login")).toBeUndefined();
  });
});
