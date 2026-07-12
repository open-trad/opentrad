import type { AgentSessionHandle } from "@opentrad/agent-core";
import type { RuntimeCreateInput } from "@opentrad/runtime-adapter";
import type { AgentEvent } from "@opentrad/shared";
import { describe, expect, it, vi } from "vitest";
import { LegacyRuntimeAdapter } from "../src/main/services/legacy-runtime-adapter";

describe("LegacyRuntimeAdapter", () => {
  it("preserves the canonical task ID while binding the created handle as the live ID", async () => {
    const fake = fakeSession("legacy-live-1");
    const factory = vi.fn((_input: RuntimeCreateInput) => fake.handle);
    const adapter = new LegacyRuntimeAdapter(factory);
    const input = runtimeInput("task-1");

    await expect(adapter.ready()).resolves.toEqual({ version: "legacy" });
    const binding = await adapter.create(input);

    expect(adapter.kind).toBe("legacy");
    expect(factory).toHaveBeenCalledWith(input);
    expect(binding).toEqual({
      canonicalSessionId: "task-1",
      liveRuntimeSessionId: "legacy-live-1",
      durableRuntimeSessionId: null,
    });
  });

  it("rejects a duplicate canonical binding before creating another handle", async () => {
    const fake = fakeSession("legacy-live-1");
    const factory = vi.fn(() => fake.handle);
    const adapter = new LegacyRuntimeAdapter(factory);
    await adapter.create(runtimeInput("task-1"));

    await expect(adapter.create(runtimeInput("task-1"))).rejects.toThrow(
      /canonical runtime session already exists: task-1/,
    );

    expect(factory).toHaveBeenCalledTimes(1);
    expect(fake.abort).not.toHaveBeenCalled();
  });

  it("aborts a newly created handle before rejecting a duplicate live ID", async () => {
    const first = fakeSession("legacy-live-1");
    const duplicate = fakeSession("legacy-live-1");
    const sessions = [first, duplicate];
    const adapter = new LegacyRuntimeAdapter(() => {
      const next = sessions.shift();
      if (!next) throw new Error("unexpected create");
      return next.handle;
    });
    const firstBinding = await adapter.create(runtimeInput("task-1"));

    await expect(adapter.create(runtimeInput("task-2"))).rejects.toThrow(
      /live runtime session already exists: legacy-live-1/,
    );

    expect(first.abort).not.toHaveBeenCalled();
    expect(duplicate.abort).toHaveBeenCalledTimes(1);
    await adapter.close(firstBinding);
    expect(first.abort).toHaveBeenCalledTimes(1);
    expect(duplicate.abort).toHaveBeenCalledTimes(1);
  });

  it("streams real handle events as runtime envelopes and unsubscribes after send", async () => {
    const event = agentError("legacy-session-1", "provider unavailable");
    const fake = fakeSession("legacy-session-1", async () => fake.emit(event));
    const adapter = new LegacyRuntimeAdapter(() => fake.handle);
    const binding = await adapter.create(runtimeInput("legacy-session-1"));
    const received: unknown[] = [];

    await adapter.stream(binding, "hello", (runtimeEvent) => received.push(runtimeEvent));

    expect(fake.send).toHaveBeenCalledWith("hello");
    expect(received).toEqual([{ type: "agent_error", payload: event }]);
    expect(fake.listenerCount()).toBe(0);
    fake.emit(agentError("legacy-session-1", "late event"));
    expect(received).toHaveLength(1);
  });

  it("unsubscribes when handle.send rejects", async () => {
    const fake = fakeSession("legacy-session-1", async () => {
      throw new Error("send failed");
    });
    const adapter = new LegacyRuntimeAdapter(() => fake.handle);
    const binding = await adapter.create(runtimeInput("legacy-session-1"));

    await expect(adapter.stream(binding, "hello", () => {})).rejects.toThrow("send failed");
    expect(fake.listenerCount()).toBe(0);
  });

  it("interrupt aborts the live handle", async () => {
    const fake = fakeSession("legacy-session-1");
    const adapter = new LegacyRuntimeAdapter(() => fake.handle);
    const binding = await adapter.create(runtimeInput("legacy-session-1"));

    await adapter.interrupt(binding);

    expect(fake.abort).toHaveBeenCalledTimes(1);
  });

  it("close is idempotent and aborts a handle at most once", async () => {
    const fake = fakeSession("legacy-session-1");
    const adapter = new LegacyRuntimeAdapter(() => fake.handle);
    const binding = await adapter.create(runtimeInput("legacy-session-1"));

    await adapter.close(binding);
    await adapter.close(binding);

    expect(fake.abort).toHaveBeenCalledTimes(1);
  });

  it("does not let an old binding close a new canonical session that reused its live ID", async () => {
    const oldSession = fakeSession("legacy-live-1");
    const newSession = fakeSession("legacy-live-1");
    const sessions = [oldSession, newSession];
    const adapter = new LegacyRuntimeAdapter(() => {
      const next = sessions.shift();
      if (!next) throw new Error("unexpected create");
      return next.handle;
    });
    const oldBinding = await adapter.create(runtimeInput("task-old"));
    await adapter.close(oldBinding);
    const newBinding = await adapter.create(runtimeInput("task-new"));

    await adapter.close(oldBinding);

    expect(newSession.abort).not.toHaveBeenCalled();
    await adapter.stream(newBinding, "still live", () => {});
    expect(newSession.send).toHaveBeenCalledWith("still live");
    await adapter.close(newBinding);
    expect(newSession.abort).toHaveBeenCalledTimes(1);
  });

  it("treats a close binding with mismatched canonical and live IDs as a no-op", async () => {
    const fake = fakeSession("legacy-live-1");
    const adapter = new LegacyRuntimeAdapter(() => fake.handle);
    const binding = await adapter.create(runtimeInput("task-1"));

    await adapter.close({ ...binding, canonicalSessionId: "task-other" });

    expect(fake.abort).not.toHaveBeenCalled();
    await adapter.stream(binding, "still live", () => {});
    await adapter.close(binding);
    expect(fake.abort).toHaveBeenCalledTimes(1);
  });

  it("does not abort twice when close follows interrupt", async () => {
    const fake = fakeSession("legacy-session-1");
    const adapter = new LegacyRuntimeAdapter(() => fake.handle);
    const binding = await adapter.create(runtimeInput("legacy-session-1"));

    await adapter.interrupt(binding);
    await adapter.close(binding);

    expect(fake.abort).toHaveBeenCalledTimes(1);
  });

  it("rejects resume because legacy sessions have no durable runtime ID", async () => {
    const adapter = new LegacyRuntimeAdapter(() => fakeSession("unused").handle);

    await expect(
      adapter.resume({
        ...runtimeInput("legacy-session-1"),
        durableRuntimeSessionId: "durable-1",
      }),
    ).rejects.toMatchObject({
      name: "RuntimeResumeUnsupportedError",
      runtimeKind: "legacy",
    });
  });

  it("dispose aborts every remaining handle once and is idempotent", async () => {
    const first = fakeSession("legacy-session-1");
    const second = fakeSession("legacy-session-2");
    const sessions = [first, second];
    const adapter = new LegacyRuntimeAdapter(() => {
      const next = sessions.shift();
      if (!next) throw new Error("unexpected create");
      return next.handle;
    });
    await adapter.create(runtimeInput("legacy-session-1"));
    await adapter.create(runtimeInput("legacy-session-2"));

    await adapter.dispose();
    await adapter.dispose();

    expect(first.abort).toHaveBeenCalledTimes(1);
    expect(second.abort).toHaveBeenCalledTimes(1);
  });

  it("offers a removable crash listener even though legacy has no crash channel", () => {
    const adapter = new LegacyRuntimeAdapter(() => fakeSession("unused").handle);
    const unsubscribe = adapter.onCrash(vi.fn());

    expect(unsubscribe).toBeTypeOf("function");
    expect(() => unsubscribe()).not.toThrow();
  });
});

interface FakeSession {
  handle: AgentSessionHandle;
  send: ReturnType<typeof vi.fn<(prompt: string) => Promise<void>>>;
  abort: ReturnType<typeof vi.fn>;
  emit(event: AgentEvent): void;
  listenerCount(): number;
}

function fakeSession(
  sessionId: string,
  sendImpl: (prompt: string) => Promise<void> = async () => {},
): FakeSession {
  const listeners = new Set<(event: AgentEvent) => void>();
  const send = vi.fn(sendImpl);
  const abort = vi.fn();
  return {
    handle: {
      sessionId,
      send,
      abort,
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    send,
    abort,
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    listenerCount: () => listeners.size,
  };
}

function runtimeInput(canonicalSessionId: string): RuntimeCreateInput {
  return {
    canonicalSessionId,
    taskId: canonicalSessionId,
    runId: `run-${canonicalSessionId}`,
    workspaceRoot: "/workspace/project",
    provider: {
      profileId: "profile-1",
      model: "claude-sonnet-4",
      apiMode: "chat_completions",
    },
  };
}

function agentError(sessionId: string, message: string): AgentEvent {
  return { type: "agent_error", sessionId, message, recoverable: true };
}
