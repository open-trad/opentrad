import { spawn as nodeSpawn } from "node:child_process";
import { isAbsolute, win32 } from "node:path";
import { createHermesCommandRunner } from "./command-runner";
import { HERMES_GATEWAY_MODULE } from "./constants";
import {
  HermesGatewayClient,
  type HermesGatewayClientOptions,
  type HermesGatewayCrashListener,
  type HermesGatewayProcess,
} from "./gateway-client";
import { verifyHermesInstallation } from "./installation";
import {
  ensureHermesStateDirs,
  type HermesPaths,
  type HermesPlatform,
  resolveHermesPaths,
} from "./paths";
import {
  createHermesSidecarTerminator,
  type HermesSidecarTerminationOptions,
  validateHermesSidecarTerminationOptions,
} from "./sidecar-process-tree";
import {
  createHermesGatewaySpawnSpec,
  type HermesGatewaySpawnSpec,
  isHermesGatewaySpawnEnvKeyAllowed,
} from "./spawn-spec";

export type HermesSidecarState = "idle" | "starting" | "ready" | "stopping" | "stopped" | "crashed";

export type HermesSidecarErrorCode =
  | "HERMES_SIDECAR_START"
  | "HERMES_SIDECAR_STOPPED"
  | "HERMES_SIDECAR_CRASHED"
  | "HERMES_SIDECAR_CLEANUP";

const SIDECAR_ERROR_MESSAGES: Readonly<Record<HermesSidecarErrorCode, string>> = {
  HERMES_SIDECAR_START: "Hermes sidecar failed to start",
  HERMES_SIDECAR_STOPPED: "Hermes sidecar startup was stopped",
  HERMES_SIDECAR_CRASHED: "Hermes sidecar process crashed",
  HERMES_SIDECAR_CLEANUP: "Hermes sidecar cleanup could not be confirmed",
};

export class HermesSidecarError extends Error {
  readonly code: HermesSidecarErrorCode;

  constructor(code: HermesSidecarErrorCode) {
    super(SIDECAR_ERROR_MESSAGES[code]);
    this.name = "HermesSidecarError";
    this.code = code;
  }
}

export interface HermesSidecarProcess extends HermesGatewayProcess {
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
}

export interface HermesSidecarSpawnOptions {
  readonly cwd: string;
  readonly detached: boolean;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly stdio: readonly ["pipe", "pipe", "pipe"];
  readonly windowsHide: true;
}

export type HermesSidecarSpawn = (
  command: string,
  args: readonly string[],
  options: HermesSidecarSpawnOptions,
) => HermesSidecarProcess;

export interface HermesSidecarClient {
  ready(): Promise<void>;
  dispose(): Promise<void>;
  onCrash(listener: HermesGatewayCrashListener): () => void;
}

export type HermesSidecarTerminatorFactory = (child: HermesSidecarProcess) => () => Promise<void>;

export interface HermesSidecarManagerOptions {
  readonly dataRoot: string;
  readonly sourceEnv?: NodeJS.ProcessEnv;
  readonly platform?: HermesPlatform;
  readonly paths?: HermesPaths;
  readonly ensureStateDirs?: typeof ensureHermesStateDirs;
  readonly verifyInstallation?: (
    pythonExecutable: string,
    spawnSpec: HermesGatewaySpawnSpec,
  ) => Promise<unknown>;
  readonly spawn?: HermesSidecarSpawn;
  readonly spawnSpecFactory?: typeof createHermesGatewaySpawnSpec;
  readonly clientFactory?: (options: HermesGatewayClientOptions) => HermesSidecarClient;
  readonly terminatorFactory?: HermesSidecarTerminatorFactory;
  readonly terminationOptions?: HermesSidecarTerminationOptions;
  readonly readyTimeoutMs?: number;
}

export type HermesSidecarCrashListener = (error: HermesSidecarError) => void | Promise<void>;

const RESOLVED = Promise.resolve();

type HermesLifecycleCommandKind = "start" | "stop" | "restart";

interface HermesLifecycleCommand {
  readonly kind: HermesLifecycleCommandKind;
  readonly token: number;
  readonly promise: Promise<void>;
  readonly cancellation: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: HermesSidecarError) => void;
  cancel(): void;
  canceled: boolean;
  settled: boolean;
}

export class HermesSidecarManager {
  private readonly dataRoot: string;
  private readonly paths: HermesPaths;
  private readonly platform: HermesPlatform;
  private readonly ensureStateDirs: typeof ensureHermesStateDirs;
  private readonly verifyInstallation: NonNullable<
    HermesSidecarManagerOptions["verifyInstallation"]
  >;
  private readonly spawnProcess: HermesSidecarSpawn;
  private readonly spawnSpec: HermesGatewaySpawnSpec;
  private readonly clientFactory: NonNullable<HermesSidecarManagerOptions["clientFactory"]>;
  private readonly terminatorFactory: HermesSidecarTerminatorFactory;
  private readonly emergencyTerminatorFactory: HermesSidecarTerminatorFactory;
  private readonly readyTimeoutMs: number | undefined;
  private readonly crashListeners = new Set<HermesSidecarCrashListener>();
  private currentState: HermesSidecarState = "idle";
  private client: HermesSidecarClient | undefined;
  private terminate: (() => Promise<void>) | undefined;
  private unsubscribeCrash: (() => void) | undefined;
  private readonly lifecycleQueue: HermesLifecycleCommand[] = [];
  private activeCommand: HermesLifecycleCommand | undefined;
  private lastIntent: HermesLifecycleCommand | undefined;
  private lifecycleActor: Promise<void> | undefined;
  private nextIntentToken = 1;
  private generation = 0;
  private crashNotifiedGeneration = -1;

  constructor(options: HermesSidecarManagerOptions) {
    this.dataRoot = options.dataRoot;
    this.platform = options.platform ?? hostHermesPlatform();
    try {
      this.paths = Object.freeze({
        ...(options.paths ?? resolveHermesPaths(options.dataRoot, this.platform)),
      });
    } catch {
      throw new HermesSidecarError("HERMES_SIDECAR_START");
    }
    this.ensureStateDirs = options.ensureStateDirs ?? ensureHermesStateDirs;
    this.spawnProcess = options.spawn ?? defaultSpawn;
    this.clientFactory =
      options.clientFactory ?? ((clientOptions) => new HermesGatewayClient(clientOptions));
    this.readyTimeoutMs = options.readyTimeoutMs;
    const specFactory = options.spawnSpecFactory ?? createHermesGatewaySpawnSpec;
    try {
      this.spawnSpec = snapshotSpawnSpec(
        specFactory(this.paths, options.sourceEnv ?? process.env, this.platform),
      );
      validateSpawnSpec(this.spawnSpec, this.paths, this.platform);
    } catch {
      throw new HermesSidecarError("HERMES_SIDECAR_START");
    }
    this.verifyInstallation =
      options.verifyInstallation ??
      (async (pythonExecutable, spawnSpec) => {
        const runner = createHermesCommandRunner({
          cwd: spawnSpec.cwd,
          env: spawnSpec.env,
        });
        await verifyHermesInstallation(pythonExecutable, runner);
      });
    let terminationOptions: Readonly<HermesSidecarTerminationOptions>;
    try {
      terminationOptions = Object.freeze({
        ...options.terminationOptions,
        platform: this.platform,
      });
      validateHermesSidecarTerminationOptions(terminationOptions);
    } catch {
      throw new HermesSidecarError("HERMES_SIDECAR_START");
    }
    this.terminatorFactory =
      options.terminatorFactory ??
      ((child) => createHermesSidecarTerminator(child, terminationOptions));
    this.emergencyTerminatorFactory = (child) =>
      createHermesSidecarTerminator(child, { platform: this.platform });
  }

  get state(): HermesSidecarState {
    return this.currentState;
  }

  start(): Promise<void> {
    const pendingIntent = this.lastPendingIntent();
    if (pendingIntent?.kind === "start" || pendingIntent?.kind === "restart") {
      return pendingIntent.promise;
    }
    if (this.currentState === "ready" && !this.hasPendingLifecycleWork()) return RESOLVED;
    return this.enqueueLifecycleCommand("start").promise;
  }

  stop(): Promise<void> {
    const pendingIntent = this.lastPendingIntent();
    if (pendingIntent?.kind === "stop") return pendingIntent.promise;
    if (
      (this.currentState === "idle" || this.currentState === "stopped") &&
      !this.hasPendingLifecycleWork() &&
      !this.client &&
      !this.terminate
    ) {
      this.currentState = "stopped";
      return RESOLVED;
    }

    this.cancelReadyIntents();
    this.currentState = "stopping";
    return this.enqueueLifecycleCommand("stop").promise;
  }

  restart(): Promise<void> {
    const pendingIntent = this.lastPendingIntent();
    if (pendingIntent?.kind === "restart") return pendingIntent.promise;
    this.cancelReadyIntents();
    this.currentState = "stopping";
    return this.enqueueLifecycleCommand("restart").promise;
  }

  onCrash(listener: HermesSidecarCrashListener): () => void {
    this.crashListeners.add(listener);
    return () => {
      this.crashListeners.delete(listener);
    };
  }

  private enqueueLifecycleCommand(kind: HermesLifecycleCommandKind): HermesLifecycleCommand {
    const command = createLifecycleCommand(kind, this.nextIntentToken);
    this.nextIntentToken += 1;
    this.lastIntent = command;
    this.lifecycleQueue.push(command);
    this.startLifecycleActor();
    return command;
  }

  private startLifecycleActor(): void {
    if (this.lifecycleActor) return;
    // Register ownership before executing injected dependencies. A dependency may synchronously
    // call start/stop/restart from its Promise executor; deferring drain prevents a second actor.
    const actor = Promise.resolve().then(() => this.drainLifecycleQueue());
    this.lifecycleActor = actor;
    void actor.then(
      () => this.finishLifecycleActor(actor),
      () => this.finishLifecycleActor(actor),
    );
  }

  private finishLifecycleActor(actor: Promise<void>): void {
    if (this.lifecycleActor === actor) this.lifecycleActor = undefined;
    if (this.lifecycleQueue.length > 0) this.startLifecycleActor();
  }

  private async drainLifecycleQueue(): Promise<void> {
    while (this.lifecycleQueue.length > 0) {
      const command = this.lifecycleQueue.shift();
      if (!command) continue;
      this.activeCommand = command;
      try {
        await this.executeLifecycleCommand(command);
        command.settled = true;
        command.resolve();
      } catch (cause) {
        command.settled = true;
        command.reject(normalizeLifecycleError(command, cause));
      } finally {
        if (this.activeCommand === command) this.activeCommand = undefined;
      }
    }
  }

  private executeLifecycleCommand(command: HermesLifecycleCommand): Promise<void> {
    switch (command.kind) {
      case "start":
        return this.startOnce(command);
      case "stop":
        return this.stopOnce();
      case "restart":
        return this.restartOnce(command);
    }
  }

  private async restartOnce(command: HermesLifecycleCommand): Promise<void> {
    await this.stopOnce();
    this.throwIfCanceled(command);
    await this.startOnce(command);
  }

  private async startOnce(command: HermesLifecycleCommand): Promise<void> {
    this.throwIfCanceled(command);
    this.currentState = "starting";
    const generation = command.token;
    this.generation = generation;
    try {
      if (this.client || this.terminate) {
        await this.cleanupCurrent(this.client);
      }
      this.throwIfCanceled(command);
      await this.ensureStateDirs(this.paths, { dataRoot: this.dataRoot });
      this.throwIfCanceled(command);
      await this.verifyInstallation(this.paths.pythonExecutable, this.spawnSpec);
      this.throwIfCanceled(command);

      const child = this.spawnProcess(
        this.spawnSpec.command,
        [...this.spawnSpec.args],
        spawnOptions(this.spawnSpec, this.platform),
      );
      try {
        const terminate = this.terminatorFactory(child);
        if (typeof terminate !== "function") {
          throw new HermesSidecarError("HERMES_SIDECAR_START");
        }
        this.terminate = terminate;
      } catch {
        this.terminate = this.emergencyTerminatorFactory(child);
        throw new HermesSidecarError("HERMES_SIDECAR_START");
      }
      const client = this.clientFactory({
        process: child,
        terminate: this.terminate,
        ...(this.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: this.readyTimeoutMs }),
      });
      this.client = client;
      this.unsubscribeCrash = client.onCrash(() => {
        this.handleCrash(generation);
      });
      this.throwIfCanceled(command);
      await Promise.race([
        client.ready(),
        command.cancellation.then(() => {
          throw new HermesSidecarError("HERMES_SIDECAR_STOPPED");
        }),
      ]);
      this.throwIfCanceled(command);
      if (generation !== this.generation || this.client !== client) {
        throw new HermesSidecarError("HERMES_SIDECAR_STOPPED");
      }
      if (this.crashNotifiedGeneration === generation) {
        throw new HermesSidecarError("HERMES_SIDECAR_CRASHED");
      }
      this.currentState = "ready";
    } catch (cause) {
      let cleanupFailed = false;
      try {
        await this.cleanupCurrent(this.client);
      } catch {
        cleanupFailed = true;
      }
      if (cleanupFailed) {
        this.currentState = "crashed";
        throw new HermesSidecarError("HERMES_SIDECAR_CLEANUP");
      }
      if (command.canceled) {
        throw new HermesSidecarError("HERMES_SIDECAR_STOPPED");
      }
      this.currentState = "crashed";
      if (isSidecarCleanupError(cause)) {
        throw new HermesSidecarError("HERMES_SIDECAR_CLEANUP");
      }
      throw new HermesSidecarError("HERMES_SIDECAR_START");
    }
  }

  private async stopOnce(): Promise<void> {
    this.currentState = "stopping";
    try {
      if (this.client || this.terminate) {
        await this.cleanupCurrent(this.client);
      }
      this.currentState = "stopped";
    } catch {
      this.currentState = "crashed";
      throw new HermesSidecarError("HERMES_SIDECAR_CLEANUP");
    }
  }

  private async cleanupCurrent(expectedClient: HermesSidecarClient | undefined): Promise<void> {
    if (expectedClient && this.client !== expectedClient) return;
    const client = this.client;
    const terminate = this.terminate;
    try {
      this.unsubscribeCrash?.();
    } catch {
      // Observer detachment must never prevent owned process cleanup.
    }
    this.unsubscribeCrash = undefined;
    try {
      if (client) {
        await client.dispose();
      } else if (terminate) {
        await terminate();
      } else {
        return;
      }
    } catch {
      throw new HermesSidecarError("HERMES_SIDECAR_CLEANUP");
    }
    if (!expectedClient || this.client === expectedClient) {
      this.client = undefined;
      this.terminate = undefined;
    }
  }

  private throwIfCanceled(command: HermesLifecycleCommand): void {
    if (command.canceled) {
      throw new HermesSidecarError("HERMES_SIDECAR_STOPPED");
    }
  }

  private lastPendingIntent(): HermesLifecycleCommand | undefined {
    return this.lastIntent && !this.lastIntent.settled ? this.lastIntent : undefined;
  }

  private hasPendingLifecycleWork(): boolean {
    return this.activeCommand !== undefined || this.lifecycleQueue.length > 0;
  }

  private cancelReadyIntents(): void {
    for (const command of [this.activeCommand, ...this.lifecycleQueue]) {
      if (command && !command.settled && (command.kind === "start" || command.kind === "restart")) {
        command.cancel();
      }
    }
  }

  private handleCrash(generation: number): void {
    if (
      generation !== this.generation ||
      this.currentState === "stopping" ||
      this.currentState === "stopped" ||
      this.crashNotifiedGeneration === generation
    ) {
      return;
    }
    this.crashNotifiedGeneration = generation;
    this.currentState = "crashed";
    const error = new HermesSidecarError("HERMES_SIDECAR_CRASHED");
    for (const listener of [...this.crashListeners]) {
      invokeObserver(listener, error);
    }
  }
}

function createLifecycleCommand(
  kind: HermesLifecycleCommandKind,
  token: number,
): HermesLifecycleCommand {
  let resolveCommand!: () => void;
  let rejectCommand!: (error: HermesSidecarError) => void;
  let resolveCancellation!: () => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolveCommand = resolve;
    rejectCommand = reject;
  });
  const cancellation = new Promise<void>((resolve) => {
    resolveCancellation = resolve;
  });
  const command: HermesLifecycleCommand = {
    kind,
    token,
    promise,
    cancellation,
    resolve: resolveCommand,
    reject: rejectCommand,
    canceled: false,
    settled: false,
    cancel() {
      if (command.canceled || command.settled) return;
      command.canceled = true;
      resolveCancellation();
    },
  };
  void promise.catch(() => {});
  return command;
}

function normalizeLifecycleError(
  command: HermesLifecycleCommand,
  cause: unknown,
): HermesSidecarError {
  if (cause instanceof HermesSidecarError) return cause;
  if (command.canceled) return new HermesSidecarError("HERMES_SIDECAR_STOPPED");
  return new HermesSidecarError(
    command.kind === "stop" ? "HERMES_SIDECAR_CLEANUP" : "HERMES_SIDECAR_START",
  );
}

function spawnOptions(
  spec: HermesGatewaySpawnSpec,
  platform: HermesPlatform,
): HermesSidecarSpawnOptions {
  return {
    cwd: spec.cwd,
    detached: platform !== "win32",
    env: { ...spec.env },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };
}

const defaultSpawn: HermesSidecarSpawn = (command, args, options) => {
  const child = nodeSpawn(command, [...args], {
    cwd: options.cwd,
    detached: options.detached,
    env: { ...options.env },
    shell: options.shell,
    stdio: [...options.stdio],
    windowsHide: options.windowsHide,
  });
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new HermesSidecarError("HERMES_SIDECAR_START");
  }
  return child as HermesSidecarProcess;
};

function validateSpawnSpec(
  spec: HermesGatewaySpawnSpec,
  paths: HermesPaths,
  platform: HermesPlatform,
): void {
  const isPlatformAbsolute = platform === "win32" ? win32.isAbsolute : isAbsolute;
  if (
    !isPlatformAbsolute(spec.command) ||
    !isPlatformAbsolute(spec.cwd) ||
    spec.command !== paths.pythonExecutable ||
    spec.cwd !== paths.gatewayCwd ||
    spec.args.length !== 3 ||
    spec.args[0] !== "-u" ||
    spec.args[1] !== "-m" ||
    spec.args[2] !== HERMES_GATEWAY_MODULE ||
    spec.env.HERMES_HOME !== paths.hermesHome ||
    spec.env.PYTHONUNBUFFERED !== "1" ||
    Object.entries(spec.env).some(
      ([key, value]) =>
        typeof value !== "string" || !isHermesGatewaySpawnEnvKeyAllowed(key, platform),
    )
  ) {
    throw new HermesSidecarError("HERMES_SIDECAR_START");
  }
}

function snapshotSpawnSpec(spec: HermesGatewaySpawnSpec): HermesGatewaySpawnSpec {
  return Object.freeze({
    command: spec.command,
    args: Object.freeze([...spec.args]),
    cwd: spec.cwd,
    env: Object.freeze({ ...spec.env }),
  });
}

function hostHermesPlatform(): HermesPlatform {
  return process.platform === "win32" || process.platform === "linux" ? process.platform : "darwin";
}

function isSidecarCleanupError(value: unknown): boolean {
  return value instanceof HermesSidecarError && value.code === "HERMES_SIDECAR_CLEANUP";
}

function invokeObserver<T>(listener: (value: T) => void | Promise<void>, value: T): void {
  try {
    void Promise.resolve(listener(value)).catch(() => {});
  } catch {
    // Observer failures never alter process ownership or cleanup.
  }
}
