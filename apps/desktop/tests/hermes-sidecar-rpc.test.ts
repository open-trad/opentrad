import { EventEmitter } from "node:events";
import { PassThrough, type Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  type HermesGatewayCrashListener,
  HermesGatewayError,
  type HermesGatewayNotification,
  type HermesGatewayNotificationListener,
  HermesGatewayRemoteError,
} from "../src/main/services/hermes/gateway-client";
import type {
  HermesGatewayRequestMethod,
  HermesGatewayRequestParams,
  HermesGatewayRequestResult,
} from "../src/main/services/hermes/gateway-protocol";
import { resolveHermesPaths } from "../src/main/services/hermes/paths";
import {
  type HermesSidecarBinding,
  type HermesSidecarCapabilityLease,
  HermesSidecarManager,
  type HermesSidecarProcess,
  type HermesSidecarSpawn,
} from "../src/main/services/hermes/sidecar-manager";

const paths = resolveHermesPaths("/opentrad-data", "darwin");
const launcherPath = "/opentrad-app/resources/hermes/opentrad_hermes_launcher.py";
const binding: HermesSidecarBinding = {
  taskId: "task-rpc",
  runId: "run-rpc",
  profileId: "profile-rpc",
  model: "openai/gpt-5.2",
  apiMode: "chat_completions",
};

class FakeSidecarProcess extends EventEmitter implements HermesSidecarProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly capabilityPipe = new PassThrough();
  readonly stdio = [this.stdin, this.stdout, this.stderr, this.capabilityPipe] as const;
  readonly pid = 12_346;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
}

type RpcRequest = <TMethod extends HermesGatewayRequestMethod>(
  method: TMethod,
  params: HermesGatewayRequestParams<TMethod>,
) => Promise<HermesGatewayRequestResult<TMethod>>;

interface RpcClientOptions {
  readonly ready?: () => Promise<void>;
  readonly request?: RpcRequest;
  readonly subscribe?: (listener: HermesGatewayNotificationListener) => () => void;
  readonly dispose?: () => Promise<void>;
}

function rpcClient(options: RpcClientOptions = {}) {
  const notificationListeners = new Set<HermesGatewayNotificationListener>();
  const crashListeners = new Set<HermesGatewayCrashListener>();
  const request =
    options.request ?? (vi.fn(async () => ({ output: "idle" })) as unknown as RpcRequest);
  const subscribe =
    options.subscribe ??
    ((listener: HermesGatewayNotificationListener) => {
      notificationListeners.add(listener);
      return () => {
        notificationListeners.delete(listener);
      };
    });
  const client = {
    ready: vi.fn(options.ready ?? (async () => {})),
    request: vi.fn(request),
    subscribe: vi.fn(subscribe),
    dispose: vi.fn(options.dispose ?? (async () => {})),
    onCrash: vi.fn((listener: HermesGatewayCrashListener) => {
      crashListeners.add(listener);
      return () => {
        crashListeners.delete(listener);
      };
    }),
  };
  return {
    client,
    emit(notification: HermesGatewayNotification) {
      for (const listener of [...notificationListeners]) listener(notification);
    },
    crash() {
      const error = new HermesGatewayError("HERMES_GATEWAY_CRASHED");
      for (const listener of [...crashListeners]) listener(error);
    },
  };
}

describe("HermesSidecarManager generation-scoped request and subscribe seam", () => {
  it("rejects an idle request asynchronously without touching the client", async () => {
    const rpc = rpcClient();
    const manager = createManager(rpc.client);
    let request: Promise<unknown> | undefined;
    let synchronousError: unknown;

    try {
      request = manager.request("session.status", { session_id: "session-1" });
    } catch (error) {
      synchronousError = error;
    }

    expect(synchronousError).toBeUndefined();
    await expect(request).rejects.toMatchObject({ code: "HERMES_SIDECAR_NOT_READY" });
    expect(rpc.client.request).not.toHaveBeenCalled();
  });

  it("rejects requests while starting without touching the client", async () => {
    let releaseEnsure!: () => void;
    const ensureGate = new Promise<void>((resolve) => {
      releaseEnsure = resolve;
    });
    const rpc = rpcClient();
    const manager = createManager(rpc.client, {
      ensureStateDirs: vi.fn(() => ensureGate),
    });
    const started = manager.start();
    await vi.waitFor(() => expect(manager.state).toBe("starting"));

    await expect(
      manager.request("session.status", { session_id: "session-1" }),
    ).rejects.toMatchObject({ code: "HERMES_SIDECAR_NOT_READY" });
    expect(rpc.client.request).not.toHaveBeenCalled();

    releaseEnsure();
    await started;
    await manager.stop();
  });

  it("proxies a ready request exactly and preserves the client receiver", async () => {
    const receiver = { marker: "client-receiver" };
    const request: RpcRequest = vi.fn(function (this: typeof receiver, method, params) {
      expect(this).toBe(receiver);
      expect(method).toBe("session.status");
      expect(params).toEqual({ session_id: "session-1" });
      return Promise.resolve({ output: "working" }) as never;
    });
    Object.assign(receiver, rpcClient({ request }).client);
    const manager = createManager(receiver);
    await manager.start();

    await expect(manager.request("session.status", { session_id: "session-1" })).resolves.toEqual({
      output: "working",
    });
    expect(request).toHaveBeenCalledOnce();

    await manager.stop();
  });

  it("throws synchronously when subscribing before ready", () => {
    const rpc = rpcClient();
    const manager = createManager(rpc.client);

    expect(() => manager.subscribe(() => {})).toThrowError(
      expect.objectContaining({ code: "HERMES_SIDECAR_NOT_READY" }),
    );
    expect(rpc.client.subscribe).not.toHaveBeenCalled();
  });

  it("throws NOT_READY when subscribing during startup without touching the client", async () => {
    const ensure = deferred<void>();
    const rpc = rpcClient();
    const manager = createManager(rpc.client, {
      ensureStateDirs: vi.fn(() => ensure.promise),
    });
    const started = manager.start();
    await vi.waitFor(() => expect(manager.state).toBe("starting"));

    expect(() => manager.subscribe(() => {})).toThrowError(
      expect.objectContaining({ code: "HERMES_SIDECAR_NOT_READY" }),
    );
    expect(rpc.client.subscribe).not.toHaveBeenCalled();

    ensure.resolve();
    await started;
    await manager.stop();
  });

  it("uses STOPPED for new requests and subscriptions after shutdown", async () => {
    const rpc = rpcClient();
    const manager = createManager(rpc.client);
    await manager.start();
    await manager.stop();

    await expect(
      manager.request("session.status", { session_id: "session-1" }),
    ).rejects.toMatchObject({ code: "HERMES_SIDECAR_STOPPED" });
    expect(() => manager.subscribe(() => {})).toThrowError(
      expect.objectContaining({ code: "HERMES_SIDECAR_STOPPED" }),
    );
    expect(rpc.client.request).not.toHaveBeenCalled();
    expect(rpc.client.subscribe).not.toHaveBeenCalled();
  });

  it("uses CRASHED for new requests and subscriptions after a crash", async () => {
    const rpc = rpcClient();
    const manager = createManager(rpc.client);
    await manager.start();
    rpc.crash();

    await expect(
      manager.request("session.status", { session_id: "session-1" }),
    ).rejects.toMatchObject({ code: "HERMES_SIDECAR_CRASHED" });
    expect(() => manager.subscribe(() => {})).toThrowError(
      expect.objectContaining({ code: "HERMES_SIDECAR_CRASHED" }),
    );
    expect(rpc.client.request).not.toHaveBeenCalled();
    expect(rpc.client.subscribe).not.toHaveBeenCalled();
    await manager.stop();
  });

  it("invalidates a pending request as soon as stop is linearized", async () => {
    const response = deferred<{ readonly output: string }>();
    const disposal = deferred<void>();
    const request = vi.fn(() => response.promise) as unknown as RpcRequest;
    const rpc = rpcClient({ request, dispose: () => disposal.promise });
    const manager = createManager(rpc.client);
    await manager.start();
    const pending = manager.request("session.status", { session_id: "session-1" });

    const stopped = manager.stop();
    expect(manager.state).toBe("stopping");
    const immediate = await settleByNextTurn(pending);

    response.resolve({ output: "late" });
    disposal.resolve();
    await Promise.allSettled([pending, stopped]);
    expect(immediate).toMatchObject({ status: "rejected", code: "HERMES_SIDECAR_STOPPED" });
  });

  it("lets stop beat a response that resolved first but had not linearized", async () => {
    const response = deferred<{ readonly output: string }>();
    const request = vi.fn(() => response.promise) as unknown as RpcRequest;
    const rpc = rpcClient({ request });
    const manager = createManager(rpc.client);
    await manager.start();
    const pending = manager.request("session.status", { session_id: "session-1" });

    response.resolve({ output: "too-late" });
    const stopped = manager.stop();

    await expect(pending).rejects.toMatchObject({ code: "HERMES_SIDECAR_STOPPED" });
    await stopped;
  });

  it("turns a synchronous reentrant stop from request into STOPPED", async () => {
    let manager!: HermesSidecarManager;
    let stopped: Promise<void> | undefined;
    const request = vi.fn(() => {
      stopped = manager.stop();
      return Promise.resolve({ output: "must-not-escape" });
    }) as unknown as RpcRequest;
    const rpc = rpcClient({ request });
    manager = createManager(rpc.client);
    await manager.start();

    await expect(
      manager.request("session.status", { session_id: "session-1" }),
    ).rejects.toMatchObject({ code: "HERMES_SIDECAR_STOPPED" });
    if (!stopped) throw new Error("request did not reenter stop");
    await stopped;
  });

  it("invalidates a pending request as CRASHED and ignores its late rejection", async () => {
    const response = deferred<{ readonly output: string }>();
    const request = vi.fn(() => response.promise) as unknown as RpcRequest;
    const rpc = rpcClient({ request });
    const manager = createManager(rpc.client);
    await manager.start();
    const pending = manager.request("session.status", { session_id: "session-1" });

    rpc.crash();
    await expect(pending).rejects.toMatchObject({ code: "HERMES_SIDECAR_CRASHED" });
    response.reject(new Error("late-request-rejection-canary"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(manager.state).toBe("crashed");
    await manager.stop();
  });

  it("never replays an invalidated request onto the replacement client", async () => {
    const firstResponse = deferred<{ readonly output: string }>();
    const firstRequest = vi.fn(() => firstResponse.promise) as unknown as RpcRequest;
    const secondRequest = vi.fn(async () => ({ output: "replacement" })) as unknown as RpcRequest;
    const first = rpcClient({ request: firstRequest });
    const second = rpcClient({ request: secondRequest });
    const clients = [first.client, second.client];
    let nextClient = 0;
    const manager = createManager(first.client, {
      spawn: vi.fn<HermesSidecarSpawn>(() => new FakeSidecarProcess()),
      clientFactory: () => {
        const client = clients[nextClient];
        nextClient += 1;
        if (!client) throw new Error("unexpected client generation");
        return client;
      },
    });
    await manager.start();
    const stale = manager.request("session.status", { session_id: "session-1" });

    await manager.restart();
    await expect(stale).rejects.toMatchObject({ code: "HERMES_SIDECAR_STOPPED" });
    await expect(manager.request("session.status", { session_id: "session-2" })).resolves.toEqual({
      output: "replacement",
    });
    expect(firstRequest).toHaveBeenCalledOnce();
    expect(secondRequest).toHaveBeenCalledOnce();

    firstResponse.resolve({ output: "stale" });
    await manager.stop();
  });

  it("owns an idempotent unsubscribe for the active generation", async () => {
    const rawUnsubscribe = vi.fn();
    const received = vi.fn();
    let rawListener: HermesGatewayNotificationListener | undefined;
    const rpc = rpcClient({
      subscribe: (listener) => {
        rawListener = listener;
        return rawUnsubscribe;
      },
    });
    const manager = createManager(rpc.client);
    await manager.start();

    const unsubscribe = manager.subscribe(received);
    rawListener?.({ method: "session.output", params: { text: "first" } });
    unsubscribe();
    unsubscribe();
    rawListener?.({ method: "session.output", params: { text: "stale" } });

    expect(received).toHaveBeenCalledOnce();
    expect(rawUnsubscribe).toHaveBeenCalledOnce();
    await manager.stop();
    expect(rawUnsubscribe).toHaveBeenCalledOnce();
  });

  it("guards stale emissions and does not let a throwing unsubscribe block dispose", async () => {
    const received = vi.fn();
    let rawListener: HermesGatewayNotificationListener | undefined;
    const rawUnsubscribe = vi.fn(() => {
      throw new Error("unsubscribe-canary");
    });
    const rpc = rpcClient({
      subscribe: (listener) => {
        rawListener = listener;
        return rawUnsubscribe;
      },
    });
    const manager = createManager(rpc.client);
    await manager.start();
    manager.subscribe(received);

    await expect(manager.stop()).resolves.toBeUndefined();
    rawListener?.({ method: "session.output", params: { text: "stale" } });

    expect(received).not.toHaveBeenCalled();
    expect(rawUnsubscribe).toHaveBeenCalledOnce();
    expect(rpc.client.dispose).toHaveBeenCalledOnce();
  });

  it("requires a fresh subscription after restart and ignores an old client that keeps emitting", async () => {
    const oldListeners: HermesGatewayNotificationListener[] = [];
    const newListeners: HermesGatewayNotificationListener[] = [];
    const first = rpcClient({
      subscribe: (listener) => {
        oldListeners.push(listener);
        return () => {};
      },
    });
    const second = rpcClient({
      subscribe: (listener) => {
        newListeners.push(listener);
        return () => {};
      },
    });
    const clients = [first.client, second.client];
    let nextClient = 0;
    const manager = createManager(first.client, {
      spawn: vi.fn<HermesSidecarSpawn>(() => new FakeSidecarProcess()),
      clientFactory: () => clients[nextClient++] as never,
    });
    const received = vi.fn();
    await manager.start();
    manager.subscribe(received);
    await manager.restart();

    oldListeners[0]?.({ method: "session.output", params: { text: "old" } });
    expect(received).not.toHaveBeenCalled();
    expect(newListeners).toHaveLength(0);

    manager.subscribe(received);
    newListeners[0]?.({ method: "session.output", params: { text: "new" } });
    expect(received).toHaveBeenCalledWith({
      method: "session.output",
      params: { text: "new" },
    });
    await manager.stop();
  });

  it("cleans up a subscription created by a reentrant stop", async () => {
    let manager!: HermesSidecarManager;
    let stopped: Promise<void> | undefined;
    const rawUnsubscribe = vi.fn();
    const rpc = rpcClient({
      subscribe: () => {
        stopped = manager.stop();
        return rawUnsubscribe;
      },
    });
    manager = createManager(rpc.client);
    await manager.start();

    expect(() => manager.subscribe(() => {})).toThrowError(
      expect.objectContaining({ code: "HERMES_SIDECAR_STOPPED" }),
    );
    if (!stopped) throw new Error("subscribe did not reenter stop");
    await stopped;
    expect(rawUnsubscribe).toHaveBeenCalledOnce();
  });

  it("lets a stop reentered from restart cleanup remain the final lifecycle intent", async () => {
    let manager!: HermesSidecarManager;
    let reentrantStop: Promise<void> | undefined;
    const rpc = rpcClient({
      subscribe: () => () => {
        reentrantStop = manager.stop();
      },
    });
    manager = createManager(rpc.client, {
      spawn: vi.fn<HermesSidecarSpawn>(() => new FakeSidecarProcess()),
    });
    await manager.start();
    manager.subscribe(() => {});

    const outerRestart = manager.restart();
    if (!reentrantStop) throw new Error("unsubscribe did not reenter stop");
    await Promise.allSettled([outerRestart, reentrantStop]);

    expect(manager.state).toBe("stopped");
  });

  it("lets a restart reentered from stop cleanup remain the final lifecycle intent", async () => {
    let manager!: HermesSidecarManager;
    let reentrantRestart: Promise<void> | undefined;
    const rpc = rpcClient({
      subscribe: () => () => {
        reentrantRestart = manager.restart();
      },
    });
    manager = createManager(rpc.client, {
      spawn: vi.fn<HermesSidecarSpawn>(() => new FakeSidecarProcess()),
    });
    await manager.start();
    manager.subscribe(() => {});

    const outerStop = manager.stop();
    if (!reentrantRestart) throw new Error("unsubscribe did not reenter restart");
    await Promise.allSettled([outerStop, reentrantRestart]);

    expect(manager.state).toBe("ready");
    await manager.stop();
  });

  it("sanitizes a synchronous raw subscribe error without reading it", async () => {
    const reads = { message: 0, cause: 0 };
    const rawError = Object.create(null);
    Object.defineProperties(rawError, {
      message: {
        get() {
          reads.message += 1;
          return "subscribe-message-canary";
        },
      },
      cause: {
        get() {
          reads.cause += 1;
          return "subscribe-cause-canary";
        },
      },
    });
    const rpc = rpcClient({
      subscribe: () => {
        throw rawError;
      },
    });
    const manager = createManager(rpc.client);
    await manager.start();

    let error: unknown;
    try {
      manager.subscribe(() => {});
    } catch (cause) {
      error = cause;
    }

    expect(error).toMatchObject({
      name: "HermesGatewayError",
      code: "HERMES_GATEWAY_PROTOCOL",
    });
    expect(reads).toEqual({ message: 0, cause: 0 });
    await manager.stop();
  });

  it("rejects a non-callable raw unsubscribe and remains cleanly stoppable", async () => {
    const rpc = rpcClient({
      subscribe: (() => "not-an-unsubscribe") as never,
    });
    const manager = createManager(rpc.client);
    await manager.start();

    expect(() => manager.subscribe(() => {})).toThrowError(
      expect.objectContaining({
        name: "HermesGatewayError",
        code: "HERMES_GATEWAY_PROTOCOL",
      }),
    );
    await expect(manager.stop()).resolves.toBeUndefined();
    expect(rpc.client.dispose).toHaveBeenCalledOnce();
  });

  it("revokes capability, invalidates subscriptions, then notifies crash observers", async () => {
    const events: string[] = [];
    const rawUnsubscribe = vi.fn(() => events.push("unsubscribe"));
    const rpc = rpcClient({ subscribe: () => rawUnsubscribe });
    const manager = createManager(rpc.client, {
      issueCapability: async () => capabilityLease(endCapabilityPipe, () => events.push("revoke")),
    });
    manager.onCrash(() => events.push("observer"));
    await manager.start();
    manager.subscribe(() => {});

    rpc.crash();
    rpc.crash();

    expect(events).toEqual(["revoke", "unsubscribe", "observer"]);
    expect(rawUnsubscribe).toHaveBeenCalledOnce();
    await manager.stop();
  });

  it("snapshots every client method once, preserves its receiver, and ignores replacement", async () => {
    const getterReads = {
      ready: 0,
      request: 0,
      subscribe: 0,
      onCrash: 0,
      dispose: 0,
    };
    const originalRequest = vi.fn(function (this: object) {
      expect(this).toBe(rawClient);
      return Promise.resolve({ output: "snapshotted" });
    }) as unknown as RpcRequest;
    const replacementRequest = vi.fn(async () => ({ output: "replaced" })) as unknown as RpcRequest;
    const originalDispose = vi.fn(function (this: object) {
      expect(this).toBe(rawClient);
      return Promise.resolve();
    });
    const replacementDispose = vi.fn(async () => {});
    let currentRequest = originalRequest;
    let currentDispose = originalDispose;
    const rawClient: Record<string, unknown> = {};
    Object.defineProperties(rawClient, {
      ready: {
        get() {
          getterReads.ready += 1;
          return function (this: object) {
            expect(this).toBe(rawClient);
            return Promise.resolve();
          };
        },
      },
      request: {
        get() {
          getterReads.request += 1;
          return currentRequest;
        },
      },
      subscribe: {
        get() {
          getterReads.subscribe += 1;
          return function (this: object) {
            expect(this).toBe(rawClient);
            return () => {};
          };
        },
      },
      onCrash: {
        get() {
          getterReads.onCrash += 1;
          return function (this: object) {
            expect(this).toBe(rawClient);
            return () => {};
          };
        },
      },
      dispose: {
        get() {
          getterReads.dispose += 1;
          return currentDispose;
        },
      },
    });
    const manager = createManager(rawClient);
    await manager.start();

    expect(getterReads).toEqual({ ready: 1, request: 1, subscribe: 1, onCrash: 1, dispose: 1 });
    currentRequest = replacementRequest;
    currentDispose = replacementDispose;
    await expect(manager.request("session.status", { session_id: "session-1" })).resolves.toEqual({
      output: "snapshotted",
    });
    manager.subscribe(() => {})();
    await manager.stop();

    expect(getterReads).toEqual({ ready: 1, request: 1, subscribe: 1, onCrash: 1, dispose: 1 });
    expect(originalRequest).toHaveBeenCalledOnce();
    expect(replacementRequest).not.toHaveBeenCalled();
    expect(originalDispose).toHaveBeenCalledOnce();
    expect(replacementDispose).not.toHaveBeenCalled();
  });

  it("fails closed and terminates when client snapshotting throws without reading raw errors", async () => {
    const terminate = vi.fn(async () => {});
    const revoke = vi.fn();
    const rawErrorReads = { message: 0, cause: 0 };
    const rawError = Object.create(null);
    Object.defineProperties(rawError, {
      message: {
        get() {
          rawErrorReads.message += 1;
          return "snapshot-message-canary";
        },
      },
      cause: {
        get() {
          rawErrorReads.cause += 1;
          return "snapshot-cause-canary";
        },
      },
    });
    const rawClient = {
      get ready(): never {
        throw rawError;
      },
      request: vi.fn(),
      subscribe: vi.fn(),
      onCrash: vi.fn(),
      dispose: vi.fn(async () => {}),
    };
    const manager = createManager(rawClient, {
      issueCapability: async () => capabilityLease(endCapabilityPipe, revoke),
      terminatorFactory: () => terminate,
    });

    const error = await manager.start().catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "HERMES_SIDECAR_START" });
    expect(rawErrorReads).toEqual({ message: 0, cause: 0 });
    expect(revoke).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledOnce();
    expect(rawClient.dispose).not.toHaveBeenCalled();
  });

  it("fails closed when a snapshotted method is not callable", async () => {
    const terminate = vi.fn(async () => {});
    const rawClient = {
      ready: async () => {},
      request: "not-callable",
      subscribe: vi.fn(),
      onCrash: vi.fn(),
      dispose: vi.fn(async () => {}),
    };
    const manager = createManager(rawClient, { terminatorFactory: () => terminate });

    await expect(manager.start()).rejects.toMatchObject({ code: "HERMES_SIDECAR_START" });
    expect(terminate).toHaveBeenCalledOnce();
    expect(rawClient.dispose).not.toHaveBeenCalled();
  });

  it("serializes restart requested reentrantly by a client snapshot getter", async () => {
    let manager!: HermesSidecarManager;
    let restarted: Promise<void> | undefined;
    let requestReads = 0;
    const dispose = vi.fn(async () => {});
    const rawClient = {
      ready: async () => {},
      get request(): RpcRequest {
        requestReads += 1;
        if (requestReads === 1) restarted = manager.restart();
        return vi.fn(async () => ({ output: "ready" })) as unknown as RpcRequest;
      },
      subscribe: () => () => {},
      onCrash: () => () => {},
      dispose,
    };
    const spawn = vi.fn<HermesSidecarSpawn>(() => new FakeSidecarProcess());
    manager = createManager(rawClient, {
      spawn,
      clientFactory: () => rawClient,
    });

    await expect(manager.start()).rejects.toMatchObject({ code: "HERMES_SIDECAR_STOPPED" });
    if (!restarted) throw new Error("snapshot did not reenter restart");
    await expect(restarted).resolves.toBeUndefined();

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledOnce();
    expect(manager.state).toBe("ready");
    await manager.stop();
  });

  it("fails closed when a client snapshot getter reentrantly requests stop", async () => {
    let manager!: HermesSidecarManager;
    let stopped: Promise<void> | undefined;
    const dispose = vi.fn(async () => {});
    const rawClient = {
      ready: async () => {},
      get request(): RpcRequest {
        stopped = manager.stop();
        return vi.fn(async () => ({ output: "must-not-start" })) as unknown as RpcRequest;
      },
      subscribe: () => () => {},
      onCrash: () => () => {},
      dispose,
    };
    manager = createManager(rawClient);

    await expect(manager.start()).rejects.toMatchObject({ code: "HERMES_SIDECAR_STOPPED" });
    if (!stopped) throw new Error("snapshot did not reenter stop");
    await expect(stopped).resolves.toBeUndefined();

    expect(dispose).toHaveBeenCalledOnce();
    expect(manager.state).toBe("stopped");
  });

  it.each([
    "sync",
    "async",
  ] as const)("sanitizes an unknown %s client request error as a gateway protocol failure", async (mode) => {
    const rawError = Object.create(null);
    Object.defineProperty(rawError, "message", {
      get() {
        throw new Error("raw-message-read-canary");
      },
    });
    const request = vi.fn(() => {
      if (mode === "sync") throw rawError;
      return Promise.reject(rawError);
    }) as unknown as RpcRequest;
    const rpc = rpcClient({ request });
    const manager = createManager(rpc.client);
    await manager.start();

    const error = await manager
      .request("session.status", { session_id: "session-1" })
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      name: "HermesGatewayError",
      code: "HERMES_GATEWAY_PROTOCOL",
    });
    expect(String(error)).not.toContain("canary");
    await manager.stop();
  });

  it.each([
    new HermesGatewayError("HERMES_GATEWAY_INVALID_PARAMS"),
    new HermesGatewayRemoteError(-32602),
  ])("preserves an already-sanitized gateway request error", async (gatewayError) => {
    const request = vi.fn(async () => {
      throw gatewayError;
    }) as unknown as RpcRequest;
    const rpc = rpcClient({ request });
    const manager = createManager(rpc.client);
    await manager.start();

    const error = await manager
      .request("session.status", { session_id: "session-1" })
      .catch((cause: unknown) => cause);

    expect(error).toBe(gatewayError);
    await manager.stop();
  });
});

function createManager(
  client: ReturnType<typeof rpcClient>["client"] | Record<string, unknown>,
  overrides: Partial<ConstructorParameters<typeof HermesSidecarManager>[0]> = {},
): HermesSidecarManager {
  const child = new FakeSidecarProcess();
  return new HermesSidecarManager({
    binding,
    dataRoot: "/opentrad-data",
    issueCapability: async () => capabilityLease(endCapabilityPipe),
    launcherPath,
    paths,
    platform: "darwin",
    ensureStateDirs: vi.fn(async () => {}),
    verifyInstallation: vi.fn(async () => {}),
    spawn: vi.fn<HermesSidecarSpawn>(() => child),
    terminatorFactory: () => async () => {},
    clientFactory: () => client as never,
    ...overrides,
  });
}

function capabilityLease(
  transmit: HermesSidecarCapabilityLease["transmit"],
  revoke: HermesSidecarCapabilityLease["revoke"] = () => {},
): HermesSidecarCapabilityLease {
  return { transmit, revoke };
}

function endCapabilityPipe(pipe: Writable): Promise<void> {
  return new Promise((resolve) => {
    pipe.end(Buffer.from("test-capability"), resolve);
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settleByNextTurn(promise: Promise<unknown>): Promise<unknown> {
  return Promise.race([
    promise.then(
      (value) => ({ status: "fulfilled", value }),
      (error: { readonly code?: string }) => ({ status: "rejected", code: error.code }),
    ),
    new Promise((resolve) => setImmediate(() => resolve({ status: "pending" }))),
  ]);
}
