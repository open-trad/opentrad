import { Buffer } from "node:buffer";
import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import {
  HERMES_GATEWAY_MAX_FRAME_BYTES,
  HermesGatewayNdjsonCodec,
  isGatewayRecord,
} from "./gateway-codec";
import {
  type HermesGatewayRequestMethod,
  type HermesGatewayRequestParams,
  type HermesGatewayRequestResult,
  isHermesGatewayRequestMethod,
} from "./gateway-protocol";
import {
  isValidHermesGatewayRequestParams,
  isValidHermesGatewayRequestResult,
} from "./gateway-validation";

export const HERMES_GATEWAY_READY_TIMEOUT_MS = 5_000;
export const HERMES_GATEWAY_REQUEST_TIMEOUT_MS = 30_000;
export const HERMES_GATEWAY_MAX_READY_TIMEOUT_MS = 60_000;
export const HERMES_GATEWAY_MAX_REQUEST_TIMEOUT_MS = 5 * 60_000;
export const HERMES_GATEWAY_MAX_PENDING_REQUESTS = 64;
export const HERMES_GATEWAY_MAX_QUEUED_BYTES = 4 * 1024 * 1024;
export { HERMES_GATEWAY_MAX_FRAME_BYTES } from "./gateway-codec";

export type HermesGatewayErrorCode =
  | "HERMES_GATEWAY_METHOD_DISALLOWED"
  | "HERMES_GATEWAY_INVALID_PARAMS"
  | "HERMES_GATEWAY_FRAME_TOO_LARGE"
  | "HERMES_GATEWAY_BACKPRESSURE"
  | "HERMES_GATEWAY_READY_TIMEOUT"
  | "HERMES_GATEWAY_REQUEST_TIMEOUT"
  | "HERMES_GATEWAY_PROTOCOL"
  | "HERMES_GATEWAY_CRASHED"
  | "HERMES_GATEWAY_CLEANUP"
  | "HERMES_GATEWAY_DISPOSED";

const ERROR_MESSAGES: Readonly<Record<HermesGatewayErrorCode, string>> = {
  HERMES_GATEWAY_METHOD_DISALLOWED: "Hermes gateway method is not allowed",
  HERMES_GATEWAY_INVALID_PARAMS: "Hermes gateway request parameters are invalid",
  HERMES_GATEWAY_FRAME_TOO_LARGE: "Hermes gateway request frame is too large",
  HERMES_GATEWAY_BACKPRESSURE: "Hermes gateway outbound queue limit exceeded",
  HERMES_GATEWAY_READY_TIMEOUT: "Hermes gateway readiness timed out",
  HERMES_GATEWAY_REQUEST_TIMEOUT: "Hermes gateway request timed out",
  HERMES_GATEWAY_PROTOCOL: "Hermes gateway protocol failure",
  HERMES_GATEWAY_CRASHED: "Hermes gateway process crashed",
  HERMES_GATEWAY_CLEANUP: "Hermes gateway process cleanup failed",
  HERMES_GATEWAY_DISPOSED: "Hermes gateway client is disposed",
};

export class HermesGatewayError extends Error {
  readonly code: HermesGatewayErrorCode;

  constructor(code: HermesGatewayErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "HermesGatewayError";
    this.code = code;
  }
}

export type HermesGatewayRemoteErrorCategory =
  | "parse_error"
  | "invalid_request"
  | "method_not_found"
  | "invalid_params"
  | "internal_error"
  | "server_error";

const REMOTE_ERROR_MESSAGES: Readonly<Record<HermesGatewayRemoteErrorCategory, string>> = {
  parse_error: "Hermes gateway request failed: parse error",
  invalid_request: "Hermes gateway request failed: invalid request",
  method_not_found: "Hermes gateway request failed: method not found",
  invalid_params: "Hermes gateway request failed: invalid params",
  internal_error: "Hermes gateway request failed: internal error",
  server_error: "Hermes gateway request failed: server error",
};

export class HermesGatewayRemoteError extends Error {
  readonly code = "HERMES_GATEWAY_REMOTE_ERROR";
  readonly remoteCode: number;
  readonly category: HermesGatewayRemoteErrorCategory;

  constructor(remoteCode: number) {
    const category = remoteErrorCategory(remoteCode);
    super(REMOTE_ERROR_MESSAGES[category]);
    this.name = "HermesGatewayRemoteError";
    this.remoteCode = remoteCode;
    this.category = category;
  }
}

export interface HermesGatewayNotification {
  readonly method: string;
  readonly params: unknown;
  readonly sessionId?: string;
}

export type HermesGatewayNotificationListener = (
  notification: HermesGatewayNotification,
) => void | Promise<void>;
export type HermesGatewayCrashListener = (error: HermesGatewayError) => void | Promise<void>;

export type HermesGatewayProcess = EventEmitter & {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
};

export interface HermesGatewayClientOptions {
  readonly process: HermesGatewayProcess;
  readonly terminate: () => Promise<void>;
  readonly readyTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

interface PendingRequest {
  readonly method: HermesGatewayRequestMethod;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  sent: boolean;
}

interface OutboundFrame {
  readonly id: number;
  readonly bytes: Buffer;
}

interface ActiveWrite {
  readonly token: symbol;
  readonly frame: OutboundFrame;
  callbackDone: boolean;
  drainDone: boolean;
  writeReturned: boolean;
  drainListener: (() => void) | undefined;
}

type GatewayState = "waiting" | "ready" | "fatal" | "disposed";

export class HermesGatewayClient {
  private readonly child: HermesGatewayProcess;
  private readonly terminateProcess: () => Promise<void>;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly outboundQueue: OutboundFrame[] = [];
  private readonly notificationListeners = new Set<HermesGatewayNotificationListener>();
  private readonly crashListeners = new Set<HermesGatewayCrashListener>();
  private readonly readyPromise: Promise<void>;
  private readonly codec = new HermesGatewayNdjsonCodec();
  private resolveReady!: () => void;
  private rejectReady!: (error: HermesGatewayError) => void;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;
  private inboundChunks: Buffer[] = [];
  private queuedOutboundBytes = 0;
  private inFlightOutboundBytes = 0;
  private activeWrite: ActiveWrite | undefined;
  private reservedRequestCount = 0;
  private nextRequestId = 1;
  private state: GatewayState = "waiting";
  private fatalError: HermesGatewayError | undefined;
  private disposalPromise: Promise<void> | undefined;
  private terminationPromise: Promise<void> | undefined;
  private listenersAttached = false;
  private processingInbound = false;

  constructor(options: HermesGatewayClientOptions) {
    const readyTimeoutMs = boundedTimeout(
      options.readyTimeoutMs,
      HERMES_GATEWAY_READY_TIMEOUT_MS,
      HERMES_GATEWAY_MAX_READY_TIMEOUT_MS,
    );
    this.requestTimeoutMs = boundedTimeout(
      options.requestTimeoutMs,
      HERMES_GATEWAY_REQUEST_TIMEOUT_MS,
      HERMES_GATEWAY_MAX_REQUEST_TIMEOUT_MS,
    );
    this.child = options.process;
    this.terminateProcess = options.terminate;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.readyPromise.catch(() => {});
    this.attachListeners();
    this.readyTimer = setTimeout(() => {
      this.fail("HERMES_GATEWAY_READY_TIMEOUT");
    }, readyTimeoutMs);
  }

  ready(): Promise<void> {
    if (this.state === "disposed") {
      return Promise.reject(new HermesGatewayError("HERMES_GATEWAY_DISPOSED"));
    }
    if (this.state === "fatal") {
      return Promise.reject(this.fatalError);
    }
    return this.readyPromise;
  }

  async request<TMethod extends HermesGatewayRequestMethod>(
    method: TMethod,
    params: HermesGatewayRequestParams<TMethod>,
  ): Promise<HermesGatewayRequestResult<TMethod>> {
    if (!isHermesGatewayRequestMethod(method)) {
      throw new HermesGatewayError("HERMES_GATEWAY_METHOD_DISALLOWED");
    }
    this.throwIfUnavailable();
    if (this.pending.size + this.reservedRequestCount >= HERMES_GATEWAY_MAX_PENDING_REQUESTS) {
      this.fail("HERMES_GATEWAY_BACKPRESSURE");
      throw this.fatalError;
    }

    const id = this.nextRequestId;
    if (!Number.isSafeInteger(id)) {
      this.fail("HERMES_GATEWAY_PROTOCOL");
      throw this.fatalError;
    }
    this.nextRequestId += 1;
    this.reservedRequestCount += 1;
    let reservationHeld = true;
    try {
      if (!isValidHermesGatewayRequestParams(method, params)) {
        this.throwIfUnavailable();
        throw new HermesGatewayError("HERMES_GATEWAY_INVALID_PARAMS");
      }
      this.throwIfUnavailable();

      let serialized: string;
      try {
        serialized = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      } catch {
        this.throwIfUnavailable();
        throw new HermesGatewayError("HERMES_GATEWAY_PROTOCOL");
      }
      this.throwIfUnavailable();
      let serializedParams: unknown;
      try {
        const wireRequest = JSON.parse(serialized) as unknown;
        serializedParams = isGatewayRecord(wireRequest) ? wireRequest.params : undefined;
      } catch {
        throw new HermesGatewayError("HERMES_GATEWAY_PROTOCOL");
      }
      if (!isValidHermesGatewayRequestParams(method, serializedParams)) {
        this.throwIfUnavailable();
        throw new HermesGatewayError("HERMES_GATEWAY_INVALID_PARAMS");
      }
      const frame = Buffer.from(`${serialized}\n`, "utf8");
      if (frame.length > HERMES_GATEWAY_MAX_FRAME_BYTES) {
        throw new HermesGatewayError("HERMES_GATEWAY_FRAME_TOO_LARGE");
      }
      if (
        this.inFlightOutboundBytes + this.queuedOutboundBytes + frame.length >
        HERMES_GATEWAY_MAX_QUEUED_BYTES
      ) {
        this.fail("HERMES_GATEWAY_BACKPRESSURE");
        throw this.fatalError;
      }

      let resolveResponse!: (result: unknown) => void;
      let rejectResponse!: (error: Error) => void;
      const response = new Promise<unknown>((resolve, reject) => {
        resolveResponse = resolve;
        rejectResponse = reject;
      });
      const timer = setTimeout(() => {
        this.fail("HERMES_GATEWAY_REQUEST_TIMEOUT");
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        method,
        resolve: resolveResponse,
        reject: rejectResponse,
        timer,
        sent: false,
      });
      this.reservedRequestCount -= 1;
      reservationHeld = false;
      this.outboundQueue.push({ id, bytes: frame });
      this.queuedOutboundBytes += frame.length;
      this.flushOutbound();
      return response as Promise<HermesGatewayRequestResult<TMethod>>;
    } finally {
      if (reservationHeld) {
        this.reservedRequestCount -= 1;
      }
    }
  }

  subscribe(listener: HermesGatewayNotificationListener): () => void {
    this.throwIfUnavailable();
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  onCrash(listener: HermesGatewayCrashListener): () => void {
    if (this.state === "fatal" || this.state === "disposed") {
      return () => {};
    }
    this.crashListeners.add(listener);
    return () => {
      this.crashListeners.delete(listener);
    };
  }

  dispose(): Promise<void> {
    if (this.disposalPromise) return this.disposalPromise;

    let resolveDisposal!: () => void;
    let rejectDisposal!: (error: unknown) => void;
    this.disposalPromise = new Promise<void>((resolve, reject) => {
      resolveDisposal = resolve;
      rejectDisposal = reject;
    });
    void this.disposeOnce().then(resolveDisposal, rejectDisposal);
    return this.disposalPromise;
  }

  private async disposeOnce(): Promise<void> {
    this.state = "disposed";
    this.clearReadyTimer();
    const error = new HermesGatewayError("HERMES_GATEWAY_DISPOSED");
    this.rejectReady(error);
    this.rejectPending(error);
    this.notificationListeners.clear();
    this.crashListeners.clear();
    this.codec.reset();
    this.clearInboundQueue();
    this.clearOutboundQueue();
    try {
      this.child.stdin.end();
    } catch {
      // Intentional shutdown remains intentional even if stdin was already unavailable.
    }
    await this.terminateOnce();
    this.detachListeners();
  }

  private attachListeners(): void {
    this.child.stdout.on("data", this.onStdoutData);
    this.child.stdout.on("error", this.onStreamError);
    this.child.stderr.on("data", this.onStderrData);
    this.child.stderr.on("error", this.onStreamError);
    this.child.stdin.on("error", this.onStreamError);
    this.child.on("error", this.onChildFailure);
    this.child.on("exit", this.onChildFailure);
    this.child.on("close", this.onChildFailure);
    this.listenersAttached = true;
  }

  private detachListeners(): void {
    if (!this.listenersAttached) return;
    this.listenersAttached = false;
    this.child.stdout.removeListener("data", this.onStdoutData);
    this.child.stdout.removeListener("error", this.onStreamError);
    this.child.stderr.removeListener("data", this.onStderrData);
    this.child.stderr.removeListener("error", this.onStreamError);
    this.child.stdin.removeListener("error", this.onStreamError);
    this.child.removeListener("error", this.onChildFailure);
    this.child.removeListener("exit", this.onChildFailure);
    this.child.removeListener("close", this.onChildFailure);
  }

  private readonly onStdoutData = (chunk: unknown): void => {
    if (this.isTerminal()) return;
    let bytes: Buffer;
    if (Buffer.isBuffer(chunk)) {
      bytes = Buffer.from(chunk);
    } else if (typeof chunk === "string") {
      bytes = Buffer.from(chunk, "utf8");
    } else if (chunk instanceof Uint8Array) {
      bytes = Buffer.from(chunk);
    } else {
      this.fail("HERMES_GATEWAY_PROTOCOL");
      return;
    }

    this.inboundChunks.push(bytes);
    if (this.processingInbound) return;
    this.processingInbound = true;
    try {
      while (!this.isTerminal()) {
        const nextChunk = this.inboundChunks.shift();
        if (!nextChunk) break;
        this.processInboundChunk(nextChunk);
      }
    } finally {
      this.processingInbound = false;
      if (this.isTerminal()) this.clearInboundQueue();
    }
  };

  private processInboundChunk(bytes: Buffer): void {
    try {
      this.codec.push(bytes, (message) => {
        this.handleMessage(message);
        return !this.isTerminal();
      });
    } catch {
      this.fail("HERMES_GATEWAY_PROTOCOL");
    }
  }

  private readonly onStderrData = (_chunk: unknown): void => {
    // Drain only. Hermes stderr is never retained, logged, or reflected in errors.
  };

  private readonly onStreamError = (): void => {
    this.fail("HERMES_GATEWAY_CRASHED", true);
  };

  private readonly onChildFailure = (): void => {
    this.fail("HERMES_GATEWAY_CRASHED", true);
  };

  private handleMessage(value: Record<string, unknown>): void {
    const hasId = Object.hasOwn(value, "id");
    const hasMethod = Object.hasOwn(value, "method");
    const hasResult = Object.hasOwn(value, "result");
    const hasError = Object.hasOwn(value, "error");
    if (!hasId && hasMethod && !hasResult && !hasError) {
      this.handleNotification(value);
      return;
    }
    if (hasId && !hasMethod && hasResult !== hasError) {
      this.handleResponse(value, hasError);
      return;
    }
    this.fail("HERMES_GATEWAY_PROTOCOL");
  }

  private handleNotification(message: Record<string, unknown>): void {
    if (message.method !== "event" || !isGatewayRecord(message.params)) {
      this.fail("HERMES_GATEWAY_PROTOCOL");
      return;
    }
    const event = message.params;
    if (
      typeof event.type !== "string" ||
      event.type.length === 0 ||
      (event.session_id !== undefined && typeof event.session_id !== "string")
    ) {
      this.fail("HERMES_GATEWAY_PROTOCOL");
      return;
    }
    if (
      event.type === "gateway.ready" &&
      (!Object.hasOwn(event, "payload") || !isGatewayRecord(event.payload))
    ) {
      this.fail("HERMES_GATEWAY_PROTOCOL");
      return;
    }
    if (event.type === "gateway.ready" && this.state === "waiting") {
      this.state = "ready";
      this.clearReadyTimer();
      this.resolveReady();
      this.flushOutbound();
    }

    const notification: HermesGatewayNotification = {
      method: event.type,
      params: event.payload,
      ...(typeof event.session_id === "string" ? { sessionId: event.session_id } : {}),
    };
    for (const listener of [...this.notificationListeners]) {
      invokeObserver(listener, notification);
    }
  }

  private handleResponse(message: Record<string, unknown>, hasError: boolean): void {
    if (!Number.isSafeInteger(message.id) || (message.id as number) <= 0) {
      this.fail("HERMES_GATEWAY_PROTOCOL");
      return;
    }
    const id = message.id as number;
    const pending = this.pending.get(id);
    if (!pending) {
      this.fail("HERMES_GATEWAY_PROTOCOL");
      return;
    }
    if (!pending.sent) {
      this.fail("HERMES_GATEWAY_PROTOCOL");
      return;
    }
    if (hasError && !isValidRemoteError(message.error)) {
      this.fail("HERMES_GATEWAY_PROTOCOL");
      return;
    }
    if (!hasError && !isValidHermesGatewayRequestResult(pending.method, message.result)) {
      this.fail("HERMES_GATEWAY_PROTOCOL");
      return;
    }

    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (hasError) {
      pending.reject(new HermesGatewayRemoteError((message.error as { code: number }).code));
    } else {
      pending.resolve(message.result);
    }
  }

  private throwIfUnavailable(): void {
    if (this.state === "disposed") {
      throw new HermesGatewayError("HERMES_GATEWAY_DISPOSED");
    }
    if (this.state === "fatal") {
      throw this.fatalError;
    }
  }

  private isTerminal(): boolean {
    return this.state === "fatal" || this.state === "disposed";
  }

  private fail(code: HermesGatewayErrorCode, emitCrash = false): void {
    if (this.state === "fatal" || this.state === "disposed") return;
    const error = new HermesGatewayError(code);
    this.state = "fatal";
    this.fatalError = error;
    this.clearReadyTimer();
    this.rejectReady(error);
    this.rejectPending(error);
    this.notificationListeners.clear();
    this.codec.reset();
    this.clearInboundQueue();
    this.clearOutboundQueue();
    if (emitCrash) {
      for (const listener of [...this.crashListeners]) {
        invokeObserver(listener, error);
      }
    }
    this.crashListeners.clear();
    void this.terminateOnce().then(
      () => this.detachListeners(),
      () => {
        // Keep protection listeners attached when termination cannot be confirmed.
      },
    );
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private clearReadyTimer(): void {
    if (this.readyTimer === undefined) return;
    clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
  }

  private clearInboundQueue(): void {
    this.inboundChunks = [];
  }

  private clearOutboundQueue(): void {
    const active = this.activeWrite;
    if (active?.drainListener) {
      this.child.stdin.removeListener("drain", active.drainListener);
    }
    this.activeWrite = undefined;
    this.outboundQueue.length = 0;
    this.queuedOutboundBytes = 0;
    this.inFlightOutboundBytes = 0;
  }

  private flushOutbound(): void {
    if (this.state !== "ready" || this.activeWrite) return;
    const frame = this.outboundQueue.shift();
    if (!frame) return;
    this.queuedOutboundBytes -= frame.bytes.length;
    const pending = this.pending.get(frame.id);
    if (!pending || pending.sent) {
      this.fail("HERMES_GATEWAY_PROTOCOL");
      return;
    }

    const active: ActiveWrite = {
      token: Symbol("hermes-gateway-write"),
      frame,
      callbackDone: false,
      drainDone: false,
      writeReturned: false,
      drainListener: undefined,
    };
    const drainListener = () => this.onWriteDrain(active);
    active.drainListener = drainListener;
    this.activeWrite = active;
    this.inFlightOutboundBytes = frame.bytes.length;
    pending.sent = true;
    this.child.stdin.once("drain", drainListener);

    let accepted: boolean;
    try {
      accepted = this.child.stdin.write(frame.bytes, (error) => {
        this.onWriteCallback(active, error);
      });
    } catch {
      if (this.isCurrentWrite(active) && !this.isTerminal()) {
        this.fail("HERMES_GATEWAY_CRASHED", true);
      }
      return;
    }
    if (!this.isCurrentWrite(active) || this.isTerminal()) return;

    active.writeReturned = true;
    if (accepted) {
      if (active.drainListener) {
        this.child.stdin.removeListener("drain", active.drainListener);
        active.drainListener = undefined;
      }
      active.drainDone = true;
    }
    this.finishActiveWriteIfReady(active);
  }

  private onWriteCallback(active: ActiveWrite, error: Error | null | undefined): void {
    if (!this.isCurrentWrite(active) || this.isTerminal()) return;
    if (error) {
      this.fail("HERMES_GATEWAY_CRASHED", true);
      return;
    }
    active.callbackDone = true;
    this.finishActiveWriteIfReady(active);
  }

  private onWriteDrain(active: ActiveWrite): void {
    if (!this.isCurrentWrite(active) || this.isTerminal()) return;
    active.drainListener = undefined;
    active.drainDone = true;
    this.finishActiveWriteIfReady(active);
  }

  private finishActiveWriteIfReady(active: ActiveWrite): void {
    if (
      !this.isCurrentWrite(active) ||
      this.isTerminal() ||
      !active.writeReturned ||
      !active.callbackDone ||
      !active.drainDone
    ) {
      return;
    }
    if (active.drainListener) {
      this.child.stdin.removeListener("drain", active.drainListener);
    }
    this.activeWrite = undefined;
    this.inFlightOutboundBytes = 0;
    this.flushOutbound();
  }

  private isCurrentWrite(active: ActiveWrite): boolean {
    return this.activeWrite?.token === active.token;
  }

  private terminateOnce(): Promise<void> {
    this.terminationPromise ??= Promise.resolve()
      .then(() => this.terminateProcess())
      .catch(() => {
        throw new HermesGatewayError("HERMES_GATEWAY_CLEANUP");
      });
    return this.terminationPromise;
  }
}

function boundedTimeout(value: number | undefined, fallback: number, maximum: number): number {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > maximum) {
    throw new RangeError("Hermes gateway timeout must be a bounded positive integer");
  }
  return timeout;
}

function isValidRemoteError(value: unknown): value is { readonly code: number } {
  return (
    isGatewayRecord(value) && Number.isSafeInteger(value.code) && typeof value.message === "string"
  );
}

function remoteErrorCategory(code: number): HermesGatewayRemoteErrorCategory {
  switch (code) {
    case -32700:
      return "parse_error";
    case -32600:
      return "invalid_request";
    case -32601:
      return "method_not_found";
    case -32602:
      return "invalid_params";
    case -32603:
      return "internal_error";
    default:
      return "server_error";
  }
}

function invokeObserver<T>(listener: (value: T) => void | Promise<void>, value: T): void {
  try {
    void Promise.resolve(listener(value)).catch(() => {});
  } catch {
    // One observer must not corrupt the gateway connection or cleanup path.
  }
}
