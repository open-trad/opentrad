import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createHermesProviderCapabilityIssuer,
  HermesProviderCapabilityError,
} from "../src/main/services/hermes/provider-capability-issuer";
import type { HermesSidecarBinding } from "../src/main/services/hermes/sidecar-manager";
import type {
  IssuedProviderCapability,
  ProviderBroker,
  ProviderBrokerEndpoint,
  ProviderCredentialLease,
} from "../src/main/services/provider-broker";

const nowMs = 1_752_240_000_000;
const binding: HermesSidecarBinding = {
  taskId: "task-123",
  runId: "run-456",
  profileId: "profile-789",
  model: "openai/gpt-5.2",
  apiMode: "chat_completions",
};
const endpoint: ProviderBrokerEndpoint = { host: "127.0.0.1", port: 43_117 };
const issued: IssuedProviderCapability = {
  capabilityId: "11111111-2222-4333-8444-555555555555",
  token: "provider-capability-token-0123456789abcdef",
  expiresAt: Math.floor(nowMs / 1_000) + 60,
};

describe("createHermesProviderCapabilityIssuer", () => {
  it("maps a frozen task binding into one exact FD3 wire capability", async () => {
    const order: string[] = [];
    const credentialLease: ProviderCredentialLease = {
      secrets: ["long-lived-provider-credential-canary"],
    };
    const broker = fakeBroker({
      start: vi.fn(async () => {
        order.push("start");
        return endpoint;
      }),
      issue: vi.fn((input, receivedCredentials) => {
        order.push("issue");
        expect(input).toEqual({ ...binding, ttlMs: 60_000 });
        expect(receivedCredentials).toBe(credentialLease);
        return issued;
      }),
    });
    const acquireCredentialLease = vi.fn(async (receivedBinding: HermesSidecarBinding) => {
      order.push("credential");
      expect(receivedBinding).toEqual(binding);
      expect(Object.isFrozen(receivedBinding)).toBe(true);
      return credentialLease;
    });
    const issuer = createHermesProviderCapabilityIssuer({
      acquireCredentialLease,
      broker,
      now: () => nowMs,
      ttlMs: 60_000,
    });

    const capability = await issuer(binding);
    const output = new CapturingWritable();
    await capability.transmit(output);

    expect(order).toEqual(["start", "credential", "issue"]);
    expect(Object.keys(capability).sort()).toEqual(["revoke", "transmit"]);
    expect(JSON.stringify(capability)).toBe("{}");
    expect(JSON.parse(output.copy.toString("utf8"))).toEqual({
      v: 1,
      expiresAt: issued.expiresAt,
      token: issued.token,
      model: binding.model,
      apiMode: binding.apiMode,
      brokerPort: endpoint.port,
    });
    expect(output.copy.toString("utf8")).not.toContain(credentialLease.secrets[0] ?? "");
    expect(output.original?.every((byte) => byte === 0)).toBe(true);
    expect(broker.revoke).not.toHaveBeenCalled();

    capability.revoke();
    capability.revoke();
    expect(broker.revoke).toHaveBeenCalledOnce();
    expect(broker.revoke).toHaveBeenCalledWith(issued.capabilityId);
  });

  it("validates expiry against the time of issuance after asynchronous setup", async () => {
    let currentTime = nowMs;
    const broker = fakeBroker({
      start: vi.fn(async () => {
        currentTime += 1_500;
        return endpoint;
      }),
      issue: vi.fn(() => ({
        ...issued,
        expiresAt: Math.floor(currentTime / 1_000) + 300,
      })),
    });
    const issuer = createHermesProviderCapabilityIssuer({
      acquireCredentialLease: async () => ({ secrets: [] }),
      broker,
      now: () => currentTime,
      ttlMs: 300_000,
    });

    const capability = await issuer(binding);

    expect(broker.issue).toHaveBeenCalledOnce();
    capability.revoke();
  });

  it("revokes and zeroes before transmit, then rejects without reflecting token", async () => {
    const broker = fakeBroker();
    const issuer = createIssuer(broker);
    const capability = await issuer(binding);

    capability.revoke();
    const error = await capability
      .transmit(new CapturingWritable())
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(HermesProviderCapabilityError);
    expect(String(error)).toBe(
      "HermesProviderCapabilityError: Hermes provider capability is unavailable",
    );
    expect(String(error)).not.toContain(issued.token);
    expect(broker.revoke).toHaveBeenCalledOnce();
  });

  it("destroys an in-flight FD3 write when synchronously revoked", async () => {
    const broker = fakeBroker();
    const capability = await createIssuer(broker)(binding);
    const output = new StalledWritable();
    const transmitting = capability.transmit(output);
    await vi.waitFor(() => expect(output.original).toBeDefined());

    capability.revoke();
    const error = await transmitting.catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(HermesProviderCapabilityError);
    expect(output.destroyed).toBe(true);
    expect(output.original?.every((byte) => byte === 0)).toBe(true);
    expect(broker.revoke).toHaveBeenCalledOnce();
  });

  it("allows only one transmit and never retains the payload after failure", async () => {
    const broker = fakeBroker();
    const capability = await createIssuer(broker)(binding);
    const first = new FailingWritable();

    await expect(capability.transmit(first)).rejects.toBeInstanceOf(HermesProviderCapabilityError);
    expect(first.original?.every((byte) => byte === 0)).toBe(true);
    await expect(capability.transmit(new CapturingWritable())).rejects.toBeInstanceOf(
      HermesProviderCapabilityError,
    );
    expect(JSON.stringify(capability)).not.toContain(issued.token);
    capability.revoke();
  });

  it("absorbs a stream error emitted after the successful end callback", async () => {
    const broker = fakeBroker();
    const capability = await createIssuer(broker)(binding);
    const output = new LateFailingWritable();

    await capability.transmit(output);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(output.destroyed).toBe(true);
    capability.revoke();
  });

  it.each([
    {
      name: "wrong broker host",
      start: async () => ({ host: "0.0.0.0", port: 43_117 }),
    },
    {
      name: "invalid broker port",
      start: async () => ({ host: "127.0.0.1", port: 0 }),
    },
  ])("rejects $name before issuing", async ({ start }) => {
    const broker = fakeBroker({ start: vi.fn(start) as never });
    const error = await createIssuer(broker)(binding).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(HermesProviderCapabilityError);
    expect(String(error)).not.toContain("0.0.0.0");
    expect(broker.issue).not.toHaveBeenCalled();
  });

  it("revokes a malformed issued capability without reflecting its values", async () => {
    const broker = fakeBroker({
      issue: vi.fn(() => ({
        ...issued,
        token: "malformed token canary",
      })),
    });
    const error = await createIssuer(broker)(binding).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(HermesProviderCapabilityError);
    expect(String(error)).not.toContain("canary");
    expect(broker.revoke).toHaveBeenCalledOnce();
    expect(broker.revoke).toHaveBeenCalledWith(issued.capabilityId);
  });

  it("sanitizes broker and credential-source failures", async () => {
    const brokerFailure = fakeBroker({
      start: vi.fn(async () => {
        throw new Error("broker-start-canary");
      }),
    });
    const credentialFailure = fakeBroker();
    const first = await createIssuer(brokerFailure)(binding).catch((cause: unknown) => cause);
    const second = await createHermesProviderCapabilityIssuer({
      acquireCredentialLease: async () => {
        throw new Error("keychain-credential-canary");
      },
      broker: credentialFailure,
      now: () => nowMs,
      ttlMs: 60_000,
    })(binding).catch((cause: unknown) => cause);

    for (const error of [first, second]) {
      expect(error).toBeInstanceOf(HermesProviderCapabilityError);
      expect(String(error)).not.toContain("canary");
    }
    expect(credentialFailure.issue).not.toHaveBeenCalled();
  });
});

function createIssuer(broker: BrokerContract) {
  return createHermesProviderCapabilityIssuer({
    acquireCredentialLease: async () => ({ secrets: [] }),
    broker,
    now: () => nowMs,
    ttlMs: 60_000,
  });
}

type BrokerContract = Pick<ProviderBroker, "start" | "issue" | "revoke">;

function fakeBroker(overrides: Partial<BrokerContract> = {}): BrokerContract {
  return {
    start: vi.fn(async () => endpoint),
    issue: vi.fn(() => issued),
    revoke: vi.fn(),
    ...overrides,
  };
}

class CapturingWritable extends Writable {
  original: Buffer | undefined;
  copy = Buffer.alloc(0);

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error) => void) {
    this.original = chunk;
    this.copy = Buffer.from(chunk);
    callback();
  }
}

class StalledWritable extends Writable {
  original: Buffer | undefined;

  override _write(chunk: Buffer, _encoding: BufferEncoding, _callback: (error?: Error) => void) {
    this.original = chunk;
  }
}

class FailingWritable extends Writable {
  original: Buffer | undefined;

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error) => void) {
    this.original = chunk;
    callback(new Error("fd3-write-canary"));
  }
}

class LateFailingWritable extends Writable {
  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error) => void) {
    callback();
  }

  override _final(callback: (error?: Error) => void) {
    callback();
    queueMicrotask(() => this.destroy(new Error("fd3-late-error-canary")));
  }
}
