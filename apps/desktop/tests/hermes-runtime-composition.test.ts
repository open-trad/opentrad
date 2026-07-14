import { PassThrough } from "node:stream";
import type { RuntimeCreateInput, RuntimeEvent } from "@opentrad/runtime-adapter";
import { describe, expect, it, vi } from "vitest";
import type { HermesGatewayNotification } from "../src/main/services/hermes/gateway-client";
import type { HermesSidecarManagerOptions } from "../src/main/services/hermes/sidecar-manager";
import type { HermesRuntimeManagerPort } from "../src/main/services/hermes-runtime-adapter";
import {
  createHermesRuntimeComposition,
  HermesRuntimeCompositionError,
} from "../src/main/services/hermes-runtime-composition";

describe("native Hermes runtime composition", () => {
  it("reports ready without starting a sidecar or reading profile secrets", async () => {
    const harness = compositionHarness();

    await expect(harness.runtime.ready()).resolves.toEqual({ version: "hermes-agent/0.18.2" });

    expect(harness.createManager).not.toHaveBeenCalled();
    expect(harness.acquireProfileSecrets).not.toHaveBeenCalled();
  });

  it("shares one persistent local sidecar across sessions in the same Profile", async () => {
    const harness = compositionHarness();
    const first = await harness.runtime.create(launchInput());
    const second = await harness.runtime.create(
      launchInput({ canonicalSessionId: "canonical-2", taskId: "task-2", runId: "run-2" }),
    );

    expect(harness.createManager).toHaveBeenCalledTimes(1);
    expect(harness.managers[0]?.start).toHaveBeenCalledTimes(1);
    expect(harness.managers[0]?.request).toHaveBeenCalledWith(
      "session.create",
      expect.objectContaining({ cwd: "/workspace/project" }),
    );
    expect(harness.managers[0]?.request).toHaveBeenCalledTimes(2);

    await Promise.all([harness.runtime.close(first), harness.runtime.close(second)]);

    expect(harness.managers[0]?.request).toHaveBeenCalledWith("session.close", {
      session_id: first.liveRuntimeSessionId,
    });
    expect(harness.managers[0]?.request).toHaveBeenCalledWith("session.close", {
      session_id: second.liveRuntimeSessionId,
    });
    expect(harness.managers[0]?.stop).not.toHaveBeenCalled();

    await harness.runtime.dispose();
    expect(harness.managers[0]?.stop).toHaveBeenCalledTimes(1);
  });

  it("uses one local sidecar per Profile", async () => {
    const harness = compositionHarness();

    await harness.runtime.create(launchInput());
    await harness.runtime.create(
      launchInput({
        canonicalSessionId: "canonical-2",
        taskId: "task-2",
        runId: "run-2",
        provider: { ...launchInput().provider, profileId: "profile-2" },
      }),
    );

    expect(harness.createManager).toHaveBeenCalledTimes(2);
    await harness.runtime.dispose();
  });

  it("stops and replaces a Profile sidecar when that Profile is invalidated", async () => {
    const harness = compositionHarness();
    const first = await harness.runtime.create(launchInput());
    const second = await harness.runtime.create(
      launchInput({ canonicalSessionId: "canonical-2", taskId: "task-2", runId: "run-2" }),
    );

    expect(harness.runtime.invalidateProfile).toBeTypeOf("function");
    await harness.runtime.invalidateProfile?.("profile-1");

    expect(harness.managers[0]?.request).toHaveBeenCalledWith("session.close", {
      session_id: first.liveRuntimeSessionId,
    });
    expect(harness.managers[0]?.request).toHaveBeenCalledWith("session.close", {
      session_id: second.liveRuntimeSessionId,
    });
    expect(harness.managers[0]?.stop).toHaveBeenCalledTimes(1);
    await expect(harness.runtime.stream(first, "stale", () => {})).rejects.toMatchObject({
      code: "HERMES_RUNTIME_UNKNOWN_SESSION",
    });

    await harness.runtime.create(
      launchInput({ canonicalSessionId: "canonical-3", taskId: "task-3", runId: "run-3" }),
    );
    expect(harness.createManager).toHaveBeenCalledTimes(2);

    await harness.runtime.dispose();
  });

  it("shards Docker sidecars by canonical workspace", async () => {
    const harness = compositionHarness();
    const dockerProvider = {
      ...launchInput().provider,
      executionBackend: "docker" as const,
    };

    await harness.runtime.create(launchInput({ provider: dockerProvider }));
    await harness.runtime.create(
      launchInput({
        canonicalSessionId: "canonical-2",
        taskId: "task-2",
        runId: "run-2",
        workspaceRoot: "/workspace/other",
        provider: dockerProvider,
      }),
    );

    expect(harness.createManager).toHaveBeenCalledTimes(2);
    await harness.runtime.dispose();
  });

  it("invalidates every Docker workspace for one Profile without stopping another Profile", async () => {
    const harness = compositionHarness();
    const dockerProvider = {
      ...launchInput().provider,
      executionBackend: "docker" as const,
    };
    await harness.runtime.create(launchInput({ provider: dockerProvider }));
    await harness.runtime.create(
      launchInput({
        canonicalSessionId: "canonical-2",
        taskId: "task-2",
        runId: "run-2",
        workspaceRoot: "/workspace/other",
        provider: dockerProvider,
      }),
    );
    await harness.runtime.create(
      launchInput({
        canonicalSessionId: "canonical-3",
        taskId: "task-3",
        runId: "run-3",
        provider: { ...dockerProvider, profileId: "profile-2" },
      }),
    );

    await requireProfileInvalidation(harness.runtime)("profile-1");

    expect(harness.managers[0]?.stop).toHaveBeenCalledTimes(1);
    expect(harness.managers[1]?.stop).toHaveBeenCalledTimes(1);
    expect(harness.managers[2]?.stop).not.toHaveBeenCalled();

    await harness.runtime.create(
      launchInput({
        canonicalSessionId: "canonical-4",
        taskId: "task-4",
        runId: "run-4",
        workspaceRoot: "/workspace/other",
        provider: dockerProvider,
      }),
    );
    expect(harness.createManager).toHaveBeenCalledTimes(4);
    await harness.runtime.dispose();
  });

  it("coalesces concurrent invalidation and blocks new leases until cleanup completes", async () => {
    const harness = compositionHarness();
    await harness.runtime.create(launchInput());
    const stopping = deferred<void>();
    harness.managers[0]?.stop.mockImplementationOnce(() => stopping.promise);
    const invalidateProfile = requireProfileInvalidation(harness.runtime);

    const first = invalidateProfile("profile-1");
    const second = invalidateProfile("profile-1");
    await expect(
      harness.runtime.create(
        launchInput({ canonicalSessionId: "canonical-2", taskId: "task-2", runId: "run-2" }),
      ),
    ).rejects.toMatchObject({ code: "HERMES_RUNTIME_CREATE_FAILED" });
    await vi.waitFor(() => expect(harness.managers[0]?.stop).toHaveBeenCalledTimes(1));

    stopping.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(harness.managers[0]?.stop).toHaveBeenCalledTimes(1);

    await harness.runtime.create(
      launchInput({ canonicalSessionId: "canonical-3", taskId: "task-3", runId: "run-3" }),
    );
    expect(harness.createManager).toHaveBeenCalledTimes(2);
    await harness.runtime.dispose();
  });

  it("keeps a Profile blocked after cleanup failure and succeeds on an explicit retry", async () => {
    const harness = compositionHarness();
    await harness.runtime.create(launchInput());
    harness.managers[0]?.stop.mockRejectedValueOnce(new Error("stop failed"));
    const invalidateProfile = requireProfileInvalidation(harness.runtime);

    await expect(invalidateProfile("profile-1")).rejects.toMatchObject({
      code: "HERMES_RUNTIME_COMPOSITION_CLEANUP_FAILED",
    });
    await expect(
      harness.runtime.create(
        launchInput({ canonicalSessionId: "canonical-2", taskId: "task-2", runId: "run-2" }),
      ),
    ).rejects.toMatchObject({ code: "HERMES_RUNTIME_CREATE_FAILED" });

    await expect(invalidateProfile("profile-1")).resolves.toBeUndefined();
    expect(harness.managers[0]?.stop).toHaveBeenCalledTimes(2);
    await harness.runtime.create(
      launchInput({ canonicalSessionId: "canonical-3", taskId: "task-3", runId: "run-3" }),
    );
    expect(harness.createManager).toHaveBeenCalledTimes(2);
    await harness.runtime.dispose();
  });

  it("passes a direct one-shot FD3 provider capability to the manager", async () => {
    const harness = compositionHarness();
    await harness.runtime.create(launchInput());
    const options = harness.managerOptions[0];
    expect(options).toBeDefined();

    const lease = await options?.issueCapability(options.binding);
    const pipe = new PassThrough();
    const chunks: Buffer[] = [];
    pipe.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    await lease?.transmit(pipe);

    expect(harness.acquireProfileSecrets).toHaveBeenCalledTimes(1);
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({
      v: 1,
      profileId: "profile-1",
      providerSlug: "anthropic",
      authMode: "api_key",
      apiMode: "chat_completions",
      executionBackend: "local",
      model: "claude-sonnet-4",
      apiKey: "test-api-key",
      baseUrl: null,
    });

    await harness.runtime.dispose();
  });

  it("snapshots the trusted network environment into every Sidecar manager", async () => {
    const networkEnvironment = {
      HTTP_PROXY: "http://127.0.0.1:7897",
      HTTPS_PROXY: "http://127.0.0.1:7897",
      NO_PROXY: "localhost,127.0.0.1,::1",
    } as const;
    const harness = compositionHarness(networkEnvironment);

    await harness.runtime.create(launchInput());

    expect(harness.managerOptions[0]?.networkEnvironment).toEqual(networkEnvironment);
    expect(harness.managerOptions[0]?.networkEnvironment).not.toBe(networkEnvironment);
    expect(Object.isFrozen(harness.managerOptions[0]?.networkEnvironment)).toBe(true);
    await harness.runtime.dispose();
  });

  it("passes the required non-secret Profile Home initializer to every manager", async () => {
    const harness = compositionHarness();
    await harness.runtime.create(launchInput());
    const options = harness.managerOptions[0];
    if (!options) throw new Error("manager options unavailable");
    const paths = { hermesHome: "/data/opentrad/hermes/profiles/profile-1" };

    await options.initializeProfileHome(options.binding, paths);

    expect(harness.initializeProfileHome).toHaveBeenCalledWith(options.binding, paths);
    await harness.runtime.dispose();
  });

  it("forwards stream, interrupt, resume and crash through distinct leases", async () => {
    const harness = compositionHarness();
    const binding = await harness.runtime.create(launchInput());
    const events: RuntimeEvent[] = [];
    const streaming = harness.runtime.stream(binding, "hello", (event) => events.push(event));
    await vi.waitFor(() => {
      expect(harness.managers[0]?.request).toHaveBeenCalledWith("prompt.submit", {
        session_id: binding.liveRuntimeSessionId,
        text: "hello",
      });
    });
    harness.managers[0]?.notify({
      method: "message.complete",
      params: { text: "done" },
      sessionId: binding.liveRuntimeSessionId,
    });
    await streaming;
    await harness.runtime.interrupt(binding);

    expect(events).toEqual([{ type: "message.complete", payload: { text: "done" } }]);
    expect(harness.managers[0]?.request).toHaveBeenCalledWith("session.interrupt", {
      session_id: binding.liveRuntimeSessionId,
    });

    await harness.runtime.close(binding);
    const resumed = await harness.runtime.resume({
      ...launchInput({ canonicalSessionId: "canonical-resumed", taskId: "task-r", runId: "run-r" }),
      durableRuntimeSessionId: binding.durableRuntimeSessionId as string,
    });
    expect(resumed.durableRuntimeSessionId).toBe(binding.durableRuntimeSessionId);
    expect(harness.createManager).toHaveBeenCalledTimes(1);
    await harness.runtime.dispose();
  });

  it("forwards approval and sensitive-input responses and rejects them after disposal", async () => {
    const harness = compositionHarness();
    const binding = await harness.runtime.create(launchInput());

    await harness.runtime.respondApproval?.(binding, "always");
    await harness.runtime.respondSudo?.(binding, "feedface", "sudo-secret-canary");
    await harness.runtime.respondSecret?.(binding, "feedface", "tool-secret-canary");

    expect(harness.managers[0]?.request).toHaveBeenCalledWith("approval.respond", {
      session_id: binding.liveRuntimeSessionId,
      choice: "always",
    });
    expect(harness.managers[0]?.request).toHaveBeenCalledWith("sudo.respond", {
      request_id: "feedface",
      password: "sudo-secret-canary",
    });
    expect(harness.managers[0]?.request).toHaveBeenCalledWith("secret.respond", {
      request_id: "feedface",
      value: "tool-secret-canary",
    });

    await harness.runtime.dispose();
    const requestCount = harness.managers[0]?.request.mock.calls.length;
    await expect(harness.runtime.respondApproval?.(binding, "deny")).rejects.toMatchObject({
      code: "HERMES_RUNTIME_COMPOSITION_DISPOSED",
    });
    await expect(
      harness.runtime.respondSudo?.(binding, "feedface", "not-forwarded-secret"),
    ).rejects.toMatchObject({ code: "HERMES_RUNTIME_COMPOSITION_DISPOSED" });
    await expect(
      harness.runtime.respondSecret?.(binding, "feedface", "not-forwarded-secret"),
    ).rejects.toMatchObject({ code: "HERMES_RUNTIME_COMPOSITION_DISPOSED" });
    expect(harness.managers[0]?.request).toHaveBeenCalledTimes(requestCount as number);
  });

  it("fails closed for conflicting immutable Profile launch metadata", async () => {
    const harness = compositionHarness();
    await harness.runtime.create(launchInput());

    await expect(
      harness.runtime.create(
        launchInput({
          canonicalSessionId: "canonical-2",
          taskId: "task-2",
          runId: "run-2",
          provider: { ...launchInput().provider, providerSlug: "deepseek" },
        }),
      ),
    ).rejects.toMatchObject({ code: "HERMES_RUNTIME_CREATE_FAILED" });

    expect(harness.createManager).toHaveBeenCalledTimes(1);
    await harness.runtime.dispose();
  });

  it("does not fall back and rejects new work after disposal", async () => {
    const harness = compositionHarness();
    await harness.runtime.create(launchInput());
    await harness.runtime.dispose();

    const closeOrder = harness.managers[0]?.request.mock.invocationCallOrder.at(-1);
    const stopOrder = harness.managers[0]?.stop.mock.invocationCallOrder[0];
    expect(closeOrder).toBeLessThan(stopOrder as number);

    await expect(
      harness.runtime.create(launchInput({ canonicalSessionId: "later" })),
    ).rejects.toBeInstanceOf(HermesRuntimeCompositionError);
    expect(harness.createManager).toHaveBeenCalledTimes(1);
  });
});

interface MutableLaunchInput {
  canonicalSessionId: string;
  taskId: string;
  runId: string;
  workspaceRoot: string;
  provider: RuntimeCreateInput["provider"];
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

function requireProfileInvalidation(
  runtime: ReturnType<typeof createHermesRuntimeComposition>,
): (profileId: string) => Promise<void> {
  const invalidateProfile = runtime.invalidateProfile?.bind(runtime);
  if (!invalidateProfile) throw new Error("profile invalidation is unavailable");
  return invalidateProfile;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function compositionHarness(networkEnvironment?: Readonly<Record<string, string>>) {
  const managers: FakeManager[] = [];
  const managerOptions: HermesSidecarManagerOptions[] = [];
  const acquireProfileSecrets = vi.fn(async () => ({
    apiKey: "test-api-key",
    baseUrl: null,
  }));
  const initializeProfileHome = vi.fn(async () => {});
  const createManager = vi.fn((options: HermesSidecarManagerOptions) => {
    managerOptions.push(options);
    const manager = new FakeManager();
    managers.push(manager);
    return manager.port;
  });
  const runtime = createHermesRuntimeComposition({
    dataRoot: "/data/opentrad",
    launcherPath: "/app/opentrad_hermes_launcher.py",
    acquireProfileSecrets,
    initializeProfileHome,
    createManager,
    ...(networkEnvironment ? { networkEnvironment } : {}),
  });
  return {
    runtime,
    managers,
    managerOptions,
    acquireProfileSecrets,
    initializeProfileHome,
    createManager,
  };
}

class FakeManager {
  readonly start = vi.fn(async () => {});
  readonly stop = vi.fn(async () => {});
  readonly request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "session.create") return this.createResult();
    if (method === "session.resume") {
      return {
        session_id: this.nextLiveId(),
        resumed: params.session_id,
        message_count: 0,
        messages: [],
        info: {},
        running: false,
        session_key: "resumed",
        started_at: 1,
        status: "idle",
      };
    }
    if (method === "session.close") return { closed: true };
    if (method === "session.interrupt") return { status: "interrupted" };
    if (method === "prompt.submit") return { status: "streaming" };
    if (method === "approval.respond") return { resolved: 1 };
    if (method === "sudo.respond" || method === "secret.respond") return { status: "ok" };
    throw new Error("unexpected request");
  });
  readonly port: HermesRuntimeManagerPort;
  private readonly notificationListeners = new Set<(value: HermesGatewayNotification) => void>();
  private readonly crashListeners = new Set<() => void>();
  private sequence = 0;

  constructor() {
    this.port = {
      start: this.start,
      stop: this.stop,
      request: this.request as HermesRuntimeManagerPort["request"],
      subscribe: (listener) => {
        this.notificationListeners.add(listener);
        return () => this.notificationListeners.delete(listener);
      },
      onCrash: (listener) => {
        this.crashListeners.add(listener);
        return () => this.crashListeners.delete(listener);
      },
    };
  }

  notify(value: HermesGatewayNotification): void {
    for (const listener of this.notificationListeners) listener(value);
  }

  private nextLiveId(): string {
    this.sequence += 1;
    return this.sequence.toString(16).padStart(8, "0");
  }

  private createResult(): Record<string, unknown> {
    const live = this.nextLiveId();
    return {
      session_id: live,
      stored_session_id: `20260713_${live.slice(0, 6)}_abcdef`,
      message_count: 0,
      messages: [],
      info: {},
    };
  }
}
