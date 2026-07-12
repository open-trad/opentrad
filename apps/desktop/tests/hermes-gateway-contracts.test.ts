import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HermesGatewayClient,
  type HermesGatewayProcess,
} from "../src/main/services/hermes/gateway-client";
import { HERMES_GATEWAY_REQUEST_METHODS } from "../src/main/services/hermes/gateway-protocol";
import {
  isValidHermesGatewayRequestParams,
  isValidHermesGatewayRequestResult,
} from "../src/main/services/hermes/gateway-validation";

const LIVE_SESSION_ID = "deadbeef";
const STORED_SESSION_ID = "20260711_120000_abcdef";

const PINNED_READY_FRAME = {
  jsonrpc: "2.0",
  method: "event",
  params: {
    type: "gateway.ready",
    payload: { skin: "hermes" },
  },
} as const;

afterEach(() => {
  vi.useRealTimers();
});

describe("Hermes v2026.7.7.2 gateway wire contract", () => {
  it("becomes ready only from the pinned event envelope and normalizes it", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    const notifications: unknown[] = [];
    client.subscribe((notification) => notifications.push(notification));

    gateway.send(PINNED_READY_FRAME);

    await expect(client.ready()).resolves.toBeUndefined();
    expect(notifications).toEqual([
      {
        method: "gateway.ready",
        params: { skin: "hermes" },
      },
    ]);
    await client.dispose();
  });

  it("rejects a forged direct gateway.ready notification", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);

    gateway.send({ jsonrpc: "2.0", method: "gateway.ready" });

    await expect(client.ready()).rejects.toMatchObject({
      code: "HERMES_GATEWAY_PROTOCOL",
    });
    expect(gateway.terminate).toHaveBeenCalledOnce();
  });

  it("accepts pinned events that omit payload and normalizes params to undefined", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    const notifications: unknown[] = [];
    client.subscribe((notification) => notifications.push(notification));
    gateway.send(PINNED_READY_FRAME);
    await client.ready();

    gateway.send({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "message.start", session_id: "live-1" },
    });

    expect(notifications.at(-1)).toEqual({
      method: "message.start",
      params: undefined,
      sessionId: "live-1",
    });
    expect(gateway.terminate).not.toHaveBeenCalled();
    await client.dispose();
  });
});

describe("OpenTrad owned launcher request contracts", () => {
  it("writes the exact empty external session.create params object", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    gateway.send(PINNED_READY_FRAME);
    await client.ready();

    const request = client.request("session.create", {});
    void request.catch(() => {});
    await Promise.resolve();

    expect(gateway.stdinMessages()).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "session.create",
        params: {},
      },
    ]);
    gateway.send({
      jsonrpc: "2.0",
      id: 1,
      result: {
        session_id: LIVE_SESSION_ID,
        stored_session_id: STORED_SESSION_ID,
        message_count: 0,
        messages: [],
        persisted: false,
        resumable: false,
        info: {
          lazy: true,
          persisted: false,
          resumable: false,
          runtime: "hermes-quarantined",
          state: "quarantined",
        },
      },
    });
    await expect(request).resolves.toMatchObject({
      session_id: LIVE_SESSION_ID,
      stored_session_id: STORED_SESSION_ID,
    });
    await client.dispose();
  });

  it("accepts only the launcher-owned external parameter shapes", () => {
    const valid = [
      ["session.create", {}],
      ["session.resume", { session_id: STORED_SESSION_ID }],
      ["session.status", { session_id: LIVE_SESSION_ID }],
      ["session.close", { session_id: LIVE_SESSION_ID }],
      ["session.interrupt", { session_id: LIVE_SESSION_ID }],
      ["prompt.submit", { session_id: LIVE_SESSION_ID, text: "continue" }],
      ["approval.respond", { session_id: LIVE_SESSION_ID, choice: "once" }],
      ["approval.respond", { session_id: LIVE_SESSION_ID, choice: "deny" }],
    ] as const;
    for (const [method, params] of valid) {
      expect(isValidHermesGatewayRequestParams(method, params), method).toBe(true);
    }

    const invalid = [
      ["session.create", { cwd: "/workspace", source: "opentrad", close_on_disconnect: true }],
      ["session.create", { extra: "canary" }],
      ["session.resume", { session_id: LIVE_SESSION_ID }],
      ["session.resume", { session_id: STORED_SESSION_ID, cols: 120 }],
      ["session.status", { session_id: STORED_SESSION_ID }],
      ["session.close", { session_id: "DEADBEEF" }],
      ["session.interrupt", { session_id: "deadbee" }],
      ["prompt.submit", { session_id: STORED_SESSION_ID, text: "continue" }],
      ["prompt.submit", { session_id: LIVE_SESSION_ID, text: " \t\n " }],
      ["prompt.submit", { session_id: LIVE_SESSION_ID, text: "bad-surrogate-\ud800" }],
      ["prompt.submit", { session_id: LIVE_SESSION_ID, text: "a".repeat(262_145) }],
      [
        "prompt.submit",
        { session_id: LIVE_SESSION_ID, text: "continue", truncate_before_user_ordinal: 0 },
      ],
      ["approval.respond", { session_id: STORED_SESSION_ID, choice: "once" }],
      ["approval.respond", { session_id: LIVE_SESSION_ID, choice: "session" }],
      ["approval.respond", { session_id: LIVE_SESSION_ID, choice: "always" }],
      ["approval.respond", { session_id: LIVE_SESSION_ID, choice: "once", all: false }],
    ] as const;
    for (const [method, params] of invalid) {
      expect(isValidHermesGatewayRequestParams(method, params), method).toBe(false);
    }
  });

  it("uses Unicode scalar and UTF-8 byte bounds for prompt text", () => {
    const exactFourByteBoundary = "\u{1f642}".repeat(262_144);

    expect(
      isValidHermesGatewayRequestParams("prompt.submit", {
        session_id: LIVE_SESSION_ID,
        text: exactFourByteBoundary,
      }),
    ).toBe(true);
    expect(Buffer.byteLength(exactFourByteBoundary, "utf8")).toBe(1024 * 1024);
    expect(
      isValidHermesGatewayRequestParams("prompt.submit", {
        session_id: LIVE_SESSION_ID,
        text: `${exactFourByteBoundary}a`,
      }),
    ).toBe(false);
  });

  it("validates live and stored identifiers in session.create results", () => {
    const base = {
      message_count: 0,
      messages: [],
      persisted: false,
      resumable: false,
      info: {
        lazy: true,
        persisted: false,
        resumable: false,
        runtime: "hermes-quarantined",
        state: "quarantined",
      },
    };

    expect(
      isValidHermesGatewayRequestResult("session.create", {
        ...base,
        session_id: LIVE_SESSION_ID,
        stored_session_id: STORED_SESSION_ID,
      }),
    ).toBe(true);
    expect(
      isValidHermesGatewayRequestResult("session.create", {
        ...base,
        session_id: "live-1",
        stored_session_id: STORED_SESSION_ID,
      }),
    ).toBe(false);
    expect(
      isValidHermesGatewayRequestResult("session.create", {
        ...base,
        session_id: LIVE_SESSION_ID,
        stored_session_id: "stored-1",
      }),
    ).toBe(false);
    expect(
      isValidHermesGatewayRequestResult("session.create", {
        ...base,
        session_id: LIVE_SESSION_ID,
        stored_session_id: STORED_SESSION_ID,
        message_count: 1,
      }),
    ).toBe(false);
    expect(
      isValidHermesGatewayRequestResult("session.create", {
        ...base,
        session_id: LIVE_SESSION_ID,
        stored_session_id: STORED_SESSION_ID,
        messages: [{ role: "assistant" }],
      }),
    ).toBe(false);
  });

  it("fails closed for throwing request and result object traps", () => {
    const throwingRequest = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("request-getter-canary");
        },
      },
    );
    const throwingResult = new Proxy(
      {},
      {
        get() {
          throw new Error("result-getter-canary");
        },
      },
    );

    for (const method of HERMES_GATEWAY_REQUEST_METHODS) {
      expect(isValidHermesGatewayRequestParams(method, throwingRequest), method).toBe(false);
      expect(isValidHermesGatewayRequestResult(method, throwingResult), method).toBe(false);
    }
  });

  it.each([
    ["session.create", { cwd: "/workspace", source: "opentrad", closeOnDisconnect: true }],
    ["session.resume", { sessionId: "stored-1" }],
    ["prompt.submit", { sessionId: "live-1", prompt: "hello" }],
    ["session.interrupt", { sessionId: "live-1" }],
    ["session.close", { sessionId: "live-1" }],
    ["session.status", { sessionId: "live-1" }],
    ["session.status", { session_id: "   " }],
    ["approval.respond", { sessionId: "live-1", choice: "once" }],
  ] as const)("rejects invalid outbound params for %s before writing", async (method, params) => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    gateway.send(PINNED_READY_FRAME);
    await client.ready();
    const unsafeRequest = client.request.bind(client) as (
      method: string,
      params: unknown,
    ) => Promise<unknown>;

    const error = await unsafeRequest(method, params).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "HERMES_GATEWAY_INVALID_PARAMS" });
    expect(JSON.stringify(error)).not.toContain("hello");
    expect(gateway.stdinText()).toBe("");
    expect(gateway.terminate).not.toHaveBeenCalled();
    await client.dispose();
  });

  it("validates the serialized params rather than trusting a custom toJSON", async () => {
    vi.useFakeTimers();
    const gateway = fakeGateway();
    const client = createClient(gateway);
    gateway.send(PINNED_READY_FRAME);
    await client.ready();
    const params = { session_id: LIVE_SESSION_ID };
    Object.defineProperty(params, "toJSON", {
      enumerable: false,
      value: () => ({ sessionId: "serialized-secret-canary" }),
    });

    const outcome = client.request("session.status", params).catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(100);

    const error = await outcome;
    expect(error).toMatchObject({ code: "HERMES_GATEWAY_INVALID_PARAMS" });
    expect(JSON.stringify(error)).not.toContain("canary");
    expect(gateway.stdinText()).toBe("");
    expect(gateway.terminate).not.toHaveBeenCalled();
    await client.dispose();
  });

  it.each([
    [
      "session.create",
      {},
      { session_id: "live-secret-canary", message_count: 0, messages: [], info: {} },
    ],
    [
      "session.resume",
      { session_id: STORED_SESSION_ID },
      {
        session_id: LIVE_SESSION_ID,
        resumed: STORED_SESSION_ID,
        message_count: 0,
        messages: [],
        info: {},
        session_key: 42,
        started_at: 1,
        running: false,
        status: "idle",
      },
    ],
    [
      "session.resume",
      { session_id: STORED_SESSION_ID },
      {
        session_id: LIVE_SESSION_ID,
        resumed: STORED_SESSION_ID,
        message_count: 0,
        messages: [],
        info: {},
        session_key: STORED_SESSION_ID,
        started_at: 1,
        running: false,
        status: "unknown",
      },
    ],
    ["prompt.submit", { session_id: LIVE_SESSION_ID, text: "hello" }, { status: 42 }],
    ["session.interrupt", { session_id: LIVE_SESSION_ID }, { status: 42 }],
    ["session.close", { session_id: LIVE_SESSION_ID }, { closed: "yes" }],
    ["session.status", { session_id: LIVE_SESSION_ID }, { output: 42 }],
    [
      "approval.respond",
      { session_id: LIVE_SESSION_ID, choice: "once" },
      { resolved: "secret-result-canary" },
    ],
  ] as const)("fails closed on a malformed %s result", async (method, params, result) => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    gateway.send(PINNED_READY_FRAME);
    await client.ready();
    const unsafeRequest = client.request.bind(client) as (
      method: string,
      params: unknown,
    ) => Promise<unknown>;
    const pending = unsafeRequest(method, params);
    await Promise.resolve();

    gateway.send({ jsonrpc: "2.0", id: 1, result });

    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "HERMES_GATEWAY_PROTOCOL" });
    expect(JSON.stringify(error)).not.toContain("canary");
    expect(gateway.terminate).toHaveBeenCalledOnce();
  });
});

describe("Hermes gateway observer isolation", () => {
  it("consumes rejected notification listener promises without unhandledRejection", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    gateway.send(PINNED_READY_FRAME);
    await client.ready();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    client.subscribe(async () => {
      throw new Error("notification-listener-secret-canary");
    });

    gateway.send({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "message.delta", session_id: "live-1", payload: { text: "hello" } },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    process.removeListener("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    await client.dispose();
  });

  it("consumes rejected crash observer promises without unhandledRejection", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    client.onCrash(async () => {
      throw new Error("crash-listener-secret-canary");
    });

    gateway.process.emit("error", new Error("child-secret-canary"));
    await expect(client.ready()).rejects.toMatchObject({ code: "HERMES_GATEWAY_CRASHED" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    process.removeListener("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

interface FakeGateway {
  process: HermesGatewayProcess;
  stdin: PassThrough;
  stdout: PassThrough;
  terminate: ReturnType<typeof vi.fn<() => Promise<void>>>;
  send(message: unknown): void;
  stdinText(): string;
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
    stdin,
    stdout,
    terminate,
    send(message) {
      stdout.write(`${JSON.stringify(message)}\n`);
    },
    stdinText: () => stdinText,
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
    readyTimeoutMs: 20,
    requestTimeoutMs: 100,
  });
}
