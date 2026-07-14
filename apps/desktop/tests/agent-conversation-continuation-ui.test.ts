import { describe, expect, it } from "vitest";
import { agentConversationComposerState } from "../src/renderer/features/agent/AgentChatPanel";

describe("persistent conversation composer", () => {
  it("describes turn and recovery state without presenting the conversation as ended", () => {
    expect(agentConversationComposerState("ready")).toEqual({
      disabled: false,
      placeholder: "输入消息，Enter 发送",
      action: "send",
    });
    expect(agentConversationComposerState("recovering")).toEqual({
      disabled: true,
      placeholder: "正在恢复会话…",
      action: "recovering",
    });
    expect(agentConversationComposerState("retryable")).toEqual({
      disabled: true,
      placeholder: "会话暂时断开，请重试恢复",
      action: "retry",
    });
    expect(agentConversationComposerState("historical")).toEqual({
      disabled: true,
      placeholder: "这条旧记录缺少可恢复的运行时会话",
      action: "historical",
    });

    for (const state of ["ready", "recovering", "retryable", "historical"] as const) {
      expect(agentConversationComposerState(state).placeholder).not.toContain("结束");
    }
  });
});
