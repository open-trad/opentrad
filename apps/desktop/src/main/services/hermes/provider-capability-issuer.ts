import { Buffer } from "node:buffer";
import type { Writable } from "node:stream";
import type {
  IssuedProviderCapability,
  ProviderBroker,
  ProviderBrokerEndpoint,
  ProviderCredentialLease,
} from "../provider-broker";
import type {
  HermesSidecarBinding,
  HermesSidecarCapabilityIssuer,
  HermesSidecarCapabilityLease,
} from "./sidecar-manager";

export type ProviderCredentialLeaseSource = (
  binding: HermesSidecarBinding,
) => Promise<ProviderCredentialLease>;

export interface HermesProviderCapabilityIssuerOptions {
  readonly broker: Pick<ProviderBroker, "start" | "issue" | "revoke">;
  readonly acquireCredentialLease: ProviderCredentialLeaseSource;
  readonly ttlMs: number;
  readonly now?: () => number;
}

export class HermesProviderCapabilityError extends Error {
  constructor() {
    super("Hermes provider capability is unavailable");
    this.name = "HermesProviderCapabilityError";
  }
}

type BrokerContract = Pick<ProviderBroker, "start" | "issue" | "revoke">;

interface BrokerOperations {
  readonly start: () => Promise<ProviderBrokerEndpoint>;
  readonly issue: BrokerContract["issue"];
  readonly revoke: BrokerContract["revoke"];
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
const CAPABILITY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAPABILITY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 300_000;
const MAX_EXPIRY_SECONDS = 300;
const MAX_WIRE_BYTES = 4_096;

export function createHermesProviderCapabilityIssuer(
  options: HermesProviderCapabilityIssuerOptions,
): HermesSidecarCapabilityIssuer {
  try {
    const broker = snapshotBroker(options.broker);
    const acquireCredentialLease = requireFunction(options.acquireCredentialLease);
    const ttlMs = requireTtl(options.ttlMs);
    const now = options.now === undefined ? Date.now : requireFunction(options.now);

    return async (binding) => {
      let capabilityId: string | undefined;
      let issued = false;
      try {
        const frozenBinding = snapshotBinding(binding);
        const endpoint = snapshotEndpoint(await broker.start());
        const credentialLease = await Reflect.apply(acquireCredentialLease, undefined, [
          frozenBinding,
        ]);
        const rawIssued = Reflect.apply(broker.issue, undefined, [
          { ...frozenBinding, ttlMs },
          credentialLease,
        ]);
        issued = true;
        capabilityId = readCapabilityId(rawIssued);
        const nowMs = requireNow(now());
        const capability = snapshotIssuedCapability(rawIssued, nowMs, capabilityId);
        const payload = createWirePayload(frozenBinding, endpoint, capability);
        return createCapabilityLease(broker.revoke, capability.capabilityId, payload);
      } catch {
        if (issued && capabilityId) bestEffortRevoke(broker.revoke, capabilityId);
        throw new HermesProviderCapabilityError();
      }
    };
  } catch {
    throw new HermesProviderCapabilityError();
  }
}

function snapshotBroker(value: BrokerContract): BrokerOperations {
  if (!value || typeof value !== "object") throw new HermesProviderCapabilityError();
  const receiver = value as object;
  const start = requireFunction(Reflect.get(receiver, "start"));
  const issue = requireFunction(Reflect.get(receiver, "issue"));
  const revoke = requireFunction(Reflect.get(receiver, "revoke"));
  return Object.freeze({
    start: () => Reflect.apply(start, receiver, []) as ReturnType<BrokerContract["start"]>,
    issue: ((input, credentialLease) =>
      Reflect.apply(issue, receiver, [input, credentialLease])) as BrokerContract["issue"],
    revoke: ((capabilityId) =>
      Reflect.apply(revoke, receiver, [capabilityId])) as BrokerContract["revoke"],
  });
}

function snapshotBinding(binding: HermesSidecarBinding): HermesSidecarBinding {
  if (!binding || typeof binding !== "object") throw new HermesProviderCapabilityError();
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
    throw new HermesProviderCapabilityError();
  }
  return Object.freeze({ taskId, runId, profileId, model, apiMode });
}

function snapshotEndpoint(value: ProviderBrokerEndpoint): ProviderBrokerEndpoint {
  if (!value || typeof value !== "object") throw new HermesProviderCapabilityError();
  const host = value.host;
  const port = value.port;
  if (host !== "127.0.0.1" || !Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new HermesProviderCapabilityError();
  }
  return Object.freeze({ host, port });
}

function readCapabilityId(value: IssuedProviderCapability): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  try {
    const capabilityId = value.capabilityId;
    return typeof capabilityId === "string" && CAPABILITY_ID_PATTERN.test(capabilityId)
      ? capabilityId
      : undefined;
  } catch {
    return undefined;
  }
}

function snapshotIssuedCapability(
  value: IssuedProviderCapability,
  nowMs: number,
  capabilityId: string | undefined,
): IssuedProviderCapability {
  if (!value || typeof value !== "object" || !capabilityId) {
    throw new HermesProviderCapabilityError();
  }
  const token = value.token;
  const expiresAt = value.expiresAt;
  const nowSeconds = Math.floor(nowMs / 1_000);
  if (
    typeof token !== "string" ||
    !CAPABILITY_TOKEN_PATTERN.test(token) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= nowSeconds ||
    expiresAt > nowSeconds + MAX_EXPIRY_SECONDS
  ) {
    throw new HermesProviderCapabilityError();
  }
  return Object.freeze({ capabilityId, token, expiresAt });
}

function createWirePayload(
  binding: HermesSidecarBinding,
  endpoint: ProviderBrokerEndpoint,
  capability: IssuedProviderCapability,
): Buffer {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      expiresAt: capability.expiresAt,
      token: capability.token,
      model: binding.model,
      apiMode: binding.apiMode,
      brokerPort: endpoint.port,
    }),
    "utf8",
  );
  if (payload.length === 0 || payload.length > MAX_WIRE_BYTES) {
    payload.fill(0);
    throw new HermesProviderCapabilityError();
  }
  return payload;
}

function createCapabilityLease(
  revokeBrokerCapability: BrokerContract["revoke"],
  capabilityId: string,
  initialPayload: Buffer,
): HermesSidecarCapabilityLease {
  let payload: Buffer | undefined = initialPayload;
  let transmitStarted = false;
  let revocationRequested = false;
  let revoked = false;
  let revoking = false;
  let activePipe: WritableOperations | undefined;
  let rejectActive: (() => void) | undefined;

  const zeroPayload = (): void => {
    payload?.fill(0);
    payload = undefined;
  };

  const revoke = (): void => {
    if (revoked) return;
    if (revoking) throw new HermesProviderCapabilityError();
    revoking = true;
    revocationRequested = true;
    let revokeFailed = false;
    try {
      Reflect.apply(revokeBrokerCapability, undefined, [capabilityId]);
      revoked = true;
    } catch {
      revokeFailed = true;
    } finally {
      rejectActive?.();
      destroyPipe(activePipe);
      zeroPayload();
      revoking = false;
    }
    if (revokeFailed) throw new HermesProviderCapabilityError();
  };

  const transmit = async (pipe: Writable): Promise<void> => {
    if (transmitStarted || revocationRequested || !payload) {
      throw new HermesProviderCapabilityError();
    }
    transmitStarted = true;
    try {
      const operations = snapshotWritable(pipe);
      activePipe = operations;
      await transmitPayload(operations, payload, (reject) => {
        rejectActive = reject;
      });
      if (revocationRequested) throw new HermesProviderCapabilityError();
    } catch {
      try {
        revoke();
      } catch {
        // The caller still receives one fixed error; the owner can retry revoke during cleanup.
      }
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
        // `finish`/the end callback can precede a late stream error. Keep the once-listeners until
        // `close`; onError absorbs that error and onClose removes any listener that remains.
        resolve();
      } else {
        // Writable.end can report an error before Node emits the matching `error` event. Keep the
        // once-listeners until that event and `close` have drained so it cannot become unhandled.
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

function bestEffortRevoke(revoke: BrokerContract["revoke"], capabilityId: string): void {
  try {
    Reflect.apply(revoke, undefined, [capabilityId]);
  } catch {
    // The acquisition still fails with one fixed error and never starts Hermes.
  }
}

function requireTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_TTL_MS || value > MAX_TTL_MS) {
    throw new HermesProviderCapabilityError();
  }
  return value;
}

function requireNow(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new HermesProviderCapabilityError();
  return value;
}

function requireFunction<T extends (...args: never[]) => unknown>(value: T): T;
function requireFunction(value: unknown): (...args: never[]) => unknown;
function requireFunction(value: unknown): (...args: never[]) => unknown {
  if (typeof value !== "function") throw new HermesProviderCapabilityError();
  return value as (...args: never[]) => unknown;
}
