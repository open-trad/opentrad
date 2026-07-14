import type { ProviderProfile } from "@opentrad/model-providers";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HermesExecutionBackendNotice } from "../src/renderer/features/agent/AgentChatPanel";

function profile(executionBackend: "local" | "docker"): ProviderProfile {
  return {
    id: `profile-${executionBackend}`,
    displayName: executionBackend,
    kind: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    credentialRef: `apikey:${executionBackend}`,
    pricing: null,
    hermes: {
      providerSlug: "deepseek",
      authMode: "api_key",
      apiMode: "chat_completions",
      executionBackend,
    },
  };
}

describe("HermesExecutionBackendNotice", () => {
  it("warns that local mode has the current macOS user's permissions", () => {
    const html = renderToStaticMarkup(
      createElement(HermesExecutionBackendNotice, { profile: profile("local") }),
    );

    expect(html).toContain("当前 macOS 用户相同权限");
    expect(html).toContain("手动审批");
    expect(html).toContain("受信代码");
  });

  it("shows the selected Docker workspace mount and lazy container state", () => {
    const html = renderToStaticMarkup(
      createElement(HermesExecutionBackendNotice, {
        profile: profile("docker"),
        workspaceRoot: "/Users/test/trade-workspace",
      }),
    );

    expect(html).toContain("Docker");
    expect(html).toContain("按需启动");
    expect(html).toContain("/Users/test/trade-workspace");
    expect(html).toContain("/workspace");
    expect(html).toContain("受信代码");
  });
});
