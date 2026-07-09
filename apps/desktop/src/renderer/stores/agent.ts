// AgentStore（M0 spike）：自建 agent loop 的会话状态。
//
// 与 SkillStore/SkillWorkArea 的 CC 通道平行：本 store 消费 agent:event 推送的
// AgentEvent 流，把流式增量聚合成可渲染的 ChatItem 列表（Chat 组件直接 map 渲染，
// 复用 MessageBubble / ToolCallCard / ToolResultCard）。
//
// 事件订阅：首次 startSession 时懒订阅一次全局 agent:event，按 sessionId 过滤。

import type { ProviderProfile } from "@opentrad/model-providers";
import type { AgentEvent } from "@opentrad/shared";
import { create } from "zustand";

// 渲染项：AgentEvent 聚合后的展示形态（text/thinking 增量并进同 msgId 的一项）
export type AgentChatItem =
  | { kind: "user"; text: string }
  | { kind: "text"; msgId: string; content: string; done: boolean }
  | { kind: "thinking"; msgId: string; content: string; done: boolean }
  | { kind: "tool_call"; toolCallId: string; toolName: string; input: unknown }
  | {
      kind: "tool_result";
      toolCallId: string;
      toolName: string;
      output: unknown;
      isError?: boolean;
      denied?: boolean;
    }
  | {
      kind: "usage";
      inputTokens: number;
      outputTokens: number;
      estimatedCostUsd: number | null;
    }
  | {
      kind: "result";
      subtype: "success" | "error" | "aborted" | "budget_exceeded" | "max_steps";
      numSteps: number;
      totalCostUsd: number | null;
      errorMessage?: string;
    }
  | { kind: "error"; message: string };

interface AgentStoreState {
  profiles: ProviderProfile[];
  profilesLoaded: boolean;
  sessionId: string | null;
  // 会话头信息（agent_session_start）
  sessionModel: string | null;
  sessionTools: string[];
  items: AgentChatItem[];
  // 一轮进行中（send 后到 agent_session_result 之间）
  running: boolean;
  // 会话终态（result subtype != success 后不能再 send）
  ended: boolean;
  totalCostUsd: number | null;
  error: string | null;

  loadProfiles: () => Promise<void>;
  saveProfile: (profile: ProviderProfile, apiKey?: string) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  startSession: (req: {
    profileId: string;
    mcpServers?: { name: string; command: string; args?: string[] }[];
  }) => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  resetSession: () => void;
}

// 全局事件订阅只挂一次（模块级守卫）
let subscribed = false;

export const useAgentStore = create<AgentStoreState>((set, get) => {
  function ensureSubscribed(): void {
    if (subscribed) return;
    subscribed = true;
    window.api.agent.onEvent((evt) => {
      if (evt.sessionId !== get().sessionId) return;
      applyEvent(evt, set, get);
    });
  }

  return {
    profiles: [],
    profilesLoaded: false,
    sessionId: null,
    sessionModel: null,
    sessionTools: [],
    items: [],
    running: false,
    ended: false,
    totalCostUsd: null,
    error: null,

    loadProfiles: async () => {
      try {
        const profiles = await window.api.agent.listProfiles();
        set({ profiles, profilesLoaded: true, error: null });
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err), profilesLoaded: true });
      }
    },

    // apiKey 非空时先写凭证（safeStorage），再存 profile（credentialRef 已由调用方填好）
    saveProfile: async (profile, apiKey) => {
      if (apiKey && profile.credentialRef) {
        await window.api.agent.setCredential({ ref: profile.credentialRef, secret: apiKey });
      }
      await window.api.agent.saveProfile(profile);
      await get().loadProfiles();
    },

    deleteProfile: async (id) => {
      const profile = get().profiles.find((p) => p.id === id);
      await window.api.agent.deleteProfile({ id });
      // 级联清理孤儿凭证（profile 删了引用就没意义了）
      if (profile?.credentialRef) {
        await window.api.agent
          .deleteCredential({ ref: profile.credentialRef })
          .catch((err) => console.error("[agent-store] credential cleanup failed", err));
      }
      await get().loadProfiles();
    },

    startSession: async (req) => {
      ensureSubscribed();
      set({
        sessionId: null,
        sessionModel: null,
        sessionTools: [],
        items: [],
        running: false,
        ended: false,
        totalCostUsd: null,
        error: null,
      });
      try {
        const { sessionId } = await window.api.agent.startSession({
          profileId: req.profileId,
          maxSteps: 50,
          budgetUsd: null,
          mcpServers: req.mcpServers ?? [],
        });
        set({ sessionId });
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    },

    sendMessage: async (text) => {
      const { sessionId, running, ended } = get();
      if (!sessionId || running || ended) return;
      set((s) => ({ items: [...s.items, { kind: "user", text }], running: true, error: null }));
      try {
        await window.api.agent.send({ sessionId, message: text });
      } catch (err) {
        set({ running: false, error: err instanceof Error ? err.message : String(err) });
      }
    },

    abort: async () => {
      const { sessionId } = get();
      if (!sessionId) return;
      await window.api.agent.abort({ sessionId }).catch((err) => {
        set({ error: err instanceof Error ? err.message : String(err) });
      });
    },

    resetSession: () => {
      set({
        sessionId: null,
        sessionModel: null,
        sessionTools: [],
        items: [],
        running: false,
        ended: false,
        totalCostUsd: null,
        error: null,
      });
    },
  };
});

type SetFn = (
  updater: Partial<AgentStoreState> | ((s: AgentStoreState) => Partial<AgentStoreState>),
) => void;
type GetFn = () => AgentStoreState;

// AgentEvent → ChatItem 聚合：text/thinking 按 msgId 合并增量，其余各自成项
function applyEvent(evt: AgentEvent, set: SetFn, get: GetFn): void {
  switch (evt.type) {
    case "agent_session_start":
      set({ sessionModel: evt.model, sessionTools: evt.tools });
      break;
    case "agent_text":
    case "agent_thinking": {
      const kind = evt.type === "agent_text" ? ("text" as const) : ("thinking" as const);
      const items = [...get().items];
      const idx = items.findIndex(
        (it) =>
          (it.kind === "text" || it.kind === "thinking") &&
          it.kind === kind &&
          it.msgId === evt.msgId &&
          !it.done,
      );
      if (idx >= 0) {
        const prev = items[idx] as Extract<AgentChatItem, { kind: "text" | "thinking" }>;
        items[idx] = { ...prev, content: prev.content + evt.delta, done: evt.done };
      } else if (evt.delta.length > 0 || !evt.done) {
        items.push({ kind, msgId: evt.msgId, content: evt.delta, done: evt.done });
      }
      set({ items });
      break;
    }
    case "agent_tool_call":
      set((s) => ({
        items: [
          ...s.items,
          {
            kind: "tool_call",
            toolCallId: evt.toolCallId,
            toolName: evt.toolName,
            input: evt.input,
          },
        ],
      }));
      break;
    case "agent_tool_result":
      set((s) => ({
        items: [
          ...s.items,
          {
            kind: "tool_result",
            toolCallId: evt.toolCallId,
            toolName: evt.toolName,
            output: evt.output,
            isError: evt.isError,
            denied: evt.denied,
          },
        ],
      }));
      break;
    case "agent_usage":
      set((s) => ({
        items: [
          ...s.items,
          {
            kind: "usage",
            inputTokens: evt.usage.inputTokens,
            outputTokens: evt.usage.outputTokens,
            estimatedCostUsd: evt.estimatedCostUsd,
          },
        ],
      }));
      break;
    case "agent_session_result":
      set((s) => ({
        items: [
          ...s.items,
          {
            kind: "result",
            subtype: evt.subtype,
            numSteps: evt.numSteps,
            totalCostUsd: evt.totalCostUsd,
            ...(evt.errorMessage !== undefined ? { errorMessage: evt.errorMessage } : {}),
          },
        ],
        running: false,
        ended: evt.subtype !== "success",
        totalCostUsd: evt.totalCostUsd,
      }));
      break;
    case "agent_error":
      set((s) => ({ items: [...s.items, { kind: "error", message: evt.message }] }));
      break;
    default:
      break;
  }
}
