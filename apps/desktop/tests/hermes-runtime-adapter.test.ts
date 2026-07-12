import type { RuntimeBinding, RuntimeCrash } from "@opentrad/runtime-adapter";
import { describe, expect, it, vi } from "vitest";
import {
  HermesRuntimeAdapter,
  HermesRuntimeAdapterError,
  type HermesRuntimeManagerFactory,
  type HermesRuntimeManagerPort,
} from "../src/main/services/hermes-runtime-adapter";

const LIVE_ONE = "deadbeef";
const LIVE_TWO = "cafebabe";
const STORED_ONE = "20260712_101010_abcdef";

describe("HermesRuntimeAdapter quarantine boundary", () => {
  it("reports a fixed quarantine version without constructing or starting a manager", async () => {
    const factory = vi.fn<HermesRuntimeManagerFactory>();
    const adapter = new HermesRuntimeAdapter(factory);

    await expect(adapter.ready()).resolves.toEqual({ version: "hermes-quarantine/1" });

    expect(adapter.kind).toBe("hermes");
    expect(factory).not.toHaveBeenCalled();
  });

  it("snapshots launch context, maps the binding, and sends exact empty create params", async () => {
    const manager = fakeManager();
    const factory = vi.fn(() => manager.port);
    const adapter = new HermesRuntimeAdapter(factory);
    const launch = launchInput();
    const createPromise = adapter.create(launch);
    launch.workspaceRoot = "/mutated";
    launch.provider.profileId = "mutated";

    const binding = await createPromise;

    expect(factory).toHaveBeenCalledWith({
      workspaceRoot: "/workspace/project",
      binding: {
        taskId: "task-1",
        runId: "run-1",
        profileId: "profile-1",
        model: "claude-sonnet-4",
        apiMode: "chat_completions",
      },
    });
    expect(manager.start).toHaveBeenCalledTimes(1);
    expect(manager.request).toHaveBeenCalledWith("session.create", {});
    expect(binding).toEqual({
      canonicalSessionId: "canonical-1",
      liveRuntimeSessionId: LIVE_ONE,
      durableRuntimeSessionId: null,
    });
  });

  it.each([
    ["duplicate canonical", launchInput(), { ...launchInput(), runId: "run-2" }],
    ["duplicate task/run", launchInput(), { ...launchInput(), canonicalSessionId: "canonical-2" }],
  ])("rejects %s reservations before invoking the factory again", async (_label, first, second) => {
    const firstManager = fakeManager();
    const factory = vi.fn(() => firstManager.port);
    const adapter = new HermesRuntimeAdapter(factory);
    await adapter.create(first);

    await expect(adapter.create(second)).rejects.toMatchObject({
      code: "HERMES_RUNTIME_DUPLICATE_CREATE",
    });

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("isolates two runs behind distinct managers", async () => {
    const first = fakeManager(createResult({ session_id: LIVE_ONE }));
    const second = fakeManager(
      createResult({ session_id: LIVE_TWO, stored_session_id: "20260712_111111_bcdefa" }),
    );
    const managers = [first.port, second.port];
    const factory = vi.fn(() => managers.shift() as HermesRuntimeManagerPort);
    const adapter = new HermesRuntimeAdapter(factory);

    const firstBinding = await adapter.create(launchInput());
    const secondBinding = await adapter.create(
      launchInput({ canonicalSessionId: "canonical-2", runId: "run-2" }),
    );

    expect(firstBinding.liveRuntimeSessionId).toBe(LIVE_ONE);
    expect(secondBinding.liveRuntimeSessionId).toBe(LIVE_TWO);
    expect(first.request).toHaveBeenCalledTimes(1);
    expect(second.request).toHaveBeenCalledTimes(1);
  });

  it("allows independent sidecars to return the same process-local live ID", async () => {
    const first = fakeManager();
    const second = fakeManager(createResult({ stored_session_id: "20260712_111111_bcdefa" }));
    const managers = [first.port, second.port];
    const adapter = new HermesRuntimeAdapter(() => managers.shift() as HermesRuntimeManagerPort);

    const firstBinding = await adapter.create(launchInput());
    const secondBinding = await adapter.create(
      launchInput({ canonicalSessionId: "canonical-2", runId: "run-2" }),
    );

    expect(firstBinding.liveRuntimeSessionId).toBe(LIVE_ONE);
    expect(secondBinding.liveRuntimeSessionId).toBe(LIVE_ONE);
    await Promise.all([adapter.close(firstBinding), adapter.close(secondBinding)]);
    expect(first.request).toHaveBeenCalledWith("session.close", { session_id: LIVE_ONE });
    expect(second.request).toHaveBeenCalledWith("session.close", { session_id: LIVE_ONE });
  });

  it("rejects a factory that reuses a manager without stopping the already-owned process", async () => {
    const manager = fakeManager();
    const factory = vi.fn(() => manager.port);
    const adapter = new HermesRuntimeAdapter(factory);
    await adapter.create(launchInput());

    await expect(
      adapter.create(launchInput({ canonicalSessionId: "canonical-2", runId: "run-2" })),
    ).rejects.toMatchObject({ code: "HERMES_RUNTIME_DUPLICATE_CREATE" });

    expect(manager.stop).not.toHaveBeenCalled();
  });

  it.each([
    "factory",
    "start",
    "request",
  ] as const)("sanitizes a %s failure and stops every manager it owns", async (stage) => {
    const manager = fakeManager();
    if (stage === "start") manager.start.mockRejectedValueOnce(new Error("LC_CANARY_SECRET"));
    if (stage === "request") {
      manager.request.mockRejectedValueOnce(new Error("LC_CANARY_SECRET"));
    }
    const factory = vi.fn(() => {
      if (stage === "factory") throw new Error("LC_CANARY_SECRET");
      return manager.port;
    });
    const adapter = new HermesRuntimeAdapter(factory);

    const error = await adapter.create(launchInput()).catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "HERMES_RUNTIME_CREATE_FAILED",
      message: "Hermes runtime session creation failed",
    });
    expect(JSON.stringify(error)).not.toContain("LC_CANARY_SECRET");
    expect(manager.stop).toHaveBeenCalledTimes(stage === "factory" ? 0 : 1);
  });

  it("snapshots and validates the manager port without leaking throwing getters", async () => {
    const stop = vi.fn(async () => {});
    const raw = {
      stop,
      get start(): never {
        throw new Error("LC_CANARY_SECRET");
      },
      request: vi.fn(),
      onCrash: vi.fn(),
    };
    const adapter = new HermesRuntimeAdapter(() => raw as never);

    const error = await adapter.create(launchInput()).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "HERMES_RUNTIME_CREATE_FAILED" });
    expect(JSON.stringify(error)).not.toContain("LC_CANARY_SECRET");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("retains a fail-closed reservation when manager stop ownership cannot be read", async () => {
    const factory = vi.fn(
      () =>
        ({
          get stop(): never {
            throw new Error("LC_CANARY_SECRET");
          },
          start: vi.fn(),
          request: vi.fn(),
          onCrash: vi.fn(),
        }) as never,
    );
    const adapter = new HermesRuntimeAdapter(factory);

    await expect(adapter.create(launchInput())).rejects.toMatchObject({
      code: "HERMES_RUNTIME_CLEANUP_FAILED",
    });
    await expect(adapter.create(launchInput())).rejects.toMatchObject({
      code: "HERMES_RUNTIME_DUPLICATE_CREATE",
    });
    await expect(adapter.dispose()).rejects.toMatchObject({
      code: "HERMES_RUNTIME_CLEANUP_FAILED",
    });
    expect(factory).toHaveBeenCalledOnce();
  });

  it.each([
    new Proxy(
      {},
      {
        getPrototypeOf(): never {
          throw new Error("LC_CANARY_SECRET");
        },
      },
    ),
    Object.assign(new HermesRuntimeAdapterError("HERMES_RUNTIME_QUARANTINE_VIOLATION"), {
      message: "LC_CANARY_SECRET",
    }),
  ])("normalizes a hostile rejected value before it can bypass cleanup", async (rejection) => {
    const manager = fakeManager();
    manager.start.mockRejectedValueOnce(rejection);
    const adapter = new HermesRuntimeAdapter(() => manager.port);

    const error = await adapter.create(launchInput()).catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "HERMES_RUNTIME_CREATE_FAILED",
      message: "Hermes runtime session creation failed",
    });
    expect(JSON.stringify(error)).not.toContain("LC_CANARY_SECRET");
    expect(manager.stop).toHaveBeenCalledOnce();
  });

  it("uses the snapshotted manager methods with their original receiver", async () => {
    const manager = fakeManager();
    const originalRequest = manager.port.request;
    manager.start.mockImplementationOnce(async () => {
      Object.defineProperty(manager.port, "request", {
        configurable: true,
        value: vi.fn(async () => {
          throw new Error("replacement-secret");
        }),
      });
    });
    const adapter = new HermesRuntimeAdapter(() => manager.port);

    await expect(adapter.create(launchInput())).resolves.toMatchObject({
      liveRuntimeSessionId: LIVE_ONE,
    });

    expect(originalRequest).toHaveBeenCalledWith("session.create", {});
  });

  it("retains reservations when create cleanup cannot stop the owned manager", async () => {
    const manager = fakeManager();
    manager.start.mockRejectedValueOnce(new Error("start-secret"));
    manager.stop.mockRejectedValueOnce(new Error("stop-secret"));
    const factory = vi.fn(() => manager.port);
    const adapter = new HermesRuntimeAdapter(factory);

    await expect(adapter.create(launchInput())).rejects.toMatchObject({
      code: "HERMES_RUNTIME_CLEANUP_FAILED",
    });
    await expect(adapter.create(launchInput())).rejects.toMatchObject({
      code: "HERMES_RUNTIME_DUPLICATE_CREATE",
    });

    expect(factory).toHaveBeenCalledTimes(1);
    await expect(adapter.dispose()).resolves.toBeUndefined();
    expect(manager.stop).toHaveBeenCalledTimes(2);
  });

  it("adopts and stops a manager returned by a factory that synchronously disposes", async () => {
    const manager = fakeManager();
    let adapter!: HermesRuntimeAdapter;
    let disposing!: Promise<void>;
    adapter = new HermesRuntimeAdapter(() => {
      disposing = adapter.dispose();
      return manager.port;
    });

    await expect(adapter.create(launchInput())).rejects.toMatchObject({
      code: "HERMES_RUNTIME_DISPOSED",
    });
    await expect(disposing).resolves.toBeUndefined();
    expect(manager.start).not.toHaveBeenCalled();
    expect(manager.stop).toHaveBeenCalledOnce();
  });

  it("does not construct a manager after an input getter synchronously disposes", async () => {
    const factory = vi.fn<HermesRuntimeManagerFactory>();
    let adapter!: HermesRuntimeAdapter;
    adapter = new HermesRuntimeAdapter(factory);
    const input = launchInput();
    const provider = input.provider;
    Object.defineProperty(input, "provider", {
      get() {
        void adapter.dispose();
        return provider;
      },
    });

    await expect(adapter.create(input)).rejects.toMatchObject({
      code: "HERMES_RUNTIME_DISPOSED",
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it("stops before start when onCrash registration synchronously disposes", async () => {
    const manager = fakeManager();
    const unsubscribe = vi.fn();
    let adapter!: HermesRuntimeAdapter;
    let disposing!: Promise<void>;
    manager.onCrash.mockImplementation(() => {
      disposing = adapter.dispose();
      return unsubscribe;
    });
    adapter = new HermesRuntimeAdapter(() => manager.port);

    await expect(adapter.create(launchInput())).rejects.toMatchObject({
      code: "HERMES_RUNTIME_DISPOSED",
    });
    await expect(disposing).resolves.toBeUndefined();
    expect(manager.start).not.toHaveBeenCalled();
    expect(manager.stop).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it.each([
    ["lazy", false],
    ["persisted info", true],
    ["resumable info", true],
    ["runtime", "native"],
    ["state", "ready"],
    ["top-level persisted", true],
    ["top-level resumable", true],
    ["message_count", 1],
    ["messages", [{ role: "assistant" }]],
  ])("fails closed when the quarantine invariant changes: %s", async (field, value) => {
    const result = createResult();
    if (field === "lazy") result.info.lazy = value;
    if (field === "persisted info") result.info.persisted = value;
    if (field === "resumable info") result.info.resumable = value;
    if (field === "runtime") result.info.runtime = value;
    if (field === "state") result.info.state = value;
    if (field === "top-level persisted") result.persisted = value;
    if (field === "top-level resumable") result.resumable = value;
    if (field === "message_count") result.message_count = value as number;
    if (field === "messages") result.messages = value as unknown[];
    const manager = fakeManager(result);
    const adapter = new HermesRuntimeAdapter(() => manager.port);

    await expect(adapter.create(launchInput())).rejects.toMatchObject({
      code: "HERMES_RUNTIME_QUARANTINE_VIOLATION",
    });

    expect(manager.stop).toHaveBeenCalledTimes(1);
  });

  it("does not publish a result whose getter synchronously disposes the adapter", async () => {
    const result = createResult();
    const info = result.info;
    let adapter!: HermesRuntimeAdapter;
    let disposing!: Promise<void>;
    Object.defineProperty(result, "info", {
      get() {
        disposing = adapter.dispose();
        return info;
      },
    });
    const manager = fakeManager(result);
    adapter = new HermesRuntimeAdapter(() => manager.port);

    await expect(adapter.create(launchInput())).rejects.toMatchObject({
      code: "HERMES_RUNTIME_DISPOSED",
    });
    await expect(disposing).resolves.toBeUndefined();
    expect(manager.stop).toHaveBeenCalledOnce();
  });

  it.each([
    "relative/path",
    "",
    "LC_CANARY_SECRET",
  ])("rejects an invalid workspace before invoking the factory: %s", async (workspaceRoot) => {
    const factory = vi.fn<HermesRuntimeManagerFactory>();
    const adapter = new HermesRuntimeAdapter(factory);

    const error = await adapter
      .create(launchInput({ workspaceRoot }))
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "HERMES_RUNTIME_INVALID_INPUT",
      message: "Hermes runtime launch context is invalid",
    });
    expect(JSON.stringify(error)).not.toContain("LC_CANARY_SECRET");
    expect(factory).not.toHaveBeenCalled();
  });

  it("quarantines stream and interrupt before binding lookup with zero manager RPC", async () => {
    const factory = vi.fn<HermesRuntimeManagerFactory>();
    const adapter = new HermesRuntimeAdapter(factory);
    const unknown = runtimeBinding("unknown", "ffffffff");

    await expect(adapter.stream(unknown, "hello", vi.fn())).rejects.toMatchObject({
      code: "RUNTIME_OPERATION_QUARANTINED",
      operation: "stream",
    });
    await expect(adapter.interrupt(unknown)).rejects.toMatchObject({
      code: "RUNTIME_OPERATION_QUARANTINED",
      operation: "interrupt",
    });

    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects resume before any binding lookup or manager construction", async () => {
    const factory = vi.fn<HermesRuntimeManagerFactory>();
    const adapter = new HermesRuntimeAdapter(factory);

    await expect(
      adapter.resume({ ...launchInput(), durableRuntimeSessionId: STORED_ONE }),
    ).rejects.toMatchObject({
      name: "RuntimeResumeUnsupportedError",
      runtimeKind: "hermes",
    });

    expect(factory).not.toHaveBeenCalled();
  });

  it("coalesces concurrent close calls into one remote close and one stop", async () => {
    const close = deferred<{ closed: boolean }>();
    const manager = fakeManager();
    manager.request.mockImplementation(async (method) => {
      if (method === "session.create") return createResult();
      if (method === "session.close") return close.promise;
      throw new Error("unexpected rpc");
    });
    const adapter = new HermesRuntimeAdapter(() => manager.port);
    const binding = await adapter.create(launchInput());

    const first = adapter.close(binding);
    const second = adapter.close(binding);
    await vi.waitFor(() => expect(manager.request).toHaveBeenCalledTimes(2));
    expect(manager.stop).not.toHaveBeenCalled();
    close.resolve({ closed: true });

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(manager.request).toHaveBeenCalledWith("session.close", { session_id: LIVE_ONE });
    expect(manager.stop).toHaveBeenCalledTimes(1);
  });

  it("always stops after a close RPC failure and returns a sanitized close error", async () => {
    const manager = fakeManager();
    manager.request.mockImplementation(async (method) => {
      if (method === "session.create") return createResult();
      throw new Error("LC_CANARY_SECRET");
    });
    const adapter = new HermesRuntimeAdapter(() => manager.port);
    const binding = await adapter.create(launchInput());

    const error = await adapter.close(binding).catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "HERMES_RUNTIME_CLOSE_FAILED",
      message: "Hermes runtime session close failed",
    });
    expect(JSON.stringify(error)).not.toContain("LC_CANARY_SECRET");
    expect(manager.stop).toHaveBeenCalledTimes(1);
  });

  it("never repeats remote close while retrying a failed stop", async () => {
    const manager = fakeManager();
    manager.request.mockImplementation(async (method) => {
      if (method === "session.create") return createResult();
      throw new Error("close-secret");
    });
    manager.stop.mockRejectedValueOnce(new Error("stop-secret")).mockResolvedValueOnce(undefined);
    const adapter = new HermesRuntimeAdapter(() => manager.port);
    const binding = await adapter.create(launchInput());

    await expect(adapter.close(binding)).rejects.toMatchObject({
      code: "HERMES_RUNTIME_CLEANUP_FAILED",
    });
    await expect(adapter.close(binding)).rejects.toMatchObject({
      code: "HERMES_RUNTIME_CLOSE_FAILED",
    });

    expect(
      manager.request.mock.calls.filter(([method]) => method === "session.close"),
    ).toHaveLength(1);
    expect(manager.stop).toHaveBeenCalledTimes(2);
  });

  it("disposes all managers before reporting residual cleanup and retries only residual work", async () => {
    const first = fakeManager(createResult({ session_id: LIVE_ONE }));
    const second = fakeManager(
      createResult({ session_id: LIVE_TWO, stored_session_id: "20260712_111111_bcdefa" }),
    );
    first.stop
      .mockRejectedValueOnce(new Error("first-stop-secret"))
      .mockResolvedValueOnce(undefined);
    const managers = [first.port, second.port];
    const factory = vi.fn(() => managers.shift() as HermesRuntimeManagerPort);
    const adapter = new HermesRuntimeAdapter(factory);
    await adapter.create(launchInput());
    await adapter.create(launchInput({ canonicalSessionId: "canonical-2", runId: "run-2" }));

    await expect(adapter.dispose()).rejects.toMatchObject({
      code: "HERMES_RUNTIME_CLEANUP_FAILED",
    });
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(second.stop).toHaveBeenCalledTimes(1);

    await expect(adapter.dispose()).resolves.toBeUndefined();
    expect(first.stop).toHaveBeenCalledTimes(2);
    expect(second.stop).toHaveBeenCalledTimes(1);
    await expect(adapter.create(launchInput())).rejects.toMatchObject({
      code: "HERMES_RUNTIME_DISPOSED",
    });
  });

  it("wakes a create blocked in start when dispose confirms process cleanup", async () => {
    const start = deferred<void>();
    const manager = fakeManager();
    manager.start.mockImplementationOnce(() => start.promise);
    const adapter = new HermesRuntimeAdapter(() => manager.port);
    const creating = adapter.create(launchInput());
    let createError: unknown;
    let settled = false;
    void creating.catch((error: unknown) => {
      createError = error;
      settled = true;
    });
    await vi.waitFor(() => expect(manager.start).toHaveBeenCalledOnce());

    await expect(adapter.dispose()).resolves.toBeUndefined();
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 100 });
    expect(createError).toMatchObject({ code: "HERMES_RUNTIME_DISPOSED" });
    expect(manager.stop).toHaveBeenCalledOnce();

    start.resolve(undefined);
    await Promise.resolve();
    expect(manager.stop).toHaveBeenCalledOnce();
  });

  it("registers cleanup ownership before a close RPC can synchronously reenter", async () => {
    const manager = fakeManager();
    const adapter = new HermesRuntimeAdapter(() => manager.port);
    const binding = await adapter.create(launchInput());
    let nestedClose: Promise<void> | undefined;
    let reentered = false;
    manager.request.mockImplementation((method) => {
      if (method === "session.close") {
        if (!reentered) {
          reentered = true;
          nestedClose = adapter.close(binding);
        }
        return Promise.resolve({ closed: true });
      }
      throw new Error("unexpected rpc");
    });

    const closing = adapter.close(binding);
    await expect(Promise.all([closing, nestedClose])).resolves.toEqual([undefined, undefined]);
    expect(nestedClose).toBe(closing);
    expect(
      manager.request.mock.calls.filter(([method]) => method === "session.close"),
    ).toHaveLength(1);
    expect(manager.stop).toHaveBeenCalledOnce();
  });

  it("registers dispose ownership before stop can synchronously reenter", async () => {
    const manager = fakeManager();
    const adapter = new HermesRuntimeAdapter(() => manager.port);
    await adapter.create(launchInput());
    manager.crash(new Error("process-secret"));
    let nestedDispose: Promise<void> | undefined;
    let reentered = false;
    manager.stop.mockImplementation(() => {
      if (!reentered) {
        reentered = true;
        nestedDispose = adapter.dispose();
      }
      return Promise.resolve();
    });

    const disposing = adapter.dispose();
    await expect(disposing).resolves.toBeUndefined();
    expect(nestedDispose).toBe(disposing);
    expect(manager.stop).toHaveBeenCalledOnce();
  });

  it("fails closed when stop directly returns the owning dispose promise", async () => {
    const manager = fakeManager();
    const adapter = new HermesRuntimeAdapter(() => manager.port);
    await adapter.create(launchInput());
    manager.crash(new Error("process-secret"));
    manager.stop.mockImplementation(() => adapter.dispose());
    let error: unknown;
    let settled = false;

    void adapter.dispose().catch((cause: unknown) => {
      error = cause;
      settled = true;
    });

    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 100 });
    expect(error).toMatchObject({ code: "HERMES_RUNTIME_CLEANUP_FAILED" });
    expect(manager.stop).toHaveBeenCalledOnce();
  });

  it("fails closed when stop directly returns the owning close promise", async () => {
    const manager = fakeManager();
    const adapter = new HermesRuntimeAdapter(() => manager.port);
    const binding = await adapter.create(launchInput());
    manager.stop.mockImplementation(() => adapter.close(binding));
    let error: unknown;
    let settled = false;

    void adapter.close(binding).catch((cause: unknown) => {
      error = cause;
      settled = true;
    });

    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 100 });
    expect(error).toMatchObject({ code: "HERMES_RUNTIME_CLEANUP_FAILED" });
    expect(manager.stop).toHaveBeenCalledOnce();
  });

  it("reports a crash before create publishes with a null binding", async () => {
    const manager = fakeManager();
    manager.onCrash.mockImplementation((listener) => {
      void listener(new Error("LC_CANARY_SECRET") as never);
      return vi.fn();
    });
    const adapter = new HermesRuntimeAdapter(() => manager.port);
    const crashes: RuntimeCrash[] = [];
    adapter.onCrash((crash) => crashes.push(crash));

    await expect(adapter.create(launchInput())).rejects.toMatchObject({
      code: "HERMES_RUNTIME_CRASHED",
    });

    expect(crashes).toHaveLength(1);
    expect(crashes[0]).toMatchObject({ runtimeKind: "hermes", binding: null });
    expect(JSON.stringify(crashes[0])).not.toContain("LC_CANARY_SECRET");
    expect(manager.start).not.toHaveBeenCalled();
    expect(manager.stop).toHaveBeenCalledTimes(1);
  });

  it("rejects a create when the sidecar crashes after request dispatch and ignores a late result", async () => {
    const create = deferred<MutableCreateResult>();
    const manager = fakeManager();
    manager.request.mockImplementation(async (method) => {
      if (method === "session.create") return create.promise;
      throw new Error("unexpected rpc");
    });
    const adapter = new HermesRuntimeAdapter(() => manager.port);
    const crashes: RuntimeCrash[] = [];
    adapter.onCrash((crash) => crashes.push(crash));

    const pending = adapter.create(launchInput());
    await vi.waitFor(() => expect(manager.request).toHaveBeenCalledWith("session.create", {}));
    manager.crash(new Error("process-secret"));

    await expect(pending).rejects.toMatchObject({ code: "HERMES_RUNTIME_CRASHED" });
    expect(crashes).toHaveLength(1);
    expect(crashes[0]?.binding).toBeNull();
    expect(manager.stop).toHaveBeenCalledTimes(1);

    create.resolve(createResult());
    await Promise.resolve();
    expect(crashes).toHaveLength(1);
  });

  it("reports a post-publish crash once with the exact binding and isolates observers", async () => {
    const manager = fakeManager();
    const adapter = new HermesRuntimeAdapter(() => manager.port);
    const received: RuntimeCrash[] = [];
    adapter.onCrash(() => {
      throw new Error("observer-secret");
    });
    adapter.onCrash((crash) => received.push(crash));
    const binding = await adapter.create(launchInput());

    manager.crash(new Error("process-secret"));
    manager.crash(new Error("duplicate-secret"));

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ runtimeKind: "hermes", binding });
    expect(JSON.stringify(received[0])).not.toMatch(/process-secret|duplicate-secret/);

    await adapter.close(binding);
    expect(
      manager.request.mock.calls.filter(([method]) => method === "session.close"),
    ).toHaveLength(0);
    expect(manager.stop).toHaveBeenCalledTimes(1);
  });

  it("does not let one crash observer mutate the error seen by another observer", async () => {
    const manager = fakeManager();
    const adapter = new HermesRuntimeAdapter(() => manager.port);
    let received: RuntimeCrash | undefined;
    adapter.onCrash((crash) => {
      (crash.error as Error).message = "LC_CANARY_SECRET";
    });
    adapter.onCrash((crash) => {
      received = crash;
    });
    await adapter.create(launchInput());

    manager.crash(new Error("process-secret"));

    expect(received?.error).toMatchObject({
      code: "HERMES_RUNTIME_CRASHED",
      message: "Hermes runtime sidecar crashed",
    });
    expect(JSON.stringify(received)).not.toContain("LC_CANARY_SECRET");
  });

  it("permanently tombstones published canonical and task/run identities", async () => {
    const first = fakeManager();
    const second = fakeManager();
    const managers = [first.port, second.port];
    const factory = vi.fn(() => managers.shift() as HermesRuntimeManagerPort);
    const adapter = new HermesRuntimeAdapter(factory);
    const oldBinding = await adapter.create(launchInput());
    await adapter.close(oldBinding);

    await expect(adapter.create(launchInput({ runId: "run-2" }))).rejects.toMatchObject({
      code: "HERMES_RUNTIME_DUPLICATE_CREATE",
    });
    await expect(
      adapter.create(launchInput({ canonicalSessionId: "canonical-2" })),
    ).rejects.toMatchObject({ code: "HERMES_RUNTIME_DUPLICATE_CREATE" });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(second.start).not.toHaveBeenCalled();
    expect(second.stop).not.toHaveBeenCalled();
  });
});

interface MutableLaunchInput {
  canonicalSessionId: string;
  taskId: string;
  runId: string;
  workspaceRoot: string;
  provider: {
    profileId: string;
    model: string;
    apiMode: "chat_completions" | "codex_responses";
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
      model: "claude-sonnet-4",
      apiMode: "chat_completions",
    },
    ...overrides,
  };
}

interface MutableCreateResult {
  session_id: string;
  stored_session_id: string;
  message_count: number;
  messages: unknown[];
  persisted: unknown;
  resumable: unknown;
  info: Record<string, unknown>;
}

function createResult(overrides: Partial<MutableCreateResult> = {}): MutableCreateResult {
  return {
    session_id: LIVE_ONE,
    stored_session_id: STORED_ONE,
    message_count: 0,
    messages: [],
    persisted: false,
    resumable: false,
    info: {
      lazy: true,
      persisted: false,
      resumable: false,
      runtime: "hermes-quarantined",
      state: "quarantined",
    },
    ...overrides,
  };
}

interface FakeManager {
  port: HermesRuntimeManagerPort;
  start: ReturnType<typeof vi.fn<() => Promise<void>>>;
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
  request: ReturnType<typeof vi.fn>;
  onCrash: ReturnType<typeof vi.fn>;
  crash(error: Error): void;
}

function fakeManager(result = createResult()): FakeManager {
  const listeners = new Set<(error: never) => void | Promise<void>>();
  const start = vi.fn(async () => {});
  const stop = vi.fn(async () => {});
  const request = vi.fn(async (method: string) => {
    if (method === "session.create") return result;
    if (method === "session.close") return { closed: true };
    throw new Error("unexpected rpc");
  });
  const onCrash = vi.fn((listener: (error: never) => void | Promise<void>) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const port = { start, stop, request, onCrash } as unknown as HermesRuntimeManagerPort;
  return {
    port,
    start,
    stop,
    request,
    onCrash,
    crash(error) {
      for (const listener of listeners) void listener(error as never);
    },
  };
}

function runtimeBinding(canonicalSessionId: string, liveRuntimeSessionId: string): RuntimeBinding {
  return { canonicalSessionId, liveRuntimeSessionId, durableRuntimeSessionId: null };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
