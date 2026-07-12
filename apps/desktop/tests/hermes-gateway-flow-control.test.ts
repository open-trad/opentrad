import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HERMES_GATEWAY_MAX_FRAME_BYTES,
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
const MAX_PROMPT_TEXT = "\u{1f642}".repeat(262_144);

afterEach(() => {
  vi.useRealTimers();
});

describe("Hermes gateway outbound flow control", () => {
  it("bounds pre-ready requests before the caller can retain large params", async () => {
    vi.useFakeTimers();
    const gateway = fakeGateway();
    const client = createClient(gateway, 20);

    const requests = Array.from({ length: 48 }, (_, index) =>
      client
        .request("prompt.submit", {
          session_id: liveSessionId(index),
          text: MAX_PROMPT_TEXT,
        })
        .catch((cause: unknown) => cause),
    );
    await vi.advanceTimersByTimeAsync(100);

    for (const request of requests) {
      expect(await request).toMatchObject({ code: "HERMES_GATEWAY_BACKPRESSURE" });
    }
    expect(gateway.stdinWrite).not.toHaveBeenCalled();
    expect(gateway.terminate).toHaveBeenCalledOnce();
  });

  it("snapshots serialized params before ready instead of retaining the caller object", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    const params = { session_id: LIVE_SESSION_ID, text: "before-ready" };

    const request = client.request("prompt.submit", params);
    params.text = "mutated-after-call";
    gateway.send(PINNED_READY_FRAME);
    await client.ready();
    await Promise.resolve();

    const frame = gateway.stdinWrite.mock.calls[0]?.[0];
    const message = JSON.parse(Buffer.from(frame as Uint8Array).toString("utf8")) as {
      params: { text: string };
    };
    expect(message.params.text).toBe("before-ready");
    gateway.send({ jsonrpc: "2.0", id: 1, result: { status: "streaming" } });
    await expect(request).resolves.toEqual({ status: "streaming" });
    await client.dispose();
  });

  it("counts write(true) frames as in-flight until their callbacks complete", async () => {
    vi.useFakeTimers();
    const stdin = new StalledWritable(16 * 1024 * 1024);
    const gateway = fakeGateway(stdin);
    const client = createClient(gateway, 20);
    gateway.send(PINNED_READY_FRAME);
    await client.ready();

    const requests = Array.from({ length: 10 }, (_, index) =>
      client
        .request("prompt.submit", {
          session_id: liveSessionId(index),
          text: MAX_PROMPT_TEXT,
        })
        .catch((cause: unknown) => cause),
    );
    await vi.advanceTimersByTimeAsync(20);

    for (const request of requests) {
      expect(await request).toMatchObject({ code: "HERMES_GATEWAY_BACKPRESSURE" });
    }
    expect(gateway.stdinWrite).toHaveBeenCalledOnce();
    expect(stdin.writableLength).toBeLessThanOrEqual(HERMES_GATEWAY_MAX_FRAME_BYTES);
    expect(gateway.terminate).toHaveBeenCalledOnce();
    stdin.releaseOne();
  });

  it("serializes writes and waits for drain after write returns false", async () => {
    const stdin = new StalledWritable();
    const gateway = fakeGateway(stdin);
    const client = createClient(gateway);
    gateway.send(PINNED_READY_FRAME);
    await client.ready();

    const first = client.request("session.status", { session_id: LIVE_SESSION_ID });
    const second = client.request("session.status", { session_id: SECOND_LIVE_SESSION_ID });
    await Promise.resolve();

    expect(gateway.stdinWrite).toHaveBeenCalledTimes(1);
    stdin.releaseOne();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(gateway.stdinWrite).toHaveBeenCalledTimes(2);

    gateway.send({ jsonrpc: "2.0", id: 1, result: { output: "first" } });
    gateway.send({ jsonrpc: "2.0", id: 2, result: { output: "second" } });
    await expect(first).resolves.toEqual({ output: "first" });
    await expect(second).resolves.toEqual({ output: "second" });
    stdin.releaseOne();
    await client.dispose();
  });

  it("rejects a prompt larger than the 1 MiB launcher contract before any write", async () => {
    vi.useFakeTimers();
    const stdin = new StalledWritable();
    const gateway = fakeGateway(stdin);
    const client = createClient(gateway, 20);
    gateway.send(PINNED_READY_FRAME);
    await client.ready();

    const request = client.request("prompt.submit", {
      session_id: LIVE_SESSION_ID,
      text: "x".repeat(HERMES_GATEWAY_MAX_FRAME_BYTES),
    });
    const outcome = request.catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(20);

    expect(await outcome).toMatchObject({ code: "HERMES_GATEWAY_INVALID_PARAMS" });
    expect(gateway.stdinWrite).not.toHaveBeenCalled();
    expect(gateway.terminate).not.toHaveBeenCalled();
    await client.dispose();
  });

  it("fails closed when stalled queued bytes exceed the hard limit", async () => {
    vi.useFakeTimers();
    const stdin = new StalledWritable();
    const gateway = fakeGateway(stdin);
    const client = createClient(gateway, 20);
    gateway.send(PINNED_READY_FRAME);
    await client.ready();

    const first = client.request("session.status", { session_id: LIVE_SESSION_ID });
    const prompts = Array.from({ length: 4 }, (_, index) =>
      client.request("prompt.submit", {
        session_id: liveSessionId(index),
        text: MAX_PROMPT_TEXT,
      }),
    );
    const outcomes = [first, ...prompts].map((promise) => promise.catch((cause: unknown) => cause));
    await vi.advanceTimersByTimeAsync(20);

    for (const outcome of outcomes) {
      expect(await outcome).toMatchObject({ code: "HERMES_GATEWAY_BACKPRESSURE" });
    }
    expect(gateway.terminate).toHaveBeenCalledOnce();
    stdin.releaseOne();
  });

  it("counts a write(false) frame against the byte limit until drain", async () => {
    vi.useFakeTimers();
    const stdin = new StalledWritable();
    const gateway = fakeGateway(stdin);
    const client = createClient(gateway, 20);
    gateway.send(PINNED_READY_FRAME);
    await client.ready();

    const requests = Array.from({ length: 4 }, (_, index) =>
      client.request("prompt.submit", {
        session_id: liveSessionId(index),
        text: MAX_PROMPT_TEXT,
      }),
    );
    const outcomes = requests.map((promise) => promise.catch((cause: unknown) => cause));
    await vi.advanceTimersByTimeAsync(20);

    for (const outcome of outcomes) {
      expect(await outcome).toMatchObject({ code: "HERMES_GATEWAY_BACKPRESSURE" });
    }
    expect(gateway.stdinWrite).toHaveBeenCalledOnce();
    expect(gateway.terminate).toHaveBeenCalledOnce();
    stdin.releaseOne();
  });

  it("fails closed when pending request count exceeds 64", async () => {
    vi.useFakeTimers();
    const stdin = new StalledWritable();
    const gateway = fakeGateway(stdin);
    const client = createClient(gateway, 20);
    gateway.send(PINNED_READY_FRAME);
    await client.ready();

    const requests = Array.from({ length: 65 }, (_, index) =>
      client
        .request("session.status", { session_id: liveSessionId(index) })
        .catch((cause: unknown) => cause),
    );
    await vi.advanceTimersByTimeAsync(20);

    for (const request of requests) {
      expect(await request).toMatchObject({ code: "HERMES_GATEWAY_BACKPRESSURE" });
    }
    expect(gateway.terminate).toHaveBeenCalledOnce();
    expect(gateway.stdinWrite).toHaveBeenCalledTimes(1);
    stdin.releaseOne();
  });

  it.each([
    "dispose",
    "stream error",
    "timeout",
  ] as const)("does not write a queued frame after %s wins the drain race", async (winner) => {
    if (winner === "timeout") vi.useFakeTimers();
    const stdin = new StalledWritable();
    const gateway = fakeGateway(stdin);
    const client = createClient(gateway, 20);
    gateway.send(PINNED_READY_FRAME);
    await client.ready();
    const first = client
      .request("session.status", { session_id: LIVE_SESSION_ID })
      .catch((cause: unknown) => cause);
    const second = client
      .request("session.status", { session_id: SECOND_LIVE_SESSION_ID })
      .catch((cause: unknown) => cause);
    await Promise.resolve();
    expect(gateway.stdinWrite).toHaveBeenCalledTimes(1);

    if (winner === "dispose") await client.dispose();
    else if (winner === "stream error") stdin.emit("error", new Error("secret-canary"));
    else await vi.advanceTimersByTimeAsync(20);
    stdin.releaseOne();
    await Promise.resolve();

    const expectedCode =
      winner === "dispose"
        ? "HERMES_GATEWAY_DISPOSED"
        : winner === "timeout"
          ? "HERMES_GATEWAY_REQUEST_TIMEOUT"
          : "HERMES_GATEWAY_CRASHED";
    expect(await first).toMatchObject({ code: expectedCode });
    expect(await second).toMatchObject({ code: expectedCode });
    expect(gateway.stdinWrite).toHaveBeenCalledTimes(1);
    expect(stdin.listenerCount("drain")).toBe(0);
  });

  it.each([
    true,
    false,
  ])("does not restore write state when stdin.write reenters dispose and returns %s", async (accepted) => {
    const stdin = new ManualWritable([accepted]);
    const gateway = fakeGateway(stdin as unknown as Writable);
    const client = createClient(gateway);
    gateway.send(PINNED_READY_FRAME);
    await client.ready();
    let disposal: Promise<void> | undefined;
    stdin.onWrite = () => {
      disposal = client.dispose();
    };

    const request = client
      .request("session.status", { session_id: LIVE_SESSION_ID })
      .catch((cause: unknown) => cause);
    await Promise.resolve();
    await disposal;

    expect(await request).toMatchObject({ code: "HERMES_GATEWAY_DISPOSED" });
    expect(stdin.listenerCount("drain")).toBe(0);
    stdin.emit("drain");
    stdin.completeNext();
    await Promise.resolve();
    expect(stdin.listenerCount("drain")).toBe(0);
    expect(gateway.stdinWrite).toHaveBeenCalledOnce();
    expect(gateway.terminate).toHaveBeenCalledOnce();
  });

  it.each([
    "callback-first",
    "drain-first",
  ] as const)("waits for both callback and drain when %s", async (order) => {
    const stdin = new ManualWritable([false, true]);
    const gateway = fakeGateway(stdin as unknown as Writable);
    const client = createClient(gateway);
    gateway.send(PINNED_READY_FRAME);
    await client.ready();
    const first = client.request("session.status", { session_id: LIVE_SESSION_ID });
    const second = client.request("session.status", { session_id: SECOND_LIVE_SESSION_ID });
    await Promise.resolve();
    expect(gateway.stdinWrite).toHaveBeenCalledOnce();

    if (order === "callback-first") stdin.completeNext();
    else stdin.emit("drain");
    await Promise.resolve();
    expect(gateway.stdinWrite).toHaveBeenCalledOnce();

    if (order === "callback-first") stdin.emit("drain");
    else stdin.completeNext();
    await Promise.resolve();
    expect(gateway.stdinWrite).toHaveBeenCalledTimes(2);

    stdin.completeNext();
    gateway.send({ jsonrpc: "2.0", id: 1, result: { output: "first" } });
    gateway.send({ jsonrpc: "2.0", id: 2, result: { output: "second" } });
    await expect(first).resolves.toEqual({ output: "first" });
    await expect(second).resolves.toEqual({ output: "second" });
    await client.dispose();
  });

  it("continues a successful queue after each write callback", async () => {
    const stdin = new ManualWritable([true, true, true]);
    const gateway = fakeGateway(stdin as unknown as Writable);
    const client = createClient(gateway);
    gateway.send(PINNED_READY_FRAME);
    await client.ready();
    const requests = [LIVE_SESSION_ID, SECOND_LIVE_SESSION_ID, "0123abcd"].map((session_id) =>
      client.request("session.status", { session_id }),
    );
    await Promise.resolve();
    expect(gateway.stdinWrite).toHaveBeenCalledOnce();

    stdin.completeNext();
    await Promise.resolve();
    expect(gateway.stdinWrite).toHaveBeenCalledTimes(2);
    stdin.completeNext();
    await Promise.resolve();
    expect(gateway.stdinWrite).toHaveBeenCalledTimes(3);
    stdin.completeNext();

    for (let id = 1; id <= 3; id += 1) {
      gateway.send({ jsonrpc: "2.0", id, result: { output: String(id) } });
    }
    await expect(Promise.all(requests)).resolves.toEqual([
      { output: "1" },
      { output: "2" },
      { output: "3" },
    ]);
    await client.dispose();
  });

  it("fails closed on a response for a queued unsent request and never writes it later", async () => {
    vi.useFakeTimers();
    const stdin = new StalledWritable();
    const gateway = fakeGateway(stdin);
    const client = createClient(gateway, 20);
    gateway.send(PINNED_READY_FRAME);
    await client.ready();
    const first = client
      .request("session.status", { session_id: LIVE_SESSION_ID })
      .catch((cause: unknown) => cause);
    const unsent = client
      .request("session.status", { session_id: SECOND_LIVE_SESSION_ID })
      .catch((cause: unknown) => cause);
    await Promise.resolve();
    expect(gateway.stdinWrite).toHaveBeenCalledOnce();

    gateway.send({ jsonrpc: "2.0", id: 2, result: { output: "forged-early" } });
    stdin.releaseOne();
    await vi.advanceTimersByTimeAsync(20);

    expect(await first).toMatchObject({ code: "HERMES_GATEWAY_PROTOCOL" });
    expect(await unsent).toMatchObject({ code: "HERMES_GATEWAY_PROTOCOL" });
    expect(gateway.stdinWrite).toHaveBeenCalledOnce();
    expect(gateway.terminate).toHaveBeenCalledOnce();
  });

  it("marks a frame sent before stdin.write can synchronously deliver its response", async () => {
    const stdin = new ManualWritable([true]);
    const gateway = fakeGateway(stdin as unknown as Writable);
    const client = createClient(gateway);
    gateway.send(PINNED_READY_FRAME);
    await client.ready();
    stdin.onWrite = () => {
      gateway.send({ jsonrpc: "2.0", id: 1, result: { output: "synchronous" } });
    };

    const request = client.request("session.status", { session_id: LIVE_SESSION_ID });

    await expect(request).resolves.toEqual({ output: "synchronous" });
    expect(gateway.terminate).not.toHaveBeenCalled();
    stdin.completeNext();
    await client.dispose();
  });

  it("fails closed before reusing an unsafe request ID", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    gateway.send(PINNED_READY_FRAME);
    await client.ready();
    (client as unknown as { nextRequestId: number }).nextRequestId = Number.MAX_SAFE_INTEGER;

    const lastSafe = client.request("session.status", { session_id: LIVE_SESSION_ID });
    await Promise.resolve();
    gateway.send({
      jsonrpc: "2.0",
      id: Number.MAX_SAFE_INTEGER,
      result: { output: "ok" },
    });
    await expect(lastSafe).resolves.toEqual({ output: "ok" });
    await expect(
      client.request("session.status", { session_id: SECOND_LIVE_SESSION_ID }),
    ).rejects.toMatchObject({
      code: "HERMES_GATEWAY_PROTOCOL",
    });
    expect(gateway.stdinWrite).toHaveBeenCalledOnce();
    expect(gateway.terminate).toHaveBeenCalledOnce();
  });
});

describe("Hermes gateway bounded inbound accumulation", () => {
  it("accepts one-byte chunks before a newline without unbounded segments", async () => {
    const gateway = fakeGateway();
    const client = createClient(gateway);
    const concat = vi.spyOn(Buffer, "concat");

    for (let index = 0; index < 512; index += 1) {
      gateway.stdout.write(Buffer.from(" "));
    }

    expect(concat.mock.calls.length).toBeLessThanOrEqual(1);
    gateway.stdout.write(Buffer.from(`${JSON.stringify(PINNED_READY_FRAME)}\n`));
    await expect(client.ready()).resolves.toBeUndefined();
    await client.dispose();
  });
});

describe("Hermes gateway cleanup failures", () => {
  it("rejects dispose with a sanitized cleanup error and retains error protection", async () => {
    const gateway = fakeGateway();
    gateway.terminate.mockRejectedValue(new Error("terminate-secret-canary"));
    const client = createClient(gateway);

    const error = await client.dispose().catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "HERMES_GATEWAY_CLEANUP" });
    expect(String(error)).not.toContain("canary");
    expect(JSON.stringify(error)).not.toContain("canary");
    expect(gateway.terminate).toHaveBeenCalledOnce();
    expect(gateway.process.listenerCount("error")).toBeGreaterThan(0);
    expect(() => gateway.process.emit("error", new Error("late-secret-canary"))).not.toThrow();
  });

  it("removes protection listeners only after successful termination", async () => {
    const gateway = fakeGateway();
    let resolveTermination: (() => void) | undefined;
    gateway.terminate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveTermination = resolve;
        }),
    );
    const client = createClient(gateway);

    const disposal = client.dispose();
    await Promise.resolve();
    expect(gateway.process.listenerCount("error")).toBeGreaterThan(0);
    resolveTermination?.();
    await disposal;
    expect(gateway.process.listenerCount("error")).toBe(0);
  });
});

class StalledWritable extends Writable {
  private readonly callbacks: Array<(error?: Error | null) => void> = [];

  constructor(highWaterMark = 1) {
    super({ highWaterMark });
  }

  override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.callbacks.push(callback);
  }

  releaseOne(): void {
    this.callbacks.shift()?.();
  }
}

class ManualWritable extends EventEmitter {
  private readonly callbacks: Array<(error?: Error | null) => void> = [];
  private readonly accepted: boolean[];
  writableEnded = false;
  onWrite: (() => void) | undefined;

  constructor(accepted: boolean[]) {
    super();
    this.accepted = [...accepted];
  }

  write(_chunk: Buffer, callback?: (error?: Error | null) => void): boolean {
    if (callback) this.callbacks.push(callback);
    this.onWrite?.();
    return this.accepted.shift() ?? true;
  }

  end(): this {
    this.writableEnded = true;
    return this;
  }

  completeNext(error?: Error | null): void {
    this.callbacks.shift()?.(error);
  }
}

interface FakeGateway {
  process: HermesGatewayProcess;
  stdout: PassThrough;
  terminate: ReturnType<typeof vi.fn<() => Promise<void>>>;
  stdinWrite: ReturnType<typeof vi.spyOn>;
  send(message: unknown): void;
}

function fakeGateway(stdin: Writable = new PassThrough()): FakeGateway {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  if (stdin instanceof PassThrough) stdin.resume();
  stderr.resume();
  const process = Object.assign(child, { stdin, stdout, stderr }) as HermesGatewayProcess;
  const terminate = vi.fn(async () => {});
  const stdinWrite = vi.spyOn(stdin, "write");
  return {
    process,
    stdout,
    terminate,
    stdinWrite,
    send(message) {
      stdout.write(`${JSON.stringify(message)}\n`);
    },
  };
}

function createClient(gateway: FakeGateway, requestTimeoutMs = 100): HermesGatewayClient {
  return new HermesGatewayClient({
    process: gateway.process,
    terminate: gateway.terminate,
    readyTimeoutMs: 100,
    requestTimeoutMs,
  });
}

function liveSessionId(index: number): string {
  return index.toString(16).padStart(8, "0");
}
