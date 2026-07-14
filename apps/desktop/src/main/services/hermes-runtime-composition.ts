import { isAbsolute } from "node:path";
import type {
  RuntimeAdapter,
  RuntimeApprovalChoice,
  RuntimeBinding,
  RuntimeCrashListener,
  RuntimeCreateInput,
  RuntimeEventSink,
  RuntimeReady,
  RuntimeResumeInput,
} from "@opentrad/runtime-adapter";
import type {
  HermesGatewayRequestMethod,
  HermesGatewayRequestParams,
  HermesGatewayRequestResult,
} from "./hermes/gateway-protocol";
import {
  type HermesNetworkEnvironment,
  snapshotHermesNetworkEnvironment,
} from "./hermes/network-environment";
import type { HermesProfileHomeInitializer } from "./hermes/profile-home";
import {
  createHermesProviderCapabilityIssuer,
  type HermesProviderProfileSecretSource,
} from "./hermes/provider-capability-issuer";
import {
  type HermesSidecarBinding,
  type HermesSidecarCrashListener,
  HermesSidecarManager,
  type HermesSidecarManagerOptions,
} from "./hermes/sidecar-manager";
import {
  HermesRuntimeAdapter,
  type HermesRuntimeManagerFactoryInput,
  type HermesRuntimeManagerPort,
} from "./hermes-runtime-adapter";

export interface HermesRuntimeCompositionOptions {
  readonly dataRoot: string;
  readonly launcherPath: string;
  readonly acquireProfileSecrets: HermesProviderProfileSecretSource;
  readonly initializeProfileHome: HermesProfileHomeInitializer;
  readonly networkEnvironment?: HermesNetworkEnvironment;
  readonly createManager?: (options: HermesSidecarManagerOptions) => HermesRuntimeManagerPort;
}

export type HermesRuntimeCompositionErrorCode =
  | "HERMES_RUNTIME_COMPOSITION_INVALID_CONFIGURATION"
  | "HERMES_RUNTIME_COMPOSITION_DISPOSED"
  | "HERMES_RUNTIME_COMPOSITION_CLEANUP_FAILED";

const ERROR_MESSAGES: Readonly<Record<HermesRuntimeCompositionErrorCode, string>> = {
  HERMES_RUNTIME_COMPOSITION_INVALID_CONFIGURATION:
    "Hermes runtime composition configuration is invalid",
  HERMES_RUNTIME_COMPOSITION_DISPOSED: "Hermes runtime composition is disposed",
  HERMES_RUNTIME_COMPOSITION_CLEANUP_FAILED:
    "Hermes runtime composition cleanup could not be confirmed",
};

const MAX_PATH_LENGTH = 4_096;
const RESOLVED = Promise.resolve();

export class HermesRuntimeCompositionError extends Error {
  readonly code: HermesRuntimeCompositionErrorCode;

  constructor(code: HermesRuntimeCompositionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "HermesRuntimeCompositionError";
    this.code = code;
  }
}

interface CompositionSnapshot {
  readonly dataRoot: string;
  readonly launcherPath: string;
  readonly acquireProfileSecrets: HermesProviderProfileSecretSource;
  readonly initializeProfileHome: HermesProfileHomeInitializer;
  readonly networkEnvironment: HermesNetworkEnvironment;
  readonly createManager: (options: HermesSidecarManagerOptions) => HermesRuntimeManagerPort;
}

interface PoolEntry {
  readonly key: string;
  readonly binding: HermesSidecarBinding;
  readonly workspaceRoot: string;
  readonly manager: HermesRuntimeManagerPort;
  readonly leases: Set<PooledManagerLease>;
  unsubscribeCrash?: () => void;
  startPromise?: Promise<void>;
  stopPromise?: Promise<void>;
  started: boolean;
  stopped: boolean;
}

class HermesSidecarPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly invalidatingProfiles = new Set<string>();
  private readonly profileInvalidations = new Map<string, Promise<void>>();
  private disposed = false;
  private disposePromise?: Promise<void>;

  constructor(private readonly snapshot: CompositionSnapshot) {}

  createLease(input: HermesRuntimeManagerFactoryInput): HermesRuntimeManagerPort {
    if (this.disposed) throw compositionError("HERMES_RUNTIME_COMPOSITION_DISPOSED");
    if (this.invalidatingProfiles.has(input.binding.profileId)) {
      throw compositionError("HERMES_RUNTIME_COMPOSITION_CLEANUP_FAILED");
    }
    const key = poolKey(input.binding, input.workspaceRoot);
    let entry = this.entries.get(key);
    if (entry) {
      if (!sameProfileRuntime(entry.binding, input.binding)) {
        throw compositionError("HERMES_RUNTIME_COMPOSITION_INVALID_CONFIGURATION");
      }
    } else {
      entry = this.createEntry(key, input);
      this.entries.set(key, entry);
    }
    const lease = new PooledManagerLease(entry, this);
    entry.leases.add(lease);
    return lease.port;
  }

  invalidateProfile(profileId: string, releaseSessions: () => Promise<void>): Promise<void> {
    if (this.disposed) {
      return Promise.reject(compositionError("HERMES_RUNTIME_COMPOSITION_DISPOSED"));
    }
    const existing = this.profileInvalidations.get(profileId);
    if (existing) return existing;

    this.invalidatingProfiles.add(profileId);
    const attempt = this.performProfileInvalidation(profileId, releaseSessions).then(() => {
      this.invalidatingProfiles.delete(profileId);
    });
    const tracked = attempt.finally(() => {
      if (this.profileInvalidations.get(profileId) === tracked) {
        this.profileInvalidations.delete(profileId);
      }
    });
    this.profileInvalidations.set(profileId, tracked);
    return tracked;
  }

  async start(entry: PoolEntry, lease: PooledManagerLease): Promise<void> {
    this.assertLeaseActive(entry, lease);
    if (entry.started) return;
    if (!entry.startPromise) {
      const starting = Promise.resolve()
        .then(() => entry.manager.start())
        .then(() => {
          if (this.disposed || entry?.stopped) throw new Error();
          entry.started = true;
        })
        .catch((error: unknown) => {
          if (entry?.startPromise === starting) entry.startPromise = undefined;
          throw error;
        });
      entry.startPromise = starting;
    }
    await entry.startPromise;
    this.assertLeaseActive(entry, lease);
  }

  release(entry: PoolEntry, lease: PooledManagerLease): void {
    entry.leases.delete(lease);
  }

  assertLeaseActive(entry: PoolEntry, lease: PooledManagerLease): void {
    if (this.disposed || entry.stopped || !entry.leases.has(lease) || lease.isReleased()) {
      throw compositionError("HERMES_RUNTIME_COMPOSITION_DISPOSED");
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    if (this.disposed && [...this.entries.values()].every((entry) => entry.stopped)) {
      return RESOLVED;
    }
    this.disposed = true;
    const disposing = this.stopAll();
    this.disposePromise = disposing.finally(() => {
      if ([...this.entries.values()].some((entry) => !entry.stopped)) {
        this.disposePromise = undefined;
      }
    });
    return this.disposePromise;
  }

  private createEntry(key: string, input: HermesRuntimeManagerFactoryInput): PoolEntry {
    const managerOptions = Object.freeze({
      binding: input.binding,
      dataRoot: this.snapshot.dataRoot,
      workspaceRoot: input.workspaceRoot,
      launcherPath: this.snapshot.launcherPath,
      initializeProfileHome: this.snapshot.initializeProfileHome,
      networkEnvironment: this.snapshot.networkEnvironment,
      issueCapability: createHermesProviderCapabilityIssuer({
        acquireProfileSecrets: this.snapshot.acquireProfileSecrets,
      }),
    }) satisfies HermesSidecarManagerOptions;
    const manager = snapshotManager(this.snapshot.createManager(managerOptions));
    const entry: PoolEntry = {
      key,
      binding: Object.freeze({ ...input.binding }),
      workspaceRoot: input.workspaceRoot,
      manager,
      leases: new Set(),
      started: false,
      stopped: false,
    };
    entry.unsubscribeCrash = manager.onCrash(() => {
      entry.started = false;
      entry.startPromise = undefined;
    });
    return entry;
  }

  private async stopAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.entries.values()].map((entry) => this.stopEntry(entry)),
    );
    if (results.some((result) => result.status === "rejected")) {
      throw compositionError("HERMES_RUNTIME_COMPOSITION_CLEANUP_FAILED");
    }
  }

  private async stopProfileEntries(profileId: string): Promise<void> {
    const entries = [...this.entries.values()].filter(
      (entry) => entry.binding.profileId === profileId,
    );
    const results = await Promise.allSettled(entries.map((entry) => this.stopEntry(entry)));
    let failed = false;
    for (const [index, result] of results.entries()) {
      const entry = entries[index];
      if (result.status === "fulfilled" && entry && this.entries.get(entry.key) === entry) {
        this.entries.delete(entry.key);
      } else if (result.status === "rejected") {
        failed = true;
      }
    }
    if (failed) throw compositionError("HERMES_RUNTIME_COMPOSITION_CLEANUP_FAILED");
  }

  private async performProfileInvalidation(
    profileId: string,
    releaseSessions: () => Promise<void>,
  ): Promise<void> {
    const releaseResult = await Promise.allSettled([Promise.resolve().then(releaseSessions)]);
    let poolFailed = false;
    try {
      await this.stopProfileEntries(profileId);
    } catch {
      poolFailed = true;
    }
    if (releaseResult[0]?.status === "rejected" || poolFailed) {
      throw compositionError("HERMES_RUNTIME_COMPOSITION_CLEANUP_FAILED");
    }
  }

  private stopEntry(entry: PoolEntry): Promise<void> {
    if (entry.stopped) return RESOLVED;
    if (entry.stopPromise) return entry.stopPromise;
    for (const lease of [...entry.leases]) lease.release();
    const stopping = Promise.resolve()
      .then(() => entry.manager.stop())
      .then(() => {
        entry.unsubscribeCrash?.();
        entry.unsubscribeCrash = undefined;
        entry.stopped = true;
        entry.started = false;
        entry.startPromise = undefined;
      })
      .finally(() => {
        if (!entry.stopped) entry.stopPromise = undefined;
      });
    entry.stopPromise = stopping;
    return stopping;
  }
}

class PooledManagerLease {
  readonly port: HermesRuntimeManagerPort;
  private readonly cleanup = new Set<() => void>();
  private released = false;

  constructor(
    private readonly entry: PoolEntry,
    private readonly pool: HermesSidecarPool,
  ) {
    this.port = Object.freeze({
      start: () => this.pool.start(this.entry, this),
      stop: () => {
        this.release();
        return RESOLVED;
      },
      request: <TMethod extends HermesGatewayRequestMethod>(
        method: TMethod,
        params: HermesGatewayRequestParams<TMethod>,
      ): Promise<HermesGatewayRequestResult<TMethod>> => {
        try {
          this.pool.assertLeaseActive(this.entry, this);
          return this.entry.manager.request(method, params);
        } catch (error) {
          return Promise.reject(error);
        }
      },
      subscribe: (listener) => this.ownSubscription(this.entry.manager.subscribe(listener)),
      onCrash: (listener) => this.ownSubscription(this.entry.manager.onCrash(listener)),
    });
  }

  isReleased(): boolean {
    return this.released;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    for (const unsubscribe of [...this.cleanup]) safeUnsubscribe(unsubscribe);
    this.cleanup.clear();
    this.pool.release(this.entry, this);
  }

  private ownSubscription(unsubscribe: () => void): () => void {
    this.pool.assertLeaseActive(this.entry, this);
    if (typeof unsubscribe !== "function") throw new Error();
    let active = true;
    const owned = (): void => {
      if (!active) return;
      active = false;
      this.cleanup.delete(owned);
      safeUnsubscribe(unsubscribe);
    };
    this.cleanup.add(owned);
    return owned;
  }
}

export function createHermesRuntimeComposition(
  options: HermesRuntimeCompositionOptions,
): RuntimeAdapter {
  let snapshot: CompositionSnapshot;
  let pool: HermesSidecarPool;
  let adapter: HermesRuntimeAdapter;
  try {
    snapshot = snapshotComposition(options);
    pool = new HermesSidecarPool(snapshot);
    adapter = new HermesRuntimeAdapter((input) => pool.createLease(input));
  } catch {
    throw compositionError("HERMES_RUNTIME_COMPOSITION_INVALID_CONFIGURATION");
  }

  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  const assertActive = (): void => {
    if (disposed) throw compositionError("HERMES_RUNTIME_COMPOSITION_DISPOSED");
  };
  const invoke = <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      assertActive();
      return operation();
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const runtime: RuntimeAdapter = {
    kind: "hermes",
    ready: (): Promise<RuntimeReady> => invoke(() => adapter.ready()),
    create: (input: RuntimeCreateInput): Promise<RuntimeBinding> =>
      invoke(() => adapter.create(input)),
    stream: (binding: RuntimeBinding, prompt: string, emit: RuntimeEventSink): Promise<void> =>
      invoke(() => adapter.stream(binding, prompt, emit)),
    interrupt: (binding: RuntimeBinding): Promise<void> => invoke(() => adapter.interrupt(binding)),
    respondApproval: (binding: RuntimeBinding, choice: RuntimeApprovalChoice): Promise<void> =>
      invoke(() => adapter.respondApproval(binding, choice)),
    respondSudo: (binding: RuntimeBinding, requestId: string, password: string): Promise<void> =>
      invoke(() => adapter.respondSudo(binding, requestId, password)),
    respondSecret: (binding: RuntimeBinding, requestId: string, value: string): Promise<void> =>
      invoke(() => adapter.respondSecret(binding, requestId, value)),
    close: (binding: RuntimeBinding): Promise<void> => invoke(() => adapter.close(binding)),
    resume: (input: RuntimeResumeInput): Promise<RuntimeBinding> =>
      invoke(() => adapter.resume(input)),
    invalidateProfile: (profileId: string): Promise<void> => {
      if (!isValidProfileId(profileId)) {
        return Promise.reject(compositionError("HERMES_RUNTIME_COMPOSITION_INVALID_CONFIGURATION"));
      }
      return invoke(() =>
        pool.invalidateProfile(profileId, () => adapter.invalidateProfile(profileId)),
      );
    },
    onCrash: (listener: RuntimeCrashListener): (() => void) => {
      assertActive();
      return adapter.onCrash(listener);
    },
    dispose: (): Promise<void> => {
      if (disposePromise) return disposePromise;
      disposed = true;
      const disposing = (async (): Promise<void> => {
        let failed = false;
        try {
          await adapter.dispose();
        } catch {
          failed = true;
        }
        try {
          await pool.dispose();
        } catch {
          failed = true;
        }
        if (failed) throw compositionError("HERMES_RUNTIME_COMPOSITION_CLEANUP_FAILED");
      })();
      disposePromise = disposing;
      return disposing;
    },
  };
  return Object.freeze(runtime);
}

function snapshotComposition(value: unknown): CompositionSnapshot {
  if (!isObjectLike(value)) throw new Error();
  const receiver = value as object;
  const dataRoot = requireAbsolutePath(Reflect.get(receiver, "dataRoot"));
  const launcherPath = requireAbsolutePath(Reflect.get(receiver, "launcherPath"));
  const rawAcquireProfileSecrets = requireFunction(Reflect.get(receiver, "acquireProfileSecrets"));
  const acquireProfileSecrets: HermesProviderProfileSecretSource = (binding) =>
    Reflect.apply(rawAcquireProfileSecrets, receiver, [
      binding,
    ]) as ReturnType<HermesProviderProfileSecretSource>;
  const rawInitializeProfileHome = requireFunction(Reflect.get(receiver, "initializeProfileHome"));
  const initializeProfileHome: HermesProfileHomeInitializer = (binding, paths) =>
    Reflect.apply(rawInitializeProfileHome, receiver, [binding, paths]) as Promise<void>;
  const networkEnvironment = snapshotHermesNetworkEnvironment(
    Reflect.get(receiver, "networkEnvironment"),
  );
  const rawCreateManager = Reflect.get(receiver, "createManager");
  const createManager =
    rawCreateManager === undefined
      ? (managerOptions: HermesSidecarManagerOptions): HermesRuntimeManagerPort =>
          new HermesSidecarManager(managerOptions)
      : snapshotManagerFactory(rawCreateManager, receiver);
  return Object.freeze({
    dataRoot,
    launcherPath,
    acquireProfileSecrets,
    initializeProfileHome,
    networkEnvironment,
    createManager,
  });
}

function snapshotManager(value: unknown): HermesRuntimeManagerPort {
  if (!isObjectLike(value)) throw new Error();
  const receiver = value as object;
  const start = requireFunction(Reflect.get(receiver, "start"));
  const stop = requireFunction(Reflect.get(receiver, "stop"));
  const request = requireFunction(Reflect.get(receiver, "request"));
  const subscribe = requireFunction(Reflect.get(receiver, "subscribe"));
  const onCrash = requireFunction(Reflect.get(receiver, "onCrash"));
  return Object.freeze({
    start: () => Reflect.apply(start, receiver, []) as Promise<void>,
    stop: () => Reflect.apply(stop, receiver, []) as Promise<void>,
    request: <TMethod extends HermesGatewayRequestMethod>(
      method: TMethod,
      params: HermesGatewayRequestParams<TMethod>,
    ) =>
      Reflect.apply(request, receiver, [method, params]) as Promise<
        HermesGatewayRequestResult<TMethod>
      >,
    subscribe: (listener) => Reflect.apply(subscribe, receiver, [listener]) as () => void,
    onCrash: (listener: HermesSidecarCrashListener) =>
      Reflect.apply(onCrash, receiver, [listener]) as () => void,
  });
}

function poolKey(binding: HermesSidecarBinding, workspaceRoot: string): string {
  return JSON.stringify(
    binding.executionBackend === "docker"
      ? [binding.profileId, workspaceRoot]
      : [binding.profileId],
  );
}

function sameProfileRuntime(left: HermesSidecarBinding, right: HermesSidecarBinding): boolean {
  return (
    left.profileId === right.profileId &&
    left.providerSlug === right.providerSlug &&
    left.authMode === right.authMode &&
    left.model === right.model &&
    left.apiMode === right.apiMode &&
    left.executionBackend === right.executionBackend
  );
}

function snapshotManagerFactory(
  value: unknown,
  receiver: object,
): (options: HermesSidecarManagerOptions) => HermesRuntimeManagerPort {
  const factory = requireFunction(value);
  return (options) => Reflect.apply(factory, receiver, [options]) as HermesRuntimeManagerPort;
}

function requireAbsolutePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    value.includes("\0") ||
    !isAbsolute(value)
  ) {
    throw new Error();
  }
  return value;
}

function isValidProfileId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !value.includes("\0") &&
    value.trim() === value
  );
}

function requireFunction(value: unknown): (...args: readonly unknown[]) => unknown {
  if (typeof value !== "function") throw new Error();
  return value as (...args: readonly unknown[]) => unknown;
}

function compositionError(code: HermesRuntimeCompositionErrorCode): HermesRuntimeCompositionError {
  return Object.freeze(new HermesRuntimeCompositionError(code));
}

function safeUnsubscribe(unsubscribe: () => void): void {
  try {
    unsubscribe();
  } catch {
    // Observer cleanup must not replace the authoritative process cleanup result.
  }
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
