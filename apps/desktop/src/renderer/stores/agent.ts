// AgentStore（M0 spike）：自建 agent loop 的会话状态。
//
// 与 SkillStore/SkillWorkArea 的 CC 通道平行：本 store 消费 agent:event 推送的
// AgentEvent 流，把流式增量聚合成可渲染的 ChatItem 列表（Chat 组件直接 map 渲染，
// 复用 MessageBubble / ToolCallCard / ToolResultCard）。
//
// 事件订阅：首次 startSession 时懒订阅一次全局 agent:event，按 sessionId 过滤。

import type { ProviderProfile } from "@opentrad/model-providers";
import type { AgentEvent, AgentSessionMeta, HermesRuntimeInstallProgress } from "@opentrad/shared";
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

export type AgentConversationContinuation = "ready" | "recovering" | "retryable" | "historical";

interface AgentStoreState {
  profiles: ProviderProfile[];
  profilesLoaded: boolean;
  sessionId: string | null;
  sessionProfileId: string | null;
  sessionResumable: boolean | null;
  workspaceRoot: string | null;
  // 会话头信息（agent_session_start）
  sessionModel: string | null;
  sessionTools: string[];
  items: AgentChatItem[];
  // 一轮进行中（send 后到 agent_session_result 之间）
  running: boolean;
  // 对话能否继续。轮次结束不等于会话结束；失败恢复可重试。
  continuation: AgentConversationContinuation;
  totalCostUsd: number | null;
  error: string | null;
  runtimeInstallProgress: HermesRuntimeInstallProgress | null;
  // 会话历史（侧栏「任务」）
  sessions: AgentSessionMeta[];
  sessionsLoading: boolean;
  sessionsError: string | null;
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
  retrySession: () => Promise<void>;
}

// 全局事件订阅只挂一次（模块级守卫）
let subscribed = false;

export const useAgentStore = create<AgentStoreState>((set, get) => {
  let latestStartAttempt = 0;
  let latestLoadAttempt = 0;

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
    sessionProfileId: null,
    sessionResumable: null,
    workspaceRoot: null,
    sessionModel: null,
    sessionTools: [],
    items: [],
    running: false,
    continuation: "ready",
    totalCostUsd: null,
    error: null,
    runtimeInstallProgress: null,
    sessions: [],
    sessionsLoading: false,
    sessionsError: null,

    loadProfiles: async () => {
      try {
        const profiles = await window.api.agent.listProfiles();
        set({ profiles, profilesLoaded: true, error: null });
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err), profilesLoaded: true });
      }
    },

    // Profile 与可选 API Key 经同一次 main mutation 提交，renderer 不持有独立凭证写入口。
    saveProfile: async (profile, apiKey) => {
      await window.api.agent.saveProfile(
        profile,
        apiKey && profile.credentialRef
          ? { ref: profile.credentialRef, secret: apiKey }
          : undefined,
      );
      await get().loadProfiles();
    },

    deleteProfile: async (id) => {
      await window.api.agent.deleteProfile({ id });
      await get().loadProfiles();
    },

    startSession: async (req) => {
      const attempt = ++latestStartAttempt;
      latestLoadAttempt += 1;
      ensureSubscribed();
      set({
        sessionId: null,
        sessionProfileId: null,
        sessionResumable: null,
        workspaceRoot: null,
        sessionModel: null,
        sessionTools: [],
        items: [],
        running: false,
        continuation: "ready",
        totalCostUsd: null,
        error: null,
        runtimeInstallProgress: null,
      });
      let acceptingProgress = true;
      const unsubscribeProgress = window.api.installer.onHermesRuntimeInstallProgress(
        (progress) => {
          if (!acceptingProgress || attempt !== latestStartAttempt) return;
          set({ runtimeInstallProgress: progress });
        },
      );
      try {
        const selected = await window.api.agent.selectWorkspace();
        if (!selected) {
          set({ error: "需要选择一个工作区才能创建 Hermes 会话" });
          return;
        }
        const { sessionId, resumable } = await window.api.agent.startSession({
          profileId: req.profileId,
          workspaceRoot: selected.workspaceRoot,
          maxSteps: 50,
          budgetUsd: null,
          enabledSites: req.enabledSites ?? [],
          mcpServers: req.mcpServers ?? [],
        });
        set({
          sessionId,
          sessionProfileId: req.profileId,
          sessionResumable: resumable,
          workspaceRoot: selected.workspaceRoot,
        });
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      } finally {
        acceptingProgress = false;
        unsubscribeProgress();
        if (attempt === latestStartAttempt) set({ runtimeInstallProgress: null });
      }
    },

    sendMessage: async (text) => {
      const { sessionId, running, continuation } = get();
      if (!sessionId || running || continuation !== "ready") return;
      const optimisticUser: AgentChatItem = { kind: "user", text };
      set((s) => ({ items: [...s.items, optimisticUser], running: true, error: null }));
      try {
        await window.api.agent.send({ sessionId, message: text });
        // 首条消息后会话有了标题，刷新侧栏历史
        void get().loadSessions();
      } catch (err) {
        set((s) =>
          s.sessionId === sessionId
            ? {
                items: s.items.filter((item) => item !== optimisticUser),
                running: false,
                error: err instanceof Error ? err.message : String(err),
              }
            : {},
        );
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
      latestLoadAttempt += 1;
      set({
        sessionId: null,
        sessionProfileId: null,
        sessionResumable: null,
        workspaceRoot: null,
        sessionModel: null,
        sessionTools: [],
        items: [],
        running: false,
        continuation: "ready",
        totalCostUsd: null,
        error: null,
        runtimeInstallProgress: null,
      });
    },

    loadSessions: async () => {
      set({ sessionsLoading: true, sessionsError: null });
      try {
        const sessions = await window.api.agent.listSessions();
        set({ sessions, sessionsLoading: false, sessionsError: null });
      } catch (err) {
        set({
          sessionsLoading: false,
          sessionsError: err instanceof Error ? err.message : String(err),
        });
      }
    },

    // 立即回放本地事件；durable Hermes binding 在 main 后台恢复。
    loadSession: async (sessionId) => {
      const attempt = ++latestLoadAttempt;
      try {
        ensureSubscribed();
        const opened = await window.api.agent.openSession(sessionId);
        if (attempt !== latestLoadAttempt) return;
        const events = opened.events as StoredEvent[];
        const readOnly = opened.recovery === "read_only";
        const resuming = opened.recovery === "resuming";
        const liveActive = opened.recovery === "live" && opened.session.status === "active";
        const continuation: AgentConversationContinuation = resuming
          ? "recovering"
          : readOnly
            ? opened.session.resumable === true
              ? "retryable"
              : "historical"
            : "ready";
        set({
          sessionId,
          sessionProfileId: opened.session.profileId ?? null,
          sessionResumable: opened.session.resumable ?? false,
          workspaceRoot: opened.session.workspaceRoot ?? null,
          items: buildItemsFromEvents(events),
          sessionModel: opened.session.model,
          sessionTools: [],
          running: liveActive,
          continuation,
          totalCostUsd: null,
          error: null,
          runtimeInstallProgress: null,
        });
        if (resuming) {
          void waitForRecovery(sessionId, set, get, () => attempt === latestLoadAttempt);
        }
      } catch (err) {
        if (attempt === latestLoadAttempt) {
          set({ error: err instanceof Error ? err.message : String(err) });
        }
      }
    },

    retrySession: async () => {
      const { sessionId } = get();
      if (!sessionId) return;
      await get().loadSession(sessionId);
    },
  };
});

async function waitForRecovery(
  sessionId: string,
  set: SetFn,
  get: GetFn,
  isCurrent: () => boolean,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && get().sessionId === sessionId && isCurrent()) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const sessions = await window.api.agent.listSessions().catch(() => []);
    if (!isCurrent()) return;
    const current = sessions.find((session) => session.sessionId === sessionId);
    if (!current?.status || current.status === "resuming") continue;
    set({ sessions });
    if (current.status === "idle" || current.status === "active") {
      set({ running: false, continuation: "ready" });
    } else {
      set({
        running: false,
        continuation: current.resumable ? "retryable" : "historical",
        error: "Hermes 会话恢复失败；本地历史仍可查看，可点击“重试恢复”继续",
      });
    }
    return;
  }
  if (get().sessionId === sessionId && isCurrent()) {
    set({
      running: false,
      continuation: "retryable",
      error: "Hermes 会话恢复超时；本地历史仍可查看，可点击“重试恢复”继续",
    });
  }
}

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
    case "agent_session_result": {
      const resumable = get().sessionResumable;
      const continuation: AgentConversationContinuation =
        evt.subtype === "success"
          ? "ready"
          : evt.subtype === "aborted" && resumable === true
            ? "ready"
            : resumable === false
              ? "historical"
              : "retryable";
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
        continuation,
        totalCostUsd: evt.totalCostUsd,
      }));
      break;
    }
    case "agent_error":
      set((s) => ({ items: [...s.items, { kind: "error", message: evt.message }] }));
      break;
    default:
      break;
  }
}
