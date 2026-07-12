import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  HermesGatewayClient,
  type HermesGatewayProcess,
} from "../src/main/services/hermes/gateway-client";

const PINNED_READY_FRAME = {
  jsonrpc: "2.0",
  method: "event",
  params: { type: "gateway.ready", payload: { skin: "hermes" } },
} as const;
const LIVE_SESSION_ID = "deadbeef";
const SECOND_LIVE_SESSION_ID = "cafebabe";

describe("Hermes gateway request reservations", () => {
  it("assigns distinct IDs when params.toJSON reenters request and settles both calls", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    gateway.send(PINNED_READY_FRAME);
    await client.ready();
    let nested: Promise<unknown> | undefined;
    const outerParams = { session_id: LIVE_SESSION_ID };
    Object.defineProperty(outerParams, "toJSON", {
      enumerable: false,
      value: () => {
        nested = client.request("session.status", { session_id: SECOND_LIVE_SESSION_ID });
        return { session_id: LIVE_SESSION_ID };
      },
    });

    const outer = client.request("session.status", outerParams);
    const outerOutcome = outer.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    const nestedOutcome = nested?.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const messages = gateway.stdinMessages();
    for (const message of messages) {
      gateway.send({
        jsonrpc: "2.0",
        id: message.id,
        result: { output: (message.params as { session_id: string }).session_id },
      });
    }
    const settled = await settleWithin([outerOutcome, nestedOutcome], 100);
    await client.dispose().catch(() => {});

    expect(new Set(messages.map((message) => message.id)).size).toBe(2);
    expect(settled).toEqual([
      { status: "fulfilled", value: { output: LIVE_SESSION_ID } },
      { status: "fulfilled", value: { output: SECOND_LIVE_SESSION_ID } },
    ]);
  });

  it("bounds 64 levels of serialization reentry and leaves no orphan state", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    gateway.send(PINNED_READY_FRAME);
    await client.ready();
    const outcomes: Promise<unknown>[] = [];

    const reentrantParams = (depth: number): { readonly session_id: string } => {
      const params = { session_id: liveSessionId(depth) };
      Object.defineProperty(params, "toJSON", {
        enumerable: false,
        value: () => {
          if (depth < 70) {
            outcomes.push(
              client
                .request("session.status", reentrantParams(depth + 1))
                .catch((error: unknown) => error),
            );
          }
          return { session_id: liveSessionId(depth) };
        },
      });
      return params;
    };

    outcomes.push(
      client.request("session.status", reentrantParams(0)).catch((error: unknown) => error),
    );
    const settled = await settleWithin(outcomes, 100);
    const state = reservationState(client);
    const observed = {
      pending: state.pending.size,
      queued: state.outboundQueue.length,
      reserved: state.reservedRequestCount,
      terminateCalls: gateway.terminate.mock.calls.length,
      writes: gateway.stdinMessages().length,
    };
    await client.dispose().catch(() => {});

    expect(observed).toEqual({
      pending: 0,
      queued: 0,
      reserved: 0,
      terminateCalls: 1,
      writes: 0,
    });
    expect(settled).not.toBe(false);
    if (settled !== false) {
      expect(settled).toHaveLength(65);
      expect(new Set(settled).size).toBe(1);
      for (const error of settled) {
        expect(error).toMatchObject({ code: "HERMES_GATEWAY_BACKPRESSURE" });
      }
    }
  });

  it("releases a reservation when local params are invalid", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    const unsafeRequest = client.request.bind(client) as (
      method: string,
      params: unknown,
    ) => Promise<unknown>;

    const error = await unsafeRequest("session.status", { sessionId: "invalid" }).catch(
      (cause: unknown) => cause,
    );

    expect(error).toMatchObject({ code: "HERMES_GATEWAY_INVALID_PARAMS" });
    expect(reservationState(client).reservedRequestCount).toBe(0);
    await client.dispose();
  });

  it("releases a reservation when params serialization throws", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    const params = { session_id: LIVE_SESSION_ID };
    Object.defineProperty(params, "toJSON", {
      enumerable: false,
      value: () => {
        throw new Error("serialization-secret-canary");
      },
    });

    const error = await client.request("session.status", params).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "HERMES_GATEWAY_PROTOCOL" });
    expect(JSON.stringify(error)).not.toContain("canary");
    expect(reservationState(client).reservedRequestCount).toBe(0);
    await client.dispose();
  });

  it("preserves getter-triggered disposal over an invalid params error", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    let disposal: Promise<void> | undefined;
    const params = Object.defineProperty({}, "session_id", {
      enumerable: true,
      get: () => {
        disposal = client.dispose();
        return "";
      },
    });

    const error = await client
      .request("session.status", params as { readonly session_id: string })
      .catch((cause: unknown) => cause);
    await disposal;

    expect(error).toMatchObject({ code: "HERMES_GATEWAY_DISPOSED" });
    expect(reservationState(client).reservedRequestCount).toBe(0);
  });

  it("releases a reservation when toJSON reenters dispose", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    let disposal: Promise<void> | undefined;
    const params = { session_id: LIVE_SESSION_ID };
    Object.defineProperty(params, "toJSON", {
      enumerable: false,
      value: () => {
        disposal = client.dispose();
        return { session_id: LIVE_SESSION_ID };
      },
    });

    const error = await client.request("session.status", params).catch((cause: unknown) => cause);
    await disposal;

    expect(error).toMatchObject({ code: "HERMES_GATEWAY_DISPOSED" });
    expect(reservationState(client).reservedRequestCount).toBe(0);
  });
});

function reservationState(client: HermesGatewayClient): {
  readonly pending: Map<number, unknown>;
  readonly outboundQueue: unknown[];
  readonly reservedRequestCount: number;
} {
  return client as unknown as {
    pending: Map<number, unknown>;
    outboundQueue: unknown[];
    reservedRequestCount: number;
  };
}

function liveSessionId(index: number): string {
  return index.toString(16).padStart(8, "0");
}

async function settleWithin<T>(
  promises: readonly Promise<T>[],
  timeoutMs: number,
): Promise<T[] | false> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.all(promises),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface FakeGateway {
  process: HermesGatewayProcess;
  stdout: PassThrough;
  terminate: ReturnType<typeof vi.fn<() => Promise<void>>>;
  send(message: unknown): void;
  stdinMessages(): Array<Record<string, unknown>>;
}

function fakeGateway(): FakeGateway {
  const child = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdinText = "";
  stdin.on("data", (chunk: Buffer) => {
    stdinText += chunk.toString("utf8");
  });
  stderr.resume();
  const process = Object.assign(child, { stdin, stdout, stderr }) as HermesGatewayProcess;
  const terminate = vi.fn(async () => {});
  return {
    process,
    stdout,
    terminate,
    send(message) {
      stdout.write(`${JSON.stringify(message)}\n`);
    },
    stdinMessages: () =>
      stdinText
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function createClient(gateway: FakeGateway): HermesGatewayClient {
  return new HermesGatewayClient({
    process: gateway.process,
    terminate: gateway.terminate,
    readyTimeoutMs: 100,
    requestTimeoutMs: 100,
  });
}
