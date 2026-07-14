import { isAbsolute } from "node:path";
import type {
  RuntimeAdapter,
  RuntimeApprovalChoice,
  RuntimeBinding,
  RuntimeCrash,
  RuntimeCrashListener,
  RuntimeCreateInput,
  RuntimeEventSink,
  RuntimeResumeInput,
} from "@opentrad/runtime-adapter";
import type { HermesGatewayNotification } from "./hermes/gateway-client";
import type {
  HermesGatewayRequestMethod,
  HermesGatewayRequestParams,
  HermesGatewayRequestResult,
} from "./hermes/gateway-protocol";
import {
  isValidHermesGatewayRequestParams,
  isValidHermesGatewayRequestResult,
} from "./hermes/gateway-validation";
import type {
  HermesSidecarBinding,
  HermesSidecarCrashListener,
  HermesSidecarManager,
} from "./hermes/sidecar-manager";

export type HermesRuntimeManagerPort = Pick<
  HermesSidecarManager,
  "start" | "stop" | "request" | "subscribe" | "onCrash"
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
  | "HERMES_RUNTIME_RESUME_FAILED"
  | "HERMES_RUNTIME_STREAM_FAILED"
  | "HERMES_RUNTIME_INTERRUPT_FAILED"
  | "HERMES_RUNTIME_APPROVAL_RESPONSE_FAILED"
  | "HERMES_RUNTIME_SUDO_RESPONSE_FAILED"
  | "HERMES_RUNTIME_SECRET_RESPONSE_FAILED"
  | "HERMES_RUNTIME_BUSY"
  | "HERMES_RUNTIME_UNKNOWN_SESSION"
  | "HERMES_RUNTIME_CRASHED"
  | "HERMES_RUNTIME_CLOSE_FAILED"
  | "HERMES_RUNTIME_CLEANUP_FAILED"
  | "HERMES_RUNTIME_DISPOSED";

const ERROR_MESSAGES: Readonly<Record<HermesRuntimeAdapterErrorCode, string>> = {
  HERMES_RUNTIME_INVALID_INPUT: "Hermes runtime launch context is invalid",
  HERMES_RUNTIME_DUPLICATE_CREATE: "Hermes runtime session identity is already reserved",
  HERMES_RUNTIME_CREATE_FAILED: "Hermes runtime session creation failed",
  HERMES_RUNTIME_RESUME_FAILED: "Hermes runtime session resume failed",
  HERMES_RUNTIME_STREAM_FAILED: "Hermes runtime stream failed",
  HERMES_RUNTIME_INTERRUPT_FAILED: "Hermes runtime interrupt failed",
  HERMES_RUNTIME_APPROVAL_RESPONSE_FAILED: "Hermes runtime approval response failed",
  HERMES_RUNTIME_SUDO_RESPONSE_FAILED: "Hermes runtime sudo response failed",
  HERMES_RUNTIME_SECRET_RESPONSE_FAILED: "Hermes runtime secret response failed",
  HERMES_RUNTIME_BUSY: "Hermes runtime session is already streaming",
  HERMES_RUNTIME_UNKNOWN_SESSION: "Hermes runtime session binding is invalid",
  HERMES_RUNTIME_CRASHED: "Hermes runtime sidecar crashed",
  HERMES_RUNTIME_CLOSE_FAILED: "Hermes runtime session close failed",
  HERMES_RUNTIME_CLEANUP_FAILED: "Hermes runtime cleanup could not be confirmed",
  HERMES_RUNTIME_DISPOSED: "Hermes runtime adapter is disposed",
};

const INTERNAL_ERROR_CODES = new WeakMap<object, HermesRuntimeAdapterErrorCode>();
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
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
  subscribe(listener: (notification: HermesGatewayNotification) => void): () => void;
  onCrash(listener: HermesSidecarCrashListener): () => void;
}

interface ActiveStream {
  readonly resolve: () => void;
  readonly reject: (error: HermesRuntimeAdapterError) => void;
  unsubscribe?: () => void;
  settled: boolean;
}

interface RuntimeEntry {
  readonly launch: LaunchSnapshot;
  readonly manager: OwnedManagerPort;
  binding: RuntimeBinding | null;
  unsubscribeCrash?: () => void;
  activeStream?: ActiveStream;
  crashed: boolean;
  removed: boolean;
  cleanupPromise?: Promise<void>;
}

type OpenMode =
  | { readonly kind: "create" }
  | { readonly kind: "resume"; readonly durableRuntimeSessionId: string };

export class HermesRuntimeAdapter implements RuntimeAdapter {
  readonly kind = "hermes" as const;
  private readonly crashListeners = new Set<RuntimeCrashListener>();
  private readonly entries = new Set<RuntimeEntry>();
  private readonly entriesByCanonical = new Map<string, RuntimeEntry>();
  private readonly entriesByTaskRun = new Map<string, RuntimeEntry>();
  private readonly canonicalTombstones = new Set<string>();
  private readonly taskRunTombstones = new Set<string>();
  private readonly managerIdentities = new WeakSet<object>();
  private disposed = false;
  private disposePromise?: Promise<void>;

  constructor(private readonly createManager: HermesRuntimeManagerFactory) {}

  async ready(): Promise<{ version: string }> {
    this.throwIfDisposed();
    return { version: "hermes-agent/0.18.2" };
  }

  create(input: RuntimeCreateInput): Promise<RuntimeBinding> {
    return this.openSession(input, { kind: "create" });
  }

  async resume(input: RuntimeResumeInput): Promise<RuntimeBinding> {
    let durableRuntimeSessionId: string;
    try {
      durableRuntimeSessionId = Reflect.get(input as object, "durableRuntimeSessionId") as string;
      if (!STORED_SESSION_ID_PATTERN.test(durableRuntimeSessionId)) throw new Error();
    } catch {
      throw runtimeError("HERMES_RUNTIME_INVALID_INPUT");
    }
    return this.openSession(input, { kind: "resume", durableRuntimeSessionId });
  }

  async stream(binding: RuntimeBinding, prompt: string, emit: RuntimeEventSink): Promise<void> {
    this.throwIfDisposed();
    const entry = this.requireEntry(binding);
    const ownedBinding = entry.binding;
    if (!ownedBinding) throw runtimeError("HERMES_RUNTIME_UNKNOWN_SESSION");
    if (entry.activeStream) throw runtimeError("HERMES_RUNTIME_BUSY");
    if (typeof prompt !== "string" || prompt.trim().length === 0 || typeof emit !== "function") {
      throw runtimeError("HERMES_RUNTIME_STREAM_FAILED");
    }

    let resolveStream!: () => void;
    let rejectStream!: (error: HermesRuntimeAdapterError) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveStream = resolve;
      rejectStream = reject;
    });
    const active: ActiveStream = {
      resolve: resolveStream,
      reject: rejectStream,
      settled: false,
    };
    entry.activeStream = active;
    try {
      const unsubscribe = entry.manager.subscribe((notification) => {
        if (notification.sessionId !== ownedBinding.liveRuntimeSessionId || active.settled) return;
        try {
          emit({ type: notification.method, payload: notification.params });
        } catch {
          this.finishStream(entry, runtimeError("HERMES_RUNTIME_STREAM_FAILED"));
          return;
        }
        if (notification.method === "error") {
          this.finishStream(entry, runtimeError("HERMES_RUNTIME_STREAM_FAILED"));
        } else if (notification.method === "message.complete") {
          this.finishStream(
            entry,
            hasErrorCompletionStatus(notification.params)
              ? runtimeError("HERMES_RUNTIME_STREAM_FAILED")
              : undefined,
          );
        }
      });
      if (typeof unsubscribe !== "function") throw new Error();
      active.unsubscribe = unsubscribe;
      await entry.manager.request("prompt.submit", {
        session_id: ownedBinding.liveRuntimeSessionId,
        text: prompt,
      });
      await completion;
    } catch (error) {
      const internal = internalErrorCode(error);
      const normalized = internal
        ? runtimeError(internal)
        : runtimeError("HERMES_RUNTIME_STREAM_FAILED");
      this.finishStream(entry, normalized);
      await completion;
    } finally {
      if (entry.activeStream === active) this.finishStream(entry);
    }
  }

  async interrupt(binding: RuntimeBinding): Promise<void> {
    this.throwIfDisposed();
    const entry = this.requireEntry(binding);
    const ownedBinding = entry.binding;
    if (!ownedBinding) throw runtimeError("HERMES_RUNTIME_UNKNOWN_SESSION");
    try {
      await entry.manager.request("session.interrupt", {
        session_id: ownedBinding.liveRuntimeSessionId,
      });
      this.finishStream(entry);
    } catch (error) {
      const internal = internalErrorCode(error);
      throw runtimeError(internal ?? "HERMES_RUNTIME_INTERRUPT_FAILED");
    }
  }

  async respondApproval(binding: RuntimeBinding, choice: RuntimeApprovalChoice): Promise<void> {
    this.throwIfDisposed();
    const entry = this.requireEntry(binding);
    const ownedBinding = entry.binding;
    if (!ownedBinding) throw runtimeError("HERMES_RUNTIME_UNKNOWN_SESSION");
    const params = { session_id: ownedBinding.liveRuntimeSessionId, choice };
    if (!isValidHermesGatewayRequestParams("approval.respond", params)) {
      throw runtimeError("HERMES_RUNTIME_APPROVAL_RESPONSE_FAILED");
    }
    try {
      const result = await entry.manager.request("approval.respond", params);
      if (!isValidHermesGatewayRequestResult("approval.respond", result)) throw new Error();
    } catch {
      throw runtimeError("HERMES_RUNTIME_APPROVAL_RESPONSE_FAILED");
    }
  }

  async respondSudo(binding: RuntimeBinding, requestId: string, password: string): Promise<void> {
    this.throwIfDisposed();
    const entry = this.requireEntry(binding);
    if (!entry.binding) throw runtimeError("HERMES_RUNTIME_UNKNOWN_SESSION");
    const params = { request_id: requestId, password };
    if (!isValidHermesGatewayRequestParams("sudo.respond", params)) {
      throw runtimeError("HERMES_RUNTIME_SUDO_RESPONSE_FAILED");
    }
    try {
      const result = await entry.manager.request("sudo.respond", params);
      if (!isValidHermesGatewayRequestResult("sudo.respond", result)) throw new Error();
    } catch {
      throw runtimeError("HERMES_RUNTIME_SUDO_RESPONSE_FAILED");
    }
  }

  async respondSecret(binding: RuntimeBinding, requestId: string, value: string): Promise<void> {
    this.throwIfDisposed();
    const entry = this.requireEntry(binding);
    if (!entry.binding) throw runtimeError("HERMES_RUNTIME_UNKNOWN_SESSION");
    const params = { request_id: requestId, value };
    if (!isValidHermesGatewayRequestParams("secret.respond", params)) {
      throw runtimeError("HERMES_RUNTIME_SECRET_RESPONSE_FAILED");
    }
    try {
      const result = await entry.manager.request("secret.respond", params);
      if (!isValidHermesGatewayRequestResult("secret.respond", result)) throw new Error();
    } catch {
      throw runtimeError("HERMES_RUNTIME_SECRET_RESPONSE_FAILED");
    }
  }

  close(binding: RuntimeBinding): Promise<void> {
    if (this.disposed) return Promise.reject(runtimeError("HERMES_RUNTIME_DISPOSED"));
    const entry = this.findEntry(binding);
    return entry ? this.cleanupEntry(entry) : Promise.resolve();
  }

  async invalidateProfile(profileId: string): Promise<void> {
    this.throwIfDisposed();
    if (typeof profileId !== "string" || profileId.length === 0) {
      throw runtimeError("HERMES_RUNTIME_INVALID_INPUT");
    }
    const results = await Promise.allSettled(
      [...this.entries]
        .filter((entry) => entry.launch.binding.profileId === profileId)
        .map((entry) => this.cleanupEntry(entry)),
    );
    if (results.some((result) => result.status === "rejected")) {
      throw runtimeError("HERMES_RUNTIME_CLEANUP_FAILED");
    }
  }

  onCrash(listener: RuntimeCrashListener): () => void {
    this.crashListeners.add(listener);
    return () => this.crashListeners.delete(listener);
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    const disposing = Promise.allSettled(
      [...this.entries].map((entry) => this.cleanupEntry(entry)),
    ).then((results) => {
      if (results.some((result) => result.status === "rejected")) {
        throw runtimeError("HERMES_RUNTIME_CLEANUP_FAILED");
      }
    });
    this.disposePromise = disposing;
    return disposing;
  }

  private async openSession(input: RuntimeCreateInput, mode: OpenMode): Promise<RuntimeBinding> {
    this.throwIfDisposed();
    const launch = snapshotLaunch(input);
    this.throwIfDisposed();
    this.throwIfDuplicate(launch, mode);
    const rawManager = this.constructManager(launch);
    const manager = snapshotManager(rawManager);
    const entry: RuntimeEntry = {
      launch,
      manager,
      binding: null,
      crashed: false,
      removed: false,
    };
    this.reserve(entry);

    try {
      const unsubscribeCrash = manager.onCrash(() => this.handleCrash(entry));
      if (typeof unsubscribeCrash !== "function") throw new Error();
      entry.unsubscribeCrash = unsubscribeCrash;
      await manager.start();
      this.throwIfDisposed();
      if (entry.crashed) throw runtimeError("HERMES_RUNTIME_CRASHED");

      let liveRuntimeSessionId: string;
      let durableRuntimeSessionId: string;
      if (mode.kind === "create") {
        const result = await manager.request("session.create", {
          cwd: launch.workspaceRoot,
          source: "opentrad",
          model: launch.binding.model,
          provider: launch.binding.providerSlug,
          close_on_disconnect: false,
        });
        liveRuntimeSessionId = result.session_id;
        durableRuntimeSessionId = result.stored_session_id;
      } else {
        const result = await manager.request("session.resume", {
          session_id: mode.durableRuntimeSessionId,
        });
        liveRuntimeSessionId = result.session_id;
        durableRuntimeSessionId = result.resumed;
      }
      if (
        !LIVE_SESSION_ID_PATTERN.test(liveRuntimeSessionId) ||
        !STORED_SESSION_ID_PATTERN.test(durableRuntimeSessionId)
      ) {
        throw new Error();
      }
      const binding = Object.freeze({
        canonicalSessionId: launch.canonicalSessionId,
        liveRuntimeSessionId,
        durableRuntimeSessionId,
      }) satisfies RuntimeBinding;
      entry.binding = binding;
      this.canonicalTombstones.add(launch.canonicalSessionId);
      this.taskRunTombstones.add(launch.taskRunKey);
      return binding;
    } catch (error) {
      try {
        await this.cleanupEntry(entry);
      } catch {
        throw runtimeError("HERMES_RUNTIME_CLEANUP_FAILED");
      }
      const internal = internalErrorCode(error);
      if (internal === "HERMES_RUNTIME_CRASHED" || internal === "HERMES_RUNTIME_DISPOSED") {
        throw runtimeError(internal);
      }
      throw runtimeError(
        mode.kind === "resume" ? "HERMES_RUNTIME_RESUME_FAILED" : "HERMES_RUNTIME_CREATE_FAILED",
      );
    }
  }

  private constructManager(launch: LaunchSnapshot): object {
    let raw: unknown;
    try {
      raw = this.createManager(
        Object.freeze({ workspaceRoot: launch.workspaceRoot, binding: launch.binding }),
      );
    } catch {
      throw runtimeError("HERMES_RUNTIME_CREATE_FAILED");
    }
    if (!isObjectLike(raw) || this.managerIdentities.has(raw)) {
      throw runtimeError(
        isObjectLike(raw) ? "HERMES_RUNTIME_DUPLICATE_CREATE" : "HERMES_RUNTIME_CREATE_FAILED",
      );
    }
    this.managerIdentities.add(raw);
    return raw;
  }

  private cleanupEntry(entry: RuntimeEntry): Promise<void> {
    if (entry.cleanupPromise) return entry.cleanupPromise;
    if (entry.removed) return Promise.resolve();
    const cleanup = this.performCleanup(entry);
    entry.cleanupPromise = cleanup;
    return cleanup;
  }

  private async performCleanup(entry: RuntimeEntry): Promise<void> {
    this.finishStream(entry, runtimeError("HERMES_RUNTIME_STREAM_FAILED"));
    let closeFailed = false;
    if (entry.binding && !entry.crashed) {
      try {
        const result = await entry.manager.request("session.close", {
          session_id: entry.binding.liveRuntimeSessionId,
        });
        closeFailed = result.closed !== true;
      } catch {
        closeFailed = true;
      }
    }
    try {
      await entry.manager.stop();
    } catch {
      throw runtimeError("HERMES_RUNTIME_CLEANUP_FAILED");
    }
    try {
      entry.unsubscribeCrash?.();
    } catch {
      throw runtimeError("HERMES_RUNTIME_CLEANUP_FAILED");
    }
    this.release(entry);
    if (closeFailed) throw runtimeError("HERMES_RUNTIME_CLOSE_FAILED");
  }

  private handleCrash(entry: RuntimeEntry): void {
    if (entry.crashed || entry.removed) return;
    entry.crashed = true;
    const error = runtimeError("HERMES_RUNTIME_CRASHED");
    this.finishStream(entry, error);
    const crash = Object.freeze({
      runtimeKind: this.kind,
      binding: entry.binding,
      error,
    }) satisfies RuntimeCrash;
    for (const listener of [...this.crashListeners]) invokeCrashListener(listener, crash);
    void this.cleanupEntry(entry).catch(() => {});
  }

  private finishStream(entry: RuntimeEntry, error?: HermesRuntimeAdapterError): void {
    const active = entry.activeStream;
    if (!active || active.settled) return;
    active.settled = true;
    try {
      active.unsubscribe?.();
    } catch {
      // A notification observer never owns the process lifecycle.
    }
    if (entry.activeStream === active) entry.activeStream = undefined;
    if (error) active.reject(error);
    else active.resolve();
  }

  private requireEntry(binding: RuntimeBinding): RuntimeEntry {
    const entry = this.findEntry(binding);
    if (!entry) throw runtimeError("HERMES_RUNTIME_UNKNOWN_SESSION");
    if (entry.crashed) throw runtimeError("HERMES_RUNTIME_CRASHED");
    return entry;
  }

  private findEntry(value: unknown): RuntimeEntry | undefined {
    const binding = snapshotRuntimeBinding(value);
    if (!binding) return undefined;
    const entry = this.entriesByCanonical.get(binding.canonicalSessionId);
    return entry?.binding && !entry.removed && sameBinding(entry.binding, binding)
      ? entry
      : undefined;
  }

  private throwIfDuplicate(launch: LaunchSnapshot, mode: OpenMode): void {
    if (
      this.entriesByCanonical.has(launch.canonicalSessionId) ||
      this.entriesByTaskRun.has(launch.taskRunKey) ||
      (mode.kind === "create" && this.canonicalTombstones.has(launch.canonicalSessionId)) ||
      this.taskRunTombstones.has(launch.taskRunKey)
    ) {
      throw runtimeError("HERMES_RUNTIME_DUPLICATE_CREATE");
    }
  }

  private reserve(entry: RuntimeEntry): void {
    this.entries.add(entry);
    this.entriesByCanonical.set(entry.launch.canonicalSessionId, entry);
    this.entriesByTaskRun.set(entry.launch.taskRunKey, entry);
  }

  private release(entry: RuntimeEntry): void {
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
    const providerSlug = Reflect.get(provider, "providerSlug");
    const authMode = Reflect.get(provider, "authMode");
    const model = Reflect.get(provider, "model");
    const apiMode = Reflect.get(provider, "apiMode");
    const executionBackend = Reflect.get(provider, "executionBackend");
    if (
      !isId(profileId) ||
      !isId(providerSlug) ||
      typeof model !== "string" ||
      !MODEL_PATTERN.test(model) ||
      (authMode !== "api_key" && authMode !== "oauth") ||
      (apiMode !== "chat_completions" && apiMode !== "codex_responses") ||
      (executionBackend !== "local" && executionBackend !== "docker")
    ) {
      throw new Error();
    }
    const binding = Object.freeze({
      taskId,
      runId,
      profileId,
      providerSlug,
      authMode,
      model,
      apiMode,
      executionBackend,
    }) satisfies HermesSidecarBinding;
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

function snapshotManager(value: object): OwnedManagerPort {
  try {
    const start = Reflect.get(value, "start");
    const stop = Reflect.get(value, "stop");
    const request = Reflect.get(value, "request");
    const subscribe = Reflect.get(value, "subscribe");
    const onCrash = Reflect.get(value, "onCrash");
    if (
      typeof start !== "function" ||
      typeof stop !== "function" ||
      typeof request !== "function" ||
      typeof subscribe !== "function" ||
      typeof onCrash !== "function"
    ) {
      throw new Error();
    }
    return Object.freeze({
      start: () => Reflect.apply(start, value, []) as Promise<void>,
      stop: () => Reflect.apply(stop, value, []) as Promise<void>,
      request<TMethod extends HermesGatewayRequestMethod>(
        method: TMethod,
        params: HermesGatewayRequestParams<TMethod>,
      ): Promise<HermesGatewayRequestResult<TMethod>> {
        return Reflect.apply(request, value, [method, params]) as Promise<
          HermesGatewayRequestResult<TMethod>
        >;
      },
      subscribe: (listener: (notification: HermesGatewayNotification) => void) =>
        Reflect.apply(subscribe, value, [listener]) as () => void,
      onCrash: (listener: HermesSidecarCrashListener) =>
        Reflect.apply(onCrash, value, [listener]) as () => void,
    });
  } catch {
    throw runtimeError("HERMES_RUNTIME_CREATE_FAILED");
  }
}

function snapshotRuntimeBinding(value: unknown): RuntimeBinding | undefined {
  try {
    if (!isObjectLike(value)) return undefined;
    const canonicalSessionId = Reflect.get(value, "canonicalSessionId");
    const liveRuntimeSessionId = Reflect.get(value, "liveRuntimeSessionId");
    const durableRuntimeSessionId = Reflect.get(value, "durableRuntimeSessionId");
    if (
      !isId(canonicalSessionId) ||
      typeof liveRuntimeSessionId !== "string" ||
      !LIVE_SESSION_ID_PATTERN.test(liveRuntimeSessionId) ||
      typeof durableRuntimeSessionId !== "string" ||
      !STORED_SESSION_ID_PATTERN.test(durableRuntimeSessionId)
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

function internalErrorCode(value: unknown): HermesRuntimeAdapterErrorCode | undefined {
  return isObjectLike(value) ? INTERNAL_ERROR_CODES.get(value) : undefined;
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

function hasErrorCompletionStatus(value: unknown): boolean {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return true;
    const status = Reflect.get(value, "status");
    return status !== undefined && status !== "complete" && status !== "interrupted";
  } catch {
    return true;
  }
}

function invokeCrashListener(listener: RuntimeCrashListener, crash: RuntimeCrash): void {
  try {
    void Promise.resolve(listener(crash)).catch(() => {});
  } catch {
    // Runtime observers never own process cleanup.
  }
}
