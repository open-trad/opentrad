import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HERMES_GATEWAY_MAX_FRAME_BYTES,
  HermesGatewayClient,
  type HermesGatewayProcess,
} from "../src/main/services/hermes/gateway-client";
import {
  HERMES_GATEWAY_REQUEST_METHODS,
  isHermesGatewayRequestMethod,
} from "../src/main/services/hermes/gateway-protocol";

const LIVE_SESSION_ID = "deadbeef";
const SECOND_LIVE_SESSION_ID = "cafebabe";
const STORED_SESSION_ID = "20260711_120000_abcdef";

afterEach(() => {
  vi.useRealTimers();
});

describe("Hermes gateway request allowlist", () => {
  it("exports exactly the approved outbound methods and a matching runtime guard", () => {
    expect(HERMES_GATEWAY_REQUEST_METHODS).toEqual([
      "session.create",
      "prompt.submit",
      "session.interrupt",
      "session.close",
      "session.resume",
      "session.status",
      "approval.respond",
    ]);
    for (const method of HERMES_GATEWAY_REQUEST_METHODS) {
      expect(isHermesGatewayRequestMethod(method)).toBe(true);
    }
    for (const method of [
      "command.dispatch",
      "config.read",
      "config.write",
      "cli.exec",
      "process.spawn",
      "process.kill",
      "session.unknown",
      "",
      null,
    ]) {
      expect(isHermesGatewayRequestMethod(method)).toBe(false);
    }
  });
});

describe("HermesGatewayClient readiness and requests", () => {
  it("writes nothing before gateway.ready and then resolves a matching response", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);

    const result = client.request("session.status", { session_id: LIVE_SESSION_ID });
    await Promise.resolve();
    expect(gateway.stdinText()).toBe("");

    gateway.send(pinnedReadyFrame());
    await client.ready();
    const request = gateway.stdinMessages()[0];
    expect(request).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "session.status",
      params: { session_id: LIVE_SESSION_ID },
    });

    gateway.send({ jsonrpc: "2.0", id: request?.id, result: { output: "idle" } });
    await expect(result).resolves.toEqual({ output: "idle" });
    await client.dispose();
  });

  it.each([
    "command.dispatch",
    "config.read",
    "cli.exec",
    "process.spawn",
    "unknown",
  ])("rejects disallowed method %s before writing any stdin bytes", async (method) => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    const requestUnknown = client.request.bind(client) as (
      value: string,
      params?: unknown,
    ) => Promise<unknown>;

    const error = await requestUnknown(method, { canary: "secret-param-canary" }).catch(
      (cause: unknown) => cause,
    );

    expect(error).toMatchObject({
      name: "HermesGatewayError",
      code: "HERMES_GATEWAY_METHOD_DISALLOWED",
    });
    expect(String(error)).not.toContain("canary");
    expect(JSON.stringify(error)).not.toContain("canary");
    expect(gateway.stdinText()).toBe("");
    expect(gateway.terminate).not.toHaveBeenCalled();
    await client.dispose();
  });

  it("uses monotonic IDs, writes one line per request, and correlates reversed responses", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    gateway.send(pinnedReadyFrame());
    await client.ready();

    const first = client.request("session.create", {});
    const second = client.request("session.status", { session_id: SECOND_LIVE_SESSION_ID });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(gateway.stdinText().endsWith("\n")).toBe(true);
    expect(gateway.stdinMessages()).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "session.create",
        params: {},
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "session.status",
        params: { session_id: SECOND_LIVE_SESSION_ID },
      },
    ]);

    gateway.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { output: "second" } })}\n${JSON.stringify(
        {
          jsonrpc: "2.0",
          id: 1,
          result: {
            session_id: LIVE_SESSION_ID,
            stored_session_id: STORED_SESSION_ID,
            message_count: 0,
            messages: [],
            info: {},
          },
        },
      )}\n`,
    );
    await expect(first).resolves.toMatchObject({ stored_session_id: STORED_SESSION_ID });
    await expect(second).resolves.toEqual({ output: "second" });
    await client.dispose();
  });

  it("sanitizes valid server errors without killing the connection", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    gateway.send(pinnedReadyFrame());
    await client.ready();

    const failed = client.request("prompt.submit", {
      session_id: LIVE_SESSION_ID,
      text: "request-param-canary",
    });
    await Promise.resolve();
    gateway.send({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32602,
        message: "remote-message-canary",
        data: { secret: "remote-data-canary" },
      },
    });
    const error = await failed.catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      name: "HermesGatewayRemoteError",
      code: "HERMES_GATEWAY_REMOTE_ERROR",
      remoteCode: -32602,
      category: "invalid_params",
      message: "Hermes gateway request failed: invalid params",
    });
    expect(String(error)).not.toContain("canary");
    expect(JSON.stringify(error)).not.toContain("canary");
    expect(gateway.terminate).not.toHaveBeenCalled();

    const healthy = client.request("session.status", { session_id: SECOND_LIVE_SESSION_ID });
    await new Promise<void>((resolve) => setImmediate(resolve));
    gateway.send({ jsonrpc: "2.0", id: 2, result: { output: "healthy" } });
    await expect(healthy).resolves.toEqual({ output: "healthy" });
    await client.dispose();
  });

  it("does not write when params serialization disposes the client", async () => {
    vi.useFakeTimers();
    const gateway = fakeGateway();
    gateway.stdin.on("error", () => {});
    const client = createClient(gateway);
    gateway.send(pinnedReadyFrame());
    await client.ready();
    let disposal: Promise<void> | undefined;
    let outcome: unknown;

    void client
      .request(
        "session.status",
        serializableStatusParams(() => {
          disposal = client.dispose();
          return { session_id: LIVE_SESSION_ID };
        }),
      )
      .catch((error: unknown) => {
        outcome = error;
      });
    await Promise.resolve();
    await Promise.resolve();
    await disposal;

    expect(outcome).toMatchObject({ code: "HERMES_GATEWAY_DISPOSED" });
    expect(gateway.stdinText()).toBe("");
    expect(gateway.terminate).toHaveBeenCalledOnce();
  });

  it("does not write when params serialization crashes the child", async () => {
    vi.useFakeTimers();
    const gateway = fakeGateway();
    const client = createClient(gateway);
    gateway.send(pinnedReadyFrame());
    await client.ready();
    let outcome: unknown;

    void client
      .request(
        "session.status",
        serializableStatusParams(() => {
          gateway.process.emit("error", new Error("serializer-crash-canary"));
          return { session_id: LIVE_SESSION_ID };
        }),
      )
      .catch((error: unknown) => {
        outcome = error;
      });
    await Promise.resolve();
    await Promise.resolve();

    expect(outcome).toMatchObject({ code: "HERMES_GATEWAY_CRASHED" });
    expect(JSON.stringify(outcome)).not.toContain("canary");
    expect(gateway.stdinText()).toBe("");
    expect(gateway.terminate).toHaveBeenCalledOnce();
  });

  it("preserves a crash that occurs before params serialization throws", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    gateway.send(pinnedReadyFrame());
    await client.ready();

    const result = client.request(
      "session.status",
      serializableStatusParams(() => {
        gateway.process.emit("error", new Error("serializer-crash-canary"));
        throw new Error("serializer-throw-canary");
      }),
    );

    const error = await result.catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "HERMES_GATEWAY_CRASHED" });
    expect(String(error)).not.toContain("canary");
    expect(JSON.stringify(error)).not.toContain("canary");
    expect(gateway.stdinText()).toBe("");
    expect(gateway.terminate).toHaveBeenCalledOnce();
  });

  it("times out readiness, terminates once, and rejects requests waiting to write", async () => {
    vi.useFakeTimers();
    const gateway = fakeGateway();
    const client = createClient(gateway, { readyTimeoutMs: 20 });
    const ready = client.ready();
    const request = client.request("session.status", { session_id: LIVE_SESSION_ID });
    const readyResult = ready.catch((cause: unknown) => cause);
    const requestResult = request.catch((cause: unknown) => cause);

    await vi.advanceTimersByTimeAsync(20);

    for (const result of [readyResult, requestResult]) {
      const error = await result;
      expect(error).toMatchObject({ code: "HERMES_GATEWAY_READY_TIMEOUT" });
      expect(String(error)).not.toContain("canary");
      expect(JSON.stringify(error)).not.toContain("canary");
    }
    expect(gateway.stdinText()).toBe("");
    expect(gateway.terminate).toHaveBeenCalledOnce();
    gateway.process.emit("close", 1, null);
    await client.dispose();
    expect(gateway.terminate).toHaveBeenCalledOnce();
  });

  it("makes one request timeout fatal and rejects every pending request", async () => {
    vi.useFakeTimers();
    const gateway = fakeGateway();
    const client = createClient(gateway, { requestTimeoutMs: 20 });
    gateway.send(pinnedReadyFrame());
    await client.ready();
    const first = client.request("prompt.submit", {
      session_id: LIVE_SESSION_ID,
      text: "first-param-canary",
    });
    const second = client.request("session.status", { session_id: SECOND_LIVE_SESSION_ID });
    let firstError: unknown;
    let secondError: unknown;
    void first.catch((error: unknown) => {
      firstError = error;
    });
    void second.catch((error: unknown) => {
      secondError = error;
    });

    await vi.advanceTimersByTimeAsync(20);

    expect(firstError).toMatchObject({ code: "HERMES_GATEWAY_REQUEST_TIMEOUT" });
    expect(secondError).toMatchObject({ code: "HERMES_GATEWAY_REQUEST_TIMEOUT" });
    expect(JSON.stringify(firstError)).not.toContain("canary");
    expect(JSON.stringify(secondError)).not.toContain("canary");
    expect(gateway.terminate).toHaveBeenCalledOnce();
    await client.dispose();
  });
});

describe("HermesGatewayClient strict incremental NDJSON parsing", () => {
  it("handles a ready frame split across chunks and a UTF-8 notification split mid-codepoint", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    const received: unknown[] = [];
    client.subscribe((notification) => received.push(notification));
    const readyFrame = Buffer.from(`${JSON.stringify(pinnedReadyFrame())}\n`, "utf8");
    gateway.stdout.write(readyFrame.subarray(0, 9));
    gateway.stdout.write(readyFrame.subarray(9));
    await client.ready();

    const eventFrame = Buffer.from(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: { type: "session.output", session_id: "live-1", payload: { text: "你好" } },
      })}\n`,
      "utf8",
    );
    const splitAt = eventFrame.indexOf(Buffer.from("好", "utf8")) + 1;
    gateway.stdout.write(eventFrame.subarray(0, splitAt));
    gateway.stdout.write(eventFrame.subarray(splitAt));

    expect(received).toEqual([
      { method: "gateway.ready", params: { skin: "hermes" } },
      { method: "session.output", params: { text: "你好" }, sessionId: "live-1" },
    ]);
    await client.dispose();
  });

  it("queues stdout chunks emitted recursively by a notification listener", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    gateway.send(pinnedReadyFrame());
    await client.ready();
    const received: string[] = [];
    const nestedFrame = Buffer.from(`${JSON.stringify(gatewayEvent("event.nested"))}\n`, "utf8");
    const splitAt = Math.floor(nestedFrame.length / 2);
    client.subscribe(({ method }) => {
      received.push(method);
      if (method === "event.first") {
        gateway.stdout.emit("data", nestedFrame.subarray(0, splitAt));
      }
    });

    gateway.stdout.write(
      `${JSON.stringify(gatewayEvent("event.first"))}\n${JSON.stringify(
        gatewayEvent("event.second"),
      )}\n`,
    );
    gateway.stdout.emit("data", nestedFrame.subarray(splitAt));

    expect(received).toEqual(["event.first", "event.second", "event.nested"]);
    expect(gateway.terminate).not.toHaveBeenCalled();
    await client.dispose();
  });

  it.each([
    ["blank", "\n"],
    ["malformed JSON", "{not-json}\n"],
    ["null", "null\n"],
    ["array", "[]\n"],
    ["wrong jsonrpc", `${JSON.stringify({ ...pinnedReadyFrame(), jsonrpc: "1.0" })}\n`],
  ])("rejects a %s frame as a fatal protocol error", async (_label, frame) => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    const ready = client.ready();

    gateway.stdout.write(frame);

    const error = await ready.catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "HERMES_GATEWAY_PROTOCOL" });
    expect(String(error)).not.toContain("not-json");
    expect(gateway.terminate).toHaveBeenCalledOnce();
  });

  it.each([
    ["both result and error", { jsonrpc: "2.0", id: 1, result: null, error: {} }],
    ["string response id", { jsonrpc: "2.0", id: "1", result: null }],
    ["missing result and error", { jsonrpc: "2.0", id: 1 }],
    ["non-integer response id", { jsonrpc: "2.0", id: 1.5, result: null }],
    [
      "non-numeric error code",
      { jsonrpc: "2.0", id: 1, error: { code: "invalid", message: "bad" } },
    ],
    ["missing error message", { jsonrpc: "2.0", id: 1, error: { code: -32603 } }],
    [
      "response mixed with notification",
      { jsonrpc: "2.0", id: 1, method: "session.output", result: null },
    ],
    ["notification without method", { jsonrpc: "2.0", params: {} }],
  ])("rejects invalid message shape: %s", async (_label, invalidMessage) => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    gateway.send(pinnedReadyFrame());
    await client.ready();
    const pending = client.request("session.status", { session_id: LIVE_SESSION_ID });
    await Promise.resolve();

    gateway.send(invalidMessage);

    await expect(pending).rejects.toMatchObject({ code: "HERMES_GATEWAY_PROTOCOL" });
    expect(gateway.terminate).toHaveBeenCalledOnce();
  });

  it("rejects an unknown response ID", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    gateway.send(pinnedReadyFrame());
    await client.ready();

    gateway.send({ jsonrpc: "2.0", id: 999, result: null });

    await expect(
      client.request("session.status", { session_id: LIVE_SESSION_ID }),
    ).rejects.toMatchObject({
      code: "HERMES_GATEWAY_PROTOCOL",
    });
    expect(gateway.stdinText()).toBe("");
    expect(gateway.terminate).toHaveBeenCalledOnce();
  });

  it("rejects a duplicate response ID after resolving it once", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    gateway.send(pinnedReadyFrame());
    await client.ready();
    const request = client.request("session.status", { session_id: LIVE_SESSION_ID });
    await Promise.resolve();
    gateway.send({ jsonrpc: "2.0", id: 1, result: { output: "once" } });
    await expect(request).resolves.toEqual({ output: "once" });

    gateway.send({ jsonrpc: "2.0", id: 1, result: "twice" });

    await expect(
      client.request("session.status", { session_id: SECOND_LIVE_SESSION_ID }),
    ).rejects.toMatchObject({
      code: "HERMES_GATEWAY_PROTOCOL",
    });
    expect(gateway.terminate).toHaveBeenCalledOnce();
  });

  it("rejects an oversized complete frame even when its JSON is valid", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    const prefix = JSON.stringify(pinnedReadyFrame());
    const oversizedValidFrame = `${prefix}${" ".repeat(
      HERMES_GATEWAY_MAX_FRAME_BYTES + 1 - Buffer.byteLength(prefix),
    )}\n`;

    gateway.stdout.write(oversizedValidFrame);

    await expect(client.ready()).rejects.toMatchObject({ code: "HERMES_GATEWAY_PROTOCOL" });
    expect(gateway.terminate).toHaveBeenCalledOnce();
  });

  it("rejects an oversized incomplete frame without waiting for a newline", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    let readyError: unknown;
    void client.ready().catch((error: unknown) => {
      readyError = error;
    });

    gateway.stdout.write(Buffer.alloc(HERMES_GATEWAY_MAX_FRAME_BYTES + 1, 0x20));
    await Promise.resolve();

    expect(readyError).toMatchObject({ code: "HERMES_GATEWAY_PROTOCOL" });
    expect(gateway.terminate).toHaveBeenCalledOnce();
  });
});

describe("HermesGatewayClient notifications and lifecycle", () => {
  it("delivers broad server notifications and supports unsubscribe", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    const received: unknown[] = [];
    const unsubscribe = client.subscribe((notification) => received.push(notification));
    gateway.send(pinnedReadyFrame({ skin: "hermes", version: "1" }));
    gateway.send(gatewayEvent("tool.approval.requested", { approvalId: "approval-1" }, "live-1"));
    await client.ready();
    unsubscribe();
    gateway.send(gatewayEvent("config.changed", { hidden: true }));

    expect(received).toEqual([
      { method: "gateway.ready", params: { skin: "hermes", version: "1" } },
      {
        method: "tool.approval.requested",
        params: { approvalId: "approval-1" },
        sessionId: "live-1",
      },
    ]);
    await client.dispose();
  });

  it("treats duplicate gateway.ready notifications as harmless", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    gateway.send(pinnedReadyFrame());
    gateway.send(pinnedReadyFrame({ skin: "hermes", duplicate: true }));
    await client.ready();

    const request = client.request("session.status", { session_id: LIVE_SESSION_ID });
    await Promise.resolve();
    gateway.send({ jsonrpc: "2.0", id: 1, result: { output: "alive" } });

    await expect(request).resolves.toEqual({ output: "alive" });
    expect(gateway.terminate).not.toHaveBeenCalled();
    await client.dispose();
  });

  it.each([
    "error",
    "exit",
    "close",
  ] as const)("turns child %s into one sanitized crash event", async (event) => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    const crashes: unknown[] = [];
    client.onCrash((error) => crashes.push(error));
    const ready = client.ready();

    if (event === "error") gateway.process.emit(event, new Error("child-error-canary"));
    else gateway.process.emit(event, 17, "SIGKILL");

    const error = await ready.catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "HERMES_GATEWAY_CRASHED" });
    expect(String(error)).not.toContain("canary");
    expect(JSON.stringify(error)).not.toContain("canary");
    expect(crashes).toHaveLength(1);
    expect(crashes[0]).toBe(error);
    expect(gateway.terminate).toHaveBeenCalledOnce();
  });

  it("coalesces error, exit, and close while rejecting pending work", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    gateway.send(pinnedReadyFrame());
    await client.ready();
    const crashes = vi.fn();
    client.onCrash(crashes);
    const pending = client.request("prompt.submit", {
      session_id: LIVE_SESSION_ID,
      text: "pending-canary",
    });
    await Promise.resolve();

    gateway.stderr.write("stderr-secret-canary\n");
    gateway.process.emit("exit", 1, null);
    gateway.process.emit("close", 1, null);
    gateway.process.emit("error", new Error("child-secret-canary"));

    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "HERMES_GATEWAY_CRASHED" });
    expect(String(error)).not.toContain("canary");
    expect(JSON.stringify(error)).not.toContain("canary");
    expect(crashes).toHaveBeenCalledOnce();
    expect(gateway.terminate).toHaveBeenCalledOnce();
  });

  it("drains stderr without persisting it or reflecting it in errors", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    expect(gateway.stderr.listenerCount("data")).toBeGreaterThan(0);
    const ready = client.ready();

    gateway.stderr.write("stderr-drain-canary");
    gateway.process.emit("error", new Error("child-canary"));
    const error = await ready.catch((cause: unknown) => cause);

    expect(String(error)).not.toContain("canary");
    expect(JSON.stringify(error)).not.toContain("canary");
  });

  it("dispose is intentional and idempotent, ends stdin, and rejects pending work", async () => {
    const gateway = fakeGateway();
    gateway.terminate.mockImplementation(async () => {
      gateway.process.emit("error", new Error("intentional-shutdown-canary"));
      gateway.process.emit("close", 0, null);
    });
    const client = createClient(gateway);
    const crashes = vi.fn();
    client.onCrash(crashes);
    gateway.send(pinnedReadyFrame());
    await client.ready();
    const pending = client.request("session.status", { session_id: LIVE_SESSION_ID });
    await Promise.resolve();

    await Promise.all([client.dispose(), client.dispose()]);

    await expect(pending).rejects.toMatchObject({ code: "HERMES_GATEWAY_DISPOSED" });
    await expect(
      client.request("session.status", { session_id: SECOND_LIVE_SESSION_ID }),
    ).rejects.toMatchObject({
      code: "HERMES_GATEWAY_DISPOSED",
    });
    expect(gateway.stdin.writableEnded).toBe(true);
    expect(gateway.terminate).toHaveBeenCalledOnce();
    expect(crashes).not.toHaveBeenCalled();
  });

  it("shares a pending disposal promise before stdin.end can reenter dispose", async () => {
    const gateway = fakeGateway();
    let releaseTerminate: (() => void) | undefined;
    gateway.terminate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseTerminate = resolve;
        }),
    );
    const client = createClient(gateway);
    let reentrantDispose: Promise<void> | undefined;
    vi.spyOn(gateway.stdin, "end").mockImplementation((() => {
      reentrantDispose = client.dispose();
      return gateway.stdin;
    }) as typeof gateway.stdin.end);

    const firstDispose = client.dispose();
    let firstSettled = false;
    let reentrantSettled = false;
    void firstDispose.then(() => {
      firstSettled = true;
    });
    void reentrantDispose?.then(() => {
      reentrantSettled = true;
    });
    await Promise.resolve();

    expect(reentrantDispose).toBe(firstDispose);
    expect(gateway.terminate).toHaveBeenCalledOnce();
    expect(firstSettled).toBe(false);
    expect(reentrantSettled).toBe(false);

    releaseTerminate?.();
    await Promise.all([firstDispose, reentrantDispose]);
    expect(firstSettled).toBe(true);
    expect(reentrantSettled).toBe(true);
    expect(gateway.terminate).toHaveBeenCalledOnce();
  });

  it("dispose rejects ready and a request that was still waiting for ready", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    const ready = client.ready();
    const request = client.request("session.status", { session_id: LIVE_SESSION_ID });

    await client.dispose();

    await expect(ready).rejects.toMatchObject({ code: "HERMES_GATEWAY_DISPOSED" });
    await expect(request).rejects.toMatchObject({ code: "HERMES_GATEWAY_DISPOSED" });
    expect(gateway.stdinText()).toBe("");
    expect(gateway.terminate).toHaveBeenCalledOnce();
  });
});

function pinnedReadyFrame(payload: Record<string, unknown> = { skin: "hermes" }) {
  return gatewayEvent("gateway.ready", payload);
}

function gatewayEvent(type: string, payload: unknown = {}, sessionId?: string) {
  return {
    jsonrpc: "2.0",
    method: "event",
    params: {
      type,
      payload,
      ...(sessionId === undefined ? {} : { session_id: sessionId }),
    },
  };
}

function serializableStatusParams(toJSON: () => { readonly session_id: string }): {
  readonly session_id: string;
} {
  const params = { session_id: LIVE_SESSION_ID };
  Object.defineProperty(params, "toJSON", { enumerable: false, value: toJSON });
  return params;
}

interface FakeGateway {
  process: HermesGatewayProcess;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
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
  const process = Object.assign(child, { stdin, stdout, stderr }) as HermesGatewayProcess;
  const terminate = vi.fn(async () => {});
  return {
    process,
    stdin,
    stdout,
    stderr,
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

function createClient(
  gateway: FakeGateway,
  timeouts: { readyTimeoutMs?: number; requestTimeoutMs?: number } = {},
): HermesGatewayClient {
  return new HermesGatewayClient({
    process: gateway.process,
    terminate: gateway.terminate,
    readyTimeoutMs: timeouts.readyTimeoutMs ?? 100,
    requestTimeoutMs: timeouts.requestTimeoutMs ?? 100,
  });
}
