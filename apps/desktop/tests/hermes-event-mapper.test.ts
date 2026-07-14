import { AgentEventSchema } from "@opentrad/shared";
import { describe, expect, it } from "vitest";
import { createHermesEventMapper } from "../src/main/services/hermes/event-mapper";

const SESSION_ID = "canonical-session";

function createMapper(knownSecrets: readonly string[] = []) {
  return createHermesEventMapper({
    canonicalSessionId: SESSION_ID,
    profileId: "profile-1",
    model: "deepseek-chat",
    knownSecrets,
  });
}

describe("Hermes RuntimeEvent to AgentEvent mapping", () => {
  it("maps the pinned session.info payload once and flattens its tool groups", () => {
    const mapper = createMapper();

    const events = mapper.map({
      type: "session.info",
      payload: {
        model: "deepseek-chat",
        provider: "deepseek",
        tools: {
          core: ["terminal", "browser"],
          mcp: ["mcp:crm:lookup", "terminal"],
        },
      },
    });

    expect(events).toEqual([
      {
        type: "agent_session_start",
        sessionId: SESSION_ID,
        profileId: "profile-1",
        model: "deepseek-chat",
        tools: ["terminal", "browser", "mcp:crm:lookup"],
      },
    ]);
    expect(events.map((event) => AgentEventSchema.parse(event))).toEqual(events);
    expect(
      mapper.map({
        type: "session.info",
        payload: { model: "another-model", tools: { core: ["other"] } },
      }),
    ).toEqual([]);
  });

  it("maps message start, streamed deltas, and completion to one stable message id", () => {
    const mapper = createMapper();

    expect(mapper.map({ type: "message.start", payload: undefined })).toEqual([]);
    expect(mapper.map({ type: "message.delta", payload: { text: "hello " } })).toEqual([
      {
        type: "agent_text",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "hello ",
        done: false,
      },
    ]);
    expect(mapper.map({ type: "message.delta", payload: { text: "world" } })).toEqual([
      {
        type: "agent_text",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "world",
        done: false,
      },
    ]);
    expect(
      mapper.map({
        type: "message.complete",
        payload: { text: "hello world", status: "complete" },
      }),
    ).toEqual([
      {
        type: "agent_text",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "",
        done: true,
      },
    ]);
  });

  it("uses the complete payload when Hermes did not emit any message deltas", () => {
    const mapper = createMapper();

    expect(mapper.map({ type: "message.complete", payload: { text: "fast response" } })).toEqual([
      {
        type: "agent_text",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "fast response",
        done: false,
      },
      {
        type: "agent_text",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "",
        done: true,
      },
    ]);
  });

  it("maps the pinned reasoning notifications and closes thinking at message completion", () => {
    const mapper = createMapper();

    expect(mapper.map({ type: "message.start", payload: undefined })).toEqual([]);
    expect(mapper.map({ type: "reasoning.delta", payload: { text: "reason " } })).toEqual([
      {
        type: "agent_thinking",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "reason ",
        done: false,
      },
    ]);
    expect(mapper.map({ type: "thinking.delta", payload: { text: "think " } })).toEqual([
      {
        type: "agent_thinking",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "think ",
        done: false,
      },
    ]);
    expect(
      mapper.map({ type: "reasoning.available", payload: { text: "available", verbose: true } }),
    ).toEqual([
      {
        type: "agent_thinking",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "available",
        done: false,
      },
    ]);

    const completed = mapper.map({ type: "message.complete", payload: { text: "answer" } });
    expect(completed).toEqual([
      {
        type: "agent_thinking",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "",
        done: true,
      },
      {
        type: "agent_text",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "answer",
        done: false,
      },
      {
        type: "agent_text",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "",
        done: true,
      },
    ]);
    expect(completed.map((event) => AgentEventSchema.parse(event))).toEqual(completed);
  });

  it("uses message.complete reasoning when Hermes emitted no reasoning deltas", () => {
    const mapper = createMapper();

    expect(
      mapper.map({
        type: "message.complete",
        payload: { text: "answer", reasoning: "internal reasoning" },
      }),
    ).toEqual([
      {
        type: "agent_thinking",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "internal reasoning",
        done: false,
      },
      {
        type: "agent_thinking",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "",
        done: true,
      },
      {
        type: "agent_text",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "answer",
        done: false,
      },
      {
        type: "agent_text",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "",
        done: true,
      },
    ]);
  });

  it("maps the pinned tool.start and tool.complete payloads", () => {
    const mapper = createMapper();
    mapper.map({ type: "message.start", payload: undefined });

    const started = mapper.map({
      type: "tool.start",
      payload: {
        tool_id: "call-1",
        name: "terminal",
        context: "Run pwd",
        args_text: '{"command":"pwd"}',
      },
    });
    expect(started).toEqual([
      {
        type: "agent_tool_call",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        toolCallId: "call-1",
        toolName: "terminal",
        input: { command: "pwd" },
      },
    ]);

    const completed = mapper.map({
      type: "tool.complete",
      payload: {
        tool_id: "call-1",
        name: "terminal",
        args: { command: "pwd" },
        result: { stdout: "/tmp/project\n", exit_code: 0 },
        duration_s: 0.1,
      },
    });
    expect(completed).toEqual([
      {
        type: "agent_tool_result",
        sessionId: SESSION_ID,
        toolCallId: "call-1",
        toolName: "terminal",
        output: { stdout: "/tmp/project\n", exit_code: 0 },
      },
    ]);
    expect([...started, ...completed].map((event) => AgentEventSchema.parse(event))).toEqual([
      ...started,
      ...completed,
    ]);
  });

  it("maps message.complete usage from the pinned gateway shape", () => {
    const mapper = createMapper();
    mapper.map({ type: "message.start", payload: undefined });

    const events = mapper.map({
      type: "message.complete",
      payload: {
        text: "done",
        status: "complete",
        usage: {
          model: "deepseek-chat",
          input: 123,
          output: 45,
          reasoning: 7,
          prompt: 123,
          completion: 45,
          total: 175,
          calls: 1,
        },
      },
    });

    expect(events).toEqual([
      {
        type: "agent_text",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "done",
        done: false,
      },
      {
        type: "agent_text",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "",
        done: true,
      },
      {
        type: "agent_usage",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        usage: { inputTokens: 123, outputTokens: 45 },
        estimatedCostUsd: null,
      },
    ]);
    expect(events.map((event) => AgentEventSchema.parse(event))).toEqual(events);
  });

  it("preserves an error completion message after redacting known secrets", () => {
    const mapper = createMapper(["test-api-key-value"]);

    const events = mapper.map({
      type: "message.complete",
      payload: {
        status: "error",
        text: "API call failed after 3 retries: Connection error. test-api-key-value",
      },
    });

    expect(events).toEqual([
      {
        type: "agent_text",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "API call failed after 3 retries: Connection error. [REDACTED]",
        done: false,
      },
      {
        type: "agent_text",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "",
        done: true,
      },
    ]);
    expect(events.map((event) => AgentEventSchema.parse(event))).toEqual(events);
  });

  it("maps gateway errors without reflecting known secret literals", () => {
    const mapper = createMapper(["api-key-value"]);

    const events = mapper.map({
      type: "error",
      payload: { message: "provider rejected api-key-value", recoverable: false },
    });

    expect(events).toEqual([
      {
        type: "agent_error",
        sessionId: SESSION_ID,
        message: "provider rejected [REDACTED]",
        recoverable: false,
      },
    ]);
  });

  it("keeps the replacement marker fixed when another known secret is inside its text", () => {
    const mapper = createMapper(["long-secret", "REDACTED"]);

    expect(mapper.map({ type: "error", payload: { message: "failed: long-secret" } })).toEqual([
      {
        type: "agent_error",
        sessionId: SESSION_ID,
        message: "failed: [REDACTED]",
        recoverable: true,
      },
    ]);
  });

  it.each([
    "approval.request",
    "approval.respond",
    "sudo.request",
    "sudo.respond",
    "secret.request",
    "secret.respond",
    "status.update",
    "future.unknown",
  ])("ignores %s instead of turning control-plane data into chat history", (type) => {
    const mapper = createMapper(["must-not-leak"]);

    expect(
      mapper.map({
        type,
        payload: {
          request_id: "request-1",
          command: "echo must-not-leak",
          password: "must-not-leak",
          value: "must-not-leak",
        },
      }),
    ).toEqual([]);
  });

  it("redacts known secret literals split across message and thinking deltas", () => {
    const mapper = createMapper(["sk-live-secret"]);
    mapper.map({ type: "message.start", payload: undefined });

    expect(mapper.map({ type: "message.delta", payload: { text: "before sk-live-" } })).toEqual([
      {
        type: "agent_text",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "before ",
        done: false,
      },
    ]);
    expect(mapper.map({ type: "message.delta", payload: { text: "secret after" } })).toEqual([
      {
        type: "agent_text",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "[REDACTED] after",
        done: false,
      },
    ]);
    expect(mapper.map({ type: "reasoning.delta", payload: { text: "why sk-live-" } })).toEqual([
      {
        type: "agent_thinking",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "why ",
        done: false,
      },
    ]);
    expect(mapper.map({ type: "thinking.delta", payload: { text: "secret done" } })).toEqual([
      {
        type: "agent_thinking",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "[REDACTED] done",
        done: false,
      },
    ]);
  });

  it("registers a tool secret before later streamed output can expose it", () => {
    const mapper = createMapper();
    mapper.map({ type: "message.start", payload: undefined });
    mapper.registerSecret("dynamic-tool-secret");

    expect(mapper.map({ type: "message.delta", payload: { text: "dynamic-tool-" } })).toEqual([]);
    expect(mapper.map({ type: "message.delta", payload: { text: "secret exposed!" } })).toEqual([
      {
        type: "agent_text",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "[REDACTED] exposed!",
        done: false,
      },
    ]);
  });

  it("redacts nested tool input, output, and error values without mutating payloads", () => {
    const mapper = createMapper(["nested-secret"]);
    mapper.map({ type: "message.start", payload: undefined });
    const startPayload = {
      tool_id: "call-sensitive",
      name: "http",
      args: { headers: { authorization: "Bearer nested-secret" } },
    };
    const completePayload = {
      tool_id: "call-sensitive",
      name: "http",
      result: {
        ok: false,
        error: { message: "request with nested-secret failed" },
        rows: [{ token: "nested-secret" }],
      },
      is_error: true,
      denied: true,
    };

    expect(mapper.map({ type: "tool.start", payload: startPayload })).toEqual([
      {
        type: "agent_tool_call",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        toolCallId: "call-sensitive",
        toolName: "http",
        input: { headers: { authorization: "Bearer [REDACTED]" } },
      },
    ]);
    expect(mapper.map({ type: "tool.complete", payload: completePayload })).toEqual([
      {
        type: "agent_tool_result",
        sessionId: SESSION_ID,
        toolCallId: "call-sensitive",
        toolName: "http",
        output: {
          ok: false,
          error: { message: "request with [REDACTED] failed" },
          rows: [{ token: "[REDACTED]" }],
        },
        isError: true,
        denied: true,
      },
    ]);
    expect(startPayload.args.headers.authorization).toBe("Bearer nested-secret");
    expect(completePayload.result.error.message).toBe("request with nested-secret failed");
  });

  it("flushes a possible secret tail as a redaction without closing the message", () => {
    const mapper = createMapper(["sk-live-secret"]);
    mapper.map({ type: "message.start", payload: undefined });

    expect(mapper.map({ type: "message.delta", payload: { text: "prefix sk-live-" } })).toEqual([
      {
        type: "agent_text",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "prefix ",
        done: false,
      },
    ]);
    expect(mapper.flush()).toEqual([
      {
        type: "agent_text",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "[REDACTED]",
        done: false,
      },
    ]);
    expect(mapper.map({ type: "message.delta", payload: { text: "safe" } })).toEqual([
      {
        type: "agent_text",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "safe",
        done: false,
      },
    ]);
  });

  it("finalizes possible secret tails conservatively and is idempotent", () => {
    const mapper = createMapper(["sk-live-secret"]);
    mapper.map({ type: "message.start", payload: undefined });
    expect(mapper.map({ type: "message.delta", payload: { text: "prefix sk-live-" } })).toEqual([
      {
        type: "agent_text",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "prefix ",
        done: false,
      },
    ]);

    expect(mapper.finalize()).toEqual([
      {
        type: "agent_text",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "[REDACTED]",
        done: false,
      },
      {
        type: "agent_text",
        sessionId: SESSION_ID,
        msgId: `${SESSION_ID}#m1`,
        delta: "",
        done: true,
      },
    ]);
    expect(mapper.finalize()).toEqual([]);
  });
});
