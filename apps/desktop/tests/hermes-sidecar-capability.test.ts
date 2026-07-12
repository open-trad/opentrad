import { EventEmitter } from "node:events";
import { PassThrough, type Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { resolveHermesPaths } from "../src/main/services/hermes/paths";
import {
  type HermesSidecarBinding,
  type HermesSidecarCapabilityLease,
  type HermesSidecarClient,
  HermesSidecarManager,
  type HermesSidecarProcess,
  type HermesSidecarSpawn,
} from "../src/main/services/hermes/sidecar-manager";

const paths = resolveHermesPaths("/opentrad-data", "darwin");
const launcherPath = "/opentrad-app/resources/hermes/opentrad_hermes_launcher.py";
const binding: HermesSidecarBinding = {
  taskId: "task-123",
  runId: "run-456",
  profileId: "profile-789",
  model: "openai/gpt-5.2",
  apiMode: "chat_completions",
};

class FakeSidecarProcess extends EventEmitter implements HermesSidecarProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly capabilityPipe = new PassThrough();
  readonly stdio = [this.stdin, this.stdout, this.stderr, this.capabilityPipe] as const;
  readonly pid = 12_345;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
}

describe("HermesSidecarManager FD3 capability lifecycle", () => {
  it("snapshots one immutable task and run binding at construction", async () => {
    const mutableBinding = { ...binding };
    const issueCapability = vi.fn(async () =>
      lease(
        async (pipe) => endPipe(pipe, Buffer.from("binding-capability")),
        () => {},
      ),
    );
    const manager = createManager({ binding: mutableBinding, issueCapability });
    mutableBinding.taskId = "redirected-task";
    mutableBinding.model = "openai/redirected-model";

    await manager.start();

    expect(issueCapability).toHaveBeenCalledWith(binding);
    const supplied = issueCapability.mock.calls[0]?.[0];
    expect(Object.isFrozen(supplied)).toBe(true);
    await manager.stop();
  });

  it("transmits the capability only through FD3 before waiting for ready", async () => {
    const child = new FakeSidecarProcess();
    const token = "fd3-capability-canary-0123456789abcdef";
    const fd3Chunks: Buffer[] = [];
    child.capabilityPipe.on("data", (chunk: Buffer) => fd3Chunks.push(Buffer.from(chunk)));
    const order: string[] = [];
    const revoke = vi.fn(() => order.push("revoke"));
    const issueCapability = vi.fn(async (receivedBinding: HermesSidecarBinding) => {
      order.push("issue");
      expect(receivedBinding).toEqual(binding);
      expect(Object.isFrozen(receivedBinding)).toBe(true);
      return lease(async (pipe) => {
        order.push("transmit");
        await endPipe(pipe, Buffer.from(token));
      }, revoke);
    });
    const spawn = vi.fn<HermesSidecarSpawn>(() => {
      order.push("spawn");
      return child;
    });
    const manager = createManager({
      binding,
      child,
      issueCapability,
      spawn,
      clientFactory: () => ({
        ready: async () => {
          order.push("ready");
        },
        dispose: async () => {},
        onCrash: () => () => {},
      }),
      ensureStateDirs: vi.fn(async () => order.push("ensure")),
      verifyInstallation: vi.fn(async () => order.push("verify")),
    });

    await manager.start();

    expect(order).toEqual(["ensure", "verify", "issue", "spawn", "transmit", "ready"]);
    expect(Buffer.concat(fd3Chunks).toString("utf8")).toBe(token);
    expect(child.capabilityPipe.writableEnded).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      paths.pythonExecutable,
      ["-I", "-S", "-B", "-u", "-X", "utf8", launcherPath],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe", "pipe"] }),
    );
    expect(JSON.stringify(spawn.mock.calls)).not.toContain(token);
    expect(child.stdin.readableLength).toBe(0);

    await manager.stop();
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("revokes a newly issued capability when spawn fails synchronously", async () => {
    const revoke = vi.fn();
    const manager = createManager({
      issueCapability: vi.fn(async () => lease(async () => {}, revoke)),
      spawn: vi.fn<HermesSidecarSpawn>(() => {
        throw new Error("spawn-capability-canary");
      }),
    });

    const error = await manager.start().catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "HERMES_SIDECAR_START" });
    expect(String(error)).not.toContain("canary");
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("revokes a rejected lease shape before failing closed", async () => {
    const revoke = vi.fn();
    const spawn = vi.fn<HermesSidecarSpawn>();
    const manager = createManager({
      issueCapability: vi.fn(
        async () =>
          ({
            transmit: "not-callable",
            revoke,
          }) as never,
      ),
      spawn,
    });

    const error = await manager.start().catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "HERMES_SIDECAR_START" });
    expect(revoke).toHaveBeenCalledOnce();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("revokes and terminates when FD3 transmission fails", async () => {
    const child = new FakeSidecarProcess();
    const revoke = vi.fn();
    const terminate = vi.fn(async () => {});
    const manager = createManager({
      child,
      issueCapability: vi.fn(async () =>
        lease(async () => {
          throw new Error("fd3-transmit-canary");
        }, revoke),
      ),
      terminatorFactory: () => terminate,
      clientFactory: (options) => ({
        ready: async () => {},
        dispose: options.terminate,
        onCrash: () => () => {},
      }),
    });

    const error = await manager.start().catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "HERMES_SIDECAR_START" });
    expect(String(error)).not.toContain("canary");
    expect(revoke).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledOnce();
    expect(child.capabilityPipe.destroyed).toBe(true);
  });

  it("times out a stalled FD3 transmission then revokes and terminates", async () => {
    const child = new FakeSidecarProcess();
    const revoke = vi.fn();
    const terminate = vi.fn(async () => {});
    const manager = createManager({
      capabilityTimeoutMs: 20,
      child,
      issueCapability: vi.fn(async () => lease(() => new Promise(() => {}), revoke)),
      terminatorFactory: () => terminate,
      clientFactory: (options) => ({
        ready: async () => {},
        dispose: options.terminate,
        onCrash: () => () => {},
      }),
    });

    const error = await manager.start().catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "HERMES_SIDECAR_START" });
    expect(revoke).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledOnce();
    expect(child.capabilityPipe.destroyed).toBe(true);
  });

  it("revokes and terminates when the spawned process has no FD3 pipe", async () => {
    const child = new FakeSidecarProcess();
    Object.defineProperty(child, "stdio", {
      value: [child.stdin, child.stdout, child.stderr],
    });
    const revoke = vi.fn();
    const terminate = vi.fn(async () => {});
    const manager = createManager({
      child,
      issueCapability: vi.fn(async () => lease(async () => {}, revoke)),
      terminatorFactory: () => terminate,
      clientFactory: (options) => ({
        ready: async () => {},
        dispose: options.terminate,
        onCrash: () => () => {},
      }),
    });

    const error = await manager.start().catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "HERMES_SIDECAR_START" });
    expect(revoke).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("sanitizes capability issuer failures without spawning", async () => {
    const spawn = vi.fn<HermesSidecarSpawn>();
    const manager = createManager({
      issueCapability: vi.fn(async () => {
        throw new Error("issuer-credential-canary");
      }),
      spawn,
    });

    const error = await manager.start().catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "HERMES_SIDECAR_START" });
    expect(String(error)).not.toContain("canary");
    expect(JSON.stringify(error)).not.toContain("canary");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("revokes synchronously before notifying observers about a crash", async () => {
    const child = new FakeSidecarProcess();
    const events: string[] = [];
    let crash: (() => void) | undefined;
    const manager = createManager({
      child,
      issueCapability: vi.fn(async () =>
        lease(
          async (pipe) => endPipe(pipe, Buffer.from("crash-capability")),
          () => events.push("revoke"),
        ),
      ),
      clientFactory: () => ({
        ready: async () => {},
        dispose: async () => {},
        onCrash: (listener) => {
          crash = () => listener({} as never);
          return () => {};
        },
      }),
    });
    manager.onCrash(() => events.push("observer"));
    await manager.start();

    crash?.();

    expect(events).toEqual(["revoke", "observer"]);
    expect(manager.state).toBe("crashed");
  });

  it("issues a fresh capability on restart after revoking the old one", async () => {
    const events: string[] = [];
    let generation = 0;
    const issueCapability = vi.fn(async () => {
      generation += 1;
      const current = generation;
      events.push(`issue-${current}`);
      return lease(
        async (pipe) => endPipe(pipe, Buffer.from(`capability-${current}`)),
        () => events.push(`revoke-${current}`),
      );
    });
    const manager = createManager({
      issueCapability,
      spawn: vi.fn<HermesSidecarSpawn>(() => new FakeSidecarProcess()),
      clientFactory: () => immediateClient(),
    });

    await manager.start();
    await manager.restart();

    expect(events).toEqual(["issue-1", "revoke-1", "issue-2"]);
    expect(issueCapability).toHaveBeenCalledTimes(2);
    await manager.stop();
    expect(events).toEqual(["issue-1", "revoke-1", "issue-2", "revoke-2"]);
  });

  it("cancels a pending issue without spawning and revokes a late lease", async () => {
    let resolveLease!: (value: HermesSidecarCapabilityLease) => void;
    const pendingLease = new Promise<HermesSidecarCapabilityLease>((resolve) => {
      resolveLease = resolve;
    });
    const revoke = vi.fn();
    const spawn = vi.fn<HermesSidecarSpawn>();
    const manager = createManager({
      issueCapability: vi.fn(async () => pendingLease),
      spawn,
    });

    const started = manager.start();
    await vi.waitFor(() => expect(manager.state).toBe("starting"));
    const stopped = manager.stop();
    await expect(started).rejects.toMatchObject({ code: "HERMES_SIDECAR_STOPPED" });
    await expect(stopped).resolves.toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();

    resolveLease(lease(async () => {}, revoke));
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledOnce());
  });

  it("revokes once when capability issuance reentrantly cancels its own start", async () => {
    const revoke = vi.fn();
    const spawn = vi.fn<HermesSidecarSpawn>();
    let manager!: HermesSidecarManager;
    let stopped: Promise<void> | undefined;
    manager = createManager({
      issueCapability: vi.fn(async () => {
        stopped = manager.stop();
        return lease(async () => {}, revoke);
      }),
      spawn,
    });

    await expect(manager.start()).rejects.toMatchObject({ code: "HERMES_SIDECAR_STOPPED" });
    if (!stopped) throw new Error("stop was not requested");
    await expect(stopped).resolves.toBeUndefined();

    expect(revoke).toHaveBeenCalledOnce();
    expect(spawn).not.toHaveBeenCalled();
  });
});

function createManager(
  overrides: Partial<ConstructorParameters<typeof HermesSidecarManager>[0]> & {
    readonly child?: FakeSidecarProcess;
  } = {},
): HermesSidecarManager {
  const child = overrides.child ?? new FakeSidecarProcess();
  return new HermesSidecarManager({
    dataRoot: "/opentrad-data",
    paths,
    platform: "darwin",
    launcherPath,
    binding,
    issueCapability: vi.fn(async () =>
      lease(
        async (pipe) => endPipe(pipe, Buffer.from("default-capability")),
        () => {},
      ),
    ),
    ensureStateDirs: vi.fn(async () => {}),
    verifyInstallation: vi.fn(async () => {}),
    spawn: vi.fn<HermesSidecarSpawn>(() => child),
    terminatorFactory: () => async () => {},
    clientFactory: () => immediateClient(),
    ...overrides,
  });
}

function lease(
  transmit: (pipe: Writable) => Promise<void>,
  revoke: () => void,
): HermesSidecarCapabilityLease {
  return { transmit, revoke };
}

function immediateClient(): HermesSidecarClient {
  return {
    ready: async () => {},
    dispose: async () => {},
    onCrash: () => () => {},
  };
}

function endPipe(pipe: Writable, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    pipe.once("error", reject);
    pipe.end(bytes, resolve);
  });
}
