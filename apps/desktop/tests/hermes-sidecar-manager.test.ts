import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveHermesPaths } from "../src/main/services/hermes/paths";
import {
  type HermesSidecarClient,
  HermesSidecarManager,
  type HermesSidecarProcess,
  type HermesSidecarSpawn,
  type HermesSidecarTerminatorFactory,
} from "../src/main/services/hermes/sidecar-manager";

class FakeSidecarProcess extends EventEmitter implements HermesSidecarProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 12_345;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
}

const paths = resolveHermesPaths("/opentrad-data", "darwin");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("HermesSidecarManager startup", () => {
  it("starts in the fail-closed order and accepts the pinned ready envelope", async () => {
    const child = new FakeSidecarProcess();
    const order: string[] = [];
    const ensureStateDirs = vi.fn(async () => {
      order.push("ensure");
    });
    const verifyInstallation = vi.fn(async () => {
      order.push("verify");
    });
    const spawn = vi.fn<HermesSidecarSpawn>(() => {
      order.push("spawn");
      return child;
    });
    const terminate = vi.fn(async () => {
      order.push("terminate");
      child.emit("close", 0, null);
    });
    const manager = new HermesSidecarManager({
      dataRoot: "/opentrad-data",
      paths,
      platform: "darwin",
      ensureStateDirs,
      verifyInstallation,
      spawn,
      terminatorFactory: () => terminate,
    });

    const started = manager.start();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    expect(manager.state).toBe("starting");
    child.stdout.write(pinnedReadyFrame());
    await expect(started).resolves.toBeUndefined();

    expect(order).toEqual(["ensure", "verify", "spawn"]);
    expect(manager.state).toBe("ready");
    expect(spawn).toHaveBeenCalledWith(
      paths.pythonExecutable,
      ["-u", "-m", "tui_gateway.entry"],
      expect.objectContaining({
        cwd: paths.gatewayCwd,
        detached: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }),
    );

    await manager.stop();
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("snapshots managed paths so caller mutation cannot redirect a later start", async () => {
    const child = new FakeSidecarProcess();
    const mutablePaths = { ...paths };
    const ensureStateDirs = vi.fn(async () => {});
    const verifyInstallation = vi.fn(async () => {});
    const spawn = vi.fn<HermesSidecarSpawn>(() => child);
    const manager = new HermesSidecarManager({
      dataRoot: "/opentrad-data",
      paths: mutablePaths,
      platform: "darwin",
      ensureStateDirs,
      verifyInstallation,
      spawn,
      terminatorFactory: () => async () => {
        child.emit("close", 0, null);
      },
    });
    mutablePaths.gatewayCwd = "/tmp/redirected-gateway-cwd";
    mutablePaths.pythonExecutable = "/tmp/redirected-python";

    const started = manager.start();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.stdout.write(pinnedReadyFrame());
    await started;

    expect(ensureStateDirs.mock.calls[0]?.[0]).toMatchObject({
      gatewayCwd: paths.gatewayCwd,
      pythonExecutable: paths.pythonExecutable,
    });
    expect(verifyInstallation).toHaveBeenCalledWith(paths.pythonExecutable, expect.any(Object));
    expect(spawn.mock.calls[0]?.[0]).toBe(paths.pythonExecutable);
    expect(spawn.mock.calls[0]?.[2].cwd).toBe(paths.gatewayCwd);
    await manager.stop();
  });

  it.each([
    "missing-version-canary",
    "mismatch-version-canary",
  ])("rejects an unavailable pinned installation without spawning: %s", async (secret) => {
    const spawn = vi.fn<HermesSidecarSpawn>();
    const manager = createManager({
      spawn,
      verifyInstallation: vi.fn(async () => {
        throw new Error(secret);
      }),
    });

    const error = await manager.start().catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "HERMES_SIDECAR_START" });
    expect(String(error)).not.toContain("canary");
    expect(JSON.stringify(error)).not.toContain("canary");
    expect(spawn).not.toHaveBeenCalled();
    expect(manager.state).toBe("crashed");
  });

  it("sanitizes a synchronous spawn failure", async () => {
    const manager = createManager({
      spawn: vi.fn<HermesSidecarSpawn>(() => {
        throw new Error("spawn-raw-canary");
      }),
    });

    const error = await manager.start().catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "HERMES_SIDECAR_START" });
    expect(String(error)).not.toContain("canary");
    expect(JSON.stringify(error)).not.toContain("canary");
    expect(manager.state).toBe("crashed");
  });

  it("rejects invalid cleanup grace configuration before spawning", () => {
    const spawn = vi.fn<HermesSidecarSpawn>();

    expect(
      () =>
        new HermesSidecarManager({
          dataRoot: "/opentrad-data",
          paths,
          platform: "darwin",
          spawn,
          terminationOptions: { gracefulShutdownMs: 1_000 },
        }),
    ).toThrowError(expect.objectContaining({ code: "HERMES_SIDECAR_START" }));
    expect(spawn).not.toHaveBeenCalled();
  });

  it("falls back to owned process-tree cleanup if an injected terminator factory throws", async () => {
    const child = new FakeSidecarProcess();
    child.exitCode = 1;
    const missingGroup = Object.assign(new Error("missing process group"), { code: "ESRCH" });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw missingGroup;
    });
    const manager = createManager({
      child,
      terminatorFactory: () => {
        throw new Error("terminator-factory-canary");
      },
    });

    const error = await manager.start().catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "HERMES_SIDECAR_START" });
    expect(String(error)).not.toContain("canary");
    expect(kill).toHaveBeenCalledWith(-child.pid, 0);
    expect(child.listenerCount("error")).toBe(0);
    expect(manager.state).toBe("crashed");
  });

  it.each([
    {
      name: "gateway module args",
      mutate: (spec: ReturnType<typeof validSpawnSpec>) => ({
        ...spec,
        args: ["-u", "-m", "untrusted.module"],
      }),
    },
    {
      name: "isolated HERMES_HOME",
      mutate: (spec: ReturnType<typeof validSpawnSpec>) => ({
        ...spec,
        env: { ...spec.env, HERMES_HOME: "/Users/example/.hermes" },
      }),
    },
    {
      name: "environment allowlist",
      mutate: (spec: ReturnType<typeof validSpawnSpec>) => ({
        ...spec,
        env: { ...spec.env, OPENAI_API_KEY: "spec-canary" },
      }),
    },
    {
      name: "environment string values",
      mutate: (spec: ReturnType<typeof validSpawnSpec>) => ({
        ...spec,
        env: { ...spec.env, PATH: 42 as unknown as string },
      }),
    },
  ])("rejects a malformed $name contract before spawn", ({ mutate }) => {
    const spawn = vi.fn<HermesSidecarSpawn>();
    let error: unknown;

    try {
      new HermesSidecarManager({
        dataRoot: "/opentrad-data",
        paths,
        platform: "darwin",
        ensureStateDirs: vi.fn(async () => {}),
        verifyInstallation: vi.fn(async () => {}),
        spawn,
        spawnSpecFactory: () => mutate(validSpawnSpec()),
      });
    } catch (cause) {
      error = cause;
    }

    expect(error).toMatchObject({ code: "HERMES_SIDECAR_START" });
    expect(String(error)).not.toContain("canary");
    expect(JSON.stringify(error)).not.toContain("canary");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("coalesces concurrent starts into one process", async () => {
    const child = new FakeSidecarProcess();
    const spawn = vi.fn<HermesSidecarSpawn>(() => child);
    const manager = createManager({ spawn, child });

    const first = manager.start();
    const second = manager.start();

    expect(first).toBe(second);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.stdout.write(pinnedReadyFrame());
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    await manager.stop();
  });

  it("cleans up an error before ready and reports one sanitized crash", async () => {
    const child = new FakeSidecarProcess();
    const spawn = vi.fn<HermesSidecarSpawn>(() => child);
    const terminate = vi.fn(async () => {
      child.emit("close", 1, null);
    });
    const manager = createManager({ child, spawn, terminatorFactory: () => terminate });
    const crashes = vi.fn();
    manager.onCrash(crashes);

    const started = manager.start();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.emit("error", new Error("child-error-canary"));
    child.emit("exit", 1, null);
    child.emit("close", 1, null);
    const error = await started.catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "HERMES_SIDECAR_START" });
    expect(String(error)).not.toContain("canary");
    expect(terminate).toHaveBeenCalledOnce();
    expect(crashes).toHaveBeenCalledOnce();
    expect(crashes.mock.calls[0]?.[0]).toMatchObject({ code: "HERMES_SIDECAR_CRASHED" });
    expect(manager.state).toBe("crashed");
  });

  it("cannot overwrite a same-turn crash with ready after the ready promise resolves", async () => {
    const child = new FakeSidecarProcess();
    const spawn = vi.fn<HermesSidecarSpawn>(() => child);
    const terminate = vi.fn(async () => {
      child.emit("close", 1, null);
    });
    const manager = createManager({ child, spawn, terminatorFactory: () => terminate });
    const crashes = vi.fn();
    manager.onCrash(crashes);

    const started = manager.start();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.stdout.write(pinnedReadyFrame());
    child.emit("error", new Error("same-turn-crash-canary"));

    await expect(started).rejects.toMatchObject({ code: "HERMES_SIDECAR_START" });
    expect(manager.state).toBe("crashed");
    expect(crashes).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("times out readiness, confirms cleanup, and never exposes stderr", async () => {
    vi.useFakeTimers();
    const child = new FakeSidecarProcess();
    const terminate = vi.fn(async () => {
      child.emit("close", 1, null);
    });
    const manager = createManager({
      child,
      readyTimeoutMs: 10,
      terminatorFactory: () => terminate,
    });

    const started = manager.start();
    const outcome = started.catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(0);
    child.stderr.write("stderr-ready-timeout-canary");
    await vi.advanceTimersByTimeAsync(10);
    const error = await outcome;

    expect(error).toMatchObject({ code: "HERMES_SIDECAR_START" });
    expect(String(error)).not.toContain("canary");
    expect(JSON.stringify(error)).not.toContain("canary");
    expect(terminate).toHaveBeenCalledOnce();
    expect(manager.state).toBe("crashed");
  });

  it("cancels a concurrent start before spawn when stop is requested during verification", async () => {
    let releaseVerification!: () => void;
    const verification = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    const spawn = vi.fn<HermesSidecarSpawn>();
    const manager = createManager({
      spawn,
      verifyInstallation: vi.fn(() => verification),
    });

    const started = manager.start();
    await vi.waitFor(() => expect(manager.state).toBe("starting"));
    const firstStop = manager.stop();
    const secondStop = manager.stop();
    expect(firstStop).toBe(secondStop);
    releaseVerification();

    await expect(started).rejects.toMatchObject({ code: "HERMES_SIDECAR_STOPPED" });
    await expect(firstStop).resolves.toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
    expect(manager.state).toBe("stopped");
  });

  it("cancels an active ready wait and lets the lifecycle actor own cleanup", async () => {
    const child = new FakeSidecarProcess();
    const spawn = vi.fn<HermesSidecarSpawn>(() => child);
    const terminate = vi.fn(async () => {
      child.emit("close", 0, null);
    });
    const manager = createManager({ child, spawn, terminatorFactory: () => terminate });
    const crashes = vi.fn();
    manager.onCrash(crashes);

    const started = manager.start();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const stopped = manager.stop();

    await expect(started).rejects.toMatchObject({ code: "HERMES_SIDECAR_STOPPED" });
    await expect(stopped).resolves.toBeUndefined();
    expect(terminate).toHaveBeenCalledOnce();
    expect(crashes).not.toHaveBeenCalled();
    expect(manager.state).toBe("stopped");
  });
});

describe("HermesSidecarManager stop and restart", () => {
  it("coalesces active stops, ends stdin before termination, and does not report a crash", async () => {
    const child = new FakeSidecarProcess();
    const order: string[] = [];
    const terminate = vi.fn(async () => {
      expect(child.stdin.writableEnded).toBe(true);
      order.push("stdin-end");
      order.push("terminate");
      child.emit("close", 0, null);
    });
    const manager = createManager({ child, terminatorFactory: () => terminate });
    const crashes = vi.fn();
    manager.onCrash(crashes);
    const started = manager.start();
    await vi.waitFor(() => expect(manager.state).toBe("starting"));
    child.stdout.write(pinnedReadyFrame());
    await started;

    const first = manager.stop();
    const second = manager.stop();

    expect(first).toBe(second);
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(order).toEqual(["stdin-end", "terminate"]);
    expect(terminate).toHaveBeenCalledOnce();
    expect(crashes).not.toHaveBeenCalled();
    expect(manager.state).toBe("stopped");
  });

  it("propagates cleanup failure without exposing its raw cause", async () => {
    const child = new FakeSidecarProcess();
    const manager = createManager({
      child,
      terminatorFactory: () => async () => {
        throw new Error("cleanup-raw-canary");
      },
    });
    const started = manager.start();
    await vi.waitFor(() => expect(manager.state).toBe("starting"));
    child.stdout.write(pinnedReadyFrame());
    await started;

    const error = await manager.stop().catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "HERMES_SIDECAR_CLEANUP" });
    expect(String(error)).not.toContain("canary");
    expect(JSON.stringify(error)).not.toContain("canary");
    expect(manager.state).toBe("crashed");
  });

  it("coalesces error, exit, and close into one crash notification after ready", async () => {
    const child = new FakeSidecarProcess();
    const terminate = vi.fn(async () => {});
    const manager = createManager({ child, terminatorFactory: () => terminate });
    const crashes = vi.fn();
    manager.onCrash(crashes);
    const started = manager.start();
    await vi.waitFor(() => expect(manager.state).toBe("starting"));
    child.stdout.write(pinnedReadyFrame());
    await started;

    child.emit("error", new Error("crash-event-canary"));
    child.emit("exit", 1, null);
    child.emit("close", 1, null);
    await Promise.resolve();

    expect(crashes).toHaveBeenCalledOnce();
    expect(crashes.mock.calls[0]?.[0]).toMatchObject({ code: "HERMES_SIDECAR_CRASHED" });
    expect(String(crashes.mock.calls[0]?.[0])).not.toContain("canary");
    expect(manager.state).toBe("crashed");
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("restarts with a new process without replaying any task command", async () => {
    const firstChild = new FakeSidecarProcess();
    const secondChild = new FakeSidecarProcess();
    const children = [firstChild, secondChild];
    let nextChild = 0;
    const spawn = vi.fn<HermesSidecarSpawn>(() => {
      const child = children[nextChild];
      nextChild += 1;
      if (!child) throw new Error("unexpected extra spawn");
      return child;
    });
    const manager = createManager({
      spawn,
      terminatorFactory: (child) => async () => {
        (child as FakeSidecarProcess).emit("close", 0, null);
      },
    });
    const firstStart = manager.start();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    firstChild.stdout.write(pinnedReadyFrame());
    await firstStart;

    const restarted = manager.restart();
    const duplicateRestart = manager.restart();
    expect(restarted).toBe(duplicateRestart);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    secondChild.stdout.write(pinnedReadyFrame());
    await Promise.all([restarted, duplicateRestart]);

    expect(manager.state).toBe("ready");
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(firstChild.stdin.readableLength).toBe(0);
    expect(secondChild.stdin.readableLength).toBe(0);
    await manager.stop();
  });

  it("linearizes restart followed by start onto one replacement process", async () => {
    const children = [new FakeSidecarProcess(), new FakeSidecarProcess()];
    let releaseFirstDispose!: () => void;
    const firstDisposeGate = new Promise<void>((resolve) => {
      releaseFirstDispose = resolve;
    });
    const clients = [immediateClient(() => firstDisposeGate), immediateClient(async () => {})];
    let nextChild = 0;
    let nextClient = 0;
    const spawn = vi.fn<HermesSidecarSpawn>(() => {
      const child = children[nextChild];
      nextChild += 1;
      if (!child) throw new Error("unexpected extra process");
      return child;
    });
    const manager = createManager({
      spawn,
      clientFactory: () => {
        const client = clients[nextClient];
        nextClient += 1;
        if (!client) throw new Error("unexpected extra client");
        return client;
      },
    });
    await manager.start();

    const restarted = manager.restart();
    const joinedStart = manager.start();
    releaseFirstDispose();
    const outcomes = await Promise.allSettled([restarted, joinedStart]);

    expect(joinedStart).toBe(restarted);
    expect(outcomes.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(clients[0]?.dispose).toHaveBeenCalledOnce();
    expect(clients[1]?.dispose).not.toHaveBeenCalled();
    expect(manager.state).toBe("ready");

    await manager.stop();
    expect(clients[1]?.dispose).toHaveBeenCalledOnce();
  });

  it("honors a newer stop across stop-start-stop interleaving", async () => {
    const child = new FakeSidecarProcess();
    let releaseDispose!: () => void;
    const disposeGate = new Promise<void>((resolve) => {
      releaseDispose = resolve;
    });
    const client = immediateClient(() => disposeGate);
    const spawn = vi.fn<HermesSidecarSpawn>(() => child);
    const manager = createManager({
      spawn,
      clientFactory: () => client,
    });
    await manager.start();

    const firstStop = manager.stop();
    const deferredStart = manager.start();
    const finalStop = manager.stop();
    releaseDispose();

    await expect(firstStop).resolves.toBeUndefined();
    await expect(deferredStart).rejects.toMatchObject({ code: "HERMES_SIDECAR_STOPPED" });
    await expect(finalStop).resolves.toBeUndefined();
    expect(firstStop).not.toBe(finalStop);
    expect(spawn).toHaveBeenCalledOnce();
    expect(client.dispose).toHaveBeenCalledOnce();
    expect(manager.state).toBe("stopped");
  });

  it("prevents a reentrant spawn callback from starting a second lifecycle actor", async () => {
    const children = [new FakeSidecarProcess(), new FakeSidecarProcess()];
    let releaseFirstDispose!: () => void;
    const firstDisposeGate = new Promise<void>((resolve) => {
      releaseFirstDispose = resolve;
    });
    const clients = [immediateClient(() => firstDisposeGate), immediateClient(async () => {})];
    let manager!: HermesSidecarManager;
    let restarted: Promise<void> | undefined;
    let nextChild = 0;
    let nextClient = 0;
    const spawn = vi.fn<HermesSidecarSpawn>(() => {
      const child = children[nextChild];
      nextChild += 1;
      if (!child) throw new Error("unexpected extra process");
      if (restarted === undefined) restarted = manager.restart();
      return child;
    });
    manager = createManager({
      spawn,
      clientFactory: () => {
        const client = clients[nextClient];
        nextClient += 1;
        if (!client) throw new Error("unexpected extra client");
        return client;
      },
    });

    const initialStart = manager.start();
    const initialOutcome = initialStart.catch((cause: unknown) => cause);
    await vi.waitFor(() => expect(clients[0]?.dispose).toHaveBeenCalledOnce());

    expect(spawn).toHaveBeenCalledOnce();
    releaseFirstDispose();
    await expect(initialOutcome).resolves.toMatchObject({ code: "HERMES_SIDECAR_STOPPED" });
    if (!restarted) throw new Error("restart was not requested");
    await expect(restarted).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(manager.state).toBe("ready");
    await manager.stop();
  });

  it("registers the lifecycle actor before an injected ensure callback can reenter", async () => {
    const child = new FakeSidecarProcess();
    let manager!: HermesSidecarManager;
    let restarted: Promise<void> | undefined;
    let releaseFirstEnsure!: () => void;
    const firstEnsureGate = new Promise<void>((resolve) => {
      releaseFirstEnsure = resolve;
    });
    let activeEnsures = 0;
    let maximumActiveEnsures = 0;
    let ensureCalls = 0;
    const ensureStateDirs = vi.fn(async () => {
      ensureCalls += 1;
      activeEnsures += 1;
      maximumActiveEnsures = Math.max(maximumActiveEnsures, activeEnsures);
      if (ensureCalls === 1) {
        restarted = manager.restart();
        await firstEnsureGate;
      }
      activeEnsures -= 1;
    });
    const spawn = vi.fn<HermesSidecarSpawn>(() => child);
    manager = createManager({
      child,
      ensureStateDirs,
      spawn,
      clientFactory: () => immediateClient(async () => {}),
    });

    const initialStart = manager.start();
    const initialOutcome = initialStart.catch((cause: unknown) => cause);
    await vi.waitFor(() => expect(ensureStateDirs).toHaveBeenCalledOnce());
    await Promise.resolve();
    await Promise.resolve();

    expect(maximumActiveEnsures).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
    releaseFirstEnsure();
    await expect(initialOutcome).resolves.toMatchObject({ code: "HERMES_SIDECAR_STOPPED" });
    if (!restarted) throw new Error("restart was not requested");
    await expect(restarted).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledOnce();
    expect(manager.state).toBe("ready");
    await manager.stop();
  });
});

function createManager(
  overrides: Partial<ConstructorParameters<typeof HermesSidecarManager>[0]> & {
    readonly child?: FakeSidecarProcess;
  } = {},
): HermesSidecarManager {
  const child = overrides.child ?? new FakeSidecarProcess();
  const terminatorFactory: HermesSidecarTerminatorFactory =
    overrides.terminatorFactory ??
    (() => async () => {
      child.emit("close", 0, null);
    });
  return new HermesSidecarManager({
    dataRoot: "/opentrad-data",
    paths,
    platform: "darwin",
    ensureStateDirs: vi.fn(async () => {}),
    verifyInstallation: vi.fn(async () => {}),
    spawn: vi.fn<HermesSidecarSpawn>(() => child),
    terminatorFactory,
    ...overrides,
  });
}

function pinnedReadyFrame(): string {
  return `${JSON.stringify({
    jsonrpc: "2.0",
    method: "event",
    params: { type: "gateway.ready", payload: { skin: "classic" } },
  })}\n`;
}

function validSpawnSpec() {
  return {
    command: paths.pythonExecutable,
    args: ["-u", "-m", "tui_gateway.entry"] as const,
    cwd: paths.gatewayCwd,
    env: {
      HERMES_HOME: paths.hermesHome,
      PYTHONUNBUFFERED: "1",
    },
  };
}

function immediateClient(dispose: () => Promise<void>): HermesSidecarClient & {
  readonly dispose: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  return {
    ready: async () => {},
    dispose: vi.fn(dispose),
    onCrash: () => () => {},
  };
}
