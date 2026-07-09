// AgentSession 单测：用 ai/test 的 MockLanguageModelV3 驱动，不打真实 API。
// 覆盖 M0 spike 验收关注点：事件序列、deny 喂回自愈、预算硬顶、步数上限。

import type { ChatBackend } from "@opentrad/model-providers";
import type { AgentEvent } from "@opentrad/shared";
import { ToolHost } from "@opentrad/tool-host";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createAgentSession } from "../src/session";

// ---------- 测试脚手架 ----------

const USAGE = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 50, text: 50, reasoning: 0 },
};

// 一段纯文本回复的 V3 stream chunks
function textChunks(text: string) {
  return [
    { type: "stream-start" as const, warnings: [] },
    { type: "text-start" as const, id: "t1" },
    { type: "text-delta" as const, id: "t1", delta: text },
    { type: "text-end" as const, id: "t1" },
    { type: "finish" as const, usage: USAGE, finishReason: { unified: "stop" as const } },
  ];
}

// 一次工具调用的 V3 stream chunks（finishReason=tool-calls 让 loop 继续下一步）
function toolCallChunks(toolName: string, input: unknown) {
  return [
    { type: "stream-start" as const, warnings: [] },
    { type: "tool-input-start" as const, id: "call-1", toolName },
    { type: "tool-input-delta" as const, id: "call-1", delta: JSON.stringify(input) },
    { type: "tool-input-end" as const, id: "call-1" },
    {
      type: "tool-call" as const,
      toolCallId: "call-1",
      toolName,
      input: JSON.stringify(input),
    },
    { type: "finish" as const, usage: USAGE, finishReason: { unified: "tool-calls" as const } },
  ];
}

function streamOf(chunks: unknown[]) {
  return {
    stream: simulateReadableStream({ chunks }) as never,
  };
}

// 顺序返回多条流。不用 MockLanguageModelV3 的数组形式：ai@6.0.221 的实现先 push
// doStreamCalls 再用 length 做下标，存在差一 bug（首元素永远取不到），函数形式绕开。
function sequentialStreams(...chunkSets: unknown[][]) {
  let call = 0;
  return () => streamOf(chunkSets[call++] ?? []) as never;
}

function backendOf(model: MockLanguageModelV3): ChatBackend {
  return {
    profileId: "test-profile",
    kind: "anthropic",
    resolveModel: async () => model,
  };
}

function allowAllHost(): ToolHost {
  return new ToolHost(async () => ({ decision: "allow" }));
}

async function collectEvents(
  session: ReturnType<typeof createAgentSession>,
  message: string,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  session.onEvent((e) => events.push(e));
  await session.send(message);
  return events;
}

// ---------- 用例 ----------

describe("AgentSession", () => {
  it("纯文本回复：事件序列 start → text(delta/done) → usage → result(success)，成本按定价估算", async () => {
    const model = new MockLanguageModelV3({ doStream: streamOf(textChunks("你好，外贸人")) });
    const session = createAgentSession({
      sessionId: "s1",
      backend: backendOf(model),
      toolHost: allowAllHost(),
      maxSteps: 5,
      budgetUsd: null,
      model: "mock-model",
      pricing: { inputPerMTokUsd: 1, outputPerMTokUsd: 2 },
    });
    const events = await collectEvents(session, "hi");

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("agent_session_start");
    expect(types).toContain("agent_text");
    expect(types.at(-1)).toBe("agent_session_result");

    const textDeltas = events.filter((e) => e.type === "agent_text" && !e.done);
    expect(textDeltas.map((e) => (e.type === "agent_text" ? e.delta : "")).join("")).toBe(
      "你好，外贸人",
    );
    const done = events.find((e) => e.type === "agent_text" && e.done);
    expect(done).toBeDefined();

    const usage = events.find((e) => e.type === "agent_usage");
    expect(usage?.type === "agent_usage" && usage.usage.inputTokens).toBe(100);
    // 100/1e6*1 + 50/1e6*2 = 0.0002
    expect(usage?.type === "agent_usage" && usage.estimatedCostUsd).toBeCloseTo(0.0002, 10);

    const result = events.at(-1);
    expect(result?.type === "agent_session_result" && result.subtype).toBe("success");
    expect(result?.type === "agent_session_result" && result.totalCostUsd).toBeCloseTo(0.0002, 10);
  });

  it("工具 deny：不执行 handler、denied 事件发出、拒绝原因作为 tool result 喂回模型自愈", async () => {
    let handlerRan = false;
    const host = new ToolHost(async () => ({ decision: "deny", reason: "risk gate says no" }));
    host.register(
      {
        name: "mcp:bb:search",
        description: "search products",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
        source: "mcp",
        riskLevel: "review",
      },
      async () => {
        handlerRan = true;
        return { output: "should not happen" };
      },
    );

    // 第一步要求调工具（净化名 mcp_bb_search），第二步收到错误结果后改口纯文本
    const model = new MockLanguageModelV3({
      doStream: sequentialStreams(
        toolCallChunks("mcp_bb_search", { q: "usb hub" }),
        textChunks("工具被拒，我直接回答"),
      ),
    });
    const session = createAgentSession({
      sessionId: "s2",
      backend: backendOf(model),
      toolHost: host,
      maxSteps: 5,
      budgetUsd: null,
    });
    const events = await collectEvents(session, "找 usb hub");

    expect(handlerRan).toBe(false);
    const call = events.find((e) => e.type === "agent_tool_call");
    // 事件里是原始名（非净化名）
    expect(call?.type === "agent_tool_call" && call.toolName).toBe("mcp:bb:search");
    const toolResult = events.find((e) => e.type === "agent_tool_result");
    expect(toolResult?.type === "agent_tool_result" && toolResult.denied).toBe(true);
    expect(toolResult?.type === "agent_tool_result" && toolResult.isError).toBe(true);

    // 模型确实收到了第二次调用（错误结果喂回，loop 未崩溃）
    expect(model.doStreamCalls.length).toBe(2);
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt ?? "");
    expect(secondPrompt).toContain("denied");

    const result = events.at(-1);
    expect(result?.type === "agent_session_result" && result.subtype).toBe("success");
  });

  it("预算硬顶：累计成本达到 budgetUsd 后终止，subtype=budget_exceeded", async () => {
    // 每步成本 0.0002；预算 0.0001 → 第一步即触顶
    const model = new MockLanguageModelV3({ doStream: streamOf(textChunks("很长的回答")) });
    const session = createAgentSession({
      sessionId: "s3",
      backend: backendOf(model),
      toolHost: allowAllHost(),
      maxSteps: 10,
      budgetUsd: 0.0001,
      pricing: { inputPerMTokUsd: 1, outputPerMTokUsd: 2 },
    });
    const events = await collectEvents(session, "hi");
    const result = events.at(-1);
    expect(result?.type === "agent_session_result" && result.subtype).toBe("budget_exceeded");
    // 会话已终结：再 send 抛错
    await expect(session.send("again")).rejects.toThrow(/ended/);
  });

  it("步数上限：模型持续要求工具调用时在 maxSteps 截停，subtype=max_steps", async () => {
    const host = allowAllHost();
    host.register(
      {
        name: "echo",
        description: "echo",
        inputSchema: { type: "object" },
        source: "builtin",
        riskLevel: "safe",
      },
      async (input) => ({ output: input }),
    );
    // 两步都要求继续调工具；stopWhen(stepCountIs(2)) 截停后 finishReason 仍是 tool-calls
    const model = new MockLanguageModelV3({
      doStream: sequentialStreams(
        toolCallChunks("echo", { n: 1 }),
        toolCallChunks("echo", { n: 2 }),
      ),
    });
    const session = createAgentSession({
      sessionId: "s4",
      backend: backendOf(model),
      toolHost: host,
      maxSteps: 2,
      budgetUsd: null,
    });
    const events = await collectEvents(session, "loop forever");
    const result = events.at(-1);
    expect(result?.type === "agent_session_result" && result.subtype).toBe("max_steps");
    expect(result?.type === "agent_session_result" && result.numSteps).toBe(2);
  });

  it("allowedTools 过滤：未列入的工具不会暴露给模型", async () => {
    const host = allowAllHost();
    for (const name of ["tool_a", "tool_b"]) {
      host.register(
        {
          name,
          description: name,
          inputSchema: { type: "object" },
          source: "builtin",
          riskLevel: "safe",
        },
        async () => ({ output: null }),
      );
    }
    const model = new MockLanguageModelV3({ doStream: streamOf(textChunks("ok")) });
    const session = createAgentSession({
      sessionId: "s5",
      backend: backendOf(model),
      toolHost: host,
      allowedTools: ["tool_a"],
      maxSteps: 3,
      budgetUsd: null,
    });
    const events = await collectEvents(session, "hi");
    const start = events[0];
    expect(start?.type === "agent_session_start" && start.tools).toEqual(["tool_a"]);
    // 模型侧收到的工具定义也只有 tool_a
    const tools = model.doStreamCalls[0]?.tools ?? [];
    expect(tools.map((t) => t.name)).toEqual(["tool_a"]);
  });
});
