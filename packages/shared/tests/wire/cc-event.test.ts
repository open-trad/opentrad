// Wire 层 schema 测试：用 2026-04-24 实测的 CC 2.1.119 真实事件做正向 parse。
// 所有 wire schema 都带 .passthrough()，额外字段不应导致 parse 失败。

import { describe, expect, it } from "vitest";
import {
  WireAssistantEventSchema,
  WireCCEventSchema,
  WireContentBlockSchema,
  WireRateLimitEventSchema,
  WireResultEventSchema,
  WireSystemInitEventSchema,
} from "../../src";

describe("WireSystemInitEvent", () => {
  it("parses real CC 2.1.119 system/init event", () => {
    const raw = {
      type: "system",
      subtype: "init",
      cwd: "/Users/a1-6/Desktop/open-trad/opentrad",
      session_id: "d6da8bce-4c4b-4abc-8bc5-3b5b129b6852",
      tools: ["mcp__claude_ai_Gmail__create_draft"],
      mcp_servers: [{ name: "claude.ai Gmail", status: "connected" }],
      model: "claude-haiku-4-5-20251001",
      permissionMode: "default",
      slash_commands: ["update-config"],
      apiKeySource: "none",
      claude_code_version: "2.1.119",
      output_style: "default",
      agents: ["Explore"],
      skills: ["update-config"],
      plugins: [],
      analytics_disabled: false,
      uuid: "3142b74e-45c6-4984-bc89-57a34d6d058b",
      memory_paths: { auto: "/some/path" },
      fast_mode_state: "off",
    };
    expect(WireSystemInitEventSchema.safeParse(raw).success).toBe(true);
  });

  it("accepts minimum fields (optional ones omitted)", () => {
    const raw = {
      type: "system",
      subtype: "init",
      cwd: "/tmp",
      session_id: "s",
      tools: [],
      mcp_servers: [],
      model: "x",
      permissionMode: "default",
      apiKeySource: "subscription",
      claude_code_version: "2.1.119",
      uuid: "u",
    };
    expect(WireSystemInitEventSchema.safeParse(raw).success).toBe(true);
  });

  it("passthrough swallows future unknown fields", () => {
    const raw = {
      type: "system",
      subtype: "init",
      cwd: "/tmp",
      session_id: "s",
      tools: [],
      mcp_servers: [],
      model: "x",
      permissionMode: "default",
      apiKeySource: "subscription",
      claude_code_version: "2.1.119",
      uuid: "u",
      future_field_from_cc_2_2: { foo: "bar" },
    };
    expect(WireSystemInitEventSchema.safeParse(raw).success).toBe(true);
  });
});

describe("WireContentBlock", () => {
  it("parses text block", () => {
    expect(WireContentBlockSchema.safeParse({ type: "text", text: "hi" }).success).toBe(true);
  });

  it("parses thinking block with signature", () => {
    expect(
      WireContentBlockSchema.safeParse({
        type: "thinking",
        thinking: "...",
        signature: "abc",
      }).success,
    ).toBe(true);
  });

  it("parses tool_use block", () => {
    expect(
      WireContentBlockSchema.safeParse({
        type: "tool_use",
        id: "tu_1",
        name: "Read",
        input: { path: "/tmp" },
      }).success,
    ).toBe(true);
  });

  it("parses tool_result block with optional is_error", () => {
    expect(
      WireContentBlockSchema.safeParse({
        type: "tool_result",
        tool_use_id: "tu_1",
        content: "ok",
      }).success,
    ).toBe(true);
  });
});

describe("WireAssistantEvent", () => {
  it("parses real CC 2.1.119 assistant event with thinking block", () => {
    const raw = {
      type: "assistant",
      message: {
        model: "claude-haiku-4-5-20251001",
        id: "msg_01WyPgYLPzfUsMLga4Y9z2zK",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "用户要求我用中文回答 OK",
            signature: "Eo4DCmMIDRgCKkC...",
          },
        ],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 4780,
          cache_read_input_tokens: 5919,
          output_tokens: 1,
        },
        context_management: null,
      },
      parent_tool_use_id: null,
      session_id: "d6da8bce",
      uuid: "3dbddda6",
    };
    expect(WireAssistantEventSchema.safeParse(raw).success).toBe(true);
  });

  it("parses real CC 2.1.119 assistant event with text block", () => {
    const raw = {
      type: "assistant",
      message: {
        model: "claude-haiku-4-5-20251001",
        id: "msg_01WyPgYLPzfUsMLga4Y9z2zK",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "好的。" }],
        usage: { input_tokens: 10, output_tokens: 1 },
      },
      session_id: "s",
      uuid: "u",
    };
    expect(WireAssistantEventSchema.safeParse(raw).success).toBe(true);
  });

  it("parses assistant event with multiple content blocks", () => {
    const raw = {
      type: "assistant",
      message: {
        model: "claude-opus-4-7",
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "...", signature: "s" },
          { type: "text", text: "here you go" },
          { type: "tool_use", id: "tu_1", name: "x", input: {} },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      session_id: "s",
      uuid: "u",
    };
    expect(WireAssistantEventSchema.safeParse(raw).success).toBe(true);
  });
});

describe("WireRateLimitEvent", () => {
  it("parses real CC 2.1.119 rate_limit_event", () => {
    const raw = {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        resetsAt: 1777048200,
        rateLimitType: "five_hour",
        overageStatus: "rejected",
        overageDisabledReason: "out_of_credits",
        isUsingOverage: false,
      },
      uuid: "377af7fc",
      session_id: "d6da8bce",
    };
    expect(WireRateLimitEventSchema.safeParse(raw).success).toBe(true);
  });
});

describe("WireResultEvent", () => {
  it("parses real CC 2.1.119 result event", () => {
    const raw = {
      type: "result",
      subtype: "success",
      is_error: false,
      api_error_status: null,
      duration_ms: 2318,
      duration_api_ms: 3419,
      num_turns: 1,
      result: "好的。",
      stop_reason: "end_turn",
      session_id: "d6da8bce",
      total_cost_usd: 0.0074389,
      usage: { input_tokens: 10, output_tokens: 92 },
      modelUsage: {
        "claude-haiku-4-5-20251001": {
          inputTokens: 352,
          outputTokens: 104,
          costUSD: 0.0074389,
        },
      },
      permission_denials: [],
      terminal_reason: "completed",
      fast_mode_state: "off",
      uuid: "81a4121f",
    };
    expect(WireResultEventSchema.safeParse(raw).success).toBe(true);
  });
});

describe("WireCCEvent union", () => {
  it("discriminates by top-level type", () => {
    const system = {
      type: "system",
      subtype: "init",
      cwd: "/tmp",
      session_id: "s",
      tools: [],
      mcp_servers: [],
      model: "x",
      permissionMode: "default",
      apiKeySource: "none",
      claude_code_version: "2.1.119",
      uuid: "u",
    };
    const parsed = WireCCEventSchema.parse(system);
    expect(parsed.type).toBe("system");
  });

  it("rejects unknown top-level type (caller handles via unknown fallback)", () => {
    expect(WireCCEventSchema.safeParse({ type: "future_event_type", foo: "bar" }).success).toBe(
      false,
    );
  });
});
