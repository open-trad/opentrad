// normalize 单元测试：wire → domain 映射的各种场景（系统、单块/多块 assistant、rate limit、result）。

import type { CCEvent, WireCCEvent } from "@opentrad/shared";
import { describe, expect, it } from "vitest";
import { normalizeWireEvent } from "../src";

function collect(wire: WireCCEvent): CCEvent[] {
  return Array.from(normalizeWireEvent(wire));
}

describe("normalize system/init", () => {
  it("maps snake_case wire fields to camelCase domain data", () => {
    const wire: WireCCEvent = {
      type: "system",
      subtype: "init",
      cwd: "/tmp",
      session_id: "sess_1",
      tools: ["Read"],
      mcp_servers: [{ name: "opentrad", status: "connected" }],
      model: "claude-haiku-4-5-20251001",
      permissionMode: "default",
      slash_commands: ["init"],
      apiKeySource: "subscription",
      claude_code_version: "2.1.119",
      uuid: "u_1",
    };
    const [evt] = collect(wire);
    expect(evt?.type).toBe("system");
    if (evt?.type === "system") {
      expect(evt.data.sessionId).toBe("sess_1");
      expect(evt.data.claudeCodeVersion).toBe("2.1.119");
      expect(evt.data.slashCommands).toEqual(["init"]);
      expect(evt.data.mcpServers[0]?.status).toBe("connected");
      expect(evt.data.apiKeySource).toBe("subscription");
    }
  });
});

describe("normalize assistant (1 → N flatten)", () => {
  function buildAssistant(content: unknown[]): WireCCEvent {
    return {
      type: "assistant",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-7",
        content: content as never,
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      session_id: "s",
      uuid: "u",
    };
  }

  it("single text block → one AssistantTextEvent with isLast=true + messageMeta", () => {
    const wire = buildAssistant([{ type: "text", text: "好的。" }]);
    const events = collect(wire);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e?.type).toBe("assistant_text");
    if (e?.type === "assistant_text") {
      expect(e.msgId).toBe("msg_1");
      expect(e.seq).toBe(0);
      expect(e.isLast).toBe(true);
      expect(e.messageMeta).toEqual({
        model: "claude-opus-4-7",
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "end_turn",
      });
    }
  });

  it("thinking + text → 2 events, meta only on last", () => {
    const wire = buildAssistant([
      { type: "thinking", thinking: "...", signature: "sig" },
      { type: "text", text: "好的。" },
    ]);
    const events = collect(wire);
    expect(events).toHaveLength(2);

    const first = events[0];
    expect(first?.type).toBe("assistant_thinking");
    if (first?.type === "assistant_thinking") {
      expect(first.isLast).toBe(false);
      expect(first.messageMeta).toBeUndefined();
      expect(first.signature).toBe("sig");
    }

    const last = events[1];
    expect(last?.type).toBe("assistant_text");
    if (last?.type === "assistant_text") {
      expect(last.isLast).toBe(true);
      expect(last.messageMeta?.model).toBe("claude-opus-4-7");
    }
  });

  it("thinking + text + tool_use → 3 events; all share msgId; seq 0/1/2; meta on last", () => {
    const wire = buildAssistant([
      { type: "thinking", thinking: "...", signature: "sig" },
      { type: "text", text: "running" },
      { type: "tool_use", id: "tu_1", name: "browser_open", input: { url: "x" } },
    ]);
    const events = collect(wire);
    expect(events).toHaveLength(3);
    expect(events.map((e) => (e as { msgId?: string }).msgId)).toEqual(["msg_1", "msg_1", "msg_1"]);
    expect(events.map((e) => (e as { seq?: number }).seq)).toEqual([0, 1, 2]);

    const last = events[2];
    if (last?.type === "assistant_tool_use") {
      expect(last.isLast).toBe(true);
      expect(last.toolUseId).toBe("tu_1");
      expect(last.messageMeta).toBeDefined();
    }
  });

  it("empty content array yields 0 events (defensive)", () => {
    const wire = buildAssistant([]);
    expect(collect(wire)).toHaveLength(0);
  });
});

describe("normalize rate_limit_event", () => {
  it("maps rate_limit_info to camelCase domain rateLimitInfo (wire inner is already camelCase)", () => {
    const wire: WireCCEvent = {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        resetsAt: 1777048200,
        rateLimitType: "five_hour",
        overageStatus: "rejected",
        overageDisabledReason: "out_of_credits",
        isUsingOverage: false,
      },
      uuid: "u",
      session_id: "s",
    };
    const [e] = collect(wire);
    expect(e?.type).toBe("rate_limit_event");
    if (e?.type === "rate_limit_event") {
      expect(e.sessionId).toBe("s");
      expect(e.rateLimitInfo.rateLimitType).toBe("five_hour");
      expect(e.rateLimitInfo.resetsAt).toBe(1777048200);
    }
  });
});

describe("normalize result", () => {
  it("maps snake_case wire fields to camelCase domain data", () => {
    const wire: WireCCEvent = {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 2318,
      duration_api_ms: 3419,
      num_turns: 1,
      result: "好的。",
      stop_reason: "end_turn",
      session_id: "s",
      total_cost_usd: 0.007,
      terminal_reason: "completed",
      fast_mode_state: "off",
      uuid: "u_result",
    };
    const [e] = collect(wire);
    expect(e?.type).toBe("result");
    if (e?.type === "result") {
      expect(e.sessionId).toBe("s");
      expect(e.data.durationMs).toBe(2318);
      expect(e.data.totalCostUsd).toBeCloseTo(0.007);
      expect(e.data.terminalReason).toBe("completed");
      expect(e.data.isError).toBe(false);
    }
  });
});
