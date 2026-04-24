import { describe, expect, it } from "vitest";
import { AssistantContentSchema, CCEventSchema, McpServerInfoSchema } from "../src";

describe("CCEvent schema", () => {
  it("parses a valid system/init event", () => {
    const raw = {
      type: "system",
      subtype: "init",
      data: {
        sessionId: "abc-123",
        tools: ["Read", "Write"],
        mcpServers: [{ name: "opentrad" }],
        model: "claude-opus-4-7",
        permissionMode: "default",
        claudeCodeVersion: "2.1.119",
        apiKeySource: "subscription",
      },
    };
    const parsed = CCEventSchema.parse(raw);
    expect(parsed.type).toBe("system");
    if (parsed.type === "system") {
      expect(parsed.subtype).toBe("init");
      expect(parsed.data.sessionId).toBe("abc-123");
    }
  });

  it("parses an assistant text event", () => {
    const raw = { type: "assistant", content: { type: "text", text: "你好" } };
    expect(CCEventSchema.safeParse(raw).success).toBe(true);
  });

  it("parses an assistant thinking event", () => {
    const raw = {
      type: "assistant",
      content: { type: "thinking", thinking: "..." },
    };
    expect(CCEventSchema.safeParse(raw).success).toBe(true);
  });

  it("parses a tool_use event with arbitrary input", () => {
    const raw = {
      type: "tool_use",
      toolUseId: "t1",
      name: "Read",
      input: { path: "/etc/hosts" },
    };
    expect(CCEventSchema.safeParse(raw).success).toBe(true);
  });

  it("parses a result event (data fields passthrough)", () => {
    const raw = {
      type: "result",
      subtype: "success",
      data: { totalCostUsd: 0.01, durationMs: 1500 },
    };
    expect(CCEventSchema.safeParse(raw).success).toBe(true);
  });

  it("parses an unknown event (fallback variant for forward-compat)", () => {
    const raw = { type: "unknown", raw: "something weird" };
    expect(CCEventSchema.safeParse(raw).success).toBe(true);
  });

  it("rejects system/init with invalid apiKeySource", () => {
    const raw = {
      type: "system",
      subtype: "init",
      data: {
        sessionId: "abc",
        tools: [],
        mcpServers: [],
        model: "x",
        permissionMode: "y",
        claudeCodeVersion: "2.1.119",
        apiKeySource: "invalid_source",
      },
    };
    expect(CCEventSchema.safeParse(raw).success).toBe(false);
  });

  it("rejects event with missing type discriminator", () => {
    const raw = { content: { type: "text", text: "..." } };
    expect(CCEventSchema.safeParse(raw).success).toBe(false);
  });

  it("McpServerInfo allows unknown extra fields (passthrough)", () => {
    const raw = { name: "opentrad", status: "connected", extra: 42 };
    const parsed = McpServerInfoSchema.parse(raw);
    expect(parsed.name).toBe("opentrad");
  });
});

describe("AssistantContent schema", () => {
  it("distinguishes text vs thinking by discriminator", () => {
    expect(AssistantContentSchema.safeParse({ type: "text", text: "a" }).success).toBe(true);
    expect(AssistantContentSchema.safeParse({ type: "thinking", thinking: "b" }).success).toBe(
      true,
    );
    expect(AssistantContentSchema.safeParse({ type: "text" }).success).toBe(false);
  });
});
