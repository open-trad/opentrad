// AgentStore（M0 spike）：自建 agent loop 的会话状态。
//
// 与 SkillStore/SkillWorkArea 的 CC 通道平行：本 store 消费 agent:event 推送的
// AgentEvent 流，把流式增量聚合成可渲染的 ChatItem 列表（Chat 组件直接 map 渲染，
// 复用 MessageBubble / ToolCallCard / ToolResultCard）。
//
// 事件订阅：首次 startSession 时懒订阅一次全局 agent:event，按 sessionId 过滤。

import type { ProviderProfile } from "@opentrad/model-providers";
import type { AgentEvent, AgentSessionMeta } from "@opentrad/shared";
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
  // 会话历史（侧栏「任务」）
  sessions: AgentSessionMeta[];
  // 正在查看历史会话（只读）；null = 实时会话
  viewingHistory: boolean;

  loadProfiles: () => Promise<void>;
  saveProfile: (profile: ProviderProfile, apiKey?: string) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  startSession: (req: {
    profileId: string;
    enabledSites?: string[];
    mcpServers?: { name: string; command: string; args?: string[] }[];
  }) => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  resetSession: () => void;
  // 会话历史
  loadSessions: () => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
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
    sessions: [],
    viewingHistory: false,

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
        viewingHistory: false,
      });
      try {
        const { sessionId } = await window.api.agent.startSession({
          profileId: req.profileId,
          maxSteps: 50,
          budgetUsd: null,
          enabledSites: req.enabledSites ?? [],
          mcpServers: req.mcpServers ?? [],
        });
        set({ sessionId });
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    },

    sendMessage: async (text) => {
      const { sessionId, running, ended, viewingHistory } = get();
      if (!sessionId || running || ended || viewingHistory) return;
      set((s) => ({ items: [...s.items, { kind: "user", text }], running: true, error: null }));
      try {
        await window.api.agent.send({ sessionId, message: text });
        // 首条消息后会话有了标题，刷新侧栏历史
        void get().loadSessions();
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
        viewingHistory: false,
      });
    },

    loadSessions: async () => {
      try {
        const sessions = await window.api.agent.listSessions();
        set({ sessions });
      } catch (err) {
        console.error("[agent-store] loadSessions failed", err);
      }
    },

    // 打开历史会话（只读回放）：拉全部事件重建 items，sessionId 设为该会话但标记 viewingHistory
    loadSession: async (sessionId) => {
      try {
        const events = (await window.api.agent.loadSession(sessionId)) as StoredEvent[];
        const meta = get().sessions.find((s) => s.sessionId === sessionId);
        set({
          sessionId,
          items: buildItemsFromEvents(events),
          sessionModel: meta?.model ?? null,
          sessionTools: [],
          running: false,
          ended: true,
          totalCostUsd: null,
          error: null,
          viewingHistory: true,
        });
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
});

// 回放：持久化事件（含 agent_user 用户消息）重建为渲染项。
// 与 applyEvent 逻辑一致，但一次性构建数组（非增量 set/get）。
type StoredEvent = ({ type: string } & Record<string, unknown>) | AgentEvent;

function buildItemsFromEvents(events: StoredEvent[]): AgentChatItem[] {
  const items: AgentChatItem[] = [];
  for (const evt of events) {
    if (evt.type === "agent_user") {
      items.push({ kind: "user", text: String((evt as { text?: unknown }).text ?? "") });
      continue;
    }
    if (evt.type === "agent_text" || evt.type === "agent_thinking") {
      const e = evt as unknown as { type: string; msgId: string; delta: string; done: boolean };
      const kind = e.type === "agent_text" ? ("text" as const) : ("thinking" as const);
      const idx = items.findIndex(
        (it) =>
          (it.kind === "text" || it.kind === "thinking") &&
          it.kind === kind &&
          it.msgId === e.msgId &&
          !it.done,
      );
      if (idx >= 0) {
        const prev = items[idx] as Extract<AgentChatItem, { kind: "text" | "thinking" }>;
        items[idx] = { ...prev, content: prev.content + e.delta, done: e.done };
      } else if (e.delta.length > 0 || !e.done) {
        items.push({ kind, msgId: e.msgId, content: e.delta, done: e.done });
      }
      continue;
    }
    if (evt.type === "agent_tool_call") {
      const e = evt as unknown as { toolCallId: string; toolName: string; input: unknown };
      items.push({
        kind: "tool_call",
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        input: e.input,
      });
      continue;
    }
    if (evt.type === "agent_tool_result") {
      const e = evt as unknown as {
        toolCallId: string;
        toolName: string;
        output: unknown;
        isError?: boolean;
        denied?: boolean;
      };
      items.push({
        kind: "tool_result",
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        output: e.output,
        isError: e.isError,
        denied: e.denied,
      });
      continue;
    }
    if (evt.type === "agent_usage") {
      const e = evt as unknown as {
        usage: { inputTokens: number; outputTokens: number };
        estimatedCostUsd: number | null;
      };
      items.push({
        kind: "usage",
        inputTokens: e.usage.inputTokens,
        outputTokens: e.usage.outputTokens,
        estimatedCostUsd: e.estimatedCostUsd,
      });
      continue;
    }
    if (evt.type === "agent_session_result") {
      const e = evt as unknown as {
        subtype: "success" | "error" | "aborted" | "budget_exceeded" | "max_steps";
        numSteps: number;
        totalCostUsd: number | null;
        errorMessage?: string;
      };
      items.push({
        kind: "result",
        subtype: e.subtype,
        numSteps: e.numSteps,
        totalCostUsd: e.totalCostUsd,
        ...(e.errorMessage !== undefined ? { errorMessage: e.errorMessage } : {}),
      });
      continue;
    }
    if (evt.type === "agent_error") {
      items.push({ kind: "error", message: String((evt as { message?: unknown }).message ?? "") });
    }
  }
  return items;
}

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
