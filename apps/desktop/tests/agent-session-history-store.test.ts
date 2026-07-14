import type { AgentEvent, AgentSessionMeta } from "@opentrad/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type AgentStoreModule = typeof import("../src/renderer/stores/agent");

const listSessions = vi.fn<() => Promise<AgentSessionMeta[]>>();
const openSession = vi.fn();
const send = vi.fn();
let eventHandler: ((event: AgentEvent) => void) | undefined;
let module: AgentStoreModule;

beforeEach(async () => {
  vi.resetModules();
  listSessions.mockReset();
  openSession.mockReset();
  send.mockReset();
  eventHandler = undefined;
  (globalThis as { window?: unknown }).window = {
    api: {
      installer: { onHermesRuntimeInstallProgress: vi.fn(() => vi.fn()) },
      agent: {
        onEvent: vi.fn((handler: (event: AgentEvent) => void) => {
          eventHandler = handler;
          return vi.fn();
        }),
        listSessions,
        openSession,
        send,
      },
    },
  };
  module = await import("../src/renderer/stores/agent");
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("AgentStore session history", () => {
  it("exposes loading and failure instead of treating an IPC error as empty history", async () => {
    let rejectRequest!: (error: Error) => void;
    listSessions.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRequest = reject;
        }),
    );

    const request = module.useAgentStore.getState().loadSessions();
    expect(module.useAgentStore.getState().sessionsLoading).toBe(true);
    expect(module.useAgentStore.getState().sessionsError).toBeNull();

    rejectRequest(new Error("history database unavailable"));
    await request;

    expect(module.useAgentStore.getState().sessionsLoading).toBe(false);
    expect(module.useAgentStore.getState().sessionsError).toBe("history database unavailable");
    expect(module.useAgentStore.getState().sessions).toEqual([]);
  });

  it("clears the prior failure after a successful retry", async () => {
    listSessions
      .mockRejectedValueOnce(new Error("temporary history failure"))
      .mockResolvedValueOnce([SESSION]);

    await module.useAgentStore.getState().loadSessions();
    expect(module.useAgentStore.getState().sessionsError).toBe("temporary history failure");

    await module.useAgentStore.getState().loadSessions();

    expect(module.useAgentStore.getState().sessionsError).toBeNull();
    expect(module.useAgentStore.getState().sessionsLoading).toBe(false);
    expect(module.useAgentStore.getState().sessions).toEqual([SESSION]);
  });

  it("keeps the same Hermes conversation sendable after an interrupted turn", async () => {
    openSession.mockResolvedValueOnce({
      session: SESSION,
      events: [],
      recovery: "live",
    });
    send.mockResolvedValue(undefined);

    await module.useAgentStore.getState().loadSession(SESSION.sessionId);
    eventHandler?.({
      type: "agent_session_result",
      sessionId: SESSION.sessionId,
      subtype: "aborted",
      durationMs: 1,
      numSteps: 0,
      totalCostUsd: null,
    });
    await module.useAgentStore.getState().sendMessage("继续当前会话");

    expect(send).toHaveBeenCalledWith({
      sessionId: SESSION.sessionId,
      message: "继续当前会话",
    });
  });

  it("does not accept a second turn when the reopened live session is still active", async () => {
    openSession.mockResolvedValueOnce({
      session: { ...SESSION, status: "active" },
      events: [],
      recovery: "live",
    });

    await module.useAgentStore.getState().loadSession(SESSION.sessionId);
    await module.useAgentStore.getState().sendMessage("不应并发发送");

    expect(module.useAgentStore.getState().running).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("rolls back an optimistic user item when main rejects the send", async () => {
    openSession.mockResolvedValueOnce({
      session: SESSION,
      events: [],
      recovery: "live",
    });
    send.mockRejectedValueOnce(new Error("live binding unavailable"));

    await module.useAgentStore.getState().loadSession(SESSION.sessionId);
    await module.useAgentStore.getState().sendMessage("不能成为幽灵消息");

    expect(module.useAgentStore.getState().items).toEqual([]);
    expect(module.useAgentStore.getState().running).toBe(false);
    expect(module.useAgentStore.getState().error).toBe("live binding unavailable");
  });

  it("does not present an aborted legacy fallback session as continuable", async () => {
    openSession.mockResolvedValueOnce({
      session: LEGACY_SESSION,
      events: [],
      recovery: "live",
    });

    await module.useAgentStore.getState().loadSession(LEGACY_SESSION.sessionId);
    eventHandler?.({
      type: "agent_session_result",
      sessionId: LEGACY_SESSION.sessionId,
      subtype: "aborted",
      durationMs: 1,
      numSteps: 0,
      totalCostUsd: null,
    });
    await module.useAgentStore.getState().sendMessage("legacy 不应伪装可继续");

    expect(module.useAgentStore.getState().continuation).toBe("historical");
    expect(send).not.toHaveBeenCalled();
  });

  it("ignores a stale history open that resolves after a newer selection", async () => {
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    openSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    openSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
    );

    const firstOpen = module.useAgentStore.getState().loadSession(SESSION.sessionId);
    const secondOpen = module.useAgentStore.getState().loadSession(SECOND_SESSION.sessionId);
    resolveSecond({ session: SECOND_SESSION, events: [], recovery: "live" });
    await secondOpen;
    resolveFirst({ session: SESSION, events: [], recovery: "live" });
    await firstOpen;

    expect(module.useAgentStore.getState().sessionId).toBe(SECOND_SESSION.sessionId);
    expect(module.useAgentStore.getState().workspaceRoot).toBe(SECOND_SESSION.workspaceRoot);
  });

  it("lets a resumable Hermes history retry recovery instead of ending permanently", async () => {
    openSession
      .mockResolvedValueOnce({
        session: SESSION,
        events: [],
        recovery: "read_only",
      })
      .mockResolvedValueOnce({
        session: SESSION,
        events: [],
        recovery: "live",
      });
    send.mockResolvedValue(undefined);

    await module.useAgentStore.getState().loadSession(SESSION.sessionId);
    const retryableState = module.useAgentStore.getState() as unknown as {
      continuation?: string;
      retrySession?: () => Promise<void>;
    };
    const retrySession = retryableState.retrySession;

    expect(retryableState.continuation).toBe("retryable");
    expect(retrySession).toBeTypeOf("function");
    await retrySession?.();
    await module.useAgentStore.getState().sendMessage("恢复后继续");

    expect(openSession).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith({
      sessionId: SESSION.sessionId,
      message: "恢复后继续",
    });
  });
});

const SESSION: AgentSessionMeta = {
  sessionId: "session-1",
  title: "Recovered session",
  model: "deepseek-chat",
  createdAt: 1,
  profileId: "profile-1",
  workspaceRoot: "/Users/test/workspace",
  status: "idle",
  resumable: true,
};

const LEGACY_SESSION: AgentSessionMeta = {
  sessionId: "legacy-session",
  title: "Legacy history",
  model: "deepseek-chat",
  createdAt: 2,
};

const SECOND_SESSION: AgentSessionMeta = {
  ...SESSION,
  sessionId: "session-2",
  title: "Second session",
  workspaceRoot: "/Users/test/second-workspace",
  createdAt: 3,
};
