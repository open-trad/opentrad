import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute } from "node:path";
import type {
  RuntimeBinding,
  RuntimeCrashListener,
  RuntimeCreateInput,
  RuntimeReady,
} from "@opentrad/runtime-adapter";
import {
  createHermesProviderCapabilityIssuer,
  type ProviderCredentialLeaseSource,
} from "./hermes/provider-capability-issuer";
import { HermesSidecarManager, type HermesSidecarManagerOptions } from "./hermes/sidecar-manager";
import { HermesRuntimeAdapter, type HermesRuntimeManagerPort } from "./hermes-runtime-adapter";
import type { ProviderBroker } from "./provider-broker";

export interface HermesQuarantineRuntime {
  readonly kind: "hermes";
  ready(): Promise<RuntimeReady>;
  create(input: RuntimeCreateInput): Promise<RuntimeBinding>;
  close(binding: RuntimeBinding): Promise<void>;
  onCrash(listener: RuntimeCrashListener): () => void;
  dispose(): Promise<void>;
}

type HermesQuarantineBroker = Pick<ProviderBroker, "start" | "issue" | "revoke" | "close">;

export interface HermesQuarantineCompositionOptions {
  readonly dataRoot: string;
  readonly launcherPath: string;
  readonly broker: HermesQuarantineBroker;
  readonly acquireCredentialLease: ProviderCredentialLeaseSource;
  readonly capabilityTtlMs: number;
  readonly createManager?: (options: HermesSidecarManagerOptions) => HermesRuntimeManagerPort;
}

export type HermesQuarantineCompositionErrorCode =
  | "HERMES_QUARANTINE_COMPOSITION_INVALID_CONFIGURATION"
  | "HERMES_QUARANTINE_COMPOSITION_DISPOSED"
  | "HERMES_QUARANTINE_COMPOSITION_CLEANUP_FAILED";

const ERROR_MESSAGES: Readonly<Record<HermesQuarantineCompositionErrorCode, string>> = {
  HERMES_QUARANTINE_COMPOSITION_INVALID_CONFIGURATION:
    "Hermes quarantine composition configuration is invalid",
  HERMES_QUARANTINE_COMPOSITION_DISPOSED: "Hermes quarantine composition is disposed",
  HERMES_QUARANTINE_COMPOSITION_CLEANUP_FAILED:
    "Hermes quarantine composition cleanup could not be confirmed",
};

const MIN_CAPABILITY_TTL_MS = 1_000;
const MAX_CAPABILITY_TTL_MS = 300_000;
const MAX_PATH_LENGTH = 4_096;
const RESOLVED = Promise.resolve();

export class HermesQuarantineCompositionError extends Error {
  readonly code: HermesQuarantineCompositionErrorCode;

  constructor(code: HermesQuarantineCompositionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "HermesQuarantineCompositionError";
    this.code = code;
  }
}

interface CompositionSnapshot {
  readonly dataRoot: string;
  readonly launcherPath: string;
  readonly broker: HermesQuarantineBroker;
  readonly acquireCredentialLease: ProviderCredentialLeaseSource;
  readonly capabilityTtlMs: number;
  readonly createManager: (options: HermesSidecarManagerOptions) => HermesRuntimeManagerPort;
}

interface CompositionLifecycle {
  disposed: boolean;
}

interface CleanupReentryContext {
  readonly owner: Promise<void>;
  readonly reentered: Promise<void>;
  notify(): void;
}

type CleanupOutcome =
  | { readonly kind: "complete" }
  | { readonly kind: "failed" }
  | { readonly kind: "reentered" };

export function createExperimentalHermesQuarantineRuntime(
  options: HermesQuarantineCompositionOptions,
): HermesQuarantineRuntime {
  let snapshot: CompositionSnapshot;
  let adapter: HermesRuntimeAdapter;
  const lifecycle: CompositionLifecycle = { disposed: false };
  try {
    snapshot = snapshotComposition(options);
    const issueCapability = createHermesProviderCapabilityIssuer({
      broker: createDisposalGuardedBroker(snapshot.broker, lifecycle),
      acquireCredentialLease: snapshot.acquireCredentialLease,
      ttlMs: snapshot.capabilityTtlMs,
    });
    adapter = new HermesRuntimeAdapter(({ binding }) => {
      const managerOptions = Object.freeze({
        binding,
        dataRoot: snapshot.dataRoot,
        launcherPath: snapshot.launcherPath,
        issueCapability,
      }) satisfies HermesSidecarManagerOptions;
      return snapshot.createManager(managerOptions);
    });
  } catch {
    throw compositionError("HERMES_QUARANTINE_COMPOSITION_INVALID_CONFIGURATION");
  }

  let disposeComplete = false;
  let adapterCleanupComplete = false;
  let brokerCleanupComplete = false;
  let disposePromise: Promise<void> | undefined;
  const cleanupReentry = new AsyncLocalStorage<CleanupReentryContext>();

  const throwIfDisposed = (): void => {
    if (lifecycle.disposed) {
      throw compositionError("HERMES_QUARANTINE_COMPOSITION_DISPOSED");
    }
  };

  const ready = (): Promise<RuntimeReady> => {
    try {
      throwIfDisposed();
      return adapter.ready();
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const create = (input: RuntimeCreateInput): Promise<RuntimeBinding> => {
    try {
      throwIfDisposed();
      return adapter.create(input);
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const close = (binding: RuntimeBinding): Promise<void> => {
    try {
      throwIfDisposed();
      return adapter.close(binding);
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const onCrash = (listener: RuntimeCrashListener): (() => void) => {
    throwIfDisposed();
    return adapter.onCrash(listener);
  };

  const dispose = (): Promise<void> => {
    if (disposeComplete) return RESOLVED;
    if (disposePromise) {
      const context = cleanupReentry.getStore();
      if (context?.owner === disposePromise) context.notify();
      return disposePromise;
    }
    lifecycle.disposed = true;

    let resolveOwner!: () => void;
    let rejectOwner!: (error: HermesQuarantineCompositionError) => void;
    const owner = new Promise<void>((resolve, reject) => {
      resolveOwner = resolve;
      rejectOwner = reject;
    });
    instrumentDisposeOwner(owner, cleanupReentry);
    disposePromise = owner;

    queueMicrotask(() => {
      void performDispose(owner).then(
        () => {
          disposeComplete = true;
          if (disposePromise === owner) disposePromise = undefined;
          resolveOwner();
        },
        () => {
          if (disposePromise === owner) disposePromise = undefined;
          rejectOwner(compositionError("HERMES_QUARANTINE_COMPOSITION_CLEANUP_FAILED"));
        },
      );
    });
    return owner;
  };

  const performDispose = async (owner: Promise<void>): Promise<void> => {
    let cleanupFailed = false;

    if (!adapterCleanupComplete) {
      try {
        await awaitCleanupWithoutSelfWait(cleanupReentry, owner, () => adapter.dispose());
        adapterCleanupComplete = true;
      } catch {
        cleanupFailed = true;
      }
    }

    if (!brokerCleanupComplete) {
      try {
        await awaitCleanupWithoutSelfWait(cleanupReentry, owner, () => snapshot.broker.close());
        brokerCleanupComplete = true;
      } catch {
        cleanupFailed = true;
      }
    }

    if (cleanupFailed || !adapterCleanupComplete || !brokerCleanupComplete) {
      throw compositionError("HERMES_QUARANTINE_COMPOSITION_CLEANUP_FAILED");
    }
  };

  return Object.freeze({
    kind: "hermes" as const,
    ready,
    create,
    close,
    onCrash,
    dispose,
  });
}

function snapshotComposition(value: unknown): CompositionSnapshot {
  try {
    if (!isObjectLike(value)) throw new Error();
    const receiver = value as object;
    const dataRoot = requireAbsolutePath(Reflect.get(receiver, "dataRoot"));
    const launcherPath = requireAbsolutePath(Reflect.get(receiver, "launcherPath"));
    const broker = snapshotBroker(Reflect.get(receiver, "broker"));
    const rawAcquireCredentialLease = requireFunction(
      Reflect.get(receiver, "acquireCredentialLease"),
    );
    const acquireCredentialLease: ProviderCredentialLeaseSource = (binding) =>
      Reflect.apply(rawAcquireCredentialLease, receiver, [binding]) as Promise<
        Awaited<ReturnType<ProviderCredentialLeaseSource>>
      >;
    const capabilityTtlMs = requireCapabilityTtl(Reflect.get(receiver, "capabilityTtlMs"));
    const rawCreateManager = Reflect.get(receiver, "createManager");
    const createManager =
      rawCreateManager === undefined
        ? (managerOptions: HermesSidecarManagerOptions): HermesRuntimeManagerPort =>
            new HermesSidecarManager(managerOptions)
        : snapshotManagerFactory(rawCreateManager, receiver);
    return Object.freeze({
      dataRoot,
      launcherPath,
      broker,
      acquireCredentialLease,
      capabilityTtlMs,
      createManager,
    });
  } catch {
    throw compositionError("HERMES_QUARANTINE_COMPOSITION_INVALID_CONFIGURATION");
  }
}

function snapshotBroker(value: unknown): HermesQuarantineBroker {
  if (!isObjectLike(value)) throw new Error();
  const receiver = value as object;
  const start = requireFunction(Reflect.get(receiver, "start"));
  const issue = requireFunction(Reflect.get(receiver, "issue"));
  const revoke = requireFunction(Reflect.get(receiver, "revoke"));
  const close = requireFunction(Reflect.get(receiver, "close"));
  return Object.freeze({
    start: () => Reflect.apply(start, receiver, []) as ReturnType<ProviderBroker["start"]>,
    issue: ((input, lease) =>
      Reflect.apply(issue, receiver, [input, lease])) as ProviderBroker["issue"],
    revoke: ((capabilityId) =>
      Reflect.apply(revoke, receiver, [capabilityId])) as ProviderBroker["revoke"],
    close: () => Reflect.apply(close, receiver, []) as ReturnType<ProviderBroker["close"]>,
  });
}

function createDisposalGuardedBroker(
  broker: HermesQuarantineBroker,
  lifecycle: CompositionLifecycle,
): Pick<ProviderBroker, "start" | "issue" | "revoke"> {
  return Object.freeze({
    start: (): ReturnType<ProviderBroker["start"]> => {
      if (lifecycle.disposed) {
        return Promise.reject(compositionError("HERMES_QUARANTINE_COMPOSITION_DISPOSED"));
      }
      return broker.start();
    },
    issue: ((input, lease) => {
      if (lifecycle.disposed) {
        throw compositionError("HERMES_QUARANTINE_COMPOSITION_DISPOSED");
      }
      return broker.issue(input, lease);
    }) as ProviderBroker["issue"],
    revoke: ((capabilityId) => broker.revoke(capabilityId)) as ProviderBroker["revoke"],
  });
}

async function awaitCleanupWithoutSelfWait(
  storage: AsyncLocalStorage<CleanupReentryContext>,
  owner: Promise<void>,
  invoke: () => Promise<void>,
): Promise<void> {
  let notify!: () => void;
  const reentered = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const context = Object.freeze({ owner, reentered, notify });
  const cleanup = storage.run(context, invoke);
  if (cleanup === owner) throw new Error();

  const outcome = await Promise.race<CleanupOutcome>([
    Promise.resolve(cleanup).then<CleanupOutcome, CleanupOutcome>(
      () => ({ kind: "complete" }),
      () => ({ kind: "failed" }),
    ),
    reentered.then(() => ({ kind: "reentered" })),
  ]);
  // Once unfinished cleanup reenters the owner, it is impossible to prove that the owner was
  // ignored rather than awaited. Quarantine shutdown therefore fails closed and remains retryable.
  if (outcome.kind !== "complete") throw new Error();
}

function instrumentDisposeOwner(
  owner: Promise<void>,
  storage: AsyncLocalStorage<CleanupReentryContext>,
): void {
  const rawThen = owner.then;
  const instrumentedThen = (...args: readonly unknown[]): unknown => {
    const context = storage.getStore();
    if (context?.owner === owner) context.notify();
    return Reflect.apply(rawThen, owner, args);
  };
  // Await can bypass an own `then` on a same-constructor native Promise. Shadowing the constructor
  // makes PromiseResolve use the instrumented thenable path while preserving Promise identity.
  Object.defineProperty(owner, "constructor", {
    configurable: false,
    enumerable: false,
    value: undefined,
    writable: false,
  });
  // biome-ignore lint/suspicious/noThenProperty: instrument the real owner Promise to detect adopted self-waits.
  Object.defineProperty(owner, "then", {
    configurable: false,
    enumerable: false,
    value: instrumentedThen,
    writable: false,
  });
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

function requireCapabilityTtl(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < MIN_CAPABILITY_TTL_MS ||
    (value as number) > MAX_CAPABILITY_TTL_MS
  ) {
    throw new Error();
  }
  return value as number;
}

function requireFunction(value: unknown): (...args: readonly unknown[]) => unknown {
  if (typeof value !== "function") throw new Error();
  return value as (...args: readonly unknown[]) => unknown;
}

function compositionError(
  code: HermesQuarantineCompositionErrorCode,
): HermesQuarantineCompositionError {
  return Object.freeze(new HermesQuarantineCompositionError(code));
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
