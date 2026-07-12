import { spawn as nodeSpawn } from "node:child_process";
import { isAbsolute, win32 } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { ProviderApiMode } from "../provider-broker";
import { createHermesCommandRunner } from "./command-runner";
import {
  HermesGatewayClient,
  type HermesGatewayClientOptions,
  type HermesGatewayCrashListener,
  HermesGatewayError,
  type HermesGatewayNotificationListener,
  type HermesGatewayProcess,
  HermesGatewayRemoteError,
} from "./gateway-client";
import type {
  HermesGatewayRequestMethod,
  HermesGatewayRequestParams,
  HermesGatewayRequestResult,
} from "./gateway-protocol";
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
import { createHermesGatewaySpawnSpec, type HermesGatewaySpawnSpec } from "./spawn-spec";

export type HermesSidecarState = "idle" | "starting" | "ready" | "stopping" | "stopped" | "crashed";

export type HermesSidecarErrorCode =
  | "HERMES_SIDECAR_START"
  | "HERMES_SIDECAR_NOT_READY"
  | "HERMES_SIDECAR_STOPPED"
  | "HERMES_SIDECAR_CRASHED"
  | "HERMES_SIDECAR_CLEANUP";

const SIDECAR_ERROR_MESSAGES: Readonly<Record<HermesSidecarErrorCode, string>> = {
  HERMES_SIDECAR_START: "Hermes sidecar failed to start",
  HERMES_SIDECAR_NOT_READY: "Hermes sidecar is not ready",
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
  readonly stdio: readonly [Writable, Readable, Readable, Writable];
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
}

export interface HermesSidecarSpawnOptions {
  readonly cwd: string;
  readonly detached: boolean;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly stdio: readonly ["pipe", "pipe", "pipe", "pipe"];
  readonly windowsHide: true;
}

export type HermesSidecarSpawn = (
  command: string,
  args: readonly string[],
  options: HermesSidecarSpawnOptions,
) => HermesSidecarProcess;

export interface HermesSidecarClient {
  ready(): Promise<void>;
  request<TMethod extends HermesGatewayRequestMethod>(
    method: TMethod,
    params: HermesGatewayRequestParams<TMethod>,
  ): Promise<HermesGatewayRequestResult<TMethod>>;
  subscribe(listener: HermesGatewayNotificationListener): () => void;
  dispose(): Promise<void>;
  onCrash(listener: HermesGatewayCrashListener): () => void;
}

export type HermesSidecarTerminatorFactory = (child: HermesSidecarProcess) => () => Promise<void>;

export interface HermesSidecarBinding {
  readonly taskId: string;
  readonly runId: string;
  readonly profileId: string;
  readonly model: string;
  readonly apiMode: ProviderApiMode;
}

export interface HermesSidecarCapabilityLease {
  /** Write the short-lived capability to FD3 and close the pipe. */
  transmit(pipe: Writable): Promise<void>;
  /** Synchronous revocation lets crash handling revoke before notifying observers. */
  revoke(): void;
}

export type HermesSidecarCapabilityIssuer = (
  binding: HermesSidecarBinding,
) => Promise<HermesSidecarCapabilityLease>;

export interface HermesSidecarManagerOptions {
  /** One manager owns exactly one task/run process; never share it across bindings. */
  readonly binding: HermesSidecarBinding;
  readonly dataRoot: string;
  readonly issueCapability: HermesSidecarCapabilityIssuer;
  readonly launcherPath: string;
  readonly platform?: HermesPlatform;
  readonly paths?: HermesPaths;
  readonly ensureStateDirs?: typeof ensureHermesStateDirs;
  readonly verifyInstallation?: (
    pythonExecutable: string,
    spawnSpec: HermesGatewaySpawnSpec,
  ) => Promise<unknown>;
  readonly spawn?: HermesSidecarSpawn;
  readonly spawnSpecFactory?: (paths: HermesPaths, launcherPath: string) => HermesGatewaySpawnSpec;
  readonly clientFactory?: (options: HermesGatewayClientOptions) => HermesSidecarClient;
  readonly terminatorFactory?: HermesSidecarTerminatorFactory;
  readonly terminationOptions?: HermesSidecarTerminationOptions;
  readonly readyTimeoutMs?: number;
  readonly capabilityTimeoutMs?: number;
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

interface OwnedCapabilityLease {
  transmit(pipe: Writable): Promise<void>;
  revoke(): void;
}

interface OwnedSidecarSubscription {
  active: boolean;
  rawUnsubscribe: (() => void) | undefined;
}

interface HermesSidecarRpcGeneration {
  readonly client: HermesSidecarClient;
  readonly invalidation: Promise<HermesSidecarError>;
  readonly invalidate: (error: HermesSidecarError) => void;
  readonly subscriptions: Set<OwnedSidecarSubscription>;
  invalidationError: HermesSidecarError | undefined;
  invalidated: boolean;
}

type HermesSidecarRequestOutcome =
  | { readonly kind: "result"; readonly value: unknown }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "invalidated"; readonly error: HermesSidecarError };

const BINDING_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BINDING_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DEFAULT_CAPABILITY_TIMEOUT_MS = 750;
const MAX_CAPABILITY_TIMEOUT_MS = 5_000;

export class HermesSidecarManager {
  private readonly binding: HermesSidecarBinding;
  private readonly dataRoot: string;
  private readonly issueCapability: HermesSidecarCapabilityIssuer;
  private readonly launcherPath: string;
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
  private readonly capabilityTimeoutMs: number;
  private readonly crashListeners = new Set<HermesSidecarCrashListener>();
  private currentState: HermesSidecarState = "idle";
  private client: HermesSidecarClient | undefined;
  private terminate: (() => Promise<void>) | undefined;
  private unsubscribeCrash: (() => void) | undefined;
  private activeCapability: OwnedCapabilityLease | undefined;
  private capabilityPipe: Writable | undefined;
  private rpcGeneration: HermesSidecarRpcGeneration | undefined;
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
      this.binding = snapshotBinding(options.binding);
      this.issueCapability = requireCapabilityIssuer(options.issueCapability);
      this.launcherPath = requireAbsolutePath(options.launcherPath, this.platform);
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
    this.capabilityTimeoutMs = boundedCapabilityTimeout(options.capabilityTimeoutMs);
    const specFactory = options.spawnSpecFactory ?? createHermesGatewaySpawnSpec;
    try {
      this.spawnSpec = snapshotSpawnSpec(specFactory(this.paths, this.launcherPath));
      validateSpawnSpec(this.spawnSpec, this.paths, this.launcherPath, this.platform);
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
      !this.terminate &&
      !this.activeCapability &&
      !this.capabilityPipe
    ) {
      this.currentState = "stopped";
      this.invalidateRpcGeneration("HERMES_SIDECAR_STOPPED");
      return RESOLVED;
    }

    this.cancelReadyIntents();
    this.currentState = "stopping";
    const command = this.enqueueLifecycleCommand("stop");
    this.invalidateRpcGeneration("HERMES_SIDECAR_STOPPED");
    return command.promise;
  }

  restart(): Promise<void> {
    const pendingIntent = this.lastPendingIntent();
    if (pendingIntent?.kind === "restart") return pendingIntent.promise;
    this.cancelReadyIntents();
    this.currentState = "stopping";
    const command = this.enqueueLifecycleCommand("restart");
    this.invalidateRpcGeneration("HERMES_SIDECAR_STOPPED");
    return command.promise;
  }

  onCrash(listener: HermesSidecarCrashListener): () => void {
    this.crashListeners.add(listener);
    return () => {
      this.crashListeners.delete(listener);
    };
  }

  async request<TMethod extends HermesGatewayRequestMethod>(
    method: TMethod,
    params: HermesGatewayRequestParams<TMethod>,
  ): Promise<HermesGatewayRequestResult<TMethod>> {
    const generation = this.requireReadyGeneration();
    let rawRequest: Promise<HermesGatewayRequestResult<TMethod>>;
    try {
      rawRequest = generation.client.request(method, params);
    } catch (error) {
      if (!this.isRpcGenerationActive(generation)) {
        throw this.rpcGenerationError(generation);
      }
      throw normalizeRequestError(error);
    }
    const response = Promise.resolve(rawRequest).then<
      HermesSidecarRequestOutcome,
      HermesSidecarRequestOutcome
    >(
      (value) => ({ kind: "result", value }),
      (error: unknown) => ({ kind: "error", error }),
    );
    if (!this.isRpcGenerationActive(generation)) {
      void response.then(() => {});
      throw this.rpcGenerationError(generation);
    }
    const outcome = await Promise.race<HermesSidecarRequestOutcome>([
      response,
      generation.invalidation.then((error) => ({ kind: "invalidated", error })),
    ]);
    if (!this.isRpcGenerationActive(generation)) {
      throw this.rpcGenerationError(generation);
    }
    if (outcome.kind === "invalidated") throw outcome.error;
    if (outcome.kind === "error") throw normalizeRequestError(outcome.error);
    return outcome.value as HermesGatewayRequestResult<TMethod>;
  }

  subscribe(listener: HermesGatewayNotificationListener): () => void {
    const generation = this.requireReadyGeneration();
    const owned: OwnedSidecarSubscription = {
      active: true,
      rawUnsubscribe: undefined,
    };
    generation.subscriptions.add(owned);
    const guardedListener: HermesGatewayNotificationListener = (notification) => {
      if (!owned.active || !this.isRpcGenerationActive(generation)) return;
      return listener(notification);
    };
    try {
      const rawUnsubscribe: unknown = generation.client.subscribe(guardedListener);
      if (typeof rawUnsubscribe !== "function") {
        throw new HermesGatewayError("HERMES_GATEWAY_PROTOCOL");
      }
      owned.rawUnsubscribe = rawUnsubscribe as () => void;
    } catch (error) {
      this.releaseSubscription(generation, owned);
      if (!this.isRpcGenerationActive(generation)) {
        throw this.rpcGenerationError(generation);
      }
      throw normalizeRequestError(error);
    }
    if (!this.isRpcGenerationActive(generation)) {
      const rawUnsubscribe = owned.rawUnsubscribe;
      owned.rawUnsubscribe = undefined;
      if (rawUnsubscribe) {
        try {
          rawUnsubscribe();
        } catch {
          // A reentrant lifecycle transition still owns cleanup of the old subscription.
        }
      }
      throw this.rpcGenerationError(generation);
    }
    return () => {
      this.releaseSubscription(generation, owned);
    };
  }

  private requireReadyGeneration(): HermesSidecarRpcGeneration {
    const generation = this.rpcGeneration;
    if (
      this.currentState === "ready" &&
      this.client &&
      generation?.client === this.client &&
      !generation.invalidated
    ) {
      return generation;
    }
    throw this.rpcStateError();
  }

  private rpcStateError(): HermesSidecarError {
    switch (this.currentState) {
      case "stopping":
      case "stopped":
        return new HermesSidecarError("HERMES_SIDECAR_STOPPED");
      case "crashed":
        return new HermesSidecarError("HERMES_SIDECAR_CRASHED");
      default:
        return new HermesSidecarError("HERMES_SIDECAR_NOT_READY");
    }
  }

  private isRpcGenerationActive(generation: HermesSidecarRpcGeneration): boolean {
    return (
      !generation.invalidated &&
      this.rpcGeneration === generation &&
      this.client === generation.client &&
      this.currentState === "ready"
    );
  }

  private rpcGenerationError(generation: HermesSidecarRpcGeneration): HermesSidecarError {
    return generation.invalidationError ?? this.rpcStateError();
  }

  private invalidateRpcGeneration(
    code: Extract<HermesSidecarErrorCode, "HERMES_SIDECAR_STOPPED" | "HERMES_SIDECAR_CRASHED">,
  ): void {
    const generation = this.rpcGeneration;
    if (!generation || generation.invalidated) return;
    const error = new HermesSidecarError(code);
    generation.invalidated = true;
    generation.invalidationError = error;
    generation.invalidate(error);
    for (const subscription of [...generation.subscriptions]) {
      this.releaseSubscription(generation, subscription);
    }
    if (this.rpcGeneration === generation) this.rpcGeneration = undefined;
  }

  private releaseSubscription(
    generation: HermesSidecarRpcGeneration,
    subscription: OwnedSidecarSubscription,
  ): void {
    if (!subscription.active) return;
    subscription.active = false;
    generation.subscriptions.delete(subscription);
    const rawUnsubscribe = subscription.rawUnsubscribe;
    subscription.rawUnsubscribe = undefined;
    if (!rawUnsubscribe) return;
    try {
      rawUnsubscribe();
    } catch {
      // Subscription cleanup must never prevent sidecar disposal.
    }
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
      if (this.client || this.terminate || this.activeCapability || this.capabilityPipe) {
        await this.cleanupCurrent(this.client);
      }
      this.throwIfCanceled(command);
      await this.ensureStateDirs(this.paths, { dataRoot: this.dataRoot });
      this.throwIfCanceled(command);
      await this.verifyInstallation(this.paths.pythonExecutable, this.spawnSpec);
      this.throwIfCanceled(command);

      const capability = await this.acquireCapability(command);
      this.activeCapability = capability;
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
      const client = snapshotSidecarClient(
        this.clientFactory({
          process: child,
          terminate: this.terminate,
          ...(this.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: this.readyTimeoutMs }),
        }),
      );
      this.client = client;
      this.unsubscribeCrash = client.onCrash(() => {
        this.handleCrash(generation);
      });
      this.throwIfCanceled(command);
      this.capabilityPipe = requireCapabilityPipe(child.stdio[3]);
      await this.transmitCapability(command, capability, this.capabilityPipe);
      this.capabilityPipe = undefined;
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
      this.rpcGeneration = createRpcGeneration(client);
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
    this.invalidateRpcGeneration("HERMES_SIDECAR_STOPPED");
    try {
      if (this.client || this.terminate || this.activeCapability || this.capabilityPipe) {
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
    this.invalidateRpcGeneration("HERMES_SIDECAR_STOPPED");
    const client = this.client;
    const terminate = this.terminate;
    const capability = this.activeCapability;
    const capabilityPipe = this.capabilityPipe;
    let cleanupFailed = false;

    if (capability) {
      try {
        capability.revoke();
        if (this.activeCapability === capability) this.activeCapability = undefined;
      } catch {
        cleanupFailed = true;
      }
    }
    if (capabilityPipe) {
      try {
        capabilityPipe.destroy();
      } catch {
        cleanupFailed = true;
      }
      if (this.capabilityPipe === capabilityPipe) this.capabilityPipe = undefined;
    }
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
      }
    } catch {
      cleanupFailed = true;
    }
    if (!cleanupFailed && (!expectedClient || this.client === expectedClient)) {
      this.client = undefined;
      this.terminate = undefined;
    }
    if (cleanupFailed) {
      throw new HermesSidecarError("HERMES_SIDECAR_CLEANUP");
    }
  }

  private async acquireCapability(command: HermesLifecycleCommand): Promise<OwnedCapabilityLease> {
    const acquisition = Promise.resolve().then(() => this.issueCapability(this.binding));
    const canceled = command.cancellation.then(() => {
      throw new HermesSidecarError("HERMES_SIDECAR_STOPPED");
    });
    let acquisitionWon = false;
    try {
      const issued = await Promise.race([acquisition, canceled]);
      acquisitionWon = true;
      let capability: OwnedCapabilityLease;
      try {
        capability = snapshotCapabilityLease(issued);
      } catch {
        revokeLateCapability(issued);
        throw new HermesSidecarError("HERMES_SIDECAR_START");
      }
      if (command.canceled) {
        capability.revoke();
        throw new HermesSidecarError("HERMES_SIDECAR_STOPPED");
      }
      return capability;
    } catch (cause) {
      if (command.canceled) {
        if (!acquisitionWon) {
          void acquisition.then(revokeLateCapability, () => {});
        }
        if (isSidecarCleanupError(cause)) throw cause;
        throw new HermesSidecarError("HERMES_SIDECAR_STOPPED");
      }
      throw cause;
    }
  }

  private async transmitCapability(
    command: HermesLifecycleCommand,
    capability: OwnedCapabilityLease,
    pipe: Writable,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new HermesSidecarError("HERMES_SIDECAR_START")),
        this.capabilityTimeoutMs,
      );
    });
    const transmitted = Promise.resolve().then(() => capability.transmit(pipe));
    void transmitted.catch(() => {});
    try {
      await Promise.race([
        transmitted,
        timeout,
        command.cancellation.then(() => {
          throw new HermesSidecarError("HERMES_SIDECAR_STOPPED");
        }),
      ]);
      if (!pipe.writableEnded) {
        throw new HermesSidecarError("HERMES_SIDECAR_START");
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
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
    const capability = this.activeCapability;
    if (capability) {
      try {
        capability.revoke();
        if (this.activeCapability === capability) this.activeCapability = undefined;
      } catch {
        // Crash notification remains sanitized; a later cleanup retries revocation.
      }
    }
    const capabilityPipe = this.capabilityPipe;
    if (capabilityPipe) {
      try {
        capabilityPipe.destroy();
      } catch {
        // Process termination remains owned by the gateway client.
      }
      if (this.capabilityPipe === capabilityPipe) this.capabilityPipe = undefined;
    }
    this.crashNotifiedGeneration = generation;
    this.currentState = "crashed";
    this.invalidateRpcGeneration("HERMES_SIDECAR_CRASHED");
    const error = new HermesSidecarError("HERMES_SIDECAR_CRASHED");
    for (const listener of [...this.crashListeners]) {
      invokeObserver(listener, error);
    }
  }
}

function createRpcGeneration(client: HermesSidecarClient): HermesSidecarRpcGeneration {
  let invalidate!: (error: HermesSidecarError) => void;
  const invalidation = new Promise<HermesSidecarError>((resolve) => {
    invalidate = resolve;
  });
  return {
    client,
    invalidation,
    invalidate,
    subscriptions: new Set(),
    invalidationError: undefined,
    invalidated: false,
  };
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
    stdio: ["pipe", "pipe", "pipe", "pipe"],
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
  return child as unknown as HermesSidecarProcess;
};

function validateSpawnSpec(
  spec: HermesGatewaySpawnSpec,
  paths: HermesPaths,
  launcherPath: string,
  platform: HermesPlatform,
): void {
  const isPlatformAbsolute = platform === "win32" ? win32.isAbsolute : isAbsolute;
  if (
    !isPlatformAbsolute(spec.command) ||
    !isPlatformAbsolute(spec.cwd) ||
    spec.command !== paths.pythonExecutable ||
    spec.cwd !== paths.gatewayCwd ||
    spec.args.length !== 7 ||
    spec.args[0] !== "-I" ||
    spec.args[1] !== "-S" ||
    spec.args[2] !== "-B" ||
    spec.args[3] !== "-u" ||
    spec.args[4] !== "-X" ||
    spec.args[5] !== "utf8" ||
    spec.args[6] !== launcherPath ||
    spec.env.HERMES_HOME !== paths.hermesHome ||
    Object.keys(spec.env).length !== 1 ||
    Object.entries(spec.env).some(
      ([key, value]) => typeof value !== "string" || key !== "HERMES_HOME",
    )
  ) {
    throw new HermesSidecarError("HERMES_SIDECAR_START");
  }
}

function snapshotBinding(binding: HermesSidecarBinding): HermesSidecarBinding {
  if (!binding || typeof binding !== "object") {
    throw new HermesSidecarError("HERMES_SIDECAR_START");
  }
  const taskId = binding.taskId;
  const runId = binding.runId;
  const profileId = binding.profileId;
  const model = binding.model;
  const apiMode = binding.apiMode;
  if (
    typeof taskId !== "string" ||
    !BINDING_ID_PATTERN.test(taskId) ||
    typeof runId !== "string" ||
    !BINDING_ID_PATTERN.test(runId) ||
    typeof profileId !== "string" ||
    !BINDING_ID_PATTERN.test(profileId) ||
    typeof model !== "string" ||
    !BINDING_MODEL_PATTERN.test(model) ||
    (apiMode !== "chat_completions" && apiMode !== "codex_responses")
  ) {
    throw new HermesSidecarError("HERMES_SIDECAR_START");
  }
  return Object.freeze({
    taskId,
    runId,
    profileId,
    model,
    apiMode,
  });
}

function requireCapabilityIssuer(value: unknown): HermesSidecarCapabilityIssuer {
  if (typeof value !== "function") {
    throw new HermesSidecarError("HERMES_SIDECAR_START");
  }
  const issuer = value;
  return async (binding) => Reflect.apply(issuer, undefined, [binding]);
}

function requireAbsolutePath(value: unknown, platform: HermesPlatform): string {
  const isPlatformAbsolute = platform === "win32" ? win32.isAbsolute : isAbsolute;
  if (typeof value !== "string" || !isPlatformAbsolute(value)) {
    throw new HermesSidecarError("HERMES_SIDECAR_START");
  }
  return value;
}

function boundedCapabilityTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_CAPABILITY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_CAPABILITY_TIMEOUT_MS) {
    throw new HermesSidecarError("HERMES_SIDECAR_START");
  }
  return timeout;
}

function snapshotCapabilityLease(value: unknown): OwnedCapabilityLease {
  if (!value || typeof value !== "object") {
    throw new HermesSidecarError("HERMES_SIDECAR_START");
  }
  let transmit: unknown;
  let revoke: unknown;
  try {
    transmit = Reflect.get(value, "transmit");
    revoke = Reflect.get(value, "revoke");
  } catch {
    throw new HermesSidecarError("HERMES_SIDECAR_START");
  }
  if (typeof transmit !== "function" || typeof revoke !== "function") {
    throw new HermesSidecarError("HERMES_SIDECAR_START");
  }
  let revoked = false;
  let revoking = false;
  return Object.freeze({
    async transmit(pipe: Writable): Promise<void> {
      await Reflect.apply(transmit, value, [pipe]);
    },
    revoke(): void {
      if (revoked) return;
      if (revoking) throw new HermesSidecarError("HERMES_SIDECAR_CLEANUP");
      revoking = true;
      try {
        Reflect.apply(revoke, value, []);
        revoked = true;
      } catch {
        throw new HermesSidecarError("HERMES_SIDECAR_CLEANUP");
      } finally {
        revoking = false;
      }
    },
  });
}

function snapshotSidecarClient(value: unknown): HermesSidecarClient {
  if ((!value || typeof value !== "object") && typeof value !== "function") {
    throw new HermesSidecarError("HERMES_SIDECAR_START");
  }
  const receiver = value as object;
  let ready: unknown;
  let request: unknown;
  let subscribe: unknown;
  let onCrash: unknown;
  let dispose: unknown;
  try {
    ready = Reflect.get(receiver, "ready");
    request = Reflect.get(receiver, "request");
    subscribe = Reflect.get(receiver, "subscribe");
    onCrash = Reflect.get(receiver, "onCrash");
    dispose = Reflect.get(receiver, "dispose");
  } catch {
    throw new HermesSidecarError("HERMES_SIDECAR_START");
  }
  if (
    typeof ready !== "function" ||
    typeof request !== "function" ||
    typeof subscribe !== "function" ||
    typeof onCrash !== "function" ||
    typeof dispose !== "function"
  ) {
    throw new HermesSidecarError("HERMES_SIDECAR_START");
  }
  return Object.freeze({
    ready: () => Reflect.apply(ready, receiver, []) as Promise<void>,
    request<TMethod extends HermesGatewayRequestMethod>(
      method: TMethod,
      params: HermesGatewayRequestParams<TMethod>,
    ): Promise<HermesGatewayRequestResult<TMethod>> {
      return Reflect.apply(request, receiver, [method, params]) as Promise<
        HermesGatewayRequestResult<TMethod>
      >;
    },
    subscribe: (listener: HermesGatewayNotificationListener) =>
      Reflect.apply(subscribe, receiver, [listener]) as () => void,
    onCrash: (listener: HermesGatewayCrashListener) =>
      Reflect.apply(onCrash, receiver, [listener]) as () => void,
    dispose: () => Reflect.apply(dispose, receiver, []) as Promise<void>,
  });
}

function normalizeRequestError(value: unknown): HermesGatewayError | HermesGatewayRemoteError {
  try {
    if (value instanceof HermesGatewayError || value instanceof HermesGatewayRemoteError) {
      return value;
    }
  } catch {
    // Hostile injected errors are collapsed without inspecting message or cause.
  }
  return new HermesGatewayError("HERMES_GATEWAY_PROTOCOL");
}

function revokeLateCapability(value: unknown): void {
  try {
    if (!value || typeof value !== "object") return;
    const revoke = Reflect.get(value, "revoke");
    if (typeof revoke === "function") Reflect.apply(revoke, value, []);
  } catch {
    // A canceled start never surfaces late provider details or starts a process.
  }
}

function requireCapabilityPipe(value: unknown): Writable {
  if (
    !value ||
    typeof value !== "object" ||
    typeof Reflect.get(value, "write") !== "function" ||
    typeof Reflect.get(value, "end") !== "function" ||
    typeof Reflect.get(value, "destroy") !== "function"
  ) {
    throw new HermesSidecarError("HERMES_SIDECAR_START");
  }
  return value as Writable;
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
