import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

export type ProviderApiMode = "chat_completions" | "codex_responses";

export interface ProviderResponseSanitizer {
  /**
   * Dynamic, additional printable-ASCII sensitive values (at least 8 bytes) discovered while
   * dispatching. Real long-lived provider credentials must come from the mandatory
   * ProviderCredentialLease instead. Matching is byte-exact, and a non-empty list disables
   * streaming in this foundation slice.
   */
  readonly secrets: readonly string[];
}

export interface ProviderDispatchJsonResult {
  readonly kind: "json";
  readonly body: unknown;
  readonly sanitizer?: ProviderResponseSanitizer;
}

export interface ProviderDispatchStreamResult {
  readonly kind: "stream";
  readonly body: AsyncIterable<Uint8Array>;
  readonly sanitizer?: ProviderResponseSanitizer;
}

export interface ProviderDispatchRequest {
  readonly profileId: string;
  readonly model: string;
  readonly apiMode: ProviderApiMode;
  readonly body: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}

export type ProviderDispatcher = (
  request: ProviderDispatchRequest,
) => Promise<ProviderDispatchJsonResult | ProviderDispatchStreamResult>;

export interface ProviderBrokerOptions {
  readonly closeGraceMs?: number;
  readonly dispatcher: ProviderDispatcher;
  readonly maxConcurrentRequests?: number;
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
}

export interface ProviderBrokerEndpoint {
  readonly host: "127.0.0.1";
  readonly port: number;
}

export class ProviderBrokerError extends Error {
  constructor(
    message:
      | "Provider broker configuration is invalid"
      | "Provider broker is closed"
      | "Provider capability registry is full"
      | "Provider capability is invalid"
      | "Provider broker failed to bind",
  ) {
    super(message);
    this.name = "ProviderBrokerError";
  }
}

export interface ProviderCapabilityInput {
  readonly taskId: string;
  readonly runId: string;
  readonly profileId: string;
  readonly model: string;
  readonly apiMode: ProviderApiMode;
  readonly ttlMs: number;
}

export interface ProviderCredentialLease {
  /**
   * The mandatory source of every real long-lived provider credential used by the dispatcher.
   * Pass an explicit empty lease when none are used. A non-empty lease disables streaming in this
   * foundation slice.
   */
  readonly secrets: readonly string[];
}

export interface IssuedProviderCapability {
  readonly capabilityId: string;
  readonly token: string;
  readonly expiresAt: number;
}

interface CapabilityRecord extends ProviderCapabilityInput {
  readonly capabilityId: string;
  readonly credentialSecrets: readonly string[];
  readonly expiresAtMs: number;
  readonly activeControllers: Set<AbortController>;
  revoked: boolean;
}

const ROUTE_MODES = new Map<string, ProviderApiMode>([
  ["/v1/chat/completions", "chat_completions"],
  ["/v1/responses", "codex_responses"],
]);
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_REQUEST_HEADER_BYTES = 16 * 1024;
const MAX_REQUEST_HEADERS = 32;
const MAX_CAPABILITY_RECORDS = 256;
const CAPABILITY_TOMBSTONE_MS = 30_000;
const MAX_SANITIZER_SECRETS = 16;
const MIN_SANITIZER_SECRET_BYTES = 8;
const MAX_SANITIZER_SECRET_BYTES = 1_024;
const MAX_SANITIZER_TOTAL_BYTES = 8_192;
const MAX_SSE_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_SSE_LINE_BYTES = 4 * 1024 * 1024;
const MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_STREAM_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_JSON_LEAF_STRINGS = 4_096;
const MAX_JSON_LEAF_CHARACTERS = 4 * 1024 * 1024;
const MAX_JSON_SPLIT_OPERATIONS = 1_000_000;
const NATIVE_REQUEST_TIMEOUT_BUFFER_MS = 10_000;
const REDACTION_TEXT = "[REDACTED]";
const STREAM_RETURN_GRACE_MS = 100;

interface ValidatedJsonDispatchResult {
  readonly kind: "json";
  readonly body: unknown;
  readonly sanitizerSecrets: readonly string[];
}

interface ValidatedStreamDispatchResult {
  readonly kind: "stream";
  readonly iterator: StreamIteratorSnapshot;
  readonly sanitizerSecrets: readonly string[];
}

type ValidatedDispatchResult = ValidatedJsonDispatchResult | ValidatedStreamDispatchResult;

interface StreamIteratorSnapshot {
  readonly receiver: object;
  readonly next: (this: object) => unknown;
  readonly returnMethod: ((this: object) => unknown) | undefined;
}

type StreamStepSnapshot =
  | { readonly done: true; readonly value: undefined }
  | { readonly done: false; readonly value: Uint8Array };

class ProviderRequestBodyError extends Error {
  constructor(readonly category: "invalid_json" | "payload_too_large") {
    super("Provider request body refused");
  }
}

export class ProviderBroker {
  private readonly server: Server;
  private readonly dispatcher: ProviderDispatcher;
  private readonly closeGraceMs: number;
  private readonly maxConcurrentRequests: number;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;
  private readonly capabilitiesByDigest = new Map<string, CapabilityRecord>();
  private readonly digestByCapabilityId = new Map<string, string>();
  private readonly activeHandlers = new Set<Promise<void>>();
  private activeRequestCount = 0;
  private endpoint: ProviderBrokerEndpoint | undefined;
  private closing = false;
  private poisoned = false;
  private startPromise: Promise<ProviderBrokerEndpoint> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(options: ProviderBrokerOptions) {
    const closeGraceMs = options.closeGraceMs ?? 500;
    const maxConcurrentRequests = options.maxConcurrentRequests ?? 8;
    const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    if (
      !Number.isSafeInteger(closeGraceMs) ||
      closeGraceMs <= 0 ||
      closeGraceMs > 5_000 ||
      !Number.isSafeInteger(maxConcurrentRequests) ||
      maxConcurrentRequests <= 0 ||
      maxConcurrentRequests > 64 ||
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs <= 0 ||
      requestTimeoutMs > 300_000
    ) {
      throw new ProviderBrokerError("Provider broker configuration is invalid");
    }
    this.closeGraceMs = closeGraceMs;
    this.dispatcher = options.dispatcher;
    this.maxConcurrentRequests = maxConcurrentRequests;
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = requestTimeoutMs;
    this.server = createServer(
      {
        headersTimeout: 5_000,
        keepAliveTimeout: 1_000,
        maxHeaderSize: MAX_REQUEST_HEADER_BYTES,
        requestTimeout: requestTimeoutMs + NATIVE_REQUEST_TIMEOUT_BUFFER_MS,
      },
      (request, response) => {
        const handling = this.handleRequest(request, response).catch(() => {
          try {
            if (!response.headersSent && !response.destroyed) {
              writeError(response, 500, "internal", false, "Provider broker request failed");
            } else if (!response.destroyed) {
              response.destroy();
            }
          } catch {
            if (!response.destroyed) response.destroy();
          }
        });
        this.activeHandlers.add(handling);
        void handling.then(
          () => this.activeHandlers.delete(handling),
          () => this.activeHandlers.delete(handling),
        );
      },
    );
    this.server.maxHeadersCount = MAX_REQUEST_HEADERS;
    this.server.on("clientError", (error, socket) => {
      writeParserError(socket, (error as NodeJS.ErrnoException).code === "HPE_HEADER_OVERFLOW");
    });
  }

  start(): Promise<ProviderBrokerEndpoint> {
    if (this.closing || this.poisoned) {
      return Promise.reject(new ProviderBrokerError("Provider broker is closed"));
    }
    if (this.endpoint && this.server.listening) return Promise.resolve(this.endpoint);
    if (this.activeHandlers.size > 0) {
      return Promise.reject(new ProviderBrokerError("Provider broker is closed"));
    }
    if (this.startPromise) return this.startPromise;
    const promise = this.startOnce();
    this.startPromise = promise;
    void promise.then(
      () => {
        if (this.startPromise === promise) this.startPromise = undefined;
      },
      () => {
        if (this.startPromise === promise) this.startPromise = undefined;
      },
    );
    return promise;
  }

  private async startOnce(): Promise<ProviderBrokerEndpoint> {
    await new Promise<void>((resolve, reject) => {
      const onError = (): void => {
        this.server.off("listening", onListening);
        reject(new ProviderBrokerError("Provider broker failed to bind"));
      };
      const onListening = (): void => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(0, "127.0.0.1");
    });

    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new ProviderBrokerError("Provider broker failed to bind");
    }
    this.endpoint = { host: "127.0.0.1", port: address.port };
    return this.endpoint;
  }

  issue(
    input: ProviderCapabilityInput,
    credentialLease: ProviderCredentialLease,
  ): IssuedProviderCapability {
    if (this.closing || this.poisoned) {
      throw new ProviderBrokerError("Provider broker is closed");
    }
    const capability = snapshotCapabilityInput(input);
    const credentialSecrets = snapshotCredentialLease(credentialLease);
    if (!capability || !credentialSecrets) {
      throw new ProviderBrokerError("Provider capability is invalid");
    }
    const now = this.now();
    this.pruneCapabilities(now);
    if (this.capabilitiesByDigest.size >= MAX_CAPABILITY_RECORDS) {
      throw new ProviderBrokerError("Provider capability registry is full");
    }
    const token = randomBytes(32).toString("base64url");
    const capabilityId = randomUUID();
    const expiresAtMs = now + capability.ttlMs;
    const digest = digestToken(token);
    this.capabilitiesByDigest.set(digest, {
      ...capability,
      capabilityId,
      credentialSecrets,
      expiresAtMs,
      activeControllers: new Set(),
      revoked: false,
    });
    this.digestByCapabilityId.set(capabilityId, digest);
    return { capabilityId, token, expiresAt: Math.floor(expiresAtMs / 1_000) };
  }

  revoke(capabilityId: string): void {
    const digest = this.digestByCapabilityId.get(capabilityId);
    if (!digest) return;
    const capability = this.capabilitiesByDigest.get(digest);
    if (capability) revokeCapability(capability);
  }

  revokeTask(taskId: string): void {
    for (const capability of this.capabilitiesByDigest.values()) {
      if (capability.taskId === taskId) revokeCapability(capability);
    }
  }

  private pruneCapabilities(now: number): void {
    for (const [digest, capability] of this.capabilitiesByDigest) {
      if (
        capability.activeControllers.size === 0 &&
        now >= capability.expiresAtMs + CAPABILITY_TOMBSTONE_MS
      ) {
        this.capabilitiesByDigest.delete(digest);
        this.digestByCapabilityId.delete(capability.capabilityId);
      }
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    for (const capability of this.capabilitiesByDigest.values()) {
      revokeCapability(capability);
    }
    const promise = this.closeOnce(this.startPromise);
    this.closePromise = promise;
    void promise.then(
      () => this.finishClose(promise),
      () => this.finishClose(promise),
    );
    return promise;
  }

  private async closeOnce(
    pendingStart: Promise<ProviderBrokerEndpoint> | undefined,
  ): Promise<void> {
    await pendingStart?.catch(() => undefined);
    if (this.server.listening) {
      await new Promise<void>((resolve) => {
        const forceTimer = setTimeout(() => {
          this.server.closeAllConnections();
        }, this.closeGraceMs);
        this.server.close(() => {
          clearTimeout(forceTimer);
          resolve();
        });
      });
    }
    const handlersSettled = await settleWithin([...this.activeHandlers], this.closeGraceMs);
    if (!handlersSettled || this.activeHandlers.size > 0) this.poisoned = true;
    this.capabilitiesByDigest.clear();
    this.digestByCapabilityId.clear();
  }

  private finishClose(promise: Promise<void>): void {
    if (this.closePromise === promise) this.closePromise = undefined;
    this.endpoint = undefined;
    this.closing = false;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.closing) {
      request.resume();
      writeError(response, 503, "broker_closing", true, "Provider broker is closing");
      return;
    }
    const mode = request.url ? ROUTE_MODES.get(request.url) : undefined;
    if (!mode) {
      writeError(response, 404, "route_not_found", false, "Provider route not found");
      return;
    }
    if (request.method !== "POST") {
      writeError(response, 405, "method_not_allowed", false, "Provider method not allowed");
      return;
    }
    const token = bearerToken(request.headers.authorization);
    const capability = token ? this.capabilitiesByDigest.get(digestToken(token)) : undefined;
    if (!token || !capability) {
      writeError(response, 401, "unauthorized", false, "Provider capability required");
      return;
    }
    if (capability.revoked) {
      writeError(response, 401, "capability_revoked", false, "Provider capability revoked");
      return;
    }
    if (this.now() >= capability.expiresAtMs) {
      writeError(response, 401, "capability_expired", false, "Provider capability expired");
      return;
    }
    if (capability.apiMode !== mode) {
      writeError(response, 403, "capability_scope_mismatch", false, "Provider capability refused");
      return;
    }
    if (this.activeRequestCount >= this.maxConcurrentRequests) {
      request.resume();
      writeError(response, 429, "broker_busy", true, "Provider broker is busy");
      return;
    }
    this.activeRequestCount += 1;
    const controller = new AbortController();
    const externalOperations = new ExternalOperationTracker();
    capability.activeControllers.add(controller);
    let clientDisconnected = false;
    const abortForClientDisconnect = (): void => {
      if (response.writableEnded) return;
      clientDisconnected = true;
      controller.abort();
    };
    request.once("aborted", abortForClientDisconnect);
    response.once("close", abortForClientDisconnect);
    let expiredDuringRequest = false;
    let timedOut = false;
    const expiryTimer = setTimeout(
      () => {
        expiredDuringRequest = true;
        controller.abort();
      },
      Math.max(0, capability.expiresAtMs - this.now()),
    );
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);
    const writeAfterCleanup = (
      status: number,
      category: string,
      retryable: boolean,
      message: string,
    ): void => {
      if (clientDisconnected) return;
      if (this.closing) {
        writeError(response, 503, "broker_closing", true, "Provider broker is closing");
      } else if (capability.revoked) {
        writeError(response, 401, "capability_revoked", false, "Provider capability revoked");
      } else if (expiredDuringRequest || this.now() >= capability.expiresAtMs) {
        writeError(response, 401, "capability_expired", false, "Provider capability expired");
      } else if (timedOut) {
        writeError(response, 504, "request_timeout", true, "Provider request timed out");
      } else {
        writeError(response, status, category, retryable, message);
      }
    };
    try {
      const body = await readJsonBody(request, controller.signal);
      if (capability.revoked) {
        writeError(response, 401, "capability_revoked", false, "Provider capability revoked");
        return;
      }
      if (this.now() >= capability.expiresAtMs) {
        writeError(response, 401, "capability_expired", false, "Provider capability expired");
        return;
      }
      const streamField = body.stream;
      if (streamField !== undefined && typeof streamField !== "boolean") {
        writeError(response, 400, "invalid_request", false, "Provider request is invalid");
        return;
      }
      const requestExpectsStream = streamField === true;
      const leaseSecrets = uniqueSecrets(token, capability.credentialSecrets);
      if (jsonContainsProtectedValues(body, leaseSecrets)) {
        writeError(
          response,
          400,
          "sensitive_input",
          false,
          "Provider request contains a protected value",
        );
        return;
      }
      if (body.model !== capability.model) {
        writeError(
          response,
          403,
          "capability_scope_mismatch",
          false,
          "Provider capability refused",
        );
        return;
      }
      const dispatched = await raceWithAbort(
        externalOperations.track(
          this.dispatcher({
            profileId: capability.profileId,
            model: capability.model,
            apiMode: capability.apiMode,
            body,
            signal: controller.signal,
          }),
        ),
        controller.signal,
      );
      const result = validateDispatchResult(dispatched);
      if (!result) {
        throw new Error("Provider dispatcher result is invalid");
      }
      if (this.closing) {
        writeError(response, 503, "broker_closing", true, "Provider broker is closing");
        return;
      }
      if (capability.revoked) {
        writeError(response, 401, "capability_revoked", false, "Provider capability revoked");
        return;
      }
      if (this.now() >= capability.expiresAtMs) {
        writeError(response, 401, "capability_expired", false, "Provider capability expired");
        return;
      }
      if ((result.kind === "stream") !== requestExpectsStream) {
        controller.abort();
        if (result.kind === "stream") {
          await returnIteratorWithinGrace(result.iterator, externalOperations);
        }
        writeAfterCleanup(502, "dispatch_failed", true, "Provider request failed");
        return;
      }
      if (
        result.kind === "stream" &&
        (capability.credentialSecrets.length > 0 || result.sanitizerSecrets.length > 0)
      ) {
        controller.abort();
        await returnIteratorWithinGrace(result.iterator, externalOperations);
        writeAfterCleanup(
          422,
          "credentialed_stream_unsupported",
          false,
          "Credentialed provider streaming is not available",
        );
        return;
      }
      const sanitizerSecrets = uniqueSecrets(token, [
        ...capability.credentialSecrets,
        ...result.sanitizerSecrets,
      ]);
      if (result.kind === "stream") {
        const assertStreamAuthorized = (): void => {
          throwIfAborted(controller.signal);
          if (this.closing || capability.revoked || this.now() >= capability.expiresAtMs) {
            throw new Error("Provider stream authorization expired");
          }
        };
        await writeStream(
          response,
          result.iterator,
          controller.signal,
          sanitizerSecrets,
          externalOperations,
          assertStreamAuthorized,
        );
      } else {
        const serialized = redactSerializedJson(serializeJson(result.body), sanitizerSecrets);
        if (this.closing) {
          writeError(response, 503, "broker_closing", true, "Provider broker is closing");
          return;
        }
        if (capability.revoked) {
          writeError(response, 401, "capability_revoked", false, "Provider capability revoked");
          return;
        }
        if (this.now() >= capability.expiresAtMs) {
          writeError(response, 401, "capability_expired", false, "Provider capability expired");
          return;
        }
        writeSerializedJson(response, 200, serialized);
      }
    } catch (error) {
      if (clientDisconnected) {
        return;
      }
      if (response.headersSent) {
        if (!response.destroyed) response.destroy();
        return;
      }
      if (this.closing) {
        writeError(response, 503, "broker_closing", true, "Provider broker is closing");
      } else if (capability.revoked) {
        writeError(response, 401, "capability_revoked", false, "Provider capability revoked");
      } else if (expiredDuringRequest || this.now() >= capability.expiresAtMs) {
        writeError(response, 401, "capability_expired", false, "Provider capability expired");
      } else if (timedOut) {
        writeError(response, 504, "request_timeout", true, "Provider request timed out");
      } else if (
        error instanceof ProviderRequestBodyError &&
        error.category === "payload_too_large"
      ) {
        writeError(response, 413, "payload_too_large", false, "Provider request body is too large");
      } else if (error instanceof ProviderRequestBodyError) {
        writeError(response, 400, "invalid_json", false, "Provider request JSON is invalid");
      } else {
        writeError(response, 502, "dispatch_failed", true, "Provider request failed");
      }
    } finally {
      clearTimeout(timeout);
      clearTimeout(expiryTimer);
      request.off("aborted", abortForClientDisconnect);
      response.off("close", abortForClientDisconnect);
      await externalOperations.closeAndWait();
      capability.activeControllers.delete(controller);
      this.activeRequestCount -= 1;
    }
  }
}

class ExternalOperationTracker {
  private pending = 0;
  private closed = false;
  private resolveSettled!: () => void;
  private readonly settled = new Promise<void>((resolve) => {
    this.resolveSettled = resolve;
  });

  track<T>(operation: T | PromiseLike<T>): Promise<Awaited<T>> {
    if (this.closed) return Promise.reject(new Error("Provider operation tracker is closed"));
    this.pending += 1;
    const tracked = Promise.resolve(operation);
    void tracked.then(
      () => this.completeOne(),
      () => this.completeOne(),
    );
    return tracked;
  }

  closeAndWait(): Promise<void> {
    this.closed = true;
    if (this.pending === 0) this.resolveSettled();
    return this.settled;
  }

  private completeOne(): void {
    this.pending -= 1;
    if (this.closed && this.pending === 0) this.resolveSettled();
  }
}

function validateDispatchResult(value: unknown): ValidatedDispatchResult | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const result = value as { kind?: unknown; body?: unknown; sanitizer?: unknown };
  const kind = result.kind;
  const body = result.body;
  const sanitizer = result.sanitizer;
  const sanitizerSecrets = validateSanitizerSecrets(sanitizer);
  if (!sanitizerSecrets) return undefined;
  if (kind === "json") {
    return body === undefined ? undefined : { kind: "json", body, sanitizerSecrets };
  }
  if (kind !== "stream" || typeof body !== "object" || body === null) {
    return undefined;
  }
  const iterator = snapshotStreamIterator(body);
  if (!iterator) return undefined;
  return {
    kind: "stream",
    iterator,
    sanitizerSecrets,
  };
}

function snapshotStreamIterator(body: object): StreamIteratorSnapshot | undefined {
  const asyncIterator = (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator];
  if (typeof asyncIterator !== "function") return undefined;
  const receiver = asyncIterator.call(body) as unknown;
  if (typeof receiver !== "object" || receiver === null) return undefined;
  const candidate = receiver as { next?: unknown; return?: unknown };
  const next = candidate.next;
  const returnMethod = candidate.return;
  if (typeof next !== "function") return undefined;
  if (returnMethod !== undefined && typeof returnMethod !== "function") return undefined;
  return {
    receiver,
    next: next as (this: object) => unknown,
    returnMethod: returnMethod as ((this: object) => unknown) | undefined,
  };
}

function snapshotStreamStep(value: unknown): StreamStepSnapshot | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as { done?: unknown; value?: unknown };
  const done = candidate.done;
  const chunk = candidate.value;
  if (typeof done !== "boolean") return undefined;
  if (done) return { done: true, value: undefined };
  if (!(chunk instanceof Uint8Array)) return undefined;
  return { done: false, value: chunk };
}

function validateSanitizerSecrets(value: unknown): readonly string[] | undefined {
  if (value === undefined) return [];
  if (typeof value !== "object" || value === null) return undefined;
  const secrets = (value as { secrets?: unknown }).secrets;
  return validateCredentialSecrets(secrets);
}

function validateCredentialSecrets(secrets: unknown): readonly string[] | undefined {
  if (!Array.isArray(secrets)) return undefined;
  const length = secrets.length;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_SANITIZER_SECRETS) {
    return undefined;
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) snapshot.push(secrets[index]);
  const validated: string[] = [];
  let totalBytes = 0;
  for (const secret of snapshot) {
    if (
      typeof secret !== "string" ||
      !/^[\x21-\x7e]+$/.test(secret) ||
      REDACTION_TEXT.includes(secret)
    ) {
      return undefined;
    }
    const bytes = Buffer.byteLength(secret, "utf8");
    totalBytes += bytes;
    if (
      bytes < MIN_SANITIZER_SECRET_BYTES ||
      bytes > MAX_SANITIZER_SECRET_BYTES ||
      totalBytes > MAX_SANITIZER_TOTAL_BYTES
    ) {
      return undefined;
    }
    validated.push(secret);
  }
  return validated;
}

function revokeCapability(capability: CapabilityRecord): void {
  capability.revoked = true;
  for (const controller of capability.activeControllers) controller.abort();
}

function writeParserError(socket: Duplex, headersTooLarge: boolean): void {
  if (!socket.writable) return;
  const status = headersTooLarge ? 431 : 400;
  const body = JSON.stringify({
    error: headersTooLarge
      ? {
          category: "headers_too_large",
          retryable: false,
          message: "Provider request headers are too large",
        }
      : {
          category: "request_invalid",
          retryable: false,
          message: "Provider request is invalid",
        },
  });
  socket.end(
    `HTTP/1.1 ${status} ${headersTooLarge ? "Request Header Fields Too Large" : "Bad Request"}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: application/json; charset=utf-8\r\n" +
      "Cache-Control: no-store\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

function snapshotCapabilityInput(input: unknown): ProviderCapabilityInput | undefined {
  try {
    if (typeof input !== "object" || input === null) return undefined;
    const candidate = input as Record<string, unknown>;
    const taskId = candidate.taskId;
    const runId = candidate.runId;
    const profileId = candidate.profileId;
    const model = candidate.model;
    const apiMode = candidate.apiMode;
    const ttlMs = candidate.ttlMs;
    if (
      !isBoundedNonEmptyString(taskId, 256) ||
      !isBoundedNonEmptyString(runId, 256) ||
      !isBoundedNonEmptyString(profileId, 256) ||
      typeof model !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model) ||
      (apiMode !== "chat_completions" && apiMode !== "codex_responses") ||
      typeof ttlMs !== "number" ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1_000 ||
      ttlMs > 300_000
    ) {
      return undefined;
    }
    return { taskId, runId, profileId, model, apiMode, ttlMs };
  } catch {
    return undefined;
  }
}

function snapshotCredentialLease(value: unknown): readonly string[] | undefined {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const secrets = (value as { secrets?: unknown }).secrets;
    return validateCredentialSecrets(secrets);
  } catch {
    return undefined;
  }
}

function isBoundedNonEmptyString(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximumLength;
}

function jsonContainsSecrets(root: unknown, secrets: readonly string[]): boolean {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (secrets.some((secret) => value.includes(secret))) return true;
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    if (Array.isArray(value)) {
      for (const nested of value) pending.push(nested);
      continue;
    }
    for (const [key, nested] of Object.entries(value)) {
      if (secrets.some((secret) => key.includes(secret))) return true;
      pending.push(nested);
    }
  }
  return false;
}

function jsonContainsProtectedValues(root: unknown, secrets: readonly string[]): boolean {
  if (jsonContainsSecrets(root, secrets)) return true;
  try {
    rejectSplitSecretReassemblyInJson(root, secrets);
    return false;
  } catch {
    return true;
  }
}

function uniqueSecrets(localToken: string, additional: readonly string[]): readonly string[] {
  return [...new Set([localToken, ...additional])];
}

function redactSerializedJson(
  serialized: string,
  secrets: readonly string[],
  redactor = new LiteralSecretRedactor(secrets),
): string {
  assertBoundedUtf8(serialized, MAX_JSON_RESPONSE_BYTES);
  rejectSplitSecretReassembly(serialized, secrets);
  const output: string[] = [];
  let cursor = 0;
  while (cursor < serialized.length) {
    const start = serialized.indexOf('"', cursor);
    if (start < 0) break;
    output.push(serialized.slice(cursor, start));
    const end = jsonStringEnd(serialized, start);
    const decoded = JSON.parse(serialized.slice(start, end)) as unknown;
    if (typeof decoded !== "string") throw new Error("Provider JSON string is invalid");
    output.push(serializeJson(redactor.redact(decoded, MAX_JSON_RESPONSE_BYTES)));
    cursor = end;
  }
  output.push(serialized.slice(cursor));
  const redacted = output.join("");
  assertBoundedUtf8(redacted, MAX_JSON_RESPONSE_BYTES);
  return redacted;
}

function jsonStringEnd(serialized: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < serialized.length; index += 1) {
    const character = serialized[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      return index + 1;
    }
  }
  throw new Error("Provider JSON string is invalid");
}

class LiteralSecretRedactor {
  private readonly expression: RegExp;
  private readonly maxPasses: number;
  private readonly patterns: readonly string[];

  constructor(secrets: readonly string[]) {
    const patterns = [...new Set(secrets)].sort(
      (left, right) => right.length - left.length || left.localeCompare(right),
    );
    this.patterns = patterns;
    this.expression = new RegExp(patterns.map(escapeRegExp).join("|"), "g");
    this.maxPasses = patterns.length + 1;
  }

  redact(value: string, maximumBytes: number): string {
    let redacted = value;
    for (let pass = 0; pass < this.maxPasses; pass += 1) {
      this.expression.lastIndex = 0;
      if (!this.expression.test(redacted)) return redacted;
      this.expression.lastIndex = 0;
      redacted = redacted.replace(this.expression, REDACTION_TEXT);
      assertBoundedUtf8(redacted, maximumBytes);
    }
    throw new Error("Provider response redaction failed");
  }

  retainedSuffixLength(value: string): number {
    let longest = 0;
    for (const pattern of this.patterns) {
      const maximum = Math.min(value.length, pattern.length - 1);
      for (let length = maximum; length > longest; length -= 1) {
        if (suffixMatchesPrefix(value, pattern, length)) {
          longest = length;
          break;
        }
      }
    }
    return longest;
  }
}

function suffixMatchesPrefix(value: string, pattern: string, length: number): boolean {
  const offset = value.length - length;
  for (let index = 0; index < length; index += 1) {
    if (value.charCodeAt(offset + index) !== pattern.charCodeAt(index)) return false;
  }
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertBoundedUtf8(value: string, maximumBytes: number): void {
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new Error("Provider response is too large");
  }
}

function rejectSplitSecretReassembly(serialized: string, secrets: readonly string[]): void {
  rejectSplitSecretReassemblyInJson(JSON.parse(serialized) as unknown, secrets);
}

function rejectSplitSecretReassemblyInJson(root: unknown, secrets: readonly string[]): void {
  const leaves = collectJsonLeafStrings(root);
  let operations = 0;
  const consumeOperation = (): void => {
    operations += 1;
    if (operations > MAX_JSON_SPLIT_OPERATIONS) {
      throw new Error("Provider JSON secret analysis exceeded its budget");
    }
  };
  for (const secret of secrets) {
    const progress = new Set<number>();
    for (const leaf of leaves) {
      const prior = [...progress];
      const additions: number[] = [];
      for (const matched of prior) {
        consumeOperation();
        const remaining = secret.slice(matched);
        if (leaf.startsWith(remaining)) {
          throw new Error("Provider JSON response splits a protected value");
        }
        if (
          leaf.length > 0 &&
          matched + leaf.length < secret.length &&
          secret.startsWith(leaf, matched)
        ) {
          additions.push(matched + leaf.length);
        }
      }
      const maximumStart = Math.min(secret.length - 1, leaf.length);
      for (let length = 1; length <= maximumStart; length += 1) {
        consumeOperation();
        if (leaf.endsWith(secret.slice(0, length))) additions.push(length);
      }
      for (const matched of additions) progress.add(matched);
    }
  }
}

function collectJsonLeafStrings(root: unknown): readonly string[] {
  const leaves: string[] = [];
  const pending: unknown[] = [root];
  let characters = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      leaves.push(value);
      characters += value.length;
      if (leaves.length > MAX_JSON_LEAF_STRINGS || characters > MAX_JSON_LEAF_CHARACTERS) {
        throw new Error("Provider JSON leaf budget exceeded");
      }
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        pending.push(value[index]);
      }
      continue;
    }
    const entries = Object.entries(value);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry) continue;
      pending.push(entry[1]);
      pending.push(entry[0]);
    }
  }
  return leaves;
}

function writeError(
  response: ServerResponse,
  status: number,
  category: string,
  retryable: boolean,
  message: string,
): void {
  writeJson(response, status, { error: { category, retryable, message } });
}

function digestToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function bearerToken(value: string | undefined): string | undefined {
  const match = value?.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
  return match?.[1];
}

function readJsonBody(
  request: IncomingMessage,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const declaredLength = request.headers["content-length"];
  const declaredTooLarge =
    declaredLength !== undefined && Number.parseInt(declaredLength, 10) > MAX_REQUEST_BODY_BYTES;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let tooLarge = declaredTooLarge;
    let settled = false;
    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
      signal.removeEventListener("abort", onSignalAbort);
    };
    const fail = (error: ProviderRequestBodyError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer): void => {
      const buffer = Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        tooLarge = true;
      }
      if (!tooLarge) chunks.push(buffer);
    };
    const onEnd = (): void => {
      if (settled) return;
      if (tooLarge) {
        fail(new ProviderRequestBodyError("payload_too_large"));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      } catch {
        fail(new ProviderRequestBodyError("invalid_json"));
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        fail(new ProviderRequestBodyError("invalid_json"));
        return;
      }
      settled = true;
      cleanup();
      resolve(parsed as Record<string, unknown>);
    };
    const onError = (): void => fail(new ProviderRequestBodyError("invalid_json"));
    const onAborted = (): void => fail(new ProviderRequestBodyError("invalid_json"));
    const onSignalAbort = (): void => {
      request.pause();
      fail(new ProviderRequestBodyError("invalid_json"));
    };
    if (signal.aborted) {
      onSignalAbort();
      return;
    }
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
    signal.addEventListener("abort", onSignalAbort, { once: true });
  });
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  writeSerializedJson(response, status, serializeJson(body));
}

function serializeJson(body: unknown): string {
  const serialized = JSON.stringify(body);
  if (serialized === undefined) throw new Error("Provider JSON result is invalid");
  return serialized;
}

function writeSerializedJson(response: ServerResponse, status: number, serialized: string): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    connection: "close",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(serialized);
}

async function writeStream(
  response: ServerResponse,
  iterator: StreamIteratorSnapshot,
  signal: AbortSignal,
  secrets: readonly string[],
  externalOperations: ExternalOperationTracker,
  assertAuthorized: () => void,
): Promise<void> {
  const sanitizer = new ProviderStreamSanitizer(secrets);
  let completed = false;
  try {
    let step = await nextStreamStep(iterator, signal, externalOperations, assertAuthorized);
    let safeChunk: Buffer;
    while (true) {
      assertAuthorized();
      if (step.done) {
        safeChunk = sanitizer.finish();
        completed = true;
        break;
      }
      safeChunk = sanitizer.push(step.value);
      if (safeChunk.length > 0) break;
      step = await nextStreamStep(iterator, signal, externalOperations, assertAuthorized);
    }
    assertAuthorized();
    response.writeHead(200, {
      "cache-control": "no-store",
      connection: "close",
      "content-type": "text/event-stream; charset=utf-8",
    });
    await writeStreamChunk(response, safeChunk, signal, assertAuthorized);
    while (!step.done) {
      step = await nextStreamStep(iterator, signal, externalOperations, assertAuthorized);
      assertAuthorized();
      if (step.done) {
        assertAuthorized();
        safeChunk = sanitizer.finish();
        completed = true;
      } else {
        assertAuthorized();
        safeChunk = sanitizer.push(step.value);
      }
      assertAuthorized();
      await writeStreamChunk(response, safeChunk, signal, assertAuthorized);
    }
    assertAuthorized();
    response.end();
  } finally {
    if (!completed) await returnIteratorWithinGrace(iterator, externalOperations);
  }
}

async function nextStreamStep(
  iterator: StreamIteratorSnapshot,
  signal: AbortSignal,
  externalOperations: ExternalOperationTracker,
  assertAuthorized: () => void,
): Promise<StreamStepSnapshot> {
  assertAuthorized();
  const operation = iterator.next.call(iterator.receiver);
  const value = await raceWithAbort(externalOperations.track(operation), signal);
  const step = snapshotStreamStep(value);
  if (!step) throw new Error("Provider stream chunk is invalid");
  assertAuthorized();
  return step;
}

async function writeStreamChunk(
  response: ServerResponse,
  chunk: Buffer,
  signal: AbortSignal,
  assertAuthorized: () => void,
): Promise<void> {
  assertAuthorized();
  if (chunk.length === 0) return;
  const accepted = response.write(chunk);
  assertAuthorized();
  if (!accepted) {
    await waitForDrain(response, signal);
    assertAuthorized();
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Provider request aborted");
}

class ProviderStreamSanitizer {
  private readonly semantic: SseSemanticSanitizer;
  private readonly raw: StreamingSecretRedactor;
  private totalInputBytes = 0;
  private totalOutputBytes = 0;

  constructor(secrets: readonly string[]) {
    this.semantic = new SseSemanticSanitizer(secrets);
    this.raw = new StreamingSecretRedactor(secrets);
  }

  push(chunk: Uint8Array): Buffer {
    this.totalInputBytes += chunk.byteLength;
    if (this.totalInputBytes > MAX_STREAM_TOTAL_BYTES) {
      throw new Error("Provider stream input is too large");
    }
    const semanticOutput = this.semantic.push(chunk);
    if (semanticOutput.length === 0) return Buffer.alloc(0);
    return this.recordOutput(this.raw.push(semanticOutput));
  }

  finish(): Buffer {
    const semanticTail = this.semantic.finish();
    const redactedTail = this.raw.push(semanticTail);
    const finalTail = this.raw.finish();
    return this.recordOutput(Buffer.concat([redactedTail, finalTail]));
  }

  private recordOutput(output: Buffer): Buffer {
    this.totalOutputBytes += output.length;
    if (this.totalOutputBytes > MAX_STREAM_TOTAL_BYTES) {
      throw new Error("Provider stream output is too large");
    }
    return output;
  }
}

class SseSemanticSanitizer {
  private pending = Buffer.alloc(0);
  private pendingEvent: Buffer[] = [];
  private pendingEventBytes = 0;
  private firstLine = true;
  private eventHasData = false;
  private readonly secrets: readonly string[];
  private readonly semanticRedactor: LiteralSecretRedactor;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

  constructor(secrets: readonly string[]) {
    this.secrets = secrets;
    this.semanticRedactor = new LiteralSecretRedactor(secrets);
  }

  push(chunk: Uint8Array): Buffer {
    if (chunk.byteLength > MAX_SSE_CHUNK_BYTES) {
      throw new Error("Provider SSE chunk is too large");
    }
    const combined = Buffer.concat([this.pending, Buffer.from(chunk)]);
    const output: Buffer[] = [];
    let cursor = 0;
    let index = 0;
    while (index < combined.length) {
      const byte = combined[index];
      let lineEnd: number | undefined;
      if (byte === 0x0a) {
        lineEnd = index + 1;
      } else if (byte === 0x0d) {
        if (index + 1 >= combined.length) break;
        lineEnd = combined[index + 1] === 0x0a ? index + 2 : index + 1;
      }
      if (lineEnd === undefined) {
        index += 1;
        continue;
      }
      const line = combined.subarray(cursor, lineEnd);
      if (line.length > MAX_SSE_LINE_BYTES) {
        throw new Error("Provider SSE line is too large");
      }
      const sanitized = this.sanitizeLine(line);
      this.appendEventLine(sanitized.line);
      if (sanitized.endsEvent) output.push(this.takePendingEvent());
      cursor = lineEnd;
      index = lineEnd;
    }
    this.pending = Buffer.from(combined.subarray(cursor));
    if (this.pending.length > MAX_SSE_LINE_BYTES) {
      throw new Error("Provider SSE line is too large");
    }
    return output.length === 0 ? Buffer.alloc(0) : Buffer.concat(output);
  }

  finish(): Buffer {
    if (this.pending.length > 0) {
      if (this.pending.length > MAX_SSE_LINE_BYTES) {
        throw new Error("Provider SSE line is too large");
      }
      const sanitized = this.sanitizeLine(this.pending);
      this.appendEventLine(sanitized.line);
      this.pending = Buffer.alloc(0);
    }
    return this.pendingEvent.length === 0 ? Buffer.alloc(0) : this.takePendingEvent();
  }

  private sanitizeLine(line: Buffer): { readonly line: Buffer; readonly endsEvent: boolean } {
    let contentEnd = line.length;
    if (contentEnd > 0 && line[contentEnd - 1] === 0x0a) contentEnd -= 1;
    if (contentEnd > 0 && line[contentEnd - 1] === 0x0d) contentEnd -= 1;
    let contentBytes = line.subarray(0, contentEnd);
    if (this.firstLine) {
      this.firstLine = false;
      if (
        contentBytes.length >= 3 &&
        contentBytes[0] === 0xef &&
        contentBytes[1] === 0xbb &&
        contentBytes[2] === 0xbf
      ) {
        contentBytes = contentBytes.subarray(3);
      }
    }
    const content = this.decoder.decode(contentBytes);
    const ending = line.subarray(contentEnd);
    if (content.length === 0) {
      this.eventHasData = false;
      return { line: Buffer.from(line), endsEvent: true };
    }
    if (!content.startsWith("data:")) {
      return { line: Buffer.from(line), endsEvent: false };
    }
    if (this.eventHasData) throw new Error("Provider SSE event contains multiple data fields");
    this.eventHasData = true;
    const payloadStart = content[5] === " " ? 6 : 5;
    const payload = content.slice(payloadStart);
    let isJson = false;
    try {
      JSON.parse(payload);
      isJson = true;
    } catch {
      // Non-JSON SSE data (for example [DONE]) still receives raw byte redaction.
    }
    if (!isJson) return { line: Buffer.from(line), endsEvent: false };
    const sanitized = redactSerializedJson(payload, this.secrets, this.semanticRedactor);
    return {
      line: Buffer.concat([
        Buffer.from(content.slice(0, payloadStart) + sanitized, "utf8"),
        Buffer.from(ending),
      ]),
      endsEvent: false,
    };
  }

  private appendEventLine(line: Buffer): void {
    this.pendingEventBytes += line.length;
    if (this.pendingEventBytes > MAX_STREAM_TOTAL_BYTES) {
      throw new Error("Provider SSE event is too large");
    }
    this.pendingEvent.push(line);
  }

  private takePendingEvent(): Buffer {
    const event = Buffer.concat(this.pendingEvent, this.pendingEventBytes);
    this.pendingEvent = [];
    this.pendingEventBytes = 0;
    return event;
  }
}

class StreamingSecretRedactor {
  private readonly matcher: LiteralSecretRedactor;
  private pending = "";

  constructor(secrets: readonly string[]) {
    this.matcher = new LiteralSecretRedactor(secrets);
  }

  push(chunk: Uint8Array): Buffer {
    const combined = this.pending + Buffer.from(chunk).toString("utf8");
    const redacted = this.matcher.redact(combined, MAX_STREAM_TOTAL_BYTES);
    const retainedCharacters = this.matcher.retainedSuffixLength(redacted);
    let emittedCharacters = redacted.length - retainedCharacters;
    if (
      emittedCharacters > 0 &&
      emittedCharacters < redacted.length &&
      isHighSurrogate(redacted.charCodeAt(emittedCharacters - 1)) &&
      isLowSurrogate(redacted.charCodeAt(emittedCharacters))
    ) {
      emittedCharacters -= 1;
    }
    const output = Buffer.from(redacted.slice(0, emittedCharacters), "utf8");
    this.pending = redacted.slice(emittedCharacters);
    return output;
  }

  finish(): Buffer {
    return this.flushBoundary();
  }

  flushBoundary(): Buffer {
    const redacted = this.matcher.redact(this.pending, MAX_STREAM_TOTAL_BYTES);
    const output = Buffer.from(redacted, "utf8");
    this.pending = "";
    return output;
  }
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

async function returnIteratorWithinGrace(
  iterator: StreamIteratorSnapshot,
  externalOperations: ExternalOperationTracker,
): Promise<void> {
  const returnMethod = iterator.returnMethod;
  if (!returnMethod) return;
  let operation: unknown;
  try {
    operation = returnMethod.call(iterator.receiver);
  } catch {
    return;
  }
  const returned = externalOperations.track(operation).then(
    () => undefined,
    () => undefined,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, STREAM_RETURN_GRACE_MS);
  });
  await Promise.race([returned, grace]);
  if (timer !== undefined) clearTimeout(timer);
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Provider request aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(new Error("Provider request aborted"));
    };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function waitForDrain(response: ServerResponse, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("Provider request aborted"));
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      response.off("drain", onDrain);
      response.off("error", onFailure);
      response.off("close", onFailure);
      signal.removeEventListener("abort", onFailure);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onFailure = (): void => {
      cleanup();
      reject(new Error("Provider stream closed"));
    };
    response.once("drain", onDrain);
    response.once("error", onFailure);
    response.once("close", onFailure);
    signal.addEventListener("abort", onFailure, { once: true });
  });
}

async function settleWithin(
  promises: readonly Promise<void>[],
  timeoutMs: number,
): Promise<boolean> {
  if (promises.length === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const settled = await Promise.race([
    Promise.allSettled(promises).then(() => true as const),
    timeout,
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return settled;
}
