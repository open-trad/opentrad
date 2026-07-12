import type { RuntimeBinding, RuntimeCreateInput } from "@opentrad/runtime-adapter";
import { describe, expect, it, vi } from "vitest";
import type { HermesSidecarManagerOptions } from "../src/main/services/hermes/sidecar-manager";
import {
  createExperimentalHermesQuarantineRuntime,
  HermesQuarantineCompositionError,
  type HermesQuarantineCompositionOptions,
} from "../src/main/services/hermes-quarantine-composition";
import type { HermesRuntimeManagerPort } from "../src/main/services/hermes-runtime-adapter";
import type {
  IssuedProviderCapability,
  ProviderBroker,
  ProviderBrokerEndpoint,
  ProviderCapabilityInput,
  ProviderCredentialLease,
} from "../src/main/services/provider-broker";

const LIVE_SESSION_ID = "deadbeef";
const STORED_SESSION_ID = "20260712_101010_abcdef";

describe("experimental Hermes quarantine composition", () => {
  it("exposes only the frozen quarantine facade and omits executable runtime methods", () => {
    const harness = createHarness();

    expect(Object.keys(harness.runtime).sort()).toEqual([
      "close",
      "create",
      "dispose",
      "kind",
      "onCrash",
      "ready",
    ]);
    expect(Object.isFrozen(harness.runtime)).toBe(true);
    expect(harness.runtime.kind).toBe("hermes");
    expect("stream" in harness.runtime).toBe(false);
    expect("interrupt" in harness.runtime).toBe(false);
    expect("resume" in harness.runtime).toBe(false);
    expect("request" in harness.runtime).toBe(false);
    expect("subscribe" in harness.runtime).toBe(false);
    type ExecutableKey = Extract<
      keyof typeof harness.runtime,
      "stream" | "interrupt" | "resume" | "request" | "subscribe"
    >;
    const noExecutableKey: ExecutableKey extends never ? true : false = true;
    expect(noExecutableKey).toBe(true);
  });

  it("reports readiness without starting the broker, acquiring credentials, or creating a manager", async () => {
    const harness = createHarness();

    await expect(harness.runtime.ready()).resolves.toEqual({
      version: "hermes-quarantine/1",
    });

    expect(harness.broker.start).not.toHaveBeenCalled();
    expect(harness.broker.issue).not.toHaveBeenCalled();
    expect(harness.acquireCredentialLease).not.toHaveBeenCalled();
    expect(harness.createManager).not.toHaveBeenCalled();
  });

  it("maps one launch into exact sidecar options without forwarding workspaceRoot", async () => {
    const harness = createHarness();
    const launch = launchInput();

    const binding = await harness.runtime.create(launch);

    expect(binding).toEqual({
      canonicalSessionId: "canonical-1",
      liveRuntimeSessionId: LIVE_SESSION_ID,
      durableRuntimeSessionId: null,
    });
    expect(harness.managerOptions).toHaveLength(1);
    const options = harness.managerOptions[0];
    expect(Object.keys(options).sort()).toEqual([
      "binding",
      "dataRoot",
      "issueCapability",
      "launcherPath",
    ]);
    expect(Object.isFrozen(options)).toBe(true);
    expect(options).toMatchObject({
      dataRoot: "/tmp/opentrad-hermes",
      launcherPath: "/Applications/OpenTrad/Hermes/launcher.py",
      binding: {
        taskId: "task-1",
        runId: "run-1",
        profileId: "profile-1",
        model: "claude-sonnet-4",
        apiMode: "chat_completions",
      },
    });
    expect("workspaceRoot" in options).toBe(false);
    expect(harness.managers[0]?.request).toHaveBeenCalledWith("session.create", {});
    expect(harness.broker.start).not.toHaveBeenCalled();
  });

  it("creates one manager per task/run and permits process-local live ID reuse", async () => {
    const harness = createHarness();

    const first = await harness.runtime.create(launchInput());
    const second = await harness.runtime.create(
      launchInput({ canonicalSessionId: "canonical-2", taskId: "task-2", runId: "run-2" }),
    );

    expect(first.liveRuntimeSessionId).toBe(LIVE_SESSION_ID);
    expect(second.liveRuntimeSessionId).toBe(LIVE_SESSION_ID);
    expect(harness.createManager).toHaveBeenCalledTimes(2);
    expect(harness.managers[0]?.port).not.toBe(harness.managers[1]?.port);
  });

  it("integrates the provider issuer with the snapshotted broker receiver", async () => {
    const broker = statefulBroker();
    const managerOptions: HermesSidecarManagerOptions[] = [];
    let capabilityLease: Awaited<
      ReturnType<HermesSidecarManagerOptions["issueCapability"]>
    > | null = null;
    const manager = fakeManager({
      start: async () => {
        const options = managerOptions[0];
        if (!options) throw new Error("missing manager options");
        capabilityLease = await options.issueCapability(options.binding);
      },
      stop: async () => {
        capabilityLease?.revoke();
      },
    });
    const createManager = vi.fn((options: HermesSidecarManagerOptions) => {
      managerOptions.push(options);
      return manager.port;
    });
    const runtime = createExperimentalHermesQuarantineRuntime(
      compositionOptions({ broker: broker.port, createManager }),
    );

    const binding = await runtime.create(launchInput());
    await runtime.close(binding);

    expect(managerOptions).toHaveLength(1);
    expect(broker.start).toHaveBeenCalledOnce();
    expect(broker.issue).toHaveBeenCalledWith(
      {
        taskId: "task-1",
        runId: "run-1",
        profileId: "profile-1",
        model: "claude-sonnet-4",
        apiMode: "chat_completions",
        ttlMs: 30_000,
      },
      { secrets: [] },
    );
    expect(broker.revoke).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001");
    expect(broker.receiverChecks).toEqual([true, true, true]);
  });

  it("keeps failures in quarantine and never attempts a legacy fallback", async () => {
    const createManager = vi.fn(() => {
      throw new Error("LC_CANARY_SECRET");
    });
    const runtime = createExperimentalHermesQuarantineRuntime(
      compositionOptions({ createManager }),
    );

    const error = await runtime.create(launchInput()).catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "HERMES_RUNTIME_CREATE_FAILED",
      message: "Hermes runtime session creation failed",
    });
    expect(JSON.stringify(error)).not.toContain("LC_CANARY_SECRET");
    expect(createManager).toHaveBeenCalledOnce();
  });

  it("closes the session and sidecar without closing the shared broker", async () => {
    const order: string[] = [];
    const harness = createHarness({ order });
    const binding = await harness.runtime.create(launchInput());

    await harness.runtime.close(binding);

    expect(order).toEqual(["manager:session.close", "manager:stop"]);
    expect(harness.broker.close).not.toHaveBeenCalled();
  });

  it("disposes every sidecar before closing the broker", async () => {
    const order: string[] = [];
    const harness = createHarness({ order });
    await harness.runtime.create(launchInput());
    await harness.runtime.create(
      launchInput({ canonicalSessionId: "canonical-2", taskId: "task-2", runId: "run-2" }),
    );

    await harness.runtime.dispose();

    expect(order.filter((entry) => entry === "manager:stop")).toHaveLength(2);
    expect(order.at(-1)).toBe("broker:close");
    expect(harness.broker.close).toHaveBeenCalledOnce();
  });

  it("still closes the broker when sidecar cleanup fails and retries only residual cleanup", async () => {
    const order: string[] = [];
    let stopAttempts = 0;
    const harness = createHarness({
      order,
      managerOverrides: {
        stop: async () => {
          stopAttempts += 1;
          if (stopAttempts === 1) throw new Error("LC_CANARY_SECRET");
        },
      },
    });
    await harness.runtime.create(launchInput());

    await expect(harness.runtime.dispose()).rejects.toMatchObject({
      code: "HERMES_QUARANTINE_COMPOSITION_CLEANUP_FAILED",
      message: "Hermes quarantine composition cleanup could not be confirmed",
    });
    expect(order).toEqual(["manager:session.close", "manager:stop", "broker:close"]);

    await expect(harness.runtime.dispose()).resolves.toBeUndefined();
    expect(stopAttempts).toBe(2);
    expect(harness.broker.close).toHaveBeenCalledOnce();
  });

  it("does not redispose sidecars when only broker cleanup needs a retry", async () => {
    let closeAttempts = 0;
    const harness = createHarness({
      brokerClose: async () => {
        closeAttempts += 1;
        if (closeAttempts === 1) throw new Error("LC_CANARY_SECRET");
      },
    });
    await harness.runtime.create(launchInput());

    const firstError = await harness.runtime.dispose().catch((cause: unknown) => cause);
    expect(firstError).toMatchObject({
      code: "HERMES_QUARANTINE_COMPOSITION_CLEANUP_FAILED",
    });
    expect(JSON.stringify(firstError)).not.toContain("LC_CANARY_SECRET");
    expect(harness.managers[0]?.stop).toHaveBeenCalledOnce();

    await expect(harness.runtime.dispose()).resolves.toBeUndefined();
    expect(harness.managers[0]?.stop).toHaveBeenCalledOnce();
    expect(closeAttempts).toBe(2);
  });

  it("shares concurrent disposal and permits completed cleanup that ignored reentrant disposal", async () => {
    let reentrant: Promise<void> | undefined;
    let runtime!: ReturnType<typeof createExperimentalHermesQuarantineRuntime>;
    const broker = fakeBroker({
      close: () => {
        reentrant = runtime.dispose();
        return Promise.resolve();
      },
    });
    runtime = createExperimentalHermesQuarantineRuntime(compositionOptions({ broker }));

    const first = runtime.dispose();
    const second = runtime.dispose();

    expect(second).toBe(first);
    await expect(first).resolves.toBeUndefined();
    expect(reentrant).toBe(first);
  });

  it("fails closed when asynchronous cleanup reenters disposal before it completes", async () => {
    let runtime!: ReturnType<typeof createExperimentalHermesQuarantineRuntime>;
    const cleanupGate = deferred<void>();
    const broker = fakeBroker({
      close: () => {
        void runtime.dispose();
        return cleanupGate.promise;
      },
    });
    runtime = createExperimentalHermesQuarantineRuntime(compositionOptions({ broker }));

    await expect(runtime.dispose()).rejects.toMatchObject({
      code: "HERMES_QUARANTINE_COMPOSITION_CLEANUP_FAILED",
    });
    cleanupGate.resolve();
  });

  it("fails closed instead of awaiting a broker cleanup that returns the owning dispose promise", async () => {
    let runtime!: ReturnType<typeof createExperimentalHermesQuarantineRuntime>;
    const broker = fakeBroker({ close: () => runtime.dispose() });
    runtime = createExperimentalHermesQuarantineRuntime(compositionOptions({ broker }));

    await expect(runtime.dispose()).rejects.toMatchObject({
      code: "HERMES_QUARANTINE_COMPOSITION_CLEANUP_FAILED",
    });
  });

  it("fails closed when broker cleanup adopts the owning dispose promise through a chain", async () => {
    let runtime!: ReturnType<typeof createExperimentalHermesQuarantineRuntime>;
    const broker = fakeBroker({
      close: () => Promise.resolve().then(() => runtime.dispose()),
    });
    runtime = createExperimentalHermesQuarantineRuntime(compositionOptions({ broker }));

    const outcome = await Promise.race([
      runtime.dispose().then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ readonly kind: "timeout" }>((resolve) => {
        setTimeout(() => resolve({ kind: "timeout" }), 50);
      }),
    ]);

    expect(outcome).toMatchObject({
      kind: "rejected",
      error: { code: "HERMES_QUARANTINE_COMPOSITION_CLEANUP_FAILED" },
    });
  });

  it("fails closed when broker cleanup adopts an owner captured before cleanup", async () => {
    let owner!: Promise<void>;
    const broker = fakeBroker({ close: async () => owner });
    const runtime = createExperimentalHermesQuarantineRuntime(compositionOptions({ broker }));

    owner = runtime.dispose();
    const outcome = await Promise.race([
      owner.then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ readonly kind: "timeout" }>((resolve) => {
        setTimeout(() => resolve({ kind: "timeout" }), 50);
      }),
    ]);

    expect(outcome).toMatchObject({
      kind: "rejected",
      error: { code: "HERMES_QUARANTINE_COMPOSITION_CLEANUP_FAILED" },
    });
  });

  it("fails closed when broker cleanup directly awaits an owner captured before cleanup", async () => {
    let owner!: Promise<void>;
    const broker = fakeBroker({
      close: async () => {
        await owner;
      },
    });
    const runtime = createExperimentalHermesQuarantineRuntime(compositionOptions({ broker }));

    owner = runtime.dispose();
    const outcome = await Promise.race([
      owner.then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ readonly kind: "timeout" }>((resolve) => {
        setTimeout(() => resolve({ kind: "timeout" }), 50);
      }),
    ]);

    expect(outcome).toMatchObject({
      kind: "rejected",
      error: { code: "HERMES_QUARANTINE_COMPOSITION_CLEANUP_FAILED" },
    });
  });

  it("fails closed when an injected manager stop adopts the owning dispose promise", async () => {
    let runtime!: ReturnType<typeof createExperimentalHermesQuarantineRuntime>;
    const harness = createHarness({
      managerOverrides: {
        stop: () => Promise.resolve().then(() => runtime.dispose()),
      },
    });
    runtime = harness.runtime;
    await runtime.create(launchInput());

    const outcome = await Promise.race([
      runtime.dispose().then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ readonly kind: "timeout" }>((resolve) => {
        setTimeout(() => resolve({ kind: "timeout" }), 50);
      }),
    ]);

    expect(outcome).toMatchObject({
      kind: "rejected",
      error: { code: "HERMES_QUARANTINE_COMPOSITION_CLEANUP_FAILED" },
    });
  });

  it("fails closed when manager cleanup adopts an owner captured before cleanup", async () => {
    let owner!: Promise<void>;
    const harness = createHarness({
      managerOverrides: { stop: async () => owner },
    });
    const runtime = harness.runtime;
    await runtime.create(launchInput());

    owner = runtime.dispose();
    const outcome = await Promise.race([
      owner.then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ readonly kind: "timeout" }>((resolve) => {
        setTimeout(() => resolve({ kind: "timeout" }), 50);
      }),
    ]);

    expect(outcome).toMatchObject({
      kind: "rejected",
      error: { code: "HERMES_QUARANTINE_COMPOSITION_CLEANUP_FAILED" },
    });
  });

  it("blocks a capability issue that resumes after disposal closed the broker", async () => {
    const credentialGate = deferred<ProviderCredentialLease>();
    const brokerStarted = deferred<void>();
    const broker = fakeBroker();
    broker.start.mockImplementation(async () => {
      brokerStarted.resolve();
      return { host: "127.0.0.1", port: 31_337 } as const;
    });
    const createManager = vi.fn(
      (options: HermesSidecarManagerOptions) =>
        fakeManager({
          start: async () => {
            await options.issueCapability(options.binding);
          },
        }).port,
    );
    const runtime = createExperimentalHermesQuarantineRuntime(
      compositionOptions({
        broker,
        acquireCredentialLease: () => credentialGate.promise,
        createManager,
      }),
    );
    const createPromise = runtime.create(launchInput()).catch((error: unknown) => error);
    await brokerStarted.promise;

    await runtime.dispose();
    credentialGate.resolve({ secrets: ["LC_CANARY_SECRET"] });
    await createPromise;
    await Promise.resolve();
    await Promise.resolve();

    expect(broker.close).toHaveBeenCalledOnce();
    expect(broker.issue).not.toHaveBeenCalled();
  });

  it("rejects all new operations once disposal owns the composition", async () => {
    const closeGate = deferred<void>();
    const harness = createHarness({ brokerClose: () => closeGate.promise });
    const disposePromise = harness.runtime.dispose();

    await expect(harness.runtime.ready()).rejects.toMatchObject({
      code: "HERMES_QUARANTINE_COMPOSITION_DISPOSED",
    });
    await expect(harness.runtime.create(launchInput())).rejects.toMatchObject({
      code: "HERMES_QUARANTINE_COMPOSITION_DISPOSED",
    });
    await expect(harness.runtime.close(runtimeBinding())).rejects.toMatchObject({
      code: "HERMES_QUARANTINE_COMPOSITION_DISPOSED",
    });
    expect(() => harness.runtime.onCrash(() => {})).toThrowError(
      expect.objectContaining({ code: "HERMES_QUARANTINE_COMPOSITION_DISPOSED" }),
    );
    expect(harness.createManager).not.toHaveBeenCalled();

    closeGate.resolve();
    await disposePromise;
  });

  it("routes crash notifications through the narrow facade", async () => {
    const harness = createHarness();
    const listener = vi.fn();
    const unsubscribe = harness.runtime.onCrash(listener);
    await harness.runtime.create(launchInput());

    harness.managers[0]?.crash();

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeKind: "hermes",
        error: expect.objectContaining({ code: "HERMES_RUNTIME_CRASHED" }),
      }),
    );
    unsubscribe();
  });

  it("rejects hostile configuration getters with one frozen fixed error", () => {
    const options = new Proxy(
      {},
      {
        get(_target, property): unknown {
          if (property === "dataRoot") throw new Error("LC_CANARY_SECRET");
          return undefined;
        },
      },
    );

    let error: unknown;
    try {
      createExperimentalHermesQuarantineRuntime(options as HermesQuarantineCompositionOptions);
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(HermesQuarantineCompositionError);
    expect(error).toMatchObject({
      code: "HERMES_QUARANTINE_COMPOSITION_INVALID_CONFIGURATION",
      message: "Hermes quarantine composition configuration is invalid",
    });
    expect(Object.isFrozen(error)).toBe(true);
    expect(JSON.stringify(error)).not.toContain("LC_CANARY_SECRET");
  });
});

interface FakeManagerOverrides {
  readonly start?: (options: HermesSidecarManagerOptions) => Promise<void>;
  readonly stop?: () => Promise<void>;
}

function createHarness(
  input: {
    readonly brokerClose?: () => Promise<void>;
    readonly managerOverrides?: FakeManagerOverrides;
    readonly order?: string[];
  } = {},
) {
  const order = input.order ?? [];
  const broker = fakeBroker({
    close: async () => {
      order.push("broker:close");
      await input.brokerClose?.();
    },
  });
  const acquireCredentialLease = vi.fn(async () => ({ secrets: [] }) as const);
  const managerOptions: HermesSidecarManagerOptions[] = [];
  const managers: ReturnType<typeof fakeManager>[] = [];
  const createManager = vi.fn((options: HermesSidecarManagerOptions) => {
    managerOptions.push(options);
    const manager = fakeManager({
      start: input.managerOverrides?.start
        ? () => input.managerOverrides?.start?.(options) ?? Promise.resolve()
        : undefined,
      stop: input.managerOverrides?.stop,
      order,
    });
    managers.push(manager);
    return manager.port;
  });
  const runtime = createExperimentalHermesQuarantineRuntime(
    compositionOptions({ broker, acquireCredentialLease, createManager }),
  );
  return {
    runtime,
    broker,
    acquireCredentialLease,
    createManager,
    managerOptions,
    managers,
  };
}

function compositionOptions(
  overrides: Partial<HermesQuarantineCompositionOptions> = {},
): HermesQuarantineCompositionOptions {
  return {
    dataRoot: "/tmp/opentrad-hermes",
    launcherPath: "/Applications/OpenTrad/Hermes/launcher.py",
    broker: fakeBroker(),
    acquireCredentialLease: async () => ({ secrets: [] }),
    capabilityTtlMs: 30_000,
    ...overrides,
  };
}

function fakeManager(overrides: FakeManagerOverrides & { readonly order?: string[] } = {}) {
  let crashListener: (() => void) | undefined;
  const start = vi.fn(async () => {
    // A test that needs the real issuer path supplies its own start closure.
  });
  const stop = vi.fn(async () => {
    overrides.order?.push("manager:stop");
    await overrides.stop?.();
  });
  const request = vi.fn(async (method: string) => {
    if (method === "session.close") {
      overrides.order?.push("manager:session.close");
      return { closed: true };
    }
    return createResult();
  });
  const onCrash = vi.fn((listener: () => void) => {
    crashListener = listener;
    return () => {
      if (crashListener === listener) crashListener = undefined;
    };
  });
  if (overrides.start) start.mockImplementation(async () => overrides.start?.(null as never));
  const port = Object.freeze({ start, stop, request, onCrash }) as HermesRuntimeManagerPort;
  return { port, start, stop, request, onCrash, crash: () => crashListener?.() };
}

function fakeBroker(overrides: { readonly close?: () => Promise<void> } = {}): Pick<
  ProviderBroker,
  "start" | "issue" | "revoke" | "close"
> & {
  readonly start: ReturnType<typeof vi.fn>;
  readonly issue: ReturnType<typeof vi.fn>;
  readonly revoke: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn(async () => ({ host: "127.0.0.1", port: 31_337 }) as const),
    issue: vi.fn(() => issuedCapability()),
    revoke: vi.fn(),
    close: vi.fn(overrides.close ?? (async () => {})),
  } as never;
}

function statefulBroker() {
  const receiverChecks: boolean[] = [];
  const receiver = {
    start: vi.fn(function (this: unknown): Promise<ProviderBrokerEndpoint> {
      receiverChecks.push(this === receiver);
      return Promise.resolve({ host: "127.0.0.1", port: 31_337 });
    }),
    issue: vi.fn(function (
      this: unknown,
      _input: ProviderCapabilityInput,
      _lease: ProviderCredentialLease,
    ): IssuedProviderCapability {
      receiverChecks.push(this === receiver);
      return issuedCapability();
    }),
    revoke: vi.fn(function (this: unknown, _capabilityId: string): void {
      receiverChecks.push(this === receiver);
    }),
    close: vi.fn(async function (this: unknown): Promise<void> {
      if (this !== receiver) throw new Error("wrong receiver");
    }),
  };
  return {
    port: receiver as Pick<ProviderBroker, "start" | "issue" | "revoke" | "close">,
    start: receiver.start,
    issue: receiver.issue,
    revoke: receiver.revoke,
    close: receiver.close,
    receiverChecks,
  };
}

function issuedCapability(): IssuedProviderCapability {
  return {
    capabilityId: "00000000-0000-4000-8000-000000000001",
    token: "a".repeat(32),
    expiresAt: Math.floor(Date.now() / 1_000) + 60,
  };
}

function createResult() {
  return {
    session_id: LIVE_SESSION_ID,
    stored_session_id: STORED_SESSION_ID,
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
  };
}

function launchInput(overrides: Partial<RuntimeCreateInput> = {}): RuntimeCreateInput {
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

function runtimeBinding(): RuntimeBinding {
  return {
    canonicalSessionId: "canonical-1",
    liveRuntimeSessionId: LIVE_SESSION_ID,
    durableRuntimeSessionId: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}
