import { isAbsolute } from "node:path";
import {
  type RuntimeAdapter,
  type RuntimeBinding,
  type RuntimeCrash,
  type RuntimeCrashListener,
  type RuntimeCreateInput,
  type RuntimeEventSink,
  RuntimeOperationQuarantinedError,
  type RuntimeResumeInput,
  RuntimeResumeUnsupportedError,
} from "@opentrad/runtime-adapter";
import type {
  HermesGatewayRequestMethod,
  HermesGatewayRequestParams,
  HermesGatewayRequestResult,
} from "./hermes/gateway-protocol";
import type {
  HermesSidecarBinding,
  HermesSidecarCrashListener,
  HermesSidecarManager,
} from "./hermes/sidecar-manager";

export type HermesRuntimeManagerPort = Pick<
  HermesSidecarManager,
  "start" | "stop" | "request" | "onCrash"
>;

export interface HermesRuntimeManagerFactoryInput {
  readonly workspaceRoot: string;
  readonly binding: HermesSidecarBinding;
}

export type HermesRuntimeManagerFactory = (
  input: HermesRuntimeManagerFactoryInput,
) => HermesRuntimeManagerPort;

export type HermesRuntimeAdapterErrorCode =
  | "HERMES_RUNTIME_INVALID_INPUT"
  | "HERMES_RUNTIME_DUPLICATE_CREATE"
  | "HERMES_RUNTIME_CREATE_FAILED"
  | "HERMES_RUNTIME_QUARANTINE_VIOLATION"
  | "HERMES_RUNTIME_CRASHED"
  | "HERMES_RUNTIME_CLOSE_FAILED"
  | "HERMES_RUNTIME_CLEANUP_FAILED"
  | "HERMES_RUNTIME_DISPOSED";

const ERROR_MESSAGES: Readonly<Record<HermesRuntimeAdapterErrorCode, string>> = {
  HERMES_RUNTIME_INVALID_INPUT: "Hermes runtime launch context is invalid",
  HERMES_RUNTIME_DUPLICATE_CREATE: "Hermes runtime session identity is already reserved",
  HERMES_RUNTIME_CREATE_FAILED: "Hermes runtime session creation failed",
  HERMES_RUNTIME_QUARANTINE_VIOLATION: "Hermes runtime quarantine contract was violated",
  HERMES_RUNTIME_CRASHED: "Hermes runtime sidecar crashed",
  HERMES_RUNTIME_CLOSE_FAILED: "Hermes runtime session close failed",
  HERMES_RUNTIME_CLEANUP_FAILED: "Hermes runtime cleanup could not be confirmed",
  HERMES_RUNTIME_DISPOSED: "Hermes runtime adapter is disposed",
};

const INTERNAL_ERROR_CODES = new WeakMap<object, HermesRuntimeAdapterErrorCode>();

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const LIVE_SESSION_ID_PATTERN = /^[0-9a-f]{8}$/u;
const STORED_SESSION_ID_PATTERN = /^[0-9]{8}_[0-9]{6}_[0-9a-f]{6}$/u;
const MAX_WORKSPACE_PATH_LENGTH = 4_096;

export class HermesRuntimeAdapterError extends Error {
  readonly code: HermesRuntimeAdapterErrorCode;

  constructor(code: HermesRuntimeAdapterErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "HermesRuntimeAdapterError";
    this.code = code;
  }
}

interface LaunchSnapshot {
  readonly canonicalSessionId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly binding: HermesSidecarBinding;
  readonly taskRunKey: string;
}

interface OwnedManagerPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  request<TMethod extends HermesGatewayRequestMethod>(
    method: TMethod,
    params: HermesGatewayRequestParams<TMethod>,
  ): Promise<HermesGatewayRequestResult<TMethod>>;
  onCrash(listener: HermesSidecarCrashListener): () => void;
}

interface HermesRuntimeEntry {
  readonly launch: LaunchSnapshot;
  readonly terminationSignal: Promise<HermesRuntimeAdapterErrorCode>;
  readonly resolveTermination: (code: HermesRuntimeAdapterErrorCode) => void;
  manager?: OwnedManagerPort;
  stop?: () => Promise<void>;
  binding: RuntimeBinding | null;
  unsubscribeCrash?: () => void;
  crashNotified: boolean;
  crashed: boolean;
  closeAttempted: boolean;
  closeFailed: boolean;
  stopConfirmed: boolean;
  unsubscribeConfirmed: boolean;
  cleanupUnconfirmed: boolean;
  terminationCode?: HermesRuntimeAdapterErrorCode;
  removed: boolean;
  cleanupPromise?: Promise<void>;
}

interface ManagerSnapshot {
  readonly port: OwnedManagerPort;
}

type StageOutcome<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "terminated"; readonly code: HermesRuntimeAdapterErrorCode };

export class HermesRuntimeAdapter implements RuntimeAdapter {
  readonly kind = "hermes" as const;
  private readonly crashListeners = new Set<RuntimeCrashListener>();
  private readonly entries = new Set<HermesRuntimeEntry>();
  private readonly entriesByCanonical = new Map<string, HermesRuntimeEntry>();
  private readonly entriesByTaskRun = new Map<string, HermesRuntimeEntry>();
  private readonly canonicalTombstones = new Set<string>();
  private readonly taskRunTombstones = new Set<string>();
  private readonly ownedManagerIdentities = new WeakSet<object>();
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(private readonly createManager: HermesRuntimeManagerFactory) {}

  async ready(): Promise<{ version: string }> {
    this.throwIfDisposed();
    return { version: "hermes-quarantine/1" };
  }

  async create(input: RuntimeCreateInput): Promise<RuntimeBinding> {
    this.throwIfDisposed();
    const launch = snapshotLaunch(input);
    this.throwIfDisposed();
    this.throwIfDuplicate(launch);

    let resolveTermination!: (code: HermesRuntimeAdapterErrorCode) => void;
    const terminationSignal = new Promise<HermesRuntimeAdapterErrorCode>((resolve) => {
      resolveTermination = resolve;
    });
    const entry: HermesRuntimeEntry = {
      launch,
      terminationSignal,
      resolveTermination,
      binding: null,
      crashNotified: false,
      crashed: false,
      closeAttempted: false,
      closeFailed: false,
      stopConfirmed: false,
      unsubscribeConfirmed: false,
      cleanupUnconfirmed: false,
      removed: false,
    };
    this.reserve(entry);

    let rawManager: unknown;
    try {
      rawManager = this.createManager(
        Object.freeze({ workspaceRoot: launch.workspaceRoot, binding: launch.binding }),
      );
    } catch {
      this.release(entry);
      throw runtimeError("HERMES_RUNTIME_CREATE_FAILED");
    }

    if (!isObjectLike(rawManager)) {
      this.release(entry);
      throw runtimeError("HERMES_RUNTIME_CREATE_FAILED");
    }
    const managerIdentity = rawManager as object;
    if (this.ownedManagerIdentities.has(managerIdentity)) {
      this.release(entry);
      throw runtimeError("HERMES_RUNTIME_DUPLICATE_CREATE");
    }
    this.ownedManagerIdentities.add(managerIdentity);

    let stop: () => Promise<void>;
    try {
      stop = snapshotManagerStop(rawManager);
    } catch {
      entry.cleanupUnconfirmed = true;
      throw runtimeError("HERMES_RUNTIME_CLEANUP_FAILED");
    }
    entry.stop = stop;

    let managerSnapshot: ManagerSnapshot;
    try {
      managerSnapshot = snapshotManager(rawManager, stop);
    } catch {
      entry.closeAttempted = true;
      try {
        await this.cleanupEntry(entry);
      } catch {
        throw runtimeError("HERMES_RUNTIME_CLEANUP_FAILED");
      }
      throw runtimeError("HERMES_RUNTIME_CREATE_FAILED");
    }
    entry.manager = managerSnapshot.port;

    try {
      this.throwIfDisposed();
      const unsubscribe: unknown = entry.manager.onCrash(() => this.handleCrash(entry));
      if (typeof unsubscribe !== "function") {
        throw runtimeError("HERMES_RUNTIME_CREATE_FAILED");
      }
      entry.unsubscribeCrash = unsubscribe as () => void;
      if (entry.crashed) throw runtimeError("HERMES_RUNTIME_CRASHED");
      this.throwIfDisposed();

      await this.awaitStage(entry, entry.manager.start());
      if (this.disposed || entry.removed) {
        throw runtimeError("HERMES_RUNTIME_DISPOSED");
      }

      const result = await this.awaitStage(entry, entry.manager.request("session.create", {}));
      if (this.disposed || entry.removed) {
        throw runtimeError("HERMES_RUNTIME_DISPOSED");
      }

      const liveRuntimeSessionId = quarantineLiveSessionId(result);
      if (entry.crashed) throw runtimeError("HERMES_RUNTIME_CRASHED");
      if (this.disposed || entry.removed) {
        throw runtimeError("HERMES_RUNTIME_DISPOSED");
      }
      const binding = Object.freeze({
        canonicalSessionId: launch.canonicalSessionId,
        liveRuntimeSessionId,
        durableRuntimeSessionId: null,
      }) satisfies RuntimeBinding;
      entry.binding = binding;
      this.canonicalTombstones.add(launch.canonicalSessionId);
      this.taskRunTombstones.add(launch.taskRunKey);
      return binding;
    } catch (error) {
      entry.closeAttempted = true;
      try {
        await this.cleanupEntry(entry);
      } catch {
        throw runtimeError("HERMES_RUNTIME_CLEANUP_FAILED");
      }
      throw normalizeCreateError(error, entry.crashed);
    }
  }

  async stream(_binding: RuntimeBinding, _prompt: string, _emit: RuntimeEventSink): Promise<void> {
    throw new RuntimeOperationQuarantinedError("stream");
  }

  async interrupt(_binding: RuntimeBinding): Promise<void> {
    throw new RuntimeOperationQuarantinedError("interrupt");
  }

  close(binding: RuntimeBinding): Promise<void> {
    if (this.disposed) {
      return Promise.reject(runtimeError("HERMES_RUNTIME_DISPOSED"));
    }
    const entry = this.findEntry(binding);
    if (!entry) return Promise.resolve();
    return this.cleanupEntry(entry);
  }

  async resume(_input: RuntimeResumeInput): Promise<RuntimeBinding> {
    throw new RuntimeResumeUnsupportedError(this.kind);
  }

  onCrash(listener: RuntimeCrashListener): () => void {
    this.crashListeners.add(listener);
    return () => {
      this.crashListeners.delete(listener);
    };
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    const promise = Promise.resolve().then(() => this.disposeEntries());
    this.disposePromise = promise;
    for (const entry of this.entries) this.terminateEntry(entry, "HERMES_RUNTIME_DISPOSED");
    void promise.then(
      () => {
        if (this.disposePromise === promise) this.disposePromise = undefined;
      },
      () => {
        if (this.disposePromise === promise) this.disposePromise = undefined;
      },
    );
    return promise;
  }

  private async awaitStage<T>(entry: HermesRuntimeEntry, raw: Promise<T>): Promise<T> {
    const operation = Promise.resolve(raw).then<StageOutcome<T>, StageOutcome<T>>(
      (value) => ({ kind: "value", value }),
      (error: unknown) => ({ kind: "error", error }),
    );
    const outcome = await Promise.race<StageOutcome<T>>([
      operation,
      entry.terminationSignal.then((code) => ({ kind: "terminated", code })),
    ]);
    if (outcome.kind === "terminated") throw runtimeError(outcome.code);
    if (entry.crashed) throw runtimeError("HERMES_RUNTIME_CRASHED");
    if (outcome.kind === "error") throw outcome.error;
    return outcome.value;
  }

  private async disposeEntries(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.entries].map((entry) => this.cleanupEntry(entry)),
    );
    if (results.some((result) => result.status === "rejected")) {
      throw runtimeError("HERMES_RUNTIME_CLEANUP_FAILED");
    }
  }

  private cleanupEntry(entry: HermesRuntimeEntry): Promise<void> {
    if (entry.cleanupPromise) return entry.cleanupPromise;
    if (entry.removed) return Promise.resolve();
    const promise = Promise.resolve().then(() => this.performCleanup(entry));
    entry.cleanupPromise = promise;
    void promise.then(
      () => {
        if (entry.cleanupPromise === promise) entry.cleanupPromise = undefined;
      },
      () => {
        if (entry.cleanupPromise === promise) entry.cleanupPromise = undefined;
      },
    );
    return promise;
  }

  private async performCleanup(entry: HermesRuntimeEntry): Promise<void> {
    if (entry.cleanupUnconfirmed) {
      throw runtimeError("HERMES_RUNTIME_CLEANUP_FAILED");
    }
    const manager = entry.manager;
    if (manager && !entry.closeAttempted) {
      entry.closeAttempted = true;
      if (entry.binding && !entry.crashed) {
        try {
          const result = await this.awaitStage(
            entry,
            manager.request("session.close", {
              session_id: entry.binding.liveRuntimeSessionId,
            }),
          );
          if (!safeClosedResult(result)) entry.closeFailed = true;
        } catch {
          if (!entry.crashed && !this.disposed) entry.closeFailed = true;
        }
      }
    }

    if (entry.stop && !entry.stopConfirmed) {
      try {
        const stopping = entry.stop();
        if (stopping === entry.cleanupPromise || stopping === this.disposePromise) {
          throw runtimeError("HERMES_RUNTIME_CLEANUP_FAILED");
        }
        await stopping;
        entry.stopConfirmed = true;
      } catch {
        throw runtimeError("HERMES_RUNTIME_CLEANUP_FAILED");
      }
    } else if (!entry.stop) {
      entry.stopConfirmed = true;
    }

    if (!entry.unsubscribeConfirmed) {
      try {
        entry.unsubscribeCrash?.();
        entry.unsubscribeConfirmed = true;
      } catch {
        throw runtimeError("HERMES_RUNTIME_CLEANUP_FAILED");
      }
    }

    this.release(entry);
    if (entry.closeFailed) {
      throw runtimeError("HERMES_RUNTIME_CLOSE_FAILED");
    }
  }

  private handleCrash(entry: HermesRuntimeEntry): void {
    if (entry.crashNotified || entry.removed) return;
    entry.crashNotified = true;
    entry.crashed = true;
    this.terminateEntry(entry, "HERMES_RUNTIME_CRASHED");
    const crash = Object.freeze({
      runtimeKind: this.kind,
      binding: entry.binding,
      error: runtimeError("HERMES_RUNTIME_CRASHED"),
    }) satisfies RuntimeCrash;
    for (const listener of [...this.crashListeners]) invokeCrashListener(listener, crash);
  }

  private terminateEntry(entry: HermesRuntimeEntry, code: HermesRuntimeAdapterErrorCode): void {
    if (entry.terminationCode !== undefined) return;
    entry.terminationCode = code;
    entry.resolveTermination(code);
  }

  private findEntry(value: unknown): HermesRuntimeEntry | undefined {
    const binding = snapshotRuntimeBinding(value);
    if (!binding) return undefined;
    const entry = this.entriesByCanonical.get(binding.canonicalSessionId);
    if (!entry?.binding || entry.removed) return undefined;
    return sameBinding(entry.binding, binding) ? entry : undefined;
  }

  private throwIfDuplicate(launch: LaunchSnapshot): void {
    if (
      this.entriesByCanonical.has(launch.canonicalSessionId) ||
      this.entriesByTaskRun.has(launch.taskRunKey) ||
      this.canonicalTombstones.has(launch.canonicalSessionId) ||
      this.taskRunTombstones.has(launch.taskRunKey)
    ) {
      throw runtimeError("HERMES_RUNTIME_DUPLICATE_CREATE");
    }
  }

  private reserve(entry: HermesRuntimeEntry): void {
    this.entries.add(entry);
    this.entriesByCanonical.set(entry.launch.canonicalSessionId, entry);
    this.entriesByTaskRun.set(entry.launch.taskRunKey, entry);
  }

  private release(entry: HermesRuntimeEntry): void {
    if (entry.removed) return;
    entry.removed = true;
    this.entries.delete(entry);
    if (this.entriesByCanonical.get(entry.launch.canonicalSessionId) === entry) {
      this.entriesByCanonical.delete(entry.launch.canonicalSessionId);
    }
    if (this.entriesByTaskRun.get(entry.launch.taskRunKey) === entry) {
      this.entriesByTaskRun.delete(entry.launch.taskRunKey);
    }
  }

  private throwIfDisposed(): void {
    if (this.disposed) throw runtimeError("HERMES_RUNTIME_DISPOSED");
  }
}

function snapshotLaunch(value: unknown): LaunchSnapshot {
  try {
    if (!isObjectLike(value)) throw new Error();
    const canonicalSessionId = Reflect.get(value, "canonicalSessionId");
    const taskId = Reflect.get(value, "taskId");
    const runId = Reflect.get(value, "runId");
    const workspaceRoot = Reflect.get(value, "workspaceRoot");
    const provider = Reflect.get(value, "provider");
    if (
      !isId(canonicalSessionId) ||
      !isId(taskId) ||
      !isId(runId) ||
      typeof workspaceRoot !== "string" ||
      workspaceRoot.length === 0 ||
      workspaceRoot.length > MAX_WORKSPACE_PATH_LENGTH ||
      workspaceRoot.includes("\0") ||
      !isAbsolute(workspaceRoot) ||
      !isObjectLike(provider)
    ) {
      throw new Error();
    }
    const profileId = Reflect.get(provider, "profileId");
    const model = Reflect.get(provider, "model");
    const apiMode = Reflect.get(provider, "apiMode");
    if (
      !isId(profileId) ||
      typeof model !== "string" ||
      !MODEL_PATTERN.test(model) ||
      (apiMode !== "chat_completions" && apiMode !== "codex_responses")
    ) {
      throw new Error();
    }
    const binding = Object.freeze({ taskId, runId, profileId, model, apiMode });
    return Object.freeze({
      canonicalSessionId,
      taskId,
      runId,
      workspaceRoot,
      binding,
      taskRunKey: `${taskId}\0${runId}`,
    });
  } catch {
    throw runtimeError("HERMES_RUNTIME_INVALID_INPUT");
  }
}

function snapshotManagerStop(value: object): () => Promise<void> {
  try {
    const stop = Reflect.get(value, "stop");
    if (typeof stop !== "function") throw new Error();
    return () => Reflect.apply(stop, value, []) as Promise<void>;
  } catch {
    throw runtimeError("HERMES_RUNTIME_CREATE_FAILED");
  }
}

function snapshotManager(value: object, stop: () => Promise<void>): ManagerSnapshot {
  try {
    const start = Reflect.get(value, "start");
    const request = Reflect.get(value, "request");
    const onCrash = Reflect.get(value, "onCrash");
    if (
      typeof start !== "function" ||
      typeof request !== "function" ||
      typeof onCrash !== "function"
    ) {
      throw new Error();
    }
    const port: OwnedManagerPort = Object.freeze({
      start: () => Reflect.apply(start, value, []) as Promise<void>,
      stop,
      request<TMethod extends HermesGatewayRequestMethod>(
        method: TMethod,
        params: HermesGatewayRequestParams<TMethod>,
      ): Promise<HermesGatewayRequestResult<TMethod>> {
        return Reflect.apply(request, value, [method, params]) as Promise<
          HermesGatewayRequestResult<TMethod>
        >;
      },
      onCrash: (listener: HermesSidecarCrashListener) =>
        Reflect.apply(onCrash, value, [listener]) as () => void,
    });
    return { port };
  } catch {
    throw runtimeError("HERMES_RUNTIME_CREATE_FAILED");
  }
}

function quarantineLiveSessionId(value: unknown): string {
  try {
    if (!isObjectLike(value)) throw new Error();
    const sessionId = Reflect.get(value, "session_id");
    const storedSessionId = Reflect.get(value, "stored_session_id");
    const messageCount = Reflect.get(value, "message_count");
    const messages = Reflect.get(value, "messages");
    const persisted = Reflect.get(value, "persisted");
    const resumable = Reflect.get(value, "resumable");
    const info = Reflect.get(value, "info");
    if (
      typeof sessionId !== "string" ||
      !LIVE_SESSION_ID_PATTERN.test(sessionId) ||
      typeof storedSessionId !== "string" ||
      !STORED_SESSION_ID_PATTERN.test(storedSessionId) ||
      messageCount !== 0 ||
      !Array.isArray(messages) ||
      messages.length !== 0 ||
      persisted !== false ||
      resumable !== false ||
      !isObjectLike(info) ||
      Reflect.get(info, "lazy") !== true ||
      Reflect.get(info, "persisted") !== false ||
      Reflect.get(info, "resumable") !== false ||
      Reflect.get(info, "runtime") !== "hermes-quarantined" ||
      Reflect.get(info, "state") !== "quarantined"
    ) {
      throw new Error();
    }
    return sessionId;
  } catch {
    throw runtimeError("HERMES_RUNTIME_QUARANTINE_VIOLATION");
  }
}

function snapshotRuntimeBinding(value: unknown): RuntimeBinding | undefined {
  try {
    if (!isObjectLike(value)) return undefined;
    const canonicalSessionId = Reflect.get(value, "canonicalSessionId");
    const liveRuntimeSessionId = Reflect.get(value, "liveRuntimeSessionId");
    const durableRuntimeSessionId = Reflect.get(value, "durableRuntimeSessionId");
    if (
      typeof canonicalSessionId !== "string" ||
      typeof liveRuntimeSessionId !== "string" ||
      durableRuntimeSessionId !== null
    ) {
      return undefined;
    }
    return { canonicalSessionId, liveRuntimeSessionId, durableRuntimeSessionId };
  } catch {
    return undefined;
  }
}

function sameBinding(left: RuntimeBinding, right: RuntimeBinding): boolean {
  return (
    left.canonicalSessionId === right.canonicalSessionId &&
    left.liveRuntimeSessionId === right.liveRuntimeSessionId &&
    left.durableRuntimeSessionId === right.durableRuntimeSessionId
  );
}

function safeClosedResult(value: unknown): boolean {
  try {
    return isObjectLike(value) && Reflect.get(value, "closed") === true;
  } catch {
    return false;
  }
}

function normalizeCreateError(value: unknown, crashed: boolean): HermesRuntimeAdapterError {
  if (crashed) return runtimeError("HERMES_RUNTIME_CRASHED");
  const code = isObjectLike(value) ? INTERNAL_ERROR_CODES.get(value) : undefined;
  return runtimeError(code ?? "HERMES_RUNTIME_CREATE_FAILED");
}

function runtimeError(code: HermesRuntimeAdapterErrorCode): HermesRuntimeAdapterError {
  const error = new HermesRuntimeAdapterError(code);
  INTERNAL_ERROR_CODES.set(error, code);
  return Object.freeze(error);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function invokeCrashListener(listener: RuntimeCrashListener, crash: RuntimeCrash): void {
  try {
    void Promise.resolve(listener(crash)).catch(() => {});
  } catch {
    // Runtime observers never own sidecar state or cleanup.
  }
}
