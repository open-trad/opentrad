import { Buffer } from "node:buffer";
import type { Writable } from "node:stream";
import type {
  HermesSidecarBinding,
  HermesSidecarCapabilityIssuer,
  HermesSidecarCapabilityLease,
} from "./sidecar-manager";

export interface HermesProviderProfileSecrets {
  readonly apiKey: string | null;
  readonly baseUrl: string | null;
}

export type HermesProviderProfileSecretSource = (
  binding: HermesSidecarBinding,
) => Promise<HermesProviderProfileSecrets>;

export interface HermesProviderCapabilityIssuerOptions {
  readonly acquireProfileSecrets: HermesProviderProfileSecretSource;
}

export class HermesProviderCapabilityError extends Error {
  constructor() {
    super("Hermes provider capability is unavailable");
    this.name = "HermesProviderCapabilityError";
  }
}

interface WritableOperations {
  readonly receiver: object;
  readonly destroy: (...args: readonly unknown[]) => unknown;
  readonly end: (...args: readonly unknown[]) => unknown;
  readonly off: (...args: readonly unknown[]) => unknown;
  readonly once: (...args: readonly unknown[]) => unknown;
}

const BINDING_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BINDING_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const API_KEY_PATTERN = /^[\x21-\x7e]{1,2048}$/;
const MAX_BASE_URL_LENGTH = 2_048;
const MAX_WIRE_BYTES = 4_096;

export function createHermesProviderCapabilityIssuer(
  options: HermesProviderCapabilityIssuerOptions,
): HermesSidecarCapabilityIssuer {
  try {
    if (!options || typeof options !== "object") throw new HermesProviderCapabilityError();
    const acquireProfileSecrets = requireFunction(
      Reflect.get(options as object, "acquireProfileSecrets"),
    );

    return async (binding) => {
      try {
        const frozenBinding = snapshotBinding(binding);
        const rawSecrets = await Reflect.apply(acquireProfileSecrets, undefined, [frozenBinding]);
        const secrets = snapshotProfileSecrets(rawSecrets, frozenBinding);
        const payload = createWirePayload(frozenBinding, secrets);
        return createCapabilityLease(payload);
      } catch {
        throw new HermesProviderCapabilityError();
      }
    };
  } catch {
    throw new HermesProviderCapabilityError();
  }
}

function snapshotBinding(binding: HermesSidecarBinding): HermesSidecarBinding {
  if (!binding || typeof binding !== "object") throw new HermesProviderCapabilityError();
  const taskId = binding.taskId;
  const runId = binding.runId;
  const profileId = binding.profileId;
  const providerSlug = binding.providerSlug;
  const authMode = binding.authMode;
  const model = binding.model;
  const apiMode = binding.apiMode;
  const executionBackend = binding.executionBackend;
  if (
    typeof taskId !== "string" ||
    !BINDING_ID_PATTERN.test(taskId) ||
    typeof runId !== "string" ||
    !BINDING_ID_PATTERN.test(runId) ||
    typeof profileId !== "string" ||
    !BINDING_ID_PATTERN.test(profileId) ||
    typeof providerSlug !== "string" ||
    !BINDING_ID_PATTERN.test(providerSlug) ||
    (authMode !== "api_key" && authMode !== "oauth") ||
    typeof model !== "string" ||
    !BINDING_MODEL_PATTERN.test(model) ||
    (apiMode !== "chat_completions" && apiMode !== "codex_responses") ||
    (executionBackend !== "local" && executionBackend !== "docker")
  ) {
    throw new HermesProviderCapabilityError();
  }
  return Object.freeze({
    taskId,
    runId,
    profileId,
    providerSlug,
    authMode,
    model,
    apiMode,
    executionBackend,
  });
}

function snapshotProfileSecrets(
  value: unknown,
  binding: HermesSidecarBinding,
): HermesProviderProfileSecrets {
  if (!value || typeof value !== "object") throw new HermesProviderCapabilityError();
  const apiKey = Reflect.get(value, "apiKey");
  const baseUrl = Reflect.get(value, "baseUrl");
  if (apiKey !== null && typeof apiKey !== "string") {
    throw new HermesProviderCapabilityError();
  }
  if (baseUrl !== null && typeof baseUrl !== "string") {
    throw new HermesProviderCapabilityError();
  }

  if (binding.authMode === "oauth") {
    if (apiKey !== null || baseUrl !== null) throw new HermesProviderCapabilityError();
    return Object.freeze({ apiKey: null, baseUrl: null });
  }

  if (typeof apiKey !== "string" || !API_KEY_PATTERN.test(apiKey)) {
    throw new HermesProviderCapabilityError();
  }
  if (baseUrl !== null) validateBaseUrl(baseUrl);
  if (binding.providerSlug.startsWith("custom:") && baseUrl === null) {
    throw new HermesProviderCapabilityError();
  }
  return Object.freeze({ apiKey, baseUrl });
}

function validateBaseUrl(value: string): void {
  if (value.length === 0 || value.length > MAX_BASE_URL_LENGTH) {
    throw new HermesProviderCapabilityError();
  }
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new HermesProviderCapabilityError();
  }
}

function createWirePayload(
  binding: HermesSidecarBinding,
  secrets: HermesProviderProfileSecrets,
): Buffer {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      profileId: binding.profileId,
      providerSlug: binding.providerSlug,
      authMode: binding.authMode,
      apiMode: binding.apiMode,
      executionBackend: binding.executionBackend,
      model: binding.model,
      apiKey: secrets.apiKey,
      baseUrl: secrets.baseUrl,
    }),
    "utf8",
  );
  if (payload.length === 0 || payload.length > MAX_WIRE_BYTES) {
    payload.fill(0);
    throw new HermesProviderCapabilityError();
  }
  return payload;
}

function createCapabilityLease(initialPayload: Buffer): HermesSidecarCapabilityLease {
  let payload: Buffer | undefined = initialPayload;
  let transmitStarted = false;
  let revoked = false;
  let activePipe: WritableOperations | undefined;
  let rejectActive: (() => void) | undefined;

  const zeroPayload = (): void => {
    payload?.fill(0);
    payload = undefined;
  };

  const revoke = (): void => {
    if (revoked) return;
    revoked = true;
    rejectActive?.();
    destroyPipe(activePipe);
    zeroPayload();
  };

  const transmit = async (pipe: Writable): Promise<void> => {
    if (transmitStarted || revoked || !payload) {
      throw new HermesProviderCapabilityError();
    }
    transmitStarted = true;
    try {
      const operations = snapshotWritable(pipe);
      activePipe = operations;
      await transmitPayload(operations, payload, (reject) => {
        rejectActive = reject;
      });
      if (revoked) throw new HermesProviderCapabilityError();
    } catch {
      revoke();
      throw new HermesProviderCapabilityError();
    } finally {
      rejectActive = undefined;
      activePipe = undefined;
      zeroPayload();
    }
  };

  return Object.freeze({ transmit, revoke });
}

function transmitPayload(
  pipe: WritableOperations,
  payload: Buffer,
  ownReject: (reject: () => void) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (error === undefined || error === null) {
        resolve();
      } else {
        reject(new HermesProviderCapabilityError());
      }
    };
    const onError = (): void => settle(new HermesProviderCapabilityError());
    const onClose = (): void => {
      if (settled) {
        removeListeners(pipe, onError, onClose);
        return;
      }
      settle(new HermesProviderCapabilityError());
    };
    ownReject(() => settle(new HermesProviderCapabilityError()));
    try {
      Reflect.apply(pipe.once, pipe.receiver, ["error", onError]);
      Reflect.apply(pipe.once, pipe.receiver, ["close", onClose]);
      Reflect.apply(pipe.end, pipe.receiver, [payload, (error?: unknown) => settle(error)]);
    } catch {
      settle(new HermesProviderCapabilityError());
    }
  });
}

function removeListeners(pipe: WritableOperations, onError: () => void, onClose: () => void): void {
  try {
    Reflect.apply(pipe.off, pipe.receiver, ["error", onError]);
    Reflect.apply(pipe.off, pipe.receiver, ["close", onClose]);
  } catch {
    // Listener cleanup never changes the fixed result.
  }
}

function snapshotWritable(value: Writable): WritableOperations {
  if (!value || typeof value !== "object") throw new HermesProviderCapabilityError();
  const receiver = value as object;
  const once = requireFunction(Reflect.get(receiver, "once"));
  const off = requireFunction(Reflect.get(receiver, "off"));
  const end = requireFunction(Reflect.get(receiver, "end"));
  const destroy = requireFunction(Reflect.get(receiver, "destroy"));
  return Object.freeze({ receiver, once, off, end, destroy });
}

function destroyPipe(pipe: WritableOperations | undefined): void {
  if (!pipe) return;
  try {
    Reflect.apply(pipe.destroy, pipe.receiver, []);
  } catch {
    // Revocation remains fail closed even when a hostile pipe refuses cleanup.
  }
}

function requireFunction<T extends (...args: never[]) => unknown>(value: T): T;
function requireFunction(value: unknown): (...args: never[]) => unknown;
function requireFunction(value: unknown): (...args: never[]) => unknown {
  if (typeof value !== "function") throw new HermesProviderCapabilityError();
  return value as (...args: never[]) => unknown;
}
