import type { RuntimeBinding, RuntimeCrash, RuntimeEvent } from "@opentrad/runtime-adapter";
import { describe, expect, it, vi } from "vitest";
import type { HermesGatewayNotification } from "../src/main/services/hermes/gateway-client";
import {
  HermesRuntimeAdapter,
  type HermesRuntimeManagerFactory,
  type HermesRuntimeManagerPort,
} from "../src/main/services/hermes-runtime-adapter";

const LIVE_ONE = "deadbeef";
const LIVE_TWO = "cafebabe";
const STORED_ONE = "20260712_101010_abcdef";
const STORED_TWO = "20260712_111111_bcdefa";
const REQUEST_ONE = "feedface";

describe("HermesRuntimeAdapter native gateway", () => {
  it("reports the pinned native Hermes runtime without starting a manager", async () => {
    const factory = vi.fn<HermesRuntimeManagerFactory>();
    const adapter = new HermesRuntimeAdapter(factory);

    await expect(adapter.ready()).resolves.toEqual({ version: "hermes-agent/0.18.2" });
    expect(adapter.kind).toBe("hermes");
    expect(factory).not.toHaveBeenCalled();
  });

  it("creates a native durable session with the verified workspace and provider", async () => {
    const manager = fakeManager();
    const factory = vi.fn(() => manager.port);
    const adapter = new HermesRuntimeAdapter(factory);

    const binding = await adapter.create(launchInput());

    expect(factory).toHaveBeenCalledWith({
      workspaceRoot: "/workspace/project",
      binding: {
        taskId: "task-1",
        runId: "run-1",
        profileId: "profile-1",
        providerSlug: "anthropic",
        authMode: "api_key",
        model: "claude-sonnet-4",
        apiMode: "chat_completions",
        executionBackend: "local",
      },
    });
    expect(manager.request).toHaveBeenCalledWith("session.create", {
      cwd: "/workspace/project",
      source: "opentrad",
      model: "claude-sonnet-4",
      provider: "anthropic",
      close_on_disconnect: false,
    });
    expect(binding).toEqual({
      canonicalSessionId: "canonical-1",
      liveRuntimeSessionId: LIVE_ONE,
      durableRuntimeSessionId: STORED_ONE,
    });
  });

  it("snapshots launch input before asynchronous manager startup", async () => {
    const manager = fakeManager();
    const adapter = new HermesRuntimeAdapter(() => manager.port);
    const input = launchInput();
    const creating = adapter.create(input);
    input.workspaceRoot = "/mutated";
    input.provider.providerSlug = "mutated";

    await creating;

    expect(manager.request).toHaveBeenCalledWith(
      "session.create",
      expect.objectContaining({ cwd: "/workspace/project", provider: "anthropic" }),
    );
  });

  it("streams native events for one live session until message.complete", async () => {
    const manager = fakeManager();
    const adapter = new HermesRuntimeAdapter(() => manager.port);
    const binding = await adapter.create(launchInput());
    const events: RuntimeEvent[] = [];

    const streaming = adapter.stream(binding, "hello", (event) => events.push(event));
    await vi.waitFor(() => {
      expect(manager.request).toHaveBeenCalledWith("prompt.submit", {
        session_id: LIVE_ONE,
        text: "hello",
      });
    });
    manager.notify({ method: "message.delta", params: { text: "wrong" }, sessionId: LIVE_TWO });
    manager.notify({ method: "message.start", params: { role: "assistant" }, sessionId: LIVE_ONE });
    manager.notify({ method: "reasoning.delta", params: { text: "think" }, sessionId: LIVE_ONE });
    manager.notify({ method: "tool.start", params: { name: "terminal" }, sessionId: LIVE_ONE });
    manager.notify({ method: "message.delta", params: { text: "hi" }, sessionId: LIVE_ONE });
    manager.notify({ method: "message.complete", params: { text: "hi" }, sessionId: LIVE_ONE });

    await expect(streaming).resolves.toBeUndefined();
    expect(events).toEqual([
      { type: "message.start", payload: { role: "assistant" } },
      { type: "reasoning.delta", payload: { text: "think" } },
      { type: "tool.start", payload: { name: "terminal" } },
      { type: "message.delta", payload: { text: "hi" } },
      { type: "message.complete", payload: { text: "hi" } },
    ]);
    expect(manager.listenerCount()).toBe(0);
  });

  it("subscribes before prompt.submit so an immediate completion is not lost", async () => {
    const manager = fakeManager();
    manager.request.mockImplementation(async (method: string) => {
      if (method === "session.create") return createResult();
      if (method === "prompt.submit") {
        manager.notify({
          method: "message.complete",
          params: { text: "fast" },
          sessionId: LIVE_ONE,
        });
        return { status: "streaming" };
      }
      if (method === "session.close") return { closed: true };
      throw new Error("unexpected rpc");
    });
    const adapter = new HermesRuntimeAdapter(() => manager.port);
    const binding = await adapter.create(launchInput());
    const events: RuntimeEvent[] = [];

    await expect(
      adapter.stream(binding, "fast", (event) => events.push(event)),
    ).resolves.toBeUndefined();

    expect(events).toEqual([{ type: "message.complete", payload: { text: "fast" } }]);
  });

  it("rejects concurrent turns without sending a second prompt", async () => {
    const manager = fakeManager();
    const adapter = new HermesRuntimeAdapter(() => manager.port);
    const binding = await adapter.create(launchInput());
    const first = adapter.stream(binding, "first", vi.fn());
    await vi.waitFor(() => expect(manager.listenerCount()).toBe(1));

    await expect(adapter.stream(binding, "second", vi.fn())).rejects.toMatchObject({
      code: "HERMES_RUNTIME_BUSY",
      message: "Hermes runtime session is already streaming",
    });

    manager.notify({ method: "message.complete", params: {}, sessionId: LIVE_ONE });
    await first;
    expect(manager.request).not.toHaveBeenCalledWith(
      "prompt.submit",
      expect.objectContaining({ text: "second" }),
    );
  });

  it("maps a native error event to a fixed non-secret stream failure", async () => {
    const manager = fakeManager();
    const adapter = new HermesRuntimeAdapter(() => manager.port);
    const binding = await adapter.create(launchInput());
    const events: RuntimeEvent[] = [];
    const streaming = adapter.stream(binding, "hello", (event) => events.push(event));
    await vi.waitFor(() => expect(manager.listenerCount()).toBe(1));

    manager.notify({
      method: "error",
      params: { message: "LC_CANARY_SECRET" },
      sessionId: LIVE_ONE,
    });

    const error = await streaming.catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      code: "HERMES_RUNTIME_STREAM_FAILED",
      message: "Hermes runtime stream failed",
    });
    expect(JSON.stringify(error)).not.toContain("LC_CANARY_SECRET");
    expect(events).toEqual([{ type: "error", payload: { message: "LC_CANARY_SECRET" } }]);
    expect(manager.listenerCount()).toBe(0);
  });

  it("rejects a message.complete event whose Hermes status is error", async () => {
    const manager = fakeManager();
    const adapter = new HermesRuntimeAdapter(() => manager.port);
    const binding = await adapter.create(launchInput());
    const events: RuntimeEvent[] = [];
    const streaming = adapter.stream(binding, "hello", (event) => events.push(event));
    await vi.waitFor(() => expect(manager.listenerCount()).toBe(1));

    manager.notify({
      method: "message.complete",
      params: { status: "error", text: "provider exposed LC_CANARY_SECRET" },
      sessionId: LIVE_ONE,
    });

    const error = await streaming.catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      code: "HERMES_RUNTIME_STREAM_FAILED",
      message: "Hermes runtime stream failed",
    });
    expect(JSON.stringify(error)).not.toContain("LC_CANARY_SECRET");
    expect(events).toEqual([
      {
        type: "message.complete",
        payload: { status: "error", text: "provider exposed LC_CANARY_SECRET" },
      },
    ]);
    expect(manager.listenerCount()).toBe(0);
  });

  it("fails closed for an unknown message.complete status", async () => {
    const manager = fakeManager();
    const adapter = new HermesRuntimeAdapter(() => manager.port);
    const binding = await adapter.create(launchInput());
    const streaming = adapter.stream(binding, "hello", () => {});
    await vi.waitFor(() => expect(manager.listenerCount()).toBe(1));

    manager.notify({
      method: "message.complete",
      params: { status: "future-status", text: "ambiguous completion" },
      sessionId: LIVE_ONE,
    });

    await expect(streaming).rejects.toMatchObject({ code: "HERMES_RUNTIME_STREAM_FAILED" });
    expect(manager.listenerCount()).toBe(0);
  });

  it("interrupts the native live session", async () => {
    const manager = fakeManager();
    const adapter = new HermesRuntimeAdapter(() => manager.port);
    const binding = await adapter.create(launchInput());

    await adapter.interrupt(binding);

    expect(manager.request).toHaveBeenCalledWith("session.interrupt", { session_id: LIVE_ONE });
  });

  it("responds to native approval and sensitive-input requests with exact RPC parameters", async () => {
    const manager = fakeManager();
    const adapter = new HermesRuntimeAdapter(() => manager.port);
    const binding = await adapter.create(launchInput());

    await adapter.respondApproval(binding, "session");
    await adapter.respondSudo(binding, REQUEST_ONE, "sudo-secret-canary");
    await adapter.respondSecret(binding, REQUEST_ONE, "tool-secret-canary");

    expect(manager.request).toHaveBeenCalledWith("approval.respond", {
      session_id: LIVE_ONE,
      choice: "session",
    });
    expect(manager.request).toHaveBeenCalledWith("sudo.respond", {
      request_id: REQUEST_ONE,
      password: "sudo-secret-canary",
    });
    expect(manager.request).toHaveBeenCalledWith("secret.respond", {
      request_id: REQUEST_ONE,
      value: "tool-secret-canary",
    });
  });

  it.each([
    {
      operation: "approval",
      configure: (manager: FakeManager) =>
        manager.request.mockImplementation(async (method: string) => {
          if (method === "session.create") return createResult();
          if (method === "approval.respond") return { resolved: -1 };
          if (method === "session.close") return { closed: true };
          throw new Error("unexpected rpc");
        }),
      invoke: (adapter: HermesRuntimeAdapter, binding: RuntimeBinding) =>
        adapter.respondApproval(binding, "once"),
      code: "HERMES_RUNTIME_APPROVAL_RESPONSE_FAILED",
      message: "Hermes runtime approval response failed",
    },
    {
      operation: "sudo",
      configure: (manager: FakeManager) =>
        manager.request.mockImplementation(async (method: string) => {
          if (method === "session.create") return createResult();
          if (method === "sudo.respond") return { status: "wrong", leaked: "sudo-secret-canary" };
          if (method === "session.close") return { closed: true };
          throw new Error("unexpected rpc");
        }),
      invoke: (adapter: HermesRuntimeAdapter, binding: RuntimeBinding) =>
        adapter.respondSudo(binding, REQUEST_ONE, "sudo-secret-canary"),
      code: "HERMES_RUNTIME_SUDO_RESPONSE_FAILED",
      message: "Hermes runtime sudo response failed",
    },
    {
      operation: "secret",
      configure: (manager: FakeManager) =>
        manager.request.mockImplementation(async (method: string) => {
          if (method === "session.create") return createResult();
          if (method === "secret.respond") throw new Error("tool-secret-canary");
          if (method === "session.close") return { closed: true };
          throw new Error("unexpected rpc");
        }),
      invoke: (adapter: HermesRuntimeAdapter, binding: RuntimeBinding) =>
        adapter.respondSecret(binding, REQUEST_ONE, "tool-secret-canary"),
      code: "HERMES_RUNTIME_SECRET_RESPONSE_FAILED",
      message: "Hermes runtime secret response failed",
    },
  ])("fails closed with a fixed non-secret $operation response error", async (scenario) => {
    const manager = fakeManager();
    scenario.configure(manager);
    const adapter = new HermesRuntimeAdapter(() => manager.port);
    const binding = await adapter.create(launchInput());

    const error = await scenario.invoke(adapter, binding).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: scenario.code, message: scenario.message });
    expect(JSON.stringify(error)).not.toContain("secret-canary");
  });

  it("resumes the durable Hermes session and maps the new live binding", async () => {
    const manager = fakeManager(
      createResult({
        session_id: LIVE_TWO,
        stored_session_id: STORED_TWO,
      }),
    );
    manager.request.mockImplementation(async (method: string) => {
      if (method === "session.resume") {
        return resumeResult({ session_id: LIVE_TWO, resumed: STORED_ONE });
      }
      if (method === "session.close") return { closed: true };
      throw new Error("unexpected rpc");
    });
    const adapter = new HermesRuntimeAdapter(() => manager.port);

    const binding = await adapter.resume({
      ...launchInput(),
      durableRuntimeSessionId: STORED_ONE,
    });

    expect(manager.request).toHaveBeenCalledWith("session.resume", { session_id: STORED_ONE });
    expect(binding).toEqual({
      canonicalSessionId: "canonical-1",
      liveRuntimeSessionId: LIVE_TWO,
      durableRuntimeSessionId: STORED_ONE,
    });
  });

  it("permits same-canonical durable resume only after the old live entry is released", async () => {
    const first = fakeManager();
    const resumedManager = fakeManager();
    resumedManager.request.mockImplementation(async (method: string) => {
      if (method === "session.resume") {
        return resumeResult({ session_id: LIVE_TWO, resumed: STORED_ONE });
      }
      if (method === "session.close") return { closed: true };
      throw new Error("unexpected rpc");
    });
    const managers = [first.port, resumedManager.port];
    const factory = vi.fn(() => managers.shift() as HermesRuntimeManagerPort);
    const adapter = new HermesRuntimeAdapter(factory);
    const created = await adapter.create(launchInput());
    const retryInput = {
      ...launchInput({ runId: "run-retry" }),
      durableRuntimeSessionId: created.durableRuntimeSessionId as string,
    };

    await expect(adapter.resume(retryInput)).rejects.toMatchObject({
      code: "HERMES_RUNTIME_DUPLICATE_CREATE",
    });
    expect(factory).toHaveBeenCalledTimes(1);

    await adapter.close(created);
    await expect(adapter.resume(retryInput)).resolves.toEqual({
      canonicalSessionId: "canonical-1",
      liveRuntimeSessionId: LIVE_TWO,
      durableRuntimeSessionId: STORED_ONE,
    });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("closes and stops an owned native sidecar exactly once", async () => {
    const manager = fakeManager();
    const adapter = new HermesRuntimeAdapter(() => manager.port);
    const binding = await adapter.create(launchInput());

    await Promise.all([adapter.close(binding), adapter.close(binding)]);

    expect(manager.request).toHaveBeenCalledWith("session.close", { session_id: LIVE_ONE });
    expect(manager.stop).toHaveBeenCalledTimes(1);
    expect(manager.crashListenerCount()).toBe(0);
  });

  it("sanitizes manager failures and still stops every adopted manager", async () => {
    for (const stage of ["start", "create"] as const) {
      const manager = fakeManager();
      if (stage === "start") manager.start.mockRejectedValueOnce(new Error("LC_CANARY_SECRET"));
      if (stage === "create") manager.request.mockRejectedValueOnce(new Error("LC_CANARY_SECRET"));
      const adapter = new HermesRuntimeAdapter(() => manager.port);

      const error = await adapter.create(launchInput()).catch((cause: unknown) => cause);

      expect(error).toMatchObject({
        code: "HERMES_RUNTIME_CREATE_FAILED",
        message: "Hermes runtime session creation failed",
      });
      expect(JSON.stringify(error)).not.toContain("LC_CANARY_SECRET");
      expect(manager.stop).toHaveBeenCalledTimes(1);
    }
  });

  it("notifies a fixed crash and rejects an active stream", async () => {
    const manager = fakeManager();
    const adapter = new HermesRuntimeAdapter(() => manager.port);
    const binding = await adapter.create(launchInput());
    let crash: RuntimeCrash | undefined;
    adapter.onCrash((value) => {
      crash = value;
    });
    const streaming = adapter.stream(binding, "hello", vi.fn());
    await vi.waitFor(() => expect(manager.listenerCount()).toBe(1));

    manager.crash(new Error("LC_CANARY_SECRET"));

    await expect(streaming).rejects.toMatchObject({ code: "HERMES_RUNTIME_CRASHED" });
    expect(crash).toMatchObject({
      runtimeKind: "hermes",
      binding,
      error: {
        code: "HERMES_RUNTIME_CRASHED",
        message: "Hermes runtime sidecar crashed",
      },
    });
    expect(JSON.stringify(crash)).not.toContain("LC_CANARY_SECRET");
    await vi.waitFor(() => expect(manager.stop).toHaveBeenCalledTimes(1));
  });

  it("rejects invalid launch fields before constructing a manager", async () => {
    const invalid = [
      launchInput({ workspaceRoot: "relative/path" }),
      launchInput({ provider: { ...launchInput().provider, providerSlug: "bad provider" } }),
      launchInput({
        provider: { ...launchInput().provider, authMode: "oauth", apiMode: "bad" as never },
      }),
      launchInput({
        provider: { ...launchInput().provider, executionBackend: "remote" as never },
      }),
    ];
    for (const input of invalid) {
      const factory = vi.fn<HermesRuntimeManagerFactory>();
      const adapter = new HermesRuntimeAdapter(factory);

      await expect(adapter.create(input)).rejects.toMatchObject({
        code: "HERMES_RUNTIME_INVALID_INPUT",
        message: "Hermes runtime launch context is invalid",
      });
      expect(factory).not.toHaveBeenCalled();
    }
  });

  it("rejects stale or forged bindings without manager RPC", async () => {
    const manager = fakeManager();
    const adapter = new HermesRuntimeAdapter(() => manager.port);
    const binding = await adapter.create(launchInput());
    const forged: RuntimeBinding = { ...binding, durableRuntimeSessionId: STORED_TWO };

    await expect(adapter.stream(forged, "hello", vi.fn())).rejects.toMatchObject({
      code: "HERMES_RUNTIME_UNKNOWN_SESSION",
    });
    await expect(adapter.interrupt(forged)).rejects.toMatchObject({
      code: "HERMES_RUNTIME_UNKNOWN_SESSION",
    });
    await expect(adapter.respondApproval(forged, "deny")).rejects.toMatchObject({
      code: "HERMES_RUNTIME_UNKNOWN_SESSION",
    });
    await expect(
      adapter.respondSudo(forged, REQUEST_ONE, "sudo-secret-canary"),
    ).rejects.toMatchObject({
      code: "HERMES_RUNTIME_UNKNOWN_SESSION",
    });
    await expect(
      adapter.respondSecret(forged, REQUEST_ONE, "tool-secret-canary"),
    ).rejects.toMatchObject({
      code: "HERMES_RUNTIME_UNKNOWN_SESSION",
    });
    expect(manager.request).not.toHaveBeenCalledWith("prompt.submit", expect.anything());
    expect(manager.request).not.toHaveBeenCalledWith("approval.respond", expect.anything());
    expect(manager.request).not.toHaveBeenCalledWith("sudo.respond", expect.anything());
    expect(manager.request).not.toHaveBeenCalledWith("secret.respond", expect.anything());
  });

  it("disposes multiple sessions and rejects later operations", async () => {
    const first = fakeManager();
    const second = fakeManager(
      createResult({ session_id: LIVE_TWO, stored_session_id: STORED_TWO }),
    );
    const managers = [first.port, second.port];
    const adapter = new HermesRuntimeAdapter(() => managers.shift() as HermesRuntimeManagerPort);
    await adapter.create(launchInput());
    await adapter.create(
      launchInput({ canonicalSessionId: "canonical-2", taskId: "task-2", runId: "run-2" }),
    );

    await adapter.dispose();

    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(second.stop).toHaveBeenCalledTimes(1);
    await expect(
      adapter.create(launchInput({ canonicalSessionId: "canonical-3" })),
    ).rejects.toMatchObject({
      code: "HERMES_RUNTIME_DISPOSED",
    });
  });
});

interface MutableLaunchInput {
  canonicalSessionId: string;
  taskId: string;
  runId: string;
  workspaceRoot: string;
  provider: {
    profileId: string;
    providerSlug: string;
    authMode: "api_key" | "oauth";
    model: string;
    apiMode: "chat_completions" | "codex_responses";
    executionBackend: "local" | "docker";
  };
}

function launchInput(overrides: Partial<MutableLaunchInput> = {}): MutableLaunchInput {
  return {
    canonicalSessionId: "canonical-1",
    taskId: "task-1",
    runId: "run-1",
    workspaceRoot: "/workspace/project",
    provider: {
      profileId: "profile-1",
      providerSlug: "anthropic",
      authMode: "api_key",
      model: "claude-sonnet-4",
      apiMode: "chat_completions",
      executionBackend: "local",
    },
    ...overrides,
  };
}

interface MutableCreateResult {
  session_id: string;
  stored_session_id: string;
  message_count: number;
  messages: unknown[];
  info: Record<string, unknown>;
}

function createResult(overrides: Partial<MutableCreateResult> = {}): MutableCreateResult {
  return {
    session_id: LIVE_ONE,
    stored_session_id: STORED_ONE,
    message_count: 0,
    messages: [],
    info: { lazy: true, provider: "anthropic", model: "claude-sonnet-4" },
    ...overrides,
  };
}

function resumeResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: LIVE_ONE,
    resumed: STORED_ONE,
    message_count: 1,
    messages: [{ role: "assistant", content: "hello" }],
    info: { provider: "anthropic" },
    running: false,
    session_key: STORED_ONE,
    started_at: Date.now() / 1_000,
    status: "idle",
    ...overrides,
  };
}

interface FakeManager {
  port: HermesRuntimeManagerPort;
  start: ReturnType<typeof vi.fn<() => Promise<void>>>;
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
  request: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  crash(error: Error): void;
  notify(event: HermesGatewayNotification): void;
  listenerCount(): number;
  crashListenerCount(): number;
}

function fakeManager(result = createResult()): FakeManager {
  const notificationListeners = new Set<(event: HermesGatewayNotification) => void>();
  const crashListeners = new Set<(error: never) => void | Promise<void>>();
  const start = vi.fn(async () => {});
  const stop = vi.fn(async () => {});
  const request = vi.fn(async (method: string) => {
    if (method === "session.create") return result;
    if (method === "prompt.submit") return { status: "streaming" };
    if (method === "session.interrupt") return { status: "interrupted" };
    if (method === "session.close") return { closed: true };
    if (method === "approval.respond") return { resolved: 1 };
    if (method === "sudo.respond" || method === "secret.respond") return { status: "ok" };
    throw new Error("unexpected rpc");
  });
  const subscribe = vi.fn((listener: (event: HermesGatewayNotification) => void) => {
    notificationListeners.add(listener);
    return () => notificationListeners.delete(listener);
  });
  const onCrash = vi.fn((listener: (error: never) => void | Promise<void>) => {
    crashListeners.add(listener);
    return () => crashListeners.delete(listener);
  });
  const port = { start, stop, request, subscribe, onCrash } as unknown as HermesRuntimeManagerPort;
  return {
    port,
    start,
    stop,
    request,
    subscribe,
    crash(error) {
      for (const listener of crashListeners) void listener(error as never);
    },
    notify(event) {
      for (const listener of notificationListeners) listener(event);
    },
    listenerCount: () => notificationListeners.size,
    crashListenerCount: () => crashListeners.size,
  };
}
