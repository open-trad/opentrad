import { describe, expect, it } from "vitest";
import {
  AssistantTextEventSchema,
  AssistantThinkingEventSchema,
  AssistantToolUseEventSchema,
  CCEventSchema,
  McpServerInfoSchema,
  MessageMetaSchema,
  RateLimitEventSchema,
  ResultEventSchema,
  SystemEventSchema,
  ToolResultEventSchema,
  UnknownEventSchema,
} from "../src";

describe("Domain SystemEvent", () => {
  it("parses a valid system/init event", () => {
    const raw = {
      type: "system",
      subtype: "init",
      data: {
        cwd: "/tmp",
        sessionId: "abc",
        tools: ["Read"],
        mcpServers: [{ name: "x", status: "connected" }],
        model: "claude-haiku-4-5-20251001",
        permissionMode: "default",
        apiKeySource: "subscription",
        claudeCodeVersion: "2.1.119",
        uuid: "u1",
      },
    };
    expect(SystemEventSchema.safeParse(raw).success).toBe(true);
  });

  it("accepts apiKeySource=none (not logged in)", () => {
    const raw = {
      type: "system",
      subtype: "init",
      data: {
        cwd: "/tmp",
        sessionId: "abc",
        tools: [],
        mcpServers: [],
        model: "x",
        permissionMode: "default",
        apiKeySource: "none",
        claudeCodeVersion: "2.1.119",
        uuid: "u1",
      },
    };
    expect(SystemEventSchema.safeParse(raw).success).toBe(true);
  });

  it("rejects invalid apiKeySource", () => {
    const raw = {
      type: "system",
      subtype: "init",
      data: {
        cwd: "/tmp",
        sessionId: "abc",
        tools: [],
        mcpServers: [],
        model: "x",
        permissionMode: "default",
        apiKeySource: "invalid",
        claudeCodeVersion: "x",
        uuid: "u1",
      },
    };
    expect(SystemEventSchema.safeParse(raw).success).toBe(false);
  });
});

describe("Domain AssistantTextEvent", () => {
  it("parses intermediate text block (isLast=false, no messageMeta)", () => {
    const raw = {
      type: "assistant_text",
      msgId: "msg_1",
      seq: 0,
      sessionId: "s",
      uuid: "u",
      isLast: false,
      text: "你好",
    };
    expect(AssistantTextEventSchema.safeParse(raw).success).toBe(true);
  });

  it("parses last text block carrying messageMeta", () => {
    const raw = {
      type: "assistant_text",
      msgId: "msg_1",
      seq: 1,
      sessionId: "s",
      uuid: "u",
      isLast: true,
      text: "好的。",
      messageMeta: {
        model: "claude-haiku-4-5-20251001",
        usage: { inputTokens: 10, outputTokens: 1 },
        stopReason: "end_turn",
      },
    };
    expect(AssistantTextEventSchema.safeParse(raw).success).toBe(true);
  });
});

describe("Domain AssistantThinkingEvent", () => {
  it("requires signature (Anthropic API protocol)", () => {
    const raw = {
      type: "assistant_thinking",
      msgId: "msg_1",
      seq: 0,
      sessionId: "s",
      uuid: "u",
      isLast: false,
      thinking: "用户要求...",
      signature: "Eo4D...",
    };
    expect(AssistantThinkingEventSchema.safeParse(raw).success).toBe(true);
  });

  it("rejects thinking block without signature", () => {
    const raw = {
      type: "assistant_thinking",
      msgId: "msg_1",
      seq: 0,
      sessionId: "s",
      uuid: "u",
      isLast: false,
      thinking: "...",
    };
    expect(AssistantThinkingEventSchema.safeParse(raw).success).toBe(false);
  });
});

describe("Domain AssistantToolUseEvent", () => {
  it("parses tool_use with arbitrary input", () => {
    const raw = {
      type: "assistant_tool_use",
      msgId: "msg_1",
      seq: 2,
      sessionId: "s",
      uuid: "u",
      isLast: true,
      toolUseId: "tu_1",
      name: "browser_open",
      input: { url: "https://1688.com" },
      messageMeta: {
        model: "claude-opus-4-7",
        usage: { inputTokens: 100, outputTokens: 50 },
      },
    };
    expect(AssistantToolUseEventSchema.safeParse(raw).success).toBe(true);
  });
});

describe("Domain ToolResultEvent", () => {
  it("parses tool_result with content and isError", () => {
    const raw = {
      type: "tool_result",
      msgId: "msg_2",
      seq: 0,
      sessionId: "s",
      uuid: "u",
      toolUseId: "tu_1",
      content: [{ type: "text", text: "page loaded" }],
      isError: false,
    };
    expect(ToolResultEventSchema.safeParse(raw).success).toBe(true);
  });
});

describe("Domain ResultEvent", () => {
  it("parses a valid success result", () => {
    const raw = {
      type: "result",
      subtype: "success",
      sessionId: "abc",
      data: {
        durationMs: 2318,
        numTurns: 1,
        result: "好的。",
        totalCostUsd: 0.0074389,
        isError: false,
        uuid: "u",
      },
    };
    expect(ResultEventSchema.safeParse(raw).success).toBe(true);
  });
});

describe("Domain RateLimitEvent", () => {
  it("parses typical rate_limit_event", () => {
    const raw = {
      type: "rate_limit_event",
      sessionId: "s",
      uuid: "u",
      rateLimitInfo: {
        status: "allowed",
        resetsAt: 1777048200,
        rateLimitType: "five_hour",
        overageStatus: "rejected",
        overageDisabledReason: "out_of_credits",
        isUsingOverage: false,
      },
    };
    expect(RateLimitEventSchema.safeParse(raw).success).toBe(true);
  });
});

describe("Domain UnknownEvent", () => {
  it("accepts arbitrary raw payload (fallback for unknown wire events)", () => {
    expect(UnknownEventSchema.safeParse({ type: "unknown", raw: "non-JSON line" }).success).toBe(
      true,
    );
    expect(
      UnknownEventSchema.safeParse({
        type: "unknown",
        raw: { type: "future_event_type" },
      }).success,
    ).toBe(true);
  });
});

describe("Domain CCEvent discriminated union", () => {
  it("discriminates by type field", () => {
    const system = {
      type: "system",
      subtype: "init",
      data: {
        cwd: "/tmp",
        sessionId: "abc",
        tools: [],
        mcpServers: [],
        model: "x",
        permissionMode: "default",
        apiKeySource: "none",
        claudeCodeVersion: "2.1.119",
        uuid: "u",
      },
    };
    const parsed = CCEventSchema.parse(system);
    expect(parsed.type).toBe("system");
  });

  it("rejects event with missing type discriminator", () => {
    expect(CCEventSchema.safeParse({ text: "foo" }).success).toBe(false);
  });
});

describe("MessageMeta schema", () => {
  it("accepts minimum fields (model + usage only)", () => {
    expect(
      MessageMetaSchema.safeParse({
        model: "claude-haiku-4-5-20251001",
        usage: { inputTokens: 10, outputTokens: 1 },
      }).success,
    ).toBe(true);
  });

  it("accepts null stopReason", () => {
    expect(
      MessageMetaSchema.safeParse({
        model: "x",
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: null,
      }).success,
    ).toBe(true);
  });
});

describe("McpServerInfo (domain, strict)", () => {
  it("accepts name only", () => {
    expect(McpServerInfoSchema.safeParse({ name: "opentrad" }).success).toBe(true);
  });

  it("accepts name + status", () => {
    expect(McpServerInfoSchema.safeParse({ name: "x", status: "needs-auth" }).success).toBe(true);
  });
});
