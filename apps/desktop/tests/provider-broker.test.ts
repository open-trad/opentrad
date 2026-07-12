import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderBroker,
  type ProviderCredentialLease,
  type ProviderDispatcher,
  type ProviderDispatchRequest,
} from "../src/main/services/provider-broker";

const brokers: ProviderBroker[] = [];
const EMPTY_CREDENTIAL_LEASE: ProviderCredentialLease = Object.freeze({ secrets: [] });

afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
});

describe("ProviderBroker", () => {
  it("binds an operating-system-selected port on IPv4 loopback only", async () => {
    const broker = new ProviderBroker({
      dispatcher: async () => ({ kind: "json", body: { ok: true } }),
    });
    brokers.push(broker);

    const endpoint = await broker.start();

    expect(endpoint.host).toBe("127.0.0.1");
    expect(endpoint.port).toBeGreaterThan(0);
    await expect(canConnect("127.0.0.1", endpoint.port)).resolves.toBe(true);
    await expect(canConnect("::1", endpoint.port)).resolves.toBe(false);
  });

  it("dispatches an authorized request through the capability-bound profile and model", async () => {
    let dispatched: ProviderDispatchRequest | undefined;
    const dispatcher: ProviderDispatcher = async (request) => {
      dispatched = request;
      return { kind: "json", body: { id: "response-1" } };
    };
    const broker = new ProviderBroker({ dispatcher });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = broker.issue(
      {
        taskId: "task-1",
        runId: "run-1",
        profileId: "profile-1",
        model: "gpt-5.2",
        apiMode: "chat_completions",
        ttlMs: 30_000,
      },
      EMPTY_CREDENTIAL_LEASE,
    );

    expect(capability.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(capability.capabilityId).toMatch(/^[0-9a-f-]{36}$/);
    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "gpt-5.2",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "response-1" });
    expect(dispatched).toMatchObject({
      profileId: "profile-1",
      model: "gpt-5.2",
      apiMode: "chat_completions",
      body: {
        model: "gpt-5.2",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(Object.keys(dispatched ?? {})).toEqual([
      "profileId",
      "model",
      "apiMode",
      "body",
      "signal",
    ]);
  });

  it("rejects a non-boolean request stream field before dispatch without reflecting it", async () => {
    const dispatcher = vi.fn<ProviderDispatcher>();
    const broker = new ProviderBroker({ dispatcher });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-invalid-stream-field",
      runId: "run-invalid-stream-field",
      profileId: "profile-invalid-stream-field",
      model: "model-invalid-stream-field",
    });
    const canary = "invalid-stream-field-canary";

    for (const stream of [canary, 1, null]) {
      const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
        model: "model-invalid-stream-field",
        stream,
      });
      const rendered = await response.text();

      expect(response.status).toBe(400);
      expect(JSON.parse(rendered)).toEqual({
        error: {
          category: "invalid_request",
          retryable: false,
          message: "Provider request is invalid",
        },
      });
      expect(rendered).not.toContain(canary);
    }
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it("rejects a JSON dispatcher result when the request requires streaming", async () => {
    const broker = new ProviderBroker({
      dispatcher: async () => ({ kind: "json", body: { mustNotBeWritten: true } }),
    });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-json-stream-mismatch",
      runId: "run-json-stream-mismatch",
      profileId: "profile-json-stream-mismatch",
      model: "model-json-stream-mismatch",
    });

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-json-stream-mismatch",
      stream: true,
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: {
        category: "dispatch_failed",
        retryable: true,
        message: "Provider request failed",
      },
    });
  });

  it("cleans a stream dispatcher result when the request does not enable streaming", async () => {
    for (const [index, stream] of [false, undefined].entries()) {
      let nextCalls = 0;
      let returnCalls = 0;
      let dispatcherSignal: AbortSignal | undefined;
      const body: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            nextCalls += 1;
            return Promise.resolve({ done: true, value: undefined } as const);
          },
          return: () => {
            returnCalls += 1;
            return Promise.resolve({ done: true, value: undefined } as const);
          },
        }),
      };
      const broker = new ProviderBroker({
        dispatcher: async (request) => {
          dispatcherSignal = request.signal;
          return { kind: "stream", body };
        },
      });
      brokers.push(broker);
      const endpoint = await broker.start();
      const capability = issueFor(broker, {
        taskId: `task-stream-result-mismatch-${index}`,
        runId: `run-stream-result-mismatch-${index}`,
        profileId: `profile-stream-result-mismatch-${index}`,
        model: `model-stream-result-mismatch-${index}`,
      });
      const requestBody: Record<string, unknown> = {
        model: `model-stream-result-mismatch-${index}`,
      };
      if (stream !== undefined) requestBody.stream = stream;

      const response = await postJson(
        endpoint.port,
        "/v1/chat/completions",
        capability.token,
        requestBody,
      );

      expect(response.status).toBe(502);
      expect((await response.json()).error.category).toBe("dispatch_failed");
      expect(nextCalls).toBe(0);
      expect(returnCalls).toBe(1);
      expect(dispatcherSignal?.aborted).toBe(true);
    }
  });

  it("rejects a missing bearer before dispatch with a fixed unauthorized error", async () => {
    const dispatcher = vi.fn<ProviderDispatcher>();
    const broker = new ProviderBroker({ dispatcher });
    brokers.push(broker);
    const endpoint = await broker.start();

    const response = await fetch(`http://127.0.0.1:${endpoint.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "attacker-model", secret: "request-canary" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        category: "unauthorized",
        retryable: false,
        message: "Provider capability required",
      },
    });
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it("does not dispatch across method, route, API mode, or model boundaries", async () => {
    const dispatcher = vi.fn<ProviderDispatcher>();
    const broker = new ProviderBroker({ dispatcher });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = broker.issue(
      {
        taskId: "task-scope",
        runId: "run-scope",
        profileId: "profile-scope",
        model: "bound-model",
        apiMode: "chat_completions",
        ttlMs: 30_000,
      },
      EMPTY_CREDENTIAL_LEASE,
    );
    const cases = [
      {
        method: "GET",
        path: "/v1/chat/completions",
        body: undefined,
        status: 405,
        category: "method_not_allowed",
      },
      {
        method: "POST",
        path: "/v1/unknown",
        body: { model: "bound-model" },
        status: 404,
        category: "route_not_found",
      },
      {
        method: "POST",
        path: "/v1/responses",
        body: { model: "bound-model" },
        status: 403,
        category: "capability_scope_mismatch",
      },
      {
        method: "POST",
        path: "/v1/chat/completions",
        body: { model: "other-model" },
        status: 403,
        category: "capability_scope_mismatch",
      },
    ] as const;

    for (const testCase of cases) {
      const response = await requestJson(
        endpoint.port,
        testCase.method,
        testCase.path,
        capability.token,
        testCase.body,
      );
      expect(response.status, `${testCase.method} ${testCase.path}`).toBe(testCase.status);
      const payload = (await response.json()) as { error: { category: string } };
      expect(payload.error.category).toBe(testCase.category);
    }
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it("rejects invalid capability bindings and TTLs without reflecting their values", () => {
    const broker = new ProviderBroker({
      dispatcher: async () => ({ kind: "json", body: { ok: true } }),
    });
    brokers.push(broker);
    const canary = "invalid-capability-canary";
    const valid = {
      taskId: "task-valid",
      runId: "run-valid",
      profileId: "profile-valid",
      model: "model-valid",
      apiMode: "chat_completions" as const,
      ttlMs: 30_000,
    };

    for (const input of [
      { ...valid, taskId: "" },
      { ...valid, runId: "" },
      { ...valid, profileId: canary.repeat(20) },
      { ...valid, model: "" },
      { ...valid, ttlMs: 0 },
      { ...valid, ttlMs: 999 },
      { ...valid, ttlMs: 300_001 },
      { ...valid, ttlMs: 1.5 },
      { ...valid, ttlMs: Number.NaN },
    ]) {
      let thrown: unknown;
      try {
        broker.issue(input, EMPTY_CREDENTIAL_LEASE);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(String(thrown)).toBe("ProviderBrokerError: Provider capability is invalid");
      expect(String(thrown)).not.toContain(canary);
    }
  });

  it("fails closed when runtime callers bypass capability input types", () => {
    const broker = new ProviderBroker({
      dispatcher: async () => ({ kind: "json", body: { ok: true } }),
    });
    brokers.push(broker);
    const valid = {
      taskId: "task-runtime-validation",
      runId: "run-runtime-validation",
      profileId: "profile-runtime-validation",
      model: "model-runtime-validation",
      apiMode: "chat_completions" as const,
      ttlMs: 30_000,
    };

    for (const input of [null, { ...valid, model: 7 }]) {
      expect(() => broker.issue(input as never, EMPTY_CREDENTIAL_LEASE)).toThrow(
        "Provider capability is invalid",
      );
    }
  });

  it("requires an explicit credential lease even for a no-credential endpoint", () => {
    const broker = new ProviderBroker({
      dispatcher: async () => ({ kind: "json", body: { ok: true } }),
    });
    brokers.push(broker);
    const issueWithoutLease = broker.issue as unknown as (
      input: Parameters<ProviderBroker["issue"]>[0],
    ) => ReturnType<ProviderBroker["issue"]>;

    expect(() =>
      issueWithoutLease.call(broker, {
        taskId: "task-missing-lease",
        runId: "run-missing-lease",
        profileId: "profile-missing-lease",
        model: "model-missing-lease",
        apiMode: "chat_completions",
        ttlMs: 30_000,
      }),
    ).toThrow("Provider capability is invalid");
  });

  it("uses lease credentials for input rejection and output redaction without dispatcher help", async () => {
    const leaseSecret = "sk-provider-required-lease-secret";
    const dispatcher = vi.fn<ProviderDispatcher>(async () => ({
      kind: "json",
      body: { credential: leaseSecret },
    }));
    const broker = new ProviderBroker({ dispatcher });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueWithLease(
      broker,
      {
        taskId: "task-required-lease",
        runId: "run-required-lease",
        profileId: "profile-required-lease",
        model: "model-required-lease",
        apiMode: "chat_completions",
        ttlMs: 30_000,
      },
      { secrets: [leaseSecret] },
    );

    const safeRequest = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-required-lease",
    });
    const safeRendered = await safeRequest.text();
    const rejectedRequest = await postJson(
      endpoint.port,
      "/v1/chat/completions",
      capability.token,
      { model: "model-required-lease", accidental: `before-${leaseSecret}-after` },
    );

    expect(safeRequest.status).toBe(200);
    expect(JSON.parse(safeRendered)).toEqual({ credential: "[REDACTED]" });
    expect(safeRendered).not.toContain(leaseSecret);
    expect(rejectedRequest.status).toBe(400);
    expect((await rejectedRequest.json()).error.category).toBe("sensitive_input");
    expect(dispatcher).toHaveBeenCalledOnce();
  });

  it("rejects a capability token reconstructed across request JSON leaves before dispatch", async () => {
    const dispatcher = vi.fn<ProviderDispatcher>();
    const broker = new ProviderBroker({ dispatcher });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-split-sensitive-input",
      runId: "run-split-sensitive-input",
      profileId: "profile-split-sensitive-input",
      model: "model-split-sensitive-input",
    });
    const split = 21;

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-split-sensitive-input",
      first: capability.token.slice(0, split),
      metadata: "unrelated-leaf",
      last: capability.token.slice(split),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        category: "sensitive_input",
        retryable: false,
        message: "Provider request contains a protected value",
      },
    });
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it("rejects a capability token reconstructed through request object keys", async () => {
    const dispatcher = vi.fn<ProviderDispatcher>();
    const broker = new ProviderBroker({ dispatcher });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-split-sensitive-key",
      runId: "run-split-sensitive-key",
      profileId: "profile-split-sensitive-key",
      model: "model-split-sensitive-key",
    });
    const split = 21;
    const head = capability.token.slice(0, split);
    const tail = capability.token.slice(split);
    const bodies = [
      { model: "model-split-sensitive-key", [head]: 1, [tail]: 2 },
      { model: "model-split-sensitive-key", [head]: tail },
    ];

    for (const body of bodies) {
      const response = await postJson(
        endpoint.port,
        "/v1/chat/completions",
        capability.token,
        body,
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error.category).toBe("sensitive_input");
    }
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it("rejects JSON that can reconstruct a lease credential across ordered leaf strings", async () => {
    const leaseSecret = "sk-provider-split-json-secret";
    const split = 13;
    const first = leaseSecret.slice(0, split);
    const last = leaseSecret.slice(split);
    const bodies = [{ pieces: [first, last] }, { first, metadata: "unrelated-leaf", last }];

    for (const [index, body] of bodies.entries()) {
      const broker = new ProviderBroker({
        dispatcher: async () => ({ kind: "json", body }),
      });
      brokers.push(broker);
      const endpoint = await broker.start();
      const capability = issueWithLease(
        broker,
        {
          taskId: `task-json-split-${index}`,
          runId: `run-json-split-${index}`,
          profileId: `profile-json-split-${index}`,
          model: `model-json-split-${index}`,
          apiMode: "chat_completions",
          ttlMs: 30_000,
        },
        { secrets: [leaseSecret] },
      );

      const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
        model: `model-json-split-${index}`,
      });
      const rendered = await response.text();

      expect(response.status).toBe(502);
      expect(JSON.parse(rendered).error.category).toBe("dispatch_failed");
      expect(rendered).not.toContain(leaseSecret);
      expect(rendered).not.toContain(first);
      expect(rendered).not.toContain(last);
    }
  });

  it("rejects JSON that reconstructs a lease credential through object keys", async () => {
    const leaseSecret = "sk-provider-split-json-key-secret";
    const split = 15;
    const head = leaseSecret.slice(0, split);
    const tail = leaseSecret.slice(split);
    const bodies = [{ [head]: 1, [tail]: 2 }, { [head]: tail }];

    for (const [index, body] of bodies.entries()) {
      const broker = new ProviderBroker({
        dispatcher: async () => ({ kind: "json", body }),
      });
      brokers.push(broker);
      const endpoint = await broker.start();
      const capability = issueWithLease(
        broker,
        {
          taskId: `task-json-split-key-${index}`,
          runId: `run-json-split-key-${index}`,
          profileId: `profile-json-split-key-${index}`,
          model: `model-json-split-key-${index}`,
          apiMode: "chat_completions",
          ttlMs: 30_000,
        },
        { secrets: [leaseSecret] },
      );

      const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
        model: `model-json-split-key-${index}`,
      });
      const rendered = await response.text();

      expect(response.status).toBe(502);
      expect(JSON.parse(rendered).error.category).toBe("dispatch_failed");
      expect(rendered).not.toContain(head);
      expect(rendered).not.toContain(tail);
    }
  });

  it("snapshots every capability and lease field exactly once before validation", () => {
    const reads = {
      taskId: 0,
      runId: 0,
      profileId: 0,
      model: 0,
      apiMode: 0,
      ttlMs: 0,
      secrets: 0,
    };
    const input = Object.defineProperties(
      {},
      {
        taskId: {
          get: () => {
            reads.taskId += 1;
            return "task-snapshot";
          },
        },
        runId: {
          get: () => {
            reads.runId += 1;
            return "run-snapshot";
          },
        },
        profileId: {
          get: () => {
            reads.profileId += 1;
            return "profile-snapshot";
          },
        },
        model: {
          get: () => {
            reads.model += 1;
            return "model-snapshot";
          },
        },
        apiMode: {
          get: () => {
            reads.apiMode += 1;
            return "chat_completions";
          },
        },
        ttlMs: {
          get: () => {
            reads.ttlMs += 1;
            return reads.ttlMs === 1 ? 1_000 : 1_000_000;
          },
        },
      },
    );
    const lease = Object.defineProperty({}, "secrets", {
      get: () => {
        reads.secrets += 1;
        return [];
      },
    });
    const broker = new ProviderBroker({
      dispatcher: async () => ({ kind: "json", body: { ok: true } }),
      now: () => 1_999,
    });
    brokers.push(broker);

    const capability = issueWithLease(broker, input as never, lease as never);

    expect(capability.expiresAt).toBe(2);
    expect(reads).toEqual({
      taskId: 1,
      runId: 1,
      profileId: 1,
      model: 1,
      apiMode: 1,
      ttlMs: 1,
      secrets: 1,
    });
  });

  it("turns a throwing capability getter into the fixed validation error", () => {
    const canary = "capability-getter-canary";
    const broker = new ProviderBroker({
      dispatcher: async () => ({ kind: "json", body: { ok: true } }),
    });
    brokers.push(broker);
    const input = Object.defineProperty({}, "taskId", {
      get: () => {
        throw new Error(canary);
      },
    });

    let thrown: unknown;
    try {
      issueWithLease(broker, input as never, { secrets: [] });
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toBe("ProviderBrokerError: Provider capability is invalid");
    expect(String(thrown)).not.toContain(canary);
  });

  it("snapshots lease array length and indices without invoking its iterator", () => {
    const leaseSecret = "sk-provider-indexed-lease-secret";
    let lengthReads = 0;
    let elementReads = 0;
    let iteratorReads = 0;
    const secrets = new Proxy([leaseSecret], {
      get: (target, property, receiver) => {
        if (property === "length") lengthReads += 1;
        if (property === "0") elementReads += 1;
        if (property === Symbol.iterator) {
          iteratorReads += 1;
          throw new Error("lease iterator must not run");
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const broker = new ProviderBroker({
      dispatcher: async () => ({ kind: "json", body: { ok: true } }),
    });
    brokers.push(broker);

    const capability = issueWithLease(
      broker,
      {
        taskId: "task-indexed-lease",
        runId: "run-indexed-lease",
        profileId: "profile-indexed-lease",
        model: "model-indexed-lease",
        apiMode: "chat_completions",
        ttlMs: 30_000,
      },
      { secrets },
    );

    expect(capability.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect({ lengthReads, elementReads, iteratorReads }).toEqual({
      lengthReads: 1,
      elementReads: 1,
      iteratorReads: 0,
    });
  });

  it("rejects an expired capability before reading or dispatching the request", async () => {
    let now = 1_000;
    const dispatcher = vi.fn<ProviderDispatcher>();
    const broker = new ProviderBroker({ dispatcher, now: () => now });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = broker.issue(
      {
        taskId: "task-expired",
        runId: "run-expired",
        profileId: "profile-expired",
        model: "model-expired",
        apiMode: "chat_completions",
        ttlMs: 1_000,
      },
      EMPTY_CREDENTIAL_LEASE,
    );
    now += 1_001;

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-expired",
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        category: "capability_expired",
        retryable: false,
        message: "Provider capability expired",
      },
    });
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it("revokes a capability idempotently before subsequent dispatch", async () => {
    const dispatcher = vi.fn<ProviderDispatcher>();
    const broker = new ProviderBroker({ dispatcher });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = broker.issue(
      {
        taskId: "task-revoked",
        runId: "run-revoked",
        profileId: "profile-revoked",
        model: "model-revoked",
        apiMode: "chat_completions",
        ttlMs: 30_000,
      },
      EMPTY_CREDENTIAL_LEASE,
    );

    broker.revoke(capability.capabilityId);
    broker.revoke(capability.capabilityId);
    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-revoked",
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        category: "capability_revoked",
        retryable: false,
        message: "Provider capability revoked",
      },
    });
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it("revokes every capability for one task without crossing into another task", async () => {
    const dispatcher: ProviderDispatcher = async (request) => ({
      kind: "json",
      body: { profileId: request.profileId },
    });
    const broker = new ProviderBroker({ dispatcher });
    brokers.push(broker);
    const endpoint = await broker.start();
    const first = issueFor(broker, {
      taskId: "task-a",
      runId: "run-a1",
      profileId: "profile-a1",
      model: "model-a1",
    });
    const second = issueFor(broker, {
      taskId: "task-a",
      runId: "run-a2",
      profileId: "profile-a2",
      model: "model-a2",
    });
    const other = issueFor(broker, {
      taskId: "task-b",
      runId: "run-b1",
      profileId: "profile-b1",
      model: "model-b1",
    });

    broker.revokeTask("task-a");
    const [firstResponse, secondResponse, otherResponse] = await Promise.all([
      postJson(endpoint.port, "/v1/chat/completions", first.token, { model: "model-a1" }),
      postJson(endpoint.port, "/v1/chat/completions", second.token, { model: "model-a2" }),
      postJson(endpoint.port, "/v1/chat/completions", other.token, { model: "model-b1" }),
    ]);

    expect(firstResponse.status).toBe(401);
    expect(secondResponse.status).toBe(401);
    expect(otherResponse.status).toBe(200);
    await expect(otherResponse.json()).resolves.toEqual({ profileId: "profile-b1" });
  });

  it("rechecks capability expiry after reading the body and before dispatch", async () => {
    const times = [1_000, 1_000, 1_000, 2_001];
    const dispatcher = vi.fn<ProviderDispatcher>();
    const broker = new ProviderBroker({ dispatcher, now: () => times.shift() ?? 2_001 });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = broker.issue(
      {
        taskId: "task-expiry-race",
        runId: "run-expiry-race",
        profileId: "profile-expiry-race",
        model: "model-expiry-race",
        apiMode: "chat_completions",
        ttlMs: 1_000,
      },
      EMPTY_CREDENTIAL_LEASE,
    );

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-expiry-race",
    });

    expect(response.status).toBe(401);
    const payload = (await response.json()) as { error: { category: string } };
    expect(payload.error.category).toBe("capability_expired");
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it("floors launcher expiry seconds for the minimum and maximum allowed TTLs", () => {
    const broker = new ProviderBroker({
      dispatcher: async () => ({ kind: "json", body: { ok: true } }),
      now: () => 1_999,
    });
    brokers.push(broker);

    const minimum = broker.issue(
      {
        taskId: "task-minimum-ttl",
        runId: "run-minimum-ttl",
        profileId: "profile-minimum-ttl",
        model: "model-minimum-ttl",
        apiMode: "chat_completions",
        ttlMs: 1_000,
      },
      EMPTY_CREDENTIAL_LEASE,
    );
    const maximum = broker.issue(
      {
        taskId: "task-maximum-ttl",
        runId: "run-maximum-ttl",
        profileId: "profile-maximum-ttl",
        model: "model-maximum-ttl",
        apiMode: "chat_completions",
        ttlMs: 300_000,
      },
      EMPTY_CREDENTIAL_LEASE,
    );

    expect(minimum.expiresAt).toBe(2);
    expect(maximum.expiresAt).toBe(301);
    expect(maximum.expiresAt - Math.floor(1_999 / 1_000)).toBe(300);
  });

  it("returns a fixed error for invalid JSON without dispatching or reflecting the body", async () => {
    const dispatcher = vi.fn<ProviderDispatcher>();
    const broker = new ProviderBroker({ dispatcher });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-invalid-json",
      runId: "run-invalid-json",
      profileId: "profile-invalid-json",
      model: "model-invalid-json",
    });
    const canary = "invalid-json-request-canary";

    const response = await fetch(`http://127.0.0.1:${endpoint.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${capability.token}`,
        "content-type": "application/json",
      },
      body: `{"model":"model-invalid-json","input":"${canary}`,
      signal: AbortSignal.timeout(1_000),
    });
    const rendered = await response.text();

    expect(response.status).toBe(400);
    expect(JSON.parse(rendered)).toEqual({
      error: {
        category: "invalid_json",
        retryable: false,
        message: "Provider request JSON is invalid",
      },
    });
    expect(rendered).not.toContain(canary);
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it("rejects a local bearer embedded in the parsed request body before dispatch", async () => {
    const dispatcher = vi.fn<ProviderDispatcher>();
    const broker = new ProviderBroker({ dispatcher });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-sensitive-input",
      runId: "run-sensitive-input",
      profileId: "profile-sensitive-input",
      model: "model-sensitive-input",
    });

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-sensitive-input",
      nested: { accidental: `prefix-${capability.token}-suffix` },
    });
    const rendered = await response.text();

    expect(response.status).toBe(400);
    expect(JSON.parse(rendered)).toEqual({
      error: {
        category: "sensitive_input",
        retryable: false,
        message: "Provider request contains a protected value",
      },
    });
    expect(rendered).not.toContain(capability.token);
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it("rejects a request body larger than one MiB before dispatch", async () => {
    const dispatcher = vi.fn<ProviderDispatcher>();
    const broker = new ProviderBroker({ dispatcher });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-large-body",
      runId: "run-large-body",
      profileId: "profile-large-body",
      model: "model-large-body",
    });
    const canary = "large-body-canary";
    const body = JSON.stringify({
      model: "model-large-body",
      input: canary.repeat(70_000),
    });
    expect(Buffer.byteLength(body)).toBeGreaterThan(1024 * 1024);

    const response = await fetch(`http://127.0.0.1:${endpoint.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${capability.token}`,
        "content-type": "application/json",
      },
      body,
    });
    const rendered = await response.text();

    expect(response.status).toBe(413);
    expect(JSON.parse(rendered)).toEqual({
      error: {
        category: "payload_too_large",
        retryable: false,
        message: "Provider request body is too large",
      },
    });
    expect(rendered).not.toContain(canary);
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it("returns a fixed parser-level error for oversized headers", async () => {
    const dispatcher = vi.fn<ProviderDispatcher>();
    const broker = new ProviderBroker({ dispatcher });
    brokers.push(broker);
    const endpoint = await broker.start();
    const canary = "oversized-header-canary";

    const response = await fetch(`http://127.0.0.1:${endpoint.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-oversized": canary.repeat(1_000),
      },
      body: JSON.stringify({ model: "not-admitted" }),
    });
    const rendered = await response.text();

    expect(response.status).toBe(431);
    expect(JSON.parse(rendered)).toEqual({
      error: {
        category: "headers_too_large",
        retryable: false,
        message: "Provider request headers are too large",
      },
    });
    expect(rendered).not.toContain(canary);
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it("aborts a timed-out dispatcher and returns a fixed error without leaking its exception", async () => {
    const canary = "dispatcher-timeout-canary";
    let dispatcherSignal: AbortSignal | undefined;
    const dispatcher: ProviderDispatcher = async (request) => {
      dispatcherSignal = request.signal;
      await new Promise<void>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error(canary)), { once: true });
      });
      return { kind: "json", body: { unreachable: true } };
    };
    const broker = new ProviderBroker({ dispatcher, requestTimeoutMs: 30 });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-timeout",
      runId: "run-timeout",
      profileId: "profile-timeout",
      model: "model-timeout",
    });

    const response = await postJson(
      endpoint.port,
      "/v1/chat/completions",
      capability.token,
      { model: "model-timeout" },
      AbortSignal.timeout(1_000),
    );
    const rendered = await response.text();

    expect(response.status).toBe(504);
    expect(JSON.parse(rendered)).toEqual({
      error: {
        category: "request_timeout",
        retryable: true,
        message: "Provider request timed out",
      },
    });
    expect(dispatcherSignal?.aborted).toBe(true);
    expect(rendered).not.toContain(canary);
  });

  it("aborts an in-flight dispatcher when its capability is revoked", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let dispatcherSignal: AbortSignal | undefined;
    const dispatcher: ProviderDispatcher = async (request) => {
      dispatcherSignal = request.signal;
      markStarted();
      await new Promise<void>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("revoked")), {
          once: true,
        });
      });
      return { kind: "json", body: { unreachable: true } };
    };
    const broker = new ProviderBroker({ dispatcher });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-revoke-flight",
      runId: "run-revoke-flight",
      profileId: "profile-revoke-flight",
      model: "model-revoke-flight",
    });

    const responsePromise = postJson(
      endpoint.port,
      "/v1/chat/completions",
      capability.token,
      { model: "model-revoke-flight" },
      AbortSignal.timeout(1_000),
    );
    await started;
    broker.revoke(capability.capabilityId);
    const response = await responsePromise;

    expect(response.status).toBe(401);
    const payload = (await response.json()) as { error: { category: string } };
    expect(payload.error.category).toBe("capability_revoked");
    expect(dispatcherSignal?.aborted).toBe(true);
  });

  it("aborts an in-flight dispatcher when its capability expires", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let dispatcherSignal: AbortSignal | undefined;
    const dispatcher: ProviderDispatcher = async (request) => {
      dispatcherSignal = request.signal;
      markStarted();
      await new Promise<void>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("expired")), {
          once: true,
        });
      });
      return { kind: "json", body: { unreachable: true } };
    };
    const broker = new ProviderBroker({ dispatcher, requestTimeoutMs: 5_000 });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = broker.issue(
      {
        taskId: "task-expiry-flight",
        runId: "run-expiry-flight",
        profileId: "profile-expiry-flight",
        model: "model-expiry-flight",
        apiMode: "chat_completions",
        ttlMs: 1_000,
      },
      EMPTY_CREDENTIAL_LEASE,
    );

    const responsePromise = postJson(
      endpoint.port,
      "/v1/chat/completions",
      capability.token,
      { model: "model-expiry-flight" },
      AbortSignal.timeout(2_000),
    );
    await started;
    const response = await responsePromise;

    expect(response.status).toBe(401);
    const payload = (await response.json()) as { error: { category: string } };
    expect(payload.error.category).toBe("capability_expired");
    expect(dispatcherSignal?.aborted).toBe(true);
  });

  it("aborts an in-flight dispatcher when the client disconnects", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let dispatcherSignal: AbortSignal | undefined;
    const dispatcher: ProviderDispatcher = async (request) => {
      dispatcherSignal = request.signal;
      markStarted();
      await new Promise<void>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("client closed")), {
          once: true,
        });
      });
      return { kind: "json", body: { unreachable: true } };
    };
    const broker = new ProviderBroker({ dispatcher });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-client-close",
      runId: "run-client-close",
      profileId: "profile-client-close",
      model: "model-client-close",
    });
    const clientRequest = httpRequest({
      host: "127.0.0.1",
      port: endpoint.port,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        authorization: `Bearer ${capability.token}`,
        "content-type": "application/json",
      },
    });
    clientRequest.on("error", () => {});
    clientRequest.end(JSON.stringify({ model: "model-client-close" }));

    await started;
    clientRequest.destroy();
    await waitUntil(() => dispatcherSignal?.aborted === true, 300);

    expect(dispatcherSignal?.aborted).toBe(true);
  });

  it("aborts an in-flight body read when the capability is revoked", async () => {
    let nowCalls = 0;
    let markAdmitted!: () => void;
    const admitted = new Promise<void>((resolve) => {
      markAdmitted = resolve;
    });
    const dispatcher = vi.fn<ProviderDispatcher>();
    const broker = new ProviderBroker({
      dispatcher,
      now: () => {
        nowCalls += 1;
        if (nowCalls === 2) markAdmitted();
        return 1_000;
      },
    });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-revoke-body",
      runId: "run-revoke-body",
      profileId: "profile-revoke-body",
      model: "model-revoke-body",
    });
    const clientRequest = httpRequest({
      host: "127.0.0.1",
      port: endpoint.port,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        authorization: `Bearer ${capability.token}`,
        "content-type": "application/json",
      },
    });
    clientRequest.on("error", () => {});
    const responsePromise = collectNodeResponse(clientRequest);
    clientRequest.write('{"model":"model-revoke-body","input":"unfinished');

    await admitted;
    broker.revoke(capability.capabilityId);
    let result: { status: number; body: string };
    try {
      result = await Promise.race([
        responsePromise,
        rejectAfter(500, "revoked body read did not finish"),
      ]);
    } finally {
      clientRequest.destroy();
    }

    expect(result.status).toBe(401);
    expect(JSON.parse(result.body).error.category).toBe("capability_revoked");
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it("bounds concurrent admissions without dispatching the excess request", async () => {
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const seenProfiles: string[] = [];
    const dispatcher: ProviderDispatcher = async (request) => {
      seenProfiles.push(request.profileId);
      markFirstStarted();
      await firstReleased;
      return { kind: "json", body: { profileId: request.profileId } };
    };
    const broker = new ProviderBroker({ dispatcher, maxConcurrentRequests: 1 });
    brokers.push(broker);
    const endpoint = await broker.start();
    const first = issueFor(broker, {
      taskId: "task-concurrency-a",
      runId: "run-concurrency-a",
      profileId: "profile-concurrency-a",
      model: "model-concurrency-a",
    });
    const second = issueFor(broker, {
      taskId: "task-concurrency-b",
      runId: "run-concurrency-b",
      profileId: "profile-concurrency-b",
      model: "model-concurrency-b",
    });

    const firstResponsePromise = postJson(
      endpoint.port,
      "/v1/chat/completions",
      first.token,
      { model: "model-concurrency-a" },
      AbortSignal.timeout(1_000),
    );
    await firstStarted;
    let secondResponse!: Response;
    try {
      secondResponse = await postJson(
        endpoint.port,
        "/v1/chat/completions",
        second.token,
        { model: "model-concurrency-b" },
        AbortSignal.timeout(500),
      );
    } finally {
      releaseFirst();
    }
    const secondPayload = await secondResponse.json();
    const firstResponse = await firstResponsePromise;

    expect(secondResponse.status).toBe(429);
    expect(secondPayload).toEqual({
      error: {
        category: "broker_busy",
        retryable: true,
        message: "Provider broker is busy",
      },
    });
    expect(firstResponse.status).toBe(200);
    expect(seenProfiles).toEqual(["profile-concurrency-a"]);
  });

  it("streams dispatcher bytes with fixed safe response headers", async () => {
    const encoder = new TextEncoder();
    const dispatcher: ProviderDispatcher = async () => ({
      kind: "stream",
      body: (async function* () {
        yield encoder.encode("data: first\n\n");
        yield encoder.encode("data: second\n\n");
      })(),
    });
    const broker = new ProviderBroker({ dispatcher });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-stream",
      runId: "run-stream",
      profileId: "profile-stream",
      model: "model-stream",
    });

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-stream",
      stream: true,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("connection")).toBe("close");
    await expect(response.text()).resolves.toBe("data: first\n\ndata: second\n\n");
  });

  it("snapshots the stream factory, iterator methods, and iterator results exactly once", async () => {
    const encoder = new TextEncoder();
    const resultReads = [
      { done: 0, value: 0 },
      { done: 0, value: 0 },
    ];
    let asyncIteratorReads = 0;
    let asyncIteratorCalls = 0;
    let nextReads = 0;
    let returnReads = 0;
    let nextCalls = 0;
    let returnCalls = 0;
    let body: object;
    let iterator: object;
    const next = function (this: object): Promise<IteratorResult<Uint8Array>> {
      if (this !== iterator) throw new Error("wrong next receiver");
      const index = nextCalls;
      nextCalls += 1;
      const reads = resultReads[index];
      if (!reads) throw new Error("unexpected iterator call");
      const done = index === 1;
      const value = done ? undefined : encoder.encode("data: snapshot\n\n");
      return Promise.resolve(
        Object.defineProperties(
          {},
          {
            done: {
              get: () => {
                reads.done += 1;
                return done;
              },
            },
            value: {
              get: () => {
                reads.value += 1;
                return value;
              },
            },
          },
        ) as IteratorResult<Uint8Array>,
      );
    };
    const returnMethod = function (this: object): Promise<IteratorResult<Uint8Array>> {
      if (this !== iterator) throw new Error("wrong return receiver");
      returnCalls += 1;
      return Promise.resolve({ done: true, value: undefined });
    };
    iterator = Object.defineProperties(
      {},
      {
        next: {
          get: () => {
            nextReads += 1;
            return next;
          },
        },
        return: {
          get: () => {
            returnReads += 1;
            return returnMethod;
          },
        },
      },
    );
    const asyncIterator = function (this: object): object {
      if (this !== body) throw new Error("wrong async iterator receiver");
      asyncIteratorCalls += 1;
      return iterator;
    };
    body = Object.defineProperty({}, Symbol.asyncIterator, {
      get: () => {
        asyncIteratorReads += 1;
        return asyncIterator;
      },
    });
    const broker = new ProviderBroker({
      dispatcher: async () => ({ kind: "stream", body: body as AsyncIterable<Uint8Array> }),
    });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-stream-snapshot",
      runId: "run-stream-snapshot",
      profileId: "profile-stream-snapshot",
      model: "model-stream-snapshot",
    });

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-stream-snapshot",
      stream: true,
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("data: snapshot\n\n");
    expect({ asyncIteratorReads, asyncIteratorCalls, nextReads, returnReads }).toEqual({
      asyncIteratorReads: 1,
      asyncIteratorCalls: 1,
      nextReads: 1,
      returnReads: 1,
    });
    expect({ nextCalls, returnCalls }).toEqual({ nextCalls: 2, returnCalls: 0 });
    expect(resultReads).toEqual([
      { done: 1, value: 1 },
      { done: 1, value: 1 },
    ]);
  });

  it("rejects a non-boolean iterator done value before stream headers", async () => {
    const encoder = new TextEncoder();
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          Promise.resolve({ done: "false", value: encoder.encode("must-not-write") } as never),
      }),
    };
    const broker = new ProviderBroker({ dispatcher: async () => ({ kind: "stream", body }) });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-invalid-done",
      runId: "run-invalid-done",
      profileId: "profile-invalid-done",
      model: "model-invalid-done",
    });

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-invalid-done",
      stream: true,
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: {
        category: "dispatch_failed",
        retryable: true,
        message: "Provider request failed",
      },
    });
  });

  it("does not write a next result after a malicious thenable revokes in a microtask", async () => {
    const encoder = new TextEncoder();
    const canary = "stream-post-next-revoke-canary";
    let capabilityId = "";
    let nextCalls = 0;
    let returnCalls = 0;
    let broker: ProviderBroker;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          nextCalls += 1;
          if (nextCalls === 1) {
            return Promise.resolve({ done: false, value: encoder.encode("data: safe\n\n") });
          }
          return {
            // biome-ignore lint/suspicious/noThenProperty: This regression requires a malicious thenable.
            then: (resolve: (result: IteratorResult<Uint8Array>) => void) => {
              resolve({ done: false, value: encoder.encode(`data: ${canary}\n\n`) });
              queueMicrotask(() => broker.revoke(capabilityId));
            },
          } as never;
        },
        return: () => {
          returnCalls += 1;
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    };
    broker = new ProviderBroker({ dispatcher: async () => ({ kind: "stream", body }) });
    brokers.push(broker);
    const endpoint = await broker.start();
    const observedWrites: Buffer[] = [];
    const server = broker as unknown as {
      server: {
        prependListener(
          event: "request",
          listener: (_request: unknown, response: import("node:http").ServerResponse) => void,
        ): void;
      };
    };
    server.server.prependListener("request", (_request, response) => {
      const writable = response as unknown as { write(chunk: Uint8Array | string): boolean };
      const originalWrite = writable.write.bind(response);
      writable.write = (chunk) => {
        observedWrites.push(Buffer.from(chunk));
        return originalWrite(chunk);
      };
    });
    const capability = issueFor(broker, {
      taskId: "task-post-next-revoke",
      runId: "run-post-next-revoke",
      profileId: "profile-post-next-revoke",
      model: "model-post-next-revoke",
    });
    capabilityId = capability.capabilityId;

    await Promise.race([
      postJson(endpoint.port, "/v1/chat/completions", capability.token, {
        model: "model-post-next-revoke",
        stream: true,
      })
        .then(readResponseUntilClosed)
        .catch(() => ""),
      rejectAfter<string>(1_000, "post-next revoke stream did not close"),
    ]);
    await waitUntil(() => returnCalls === 1, 300);
    const rendered = Buffer.concat(observedWrites).toString("utf8");

    expect(rendered).toContain("data: safe");
    expect(rendered).not.toContain(canary);
    expect(returnCalls).toBe(1);
  });

  it("does not pull another iterator step when the first successful write revokes access", async () => {
    const encoder = new TextEncoder();
    let nextCalls = 0;
    let returnCalls = 0;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          nextCalls += 1;
          if (nextCalls === 1) {
            return Promise.resolve({ done: false, value: encoder.encode("data: first\n\n") });
          }
          return new Promise<IteratorResult<Uint8Array>>(() => {});
        },
        return: () => {
          returnCalls += 1;
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    };
    const broker = new ProviderBroker({ dispatcher: async () => ({ kind: "stream", body }) });
    brokers.push(broker);
    const endpoint = await broker.start();
    let capabilityId = "";
    const server = broker as unknown as {
      server: {
        prependListener(
          event: "request",
          listener: (_request: unknown, response: import("node:http").ServerResponse) => void,
        ): void;
      };
    };
    server.server.prependListener("request", (_request, response) => {
      const writable = response as unknown as { write(chunk: Uint8Array | string): boolean };
      const originalWrite = writable.write.bind(response);
      writable.write = (chunk) => {
        const accepted = originalWrite(chunk);
        broker.revoke(capabilityId);
        return accepted;
      };
    });
    const capability = issueFor(broker, {
      taskId: "task-post-write-revoke",
      runId: "run-post-write-revoke",
      profileId: "profile-post-write-revoke",
      model: "model-post-write-revoke",
    });
    capabilityId = capability.capabilityId;

    await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-post-write-revoke",
      stream: true,
    })
      .then(readResponseUntilClosed)
      .catch(() => "");
    await waitUntil(() => returnCalls === 1, 300);

    expect(nextCalls).toBe(1);
    expect(returnCalls).toBe(1);
  });

  it("rechecks stream expiry after iterator result getters and before the first write", async () => {
    const encoder = new TextEncoder();
    const canary = "stream-expiry-getter-canary";
    let now = 1_000;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          Promise.resolve(
            Object.defineProperties(
              {},
              {
                done: { get: () => false },
                value: {
                  get: () => {
                    now = 2_001;
                    return encoder.encode(`data: ${canary}\n\n`);
                  },
                },
              },
            ) as IteratorResult<Uint8Array>,
          ),
        return: () => Promise.resolve({ done: true, value: undefined }),
      }),
    };
    const broker = new ProviderBroker({
      dispatcher: async () => ({ kind: "stream", body }),
      now: () => now,
    });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = broker.issue(
      {
        taskId: "task-stream-expiry-getter",
        runId: "run-stream-expiry-getter",
        profileId: "profile-stream-expiry-getter",
        model: "model-stream-expiry-getter",
        apiMode: "chat_completions",
        ttlMs: 1_000,
      },
      EMPTY_CREDENTIAL_LEASE,
    );

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-stream-expiry-getter",
      stream: true,
    });
    const rendered = await response.text();

    expect(response.status).toBe(401);
    expect(JSON.parse(rendered).error.category).toBe("capability_expired");
    expect(rendered).not.toContain(canary);
  });

  it("redacts the local bearer across stream chunk boundaries", async () => {
    const encoder = new TextEncoder();
    let localToken = "";
    const dispatcher: ProviderDispatcher = async () => ({
      kind: "stream",
      body: (async function* () {
        yield encoder.encode(`data: local=${localToken.slice(0, 17)}`);
        yield encoder.encode(`${localToken.slice(17)}; safe=kept\n\n`);
      })(),
    });
    const broker = new ProviderBroker({ dispatcher });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-stream-redaction",
      runId: "run-stream-redaction",
      profileId: "profile-stream-redaction",
      model: "model-stream-redaction",
    });
    localToken = capability.token;

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-stream-redaction",
      stream: true,
    });
    const rendered = await response.text();

    expect(response.status).toBe(200);
    expect(rendered).toBe("data: local=[REDACTED]; safe=kept\n\n");
    expect(rendered).not.toContain(capability.token);
  });

  it("redacts many repeated stream secrets without quadratic rescanning", async () => {
    const encoder = new TextEncoder();
    const repetitions = 20_000;
    let localToken = "";
    const broker = new ProviderBroker({
      dispatcher: async () => ({
        kind: "stream",
        body: (async function* () {
          yield encoder.encode(`data: ${localToken.repeat(repetitions)}\n\n`);
        })(),
      }),
    });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-stream-repeated-secret",
      runId: "run-stream-repeated-secret",
      profileId: "profile-stream-repeated-secret",
      model: "model-stream-repeated-secret",
    });
    localToken = capability.token;

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-stream-repeated-secret",
      stream: true,
    });
    const rendered = await response.text();

    expect(response.status).toBe(200);
    expect(rendered).toBe(`data: ${"[REDACTED]".repeat(repetitions)}\n\n`);
    expect(rendered).not.toContain(localToken);
  }, 5_000);

  it("semantically redacts a local bearer unicode-escaped across SSE chunks", async () => {
    const encoder = new TextEncoder();
    let localToken = "";
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => {
        const escaped = [...localToken]
          .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
          .join("");
        const line = `data: {"credential":"${escaped}"}\n\n`;
        const split = Math.floor(line.length / 2);
        const chunks = [encoder.encode(line.slice(0, split)), encoder.encode(line.slice(split))];
        let index = 0;
        return {
          next: () => {
            const value = chunks[index];
            if (!value) return Promise.resolve({ done: true, value: undefined } as const);
            index += 1;
            return Promise.resolve({ done: false, value } as const);
          },
        };
      },
    };
    const broker = new ProviderBroker({ dispatcher: async () => ({ kind: "stream", body }) });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-sse-unicode",
      runId: "run-sse-unicode",
      profileId: "profile-sse-unicode",
      model: "model-sse-unicode",
    });
    localToken = capability.token;

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-sse-unicode",
      stream: true,
    });
    const rendered = await response.text();

    expect(response.status).toBe(200);
    expect(rendered).toBe('data: {"credential":"[REDACTED]"}\n\n');
    expect(rendered).not.toContain(capability.token);
  });

  it("normalizes a UTF-8 BOM and semantically redacts the first SSE data line", async () => {
    const encoder = new TextEncoder();
    let localToken = "";
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => {
        const escaped = [...localToken]
          .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
          .join("");
        const line = `\uFEFFdata: {"credential":"${escaped}"}\n\n`;
        let sent = false;
        return {
          next: () => {
            if (sent) return Promise.resolve({ done: true, value: undefined } as const);
            sent = true;
            return Promise.resolve({ done: false, value: encoder.encode(line) } as const);
          },
        };
      },
    };
    const broker = new ProviderBroker({ dispatcher: async () => ({ kind: "stream", body }) });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-sse-bom",
      runId: "run-sse-bom",
      profileId: "profile-sse-bom",
      model: "model-sse-bom",
    });
    localToken = capability.token;

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-sse-bom",
      stream: true,
    });
    const rendered = await response.text();

    expect(response.status).toBe(200);
    expect(rendered).toBe('data: {"credential":"[REDACTED]"}\n\n');
  });

  it("semantically redacts mixed CR, LF, and cross-chunk CRLF SSE lines", async () => {
    const encoder = new TextEncoder();
    let localToken = "";
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => {
        const escaped = [...localToken]
          .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
          .join("");
        const chunks = [
          encoder.encode(`data: {"cr":"${escaped}"}\r\r`),
          encoder.encode(`data: {"lf":"${escaped}"}\n\n`),
          encoder.encode(`data: {"crlf":"${escaped}"}\r`),
          encoder.encode("\n\r"),
          encoder.encode("\n"),
        ];
        let index = 0;
        return {
          next: () => {
            const value = chunks[index];
            if (!value) return Promise.resolve({ done: true, value: undefined } as const);
            index += 1;
            return Promise.resolve({ done: false, value } as const);
          },
        };
      },
    };
    const broker = new ProviderBroker({ dispatcher: async () => ({ kind: "stream", body }) });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-sse-line-endings",
      runId: "run-sse-line-endings",
      profileId: "profile-sse-line-endings",
      model: "model-sse-line-endings",
    });
    localToken = capability.token;

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-sse-line-endings",
      stream: true,
    });
    const rendered = await response.text();

    expect(response.status).toBe(200);
    expect(rendered).toBe(
      'data: {"cr":"[REDACTED]"}\r\r' +
        'data: {"lf":"[REDACTED]"}\n\n' +
        'data: {"crlf":"[REDACTED]"}\r\n\r\n',
    );
    expect(rendered).not.toContain(capability.token);
  });

  it("preserves an emoji when the streaming redaction tail would split its surrogate pair", async () => {
    const encoder = new TextEncoder();
    const first = `data: ${"a".repeat(60)}😀${"b".repeat(39)}\n\n`;
    const second = "data: after-tail\n\n";
    const broker = new ProviderBroker({
      dispatcher: async () => ({
        kind: "stream",
        body: (async function* () {
          yield encoder.encode(first);
          yield encoder.encode(second);
        })(),
      }),
    });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-stream-emoji",
      runId: "run-stream-emoji",
      profileId: "profile-stream-emoji",
      model: "model-stream-emoji",
    });

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-stream-emoji",
      stream: true,
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(first + second);
  });

  it("rejects a second data field in one SSE event before writing stream bytes", async () => {
    const encoder = new TextEncoder();
    let localToken = "";
    let nextCalls = 0;
    let returnCalls = 0;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => {
        const split = 19;
        const chunks = [
          encoder.encode(`data: {"first":"${localToken.slice(0, split)}"}\n`),
          encoder.encode(`data: {"second":"${localToken.slice(split)}"}\n\n`),
        ];
        return {
          next: () => {
            const value = chunks[nextCalls];
            nextCalls += 1;
            return Promise.resolve(
              value
                ? ({ done: false, value } as const)
                : ({ done: true, value: undefined } as const),
            );
          },
          return: () => {
            returnCalls += 1;
            return Promise.resolve({ done: true, value: undefined } as const);
          },
        };
      },
    };
    const broker = new ProviderBroker({ dispatcher: async () => ({ kind: "stream", body }) });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-sse-multiple-data",
      runId: "run-sse-multiple-data",
      profileId: "profile-sse-multiple-data",
      model: "model-sse-multiple-data",
    });
    localToken = capability.token;

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-sse-multiple-data",
      stream: true,
    });
    const rendered = await response.text();

    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(JSON.parse(rendered).error.category).toBe("dispatch_failed");
    expect(rendered).not.toContain(localToken);
    expect(nextCalls).toBe(2);
    expect(returnCalls).toBe(1);
  });

  it("fails closed on invalid UTF-8 in the first SSE line", async () => {
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => {
        let sent = false;
        return {
          next: () => {
            if (sent) return Promise.resolve({ done: true, value: undefined });
            sent = true;
            return Promise.resolve({ done: false, value: Uint8Array.from([0xff, 0x0a]) });
          },
        };
      },
    };
    const broker = new ProviderBroker({ dispatcher: async () => ({ kind: "stream", body }) });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-sse-invalid-utf8",
      runId: "run-sse-invalid-utf8",
      profileId: "profile-sse-invalid-utf8",
      model: "model-sse-invalid-utf8",
    });

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-sse-invalid-utf8",
      stream: true,
    });

    expect(response.status).toBe(502);
    expect((await response.json()).error.category).toBe("dispatch_failed");
  });

  it("fails closed when one SSE chunk exceeds four MiB", async () => {
    const oversized = new Uint8Array(4 * 1024 * 1024 + 1);
    oversized.fill(0x61);
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => {
        let sent = false;
        return {
          next: () => {
            if (sent) return Promise.resolve({ done: true, value: undefined });
            sent = true;
            return Promise.resolve({ done: false, value: oversized });
          },
        };
      },
    };
    const broker = new ProviderBroker({ dispatcher: async () => ({ kind: "stream", body }) });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-sse-oversized",
      runId: "run-sse-oversized",
      profileId: "profile-sse-oversized",
      model: "model-sse-oversized",
    });

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-sse-oversized",
      stream: true,
    });

    expect(response.status).toBe(502);
    expect((await response.json()).error.category).toBe("dispatch_failed");
  });

  it("rejects a dynamically credentialed stream before pulling and cleans its iterator", async () => {
    const dynamicSecret = "sk-provider-dynamic-stream-secret";
    let nextCalls = 0;
    let returnCalls = 0;
    let dispatcherSignal: AbortSignal | undefined;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          nextCalls += 1;
          return Promise.resolve({ done: true, value: undefined } as const);
        },
        return: () => {
          returnCalls += 1;
          return Promise.resolve({ done: true, value: undefined } as const);
        },
      }),
    };
    const broker = new ProviderBroker({
      dispatcher: async (request) => {
        dispatcherSignal = request.signal;
        return {
          kind: "stream",
          sanitizer: { secrets: [dynamicSecret] },
          body,
        };
      },
    });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-dynamic-stream-gate",
      runId: "run-dynamic-stream-gate",
      profileId: "profile-dynamic-stream-gate",
      model: "model-dynamic-stream-gate",
    });

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-dynamic-stream-gate",
      stream: true,
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: {
        category: "credentialed_stream_unsupported",
        retryable: false,
        message: "Credentialed provider streaming is not available",
      },
    });
    expect(nextCalls).toBe(0);
    expect(returnCalls).toBe(1);
    expect(dispatcherSignal?.aborted).toBe(true);
  });

  it("aborts a refused credentialed stream even when its iterator has no return method", async () => {
    let dispatcherSignal: AbortSignal | undefined;
    let nextCalls = 0;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          nextCalls += 1;
          return Promise.resolve({ done: true, value: undefined } as const);
        },
      }),
    };
    const broker = new ProviderBroker({
      dispatcher: async (request) => {
        dispatcherSignal = request.signal;
        return {
          kind: "stream",
          sanitizer: { secrets: ["sk-provider-no-return-stream-secret"] },
          body,
        };
      },
    });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-no-return-stream-gate",
      runId: "run-no-return-stream-gate",
      profileId: "profile-no-return-stream-gate",
      model: "model-no-return-stream-gate",
    });

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-no-return-stream-gate",
      stream: true,
    });

    expect(response.status).toBe(422);
    expect((await response.json()).error.category).toBe("credentialed_stream_unsupported");
    expect(nextCalls).toBe(0);
    expect(dispatcherSignal?.aborted).toBe(true);
  });

  it("reports a request timeout that occurs while cleaning a refused credentialed stream", async () => {
    let returnCalls = 0;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true, value: undefined } as const),
        return: () => {
          returnCalls += 1;
          return new Promise<IteratorResult<Uint8Array>>((resolve) => {
            setTimeout(() => resolve({ done: true, value: undefined }), 150);
          });
        },
      }),
    };
    const broker = new ProviderBroker({
      dispatcher: async () => ({
        kind: "stream",
        sanitizer: { secrets: ["sk-provider-timeout-stream-secret"] },
        body,
      }),
      requestTimeoutMs: 20,
    });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-credentialed-stream-timeout",
      runId: "run-credentialed-stream-timeout",
      profileId: "profile-credentialed-stream-timeout",
      model: "model-credentialed-stream-timeout",
    });

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-credentialed-stream-timeout",
      stream: true,
    });

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({
      error: {
        category: "request_timeout",
        retryable: true,
        message: "Provider request timed out",
      },
    });
    expect(returnCalls).toBe(1);
  });

  it("rejects a leased stream split across two SSE events before its first pull", async () => {
    const encoder = new TextEncoder();
    const leaseSecret = "sk-provider-leased-stream-secret";
    const split = 17;
    let nextCalls = 0;
    let returnCalls = 0;
    const chunks = [
      encoder.encode(`data: {"delta":"${leaseSecret.slice(0, split)}"}\n\n`),
      encoder.encode(`data: {"delta":"${leaseSecret.slice(split)}"}\n\n`),
    ];
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const value = chunks[nextCalls];
          nextCalls += 1;
          return Promise.resolve(
            value ? ({ done: false, value } as const) : ({ done: true, value: undefined } as const),
          );
        },
        return: () => {
          returnCalls += 1;
          return Promise.resolve({ done: true, value: undefined } as const);
        },
      }),
    };
    const broker = new ProviderBroker({ dispatcher: async () => ({ kind: "stream", body }) });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueWithLease(
      broker,
      {
        taskId: "task-leased-stream-gate",
        runId: "run-leased-stream-gate",
        profileId: "profile-leased-stream-gate",
        model: "model-leased-stream-gate",
        apiMode: "chat_completions",
        ttlMs: 30_000,
      },
      { secrets: [leaseSecret] },
    );

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-leased-stream-gate",
      stream: true,
    });
    const rendered = await response.text();

    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(JSON.parse(rendered).error).toEqual({
      category: "credentialed_stream_unsupported",
      retryable: false,
      message: "Credentialed provider streaming is not available",
    });
    expect(rendered).not.toContain(leaseSecret.slice(0, split));
    expect(rendered).not.toContain(leaseSecret.slice(split));
    expect(nextCalls).toBe(0);
    expect(returnCalls).toBe(1);
  });

  it("closes idempotently by aborting in-flight work and releasing the port", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let dispatcherSignal: AbortSignal | undefined;
    const dispatcher: ProviderDispatcher = async (request) => {
      dispatcherSignal = request.signal;
      markStarted();
      await new Promise<never>(() => {});
    };
    const broker = new ProviderBroker({ dispatcher, closeGraceMs: 100 });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-close",
      runId: "run-close",
      profileId: "profile-close",
      model: "model-close",
    });
    const responsePromise = postJson(
      endpoint.port,
      "/v1/chat/completions",
      capability.token,
      { model: "model-close" },
      AbortSignal.timeout(1_000),
    );
    await started;

    const firstClose = broker.close();
    const secondClose = broker.close();
    const response = await responsePromise;
    await firstClose;

    expect(secondClose).toBe(firstClose);
    expect(response.status).toBe(503);
    const payload = (await response.json()) as { error: { category: string } };
    expect(payload.error.category).toBe("broker_closing");
    expect(dispatcherSignal?.aborted).toBe(true);
    await expect(canConnect("127.0.0.1", endpoint.port)).resolves.toBe(false);
  });

  it("does not reflect a dispatcher exception or local bearer token", async () => {
    const canary = "dispatcher-throw-canary";
    let localToken = "";
    const dispatcher: ProviderDispatcher = async () => {
      throw new Error(`${canary}:${localToken}`);
    };
    const broker = new ProviderBroker({ dispatcher });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-dispatch-error",
      runId: "run-dispatch-error",
      profileId: "profile-dispatch-error",
      model: "model-dispatch-error",
    });
    localToken = capability.token;

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-dispatch-error",
    });
    const rendered = await response.text();

    expect(response.status).toBe(502);
    expect(JSON.parse(rendered)).toEqual({
      error: {
        category: "dispatch_failed",
        retryable: true,
        message: "Provider request failed",
      },
    });
    expect(rendered).not.toContain(canary);
    expect(rendered).not.toContain(capability.token);
  });

  it("serializes JSON once and redacts local and dispatcher sanitizer secrets", async () => {
    const upstreamSecret = "sk-ant-api03-provider-secret-json-canary";
    let localToken = "";
    let serializationCount = 0;
    const dispatcher: ProviderDispatcher = async () => ({
      kind: "json",
      sanitizer: { secrets: [upstreamSecret] },
      body: {
        toJSON: () => {
          serializationCount += 1;
          return {
            local: `before-${localToken}-after`,
            upstream: `before-${upstreamSecret}-after`,
            safe: "kept",
          };
        },
      },
    });
    const broker = new ProviderBroker({ dispatcher });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-json-redaction",
      runId: "run-json-redaction",
      profileId: "profile-json-redaction",
      model: "model-json-redaction",
    });
    localToken = capability.token;

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-json-redaction",
    });
    const rendered = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(rendered)).toEqual({
      local: "before-[REDACTED]-after",
      upstream: "before-[REDACTED]-after",
      safe: "kept",
    });
    expect(serializationCount).toBe(1);
    expect(rendered).not.toContain(capability.token);
    expect(rendered).not.toContain(upstreamSecret);
  });

  it("redacts many repeated JSON secrets without quadratic slicing", async () => {
    const leaseSecret = "sk-provider-json-stress-secret";
    const repetitions = 20_000;
    const broker = new ProviderBroker({
      dispatcher: async () => ({
        kind: "json",
        body: { value: leaseSecret.repeat(repetitions) },
      }),
    });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueWithLease(
      broker,
      {
        taskId: "task-json-repeated-secret",
        runId: "run-json-repeated-secret",
        profileId: "profile-json-repeated-secret",
        model: "model-json-repeated-secret",
        apiMode: "chat_completions",
        ttlMs: 30_000,
      },
      { secrets: [leaseSecret] },
    );

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-json-repeated-secret",
    });
    const rendered = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(rendered)).toEqual({ value: "[REDACTED]".repeat(repetitions) });
    expect(rendered).not.toContain(leaseSecret);
  }, 5_000);

  it("rejects JSON responses larger than sixteen MiB before writing headers", async () => {
    const broker = new ProviderBroker({
      dispatcher: async () => ({
        kind: "json",
        body: { value: "x".repeat(16 * 1024 * 1024) },
      }),
    });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-json-size-limit",
      runId: "run-json-size-limit",
      profileId: "profile-json-size-limit",
      model: "model-json-size-limit",
    });

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-json-size-limit",
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: {
        category: "dispatch_failed",
        retryable: true,
        message: "Provider request failed",
      },
    });
  });

  it.skipIf(typeof (JSON as unknown as { rawJSON?: unknown }).rawJSON !== "function")(
    "redacts a local bearer hidden behind JSON unicode escapes",
    async () => {
      let localToken = "";
      const rawJson = (JSON as unknown as { rawJSON(value: string): unknown }).rawJSON;
      const dispatcher: ProviderDispatcher = async () => {
        const escaped = [...localToken]
          .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
          .join("");
        return { kind: "json", body: { hidden: rawJson(`"${escaped}"`) } };
      };
      const broker = new ProviderBroker({ dispatcher });
      brokers.push(broker);
      const endpoint = await broker.start();
      const capability = issueFor(broker, {
        taskId: "task-json-unicode-redaction",
        runId: "run-json-unicode-redaction",
        profileId: "profile-json-unicode-redaction",
        model: "model-json-unicode-redaction",
      });
      localToken = capability.token;

      const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
        model: "model-json-unicode-redaction",
      });
      const rendered = await response.text();

      expect(response.status).toBe(200);
      expect(JSON.parse(rendered)).toEqual({ hidden: "[REDACTED]" });
      expect(rendered).not.toContain(capability.token);
    },
  );

  it("does not create a sanitizer secret at a JSON replacement boundary", async () => {
    const replacedSecret = "provider-boundary-source";
    const boundarySecret = "[REDACTED]x";
    const broker = new ProviderBroker({
      dispatcher: async () => ({
        kind: "json",
        sanitizer: { secrets: [boundarySecret, replacedSecret] },
        body: { value: `${replacedSecret}x` },
      }),
    });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-json-boundary-redaction",
      runId: "run-json-boundary-redaction",
      profileId: "profile-json-boundary-redaction",
      model: "model-json-boundary-redaction",
    });

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-json-boundary-redaction",
    });
    const rendered = await response.text();

    expect(response.status).toBe(200);
    expect(() => JSON.parse(rendered)).not.toThrow();
    expect(rendered).not.toContain(replacedSecret);
    expect(rendered).not.toContain(boundarySecret);
  });

  it("stores only the token SHA-256 digest in the broker object graph", () => {
    const broker = new ProviderBroker({
      dispatcher: async () => ({ kind: "json", body: { ok: true } }),
    });
    brokers.push(broker);
    const capability = issueFor(broker, {
      taskId: "task-digest",
      runId: "run-digest",
      profileId: "profile-digest",
      model: "model-digest",
    });
    const digest = createHash("sha256").update(capability.token, "utf8").digest("hex");

    expect(objectGraphContains(broker, capability.token)).toBe(false);
    expect(objectGraphContains(broker, digest)).toBe(true);
  });

  it("keeps concurrent capability profiles and responses isolated when completion order reverses", async () => {
    const releases = new Map<string, () => void>();
    const waits = new Map<string, Promise<void>>();
    for (const profileId of ["profile-isolated-a", "profile-isolated-b"]) {
      waits.set(profileId, new Promise<void>((resolve) => releases.set(profileId, resolve)));
    }
    let markBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    const seen: string[] = [];
    const dispatcher: ProviderDispatcher = async (request) => {
      seen.push(`${request.profileId}:${request.model}`);
      if (seen.length === 2) markBothStarted();
      await waits.get(request.profileId);
      return {
        kind: "json",
        body: { profileId: request.profileId, model: request.model },
      };
    };
    const broker = new ProviderBroker({ dispatcher, maxConcurrentRequests: 2 });
    brokers.push(broker);
    const endpoint = await broker.start();
    const first = issueFor(broker, {
      taskId: "task-isolated-a",
      runId: "run-isolated-a",
      profileId: "profile-isolated-a",
      model: "model-isolated-a",
    });
    const second = issueFor(broker, {
      taskId: "task-isolated-b",
      runId: "run-isolated-b",
      profileId: "profile-isolated-b",
      model: "model-isolated-b",
    });
    const firstResponsePromise = postJson(endpoint.port, "/v1/chat/completions", first.token, {
      model: "model-isolated-a",
    });
    const secondResponsePromise = postJson(endpoint.port, "/v1/chat/completions", second.token, {
      model: "model-isolated-b",
    });

    await bothStarted;
    releases.get("profile-isolated-b")?.();
    const secondResponse = await secondResponsePromise;
    releases.get("profile-isolated-a")?.();
    const firstResponse = await firstResponsePromise;

    await expect(firstResponse.json()).resolves.toEqual({
      profileId: "profile-isolated-a",
      model: "model-isolated-a",
    });
    await expect(secondResponse.json()).resolves.toEqual({
      profileId: "profile-isolated-b",
      model: "model-isolated-b",
    });
    expect(new Set(seen)).toEqual(
      new Set(["profile-isolated-a:model-isolated-a", "profile-isolated-b:model-isolated-b"]),
    );
  });

  it("cancels the active stream iterator when its capability is revoked", async () => {
    const stream = blockingStream("data: revoke\n\n");
    let dispatcherSignal: AbortSignal | undefined;
    const dispatcher: ProviderDispatcher = async (request) => {
      dispatcherSignal = request.signal;
      return { kind: "stream", body: stream.body };
    };
    const broker = new ProviderBroker({ dispatcher });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-stream-revoke",
      runId: "run-stream-revoke",
      profileId: "profile-stream-revoke",
      model: "model-stream-revoke",
    });
    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-stream-revoke",
      stream: true,
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await expect(reader?.read()).resolves.toMatchObject({ done: false });
    await stream.secondRequested;

    broker.revoke(capability.capabilityId);
    await waitUntil(() => stream.returned(), 300);

    expect(dispatcherSignal?.aborted).toBe(true);
    expect(stream.returned()).toBe(true);
    await reader?.cancel().catch(() => {});
  });

  it("snapshots the iterator return getter once and calls cleanup with its receiver", async () => {
    const encoder = new TextEncoder();
    let returnReads = 0;
    let returnCalls = 0;
    let nextCalls = 0;
    let iterator: object;
    let markSecondRequested!: () => void;
    const secondRequested = new Promise<void>((resolve) => {
      markSecondRequested = resolve;
    });
    const returnMethod = function (this: object): Promise<IteratorResult<Uint8Array>> {
      if (this !== iterator) throw new Error("wrong cleanup receiver");
      returnCalls += 1;
      return Promise.resolve({ done: true, value: undefined });
    };
    iterator = Object.defineProperties(
      {},
      {
        next: {
          value: () => {
            nextCalls += 1;
            if (nextCalls === 1) {
              return Promise.resolve({ done: false, value: encoder.encode("data: cleanup\n\n") });
            }
            markSecondRequested();
            return new Promise<IteratorResult<Uint8Array>>(() => {});
          },
        },
        return: {
          get: () => {
            returnReads += 1;
            return returnMethod;
          },
        },
      },
    );
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => iterator as AsyncIterator<Uint8Array>,
    };
    const broker = new ProviderBroker({ dispatcher: async () => ({ kind: "stream", body }) });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-return-snapshot",
      runId: "run-return-snapshot",
      profileId: "profile-return-snapshot",
      model: "model-return-snapshot",
    });
    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-return-snapshot",
      stream: true,
    });
    const reader = response.body?.getReader();
    await reader?.read();
    await secondRequested;

    broker.revoke(capability.capabilityId);
    await waitUntil(() => returnCalls === 1, 300);

    expect(returnReads).toBe(1);
    expect(returnCalls).toBe(1);
    await reader?.cancel().catch(() => {});
  });

  it("cancels the active stream iterator when the client cancels its response body", async () => {
    const stream = blockingStream("data: client-close\n\n");
    let dispatcherSignal: AbortSignal | undefined;
    const dispatcher: ProviderDispatcher = async (request) => {
      dispatcherSignal = request.signal;
      return { kind: "stream", body: stream.body };
    };
    const broker = new ProviderBroker({ dispatcher });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-stream-client-close",
      runId: "run-stream-client-close",
      profileId: "profile-stream-client-close",
      model: "model-stream-client-close",
    });
    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-stream-client-close",
      stream: true,
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await expect(reader?.read()).resolves.toMatchObject({ done: false });
    await stream.secondRequested;

    await reader?.cancel();
    await waitUntil(() => dispatcherSignal?.aborted === true && stream.returned(), 300);

    expect(dispatcherSignal?.aborted).toBe(true);
    expect(stream.returned()).toBe(true);
  });

  it("cancels the active stream iterator when its capability expires", async () => {
    const stream = blockingStream("data: expiry\n\n");
    let dispatcherSignal: AbortSignal | undefined;
    const dispatcher: ProviderDispatcher = async (request) => {
      dispatcherSignal = request.signal;
      return { kind: "stream", body: stream.body };
    };
    const broker = new ProviderBroker({ dispatcher, requestTimeoutMs: 5_000 });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = broker.issue(
      {
        taskId: "task-stream-expiry",
        runId: "run-stream-expiry",
        profileId: "profile-stream-expiry",
        model: "model-stream-expiry",
        apiMode: "chat_completions",
        ttlMs: 1_000,
      },
      EMPTY_CREDENTIAL_LEASE,
    );
    const response = await postJson(
      endpoint.port,
      "/v1/chat/completions",
      capability.token,
      { model: "model-stream-expiry", stream: true },
      AbortSignal.timeout(2_000),
    );
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await expect(reader?.read()).resolves.toMatchObject({ done: false });
    await stream.secondRequested;

    await waitUntil(() => dispatcherSignal?.aborted === true && stream.returned(), 1_500);

    expect(dispatcherSignal?.aborted).toBe(true);
    expect(stream.returned()).toBe(true);
    await reader?.cancel().catch(() => {});
  });

  it("waits for response backpressure before pulling the rest of a stream", async () => {
    const chunk = new TextEncoder().encode("data: backpressure\n\n");
    const totalChunks = 3;
    let nextCalls = 0;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          nextCalls += 1;
          return Promise.resolve(
            nextCalls <= totalChunks
              ? { done: false, value: chunk }
              : { done: true, value: undefined },
          );
        },
      }),
    };
    const broker = new ProviderBroker({
      dispatcher: async () => ({ kind: "stream", body }),
      requestTimeoutMs: 5_000,
    });
    brokers.push(broker);
    const endpoint = await broker.start();
    let markFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      markFirstWrite = resolve;
    });
    let blockedResponse: import("node:http").ServerResponse | undefined;
    let forcedBackpressure = false;
    const server = broker as unknown as {
      server: {
        prependListener(
          event: "request",
          listener: (_request: unknown, response: import("node:http").ServerResponse) => void,
        ): void;
      };
    };
    server.server.prependListener("request", (_request, response) => {
      const writable = response as unknown as { write(chunk: Uint8Array | string): boolean };
      const originalWrite = writable.write.bind(response);
      writable.write = (written) => {
        const accepted = originalWrite(written);
        if (!forcedBackpressure && Buffer.byteLength(written) > 0) {
          forcedBackpressure = true;
          blockedResponse = response;
          markFirstWrite();
          return false;
        }
        return accepted;
      };
    });
    const capability = issueFor(broker, {
      taskId: "task-backpressure",
      runId: "run-backpressure",
      profileId: "profile-backpressure",
      model: "model-backpressure",
    });
    const responsePromise = postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-backpressure",
      stream: true,
    });

    await firstWrite;
    expect(nextCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(nextCalls).toBe(1);

    blockedResponse?.emit("drain");
    const response = await responsePromise;
    await response.arrayBuffer();

    expect(response.status).toBe(200);
    expect(nextCalls).toBe(totalChunks + 1);
  });

  it("returns a fixed error when a dispatcher JSON result cannot be serialized", async () => {
    const canary = "circular-dispatch-result-canary";
    const circular: { canary: string; self?: unknown } = { canary };
    circular.self = circular;
    const broker = new ProviderBroker({
      dispatcher: async () => ({ kind: "json", body: circular }),
    });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-circular",
      runId: "run-circular",
      profileId: "profile-circular",
      model: "model-circular",
    });

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-circular",
    });
    const rendered = await response.text();

    expect(response.status).toBe(502);
    expect(JSON.parse(rendered).error.category).toBe("dispatch_failed");
    expect(rendered).not.toContain(canary);
  });

  it("returns a fixed error when a stream fails before its first chunk", async () => {
    const canary = "stream-first-chunk-canary";
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error(canary)),
      }),
    };
    const broker = new ProviderBroker({
      dispatcher: async () => ({ kind: "stream", body }),
    });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-first-stream-error",
      runId: "run-first-stream-error",
      profileId: "profile-first-stream-error",
      model: "model-first-stream-error",
    });

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-first-stream-error",
      stream: true,
    });
    const rendered = await response.text();

    expect(response.status).toBe(502);
    expect(JSON.parse(rendered).error.category).toBe("dispatch_failed");
    expect(rendered).not.toContain(canary);
  });

  it("single-flights concurrent starts and can listen again after a completed close", async () => {
    const broker = new ProviderBroker({
      dispatcher: async () => ({ kind: "json", body: { ok: true } }),
    });
    brokers.push(broker);

    const firstStart = broker.start();
    const secondStart = broker.start();
    expect(secondStart).toBe(firstStart);
    const firstEndpoint = await firstStart;
    await expect(canConnect("127.0.0.1", firstEndpoint.port)).resolves.toBe(true);

    await broker.close();
    await expect(canConnect("127.0.0.1", firstEndpoint.port)).resolves.toBe(false);
    const secondEndpoint = await broker.start();
    await expect(canConnect("127.0.0.1", secondEndpoint.port)).resolves.toBe(true);
    await broker.close();
    await expect(canConnect("127.0.0.1", secondEndpoint.port)).resolves.toBe(false);
  });

  it("returns the listening endpoint when start is repeated during an active request", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const broker = new ProviderBroker({
      dispatcher: async () => {
        markStarted();
        await wait;
        return { kind: "json", body: { ok: true } };
      },
    });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-repeat-start",
      runId: "run-repeat-start",
      profileId: "profile-repeat-start",
      model: "model-repeat-start",
    });
    const responsePromise = postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-repeat-start",
    });
    await started;

    try {
      await expect(broker.start()).resolves.toEqual(endpoint);
    } finally {
      release();
    }
    await expect(responsePromise).resolves.toMatchObject({ status: 200 });
  });

  it("does not allow a pending bind to outlive close or a new start to enter during close", async () => {
    const broker = new ProviderBroker({
      dispatcher: async () => ({ kind: "json", body: { ok: true } }),
      closeGraceMs: 100,
    });
    brokers.push(broker);

    const pendingStart = broker.start();
    const closing = broker.close();
    const startDuringClose = broker.start();
    await expect(startDuringClose).rejects.toThrow("Provider broker is closed");
    const endpoint = await pendingStart;
    await closing;
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(canConnect("127.0.0.1", endpoint.port)).resolves.toBe(false);
  });

  it("rechecks expiry after dispatch resolves and before writing response headers", async () => {
    const times = [1_000, 1_000, 1_000, 1_000, 2_001];
    const dispatcher = vi.fn<ProviderDispatcher>(async () => ({
      kind: "json",
      body: { mustNotBeWritten: true },
    }));
    const broker = new ProviderBroker({
      dispatcher,
      now: () => times.shift() ?? 2_001,
    });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = broker.issue(
      {
        taskId: "task-post-dispatch-expiry",
        runId: "run-post-dispatch-expiry",
        profileId: "profile-post-dispatch-expiry",
        model: "model-post-dispatch-expiry",
        apiMode: "chat_completions",
        ttlMs: 1_000,
      },
      EMPTY_CREDENTIAL_LEASE,
    );

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-post-dispatch-expiry",
    });

    expect(response.status).toBe(401);
    const payload = await response.json();
    expect(payload).toEqual({
      error: {
        category: "capability_expired",
        retryable: false,
        message: "Provider capability expired",
      },
    });
    expect(dispatcher).toHaveBeenCalledOnce();
  });

  it("rejects invalid dispatcher result kinds and undefined JSON bodies at runtime", async () => {
    const invalidResults = [
      { kind: "unknown", body: { unsafe: true } },
      { kind: "json", body: undefined },
      { kind: "json", body: () => "not-json" },
      { kind: "json", body: Symbol("not-json") },
    ];

    for (const [index, invalidResult] of invalidResults.entries()) {
      const broker = new ProviderBroker({
        dispatcher: async () => invalidResult as never,
      });
      brokers.push(broker);
      const endpoint = await broker.start();
      const capability = issueFor(broker, {
        taskId: `task-invalid-result-${index}`,
        runId: `run-invalid-result-${index}`,
        profileId: `profile-invalid-result-${index}`,
        model: `model-invalid-result-${index}`,
      });

      const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
        model: `model-invalid-result-${index}`,
      });

      expect(response.status).toBe(502);
      const payload = await response.json();
      expect(payload).toEqual({
        error: {
          category: "dispatch_failed",
          retryable: true,
          message: "Provider request failed",
        },
      });
    }
  });

  it("rejects invalid dispatcher sanitizer secrets before writing response headers", async () => {
    const broker = new ProviderBroker({
      dispatcher: async () =>
        ({
          kind: "json",
          body: { mustNotBeWritten: true },
          sanitizer: { secrets: [7] },
        }) as never,
    });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-invalid-sanitizer",
      runId: "run-invalid-sanitizer",
      profileId: "profile-invalid-sanitizer",
      model: "model-invalid-sanitizer",
    });

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-invalid-sanitizer",
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: {
        category: "dispatch_failed",
        retryable: true,
        message: "Provider request failed",
      },
    });
  });

  it("rejects short, non-ASCII, and control-character sanitizer credentials", async () => {
    for (const [index, secret] of [
      "short",
      "sk-provider-密钥",
      "sk-provider-line\nbreak",
    ].entries()) {
      const broker = new ProviderBroker({
        dispatcher: async () => ({
          kind: "json",
          body: { mustNotBeWritten: true },
          sanitizer: { secrets: [secret] },
        }),
      });
      brokers.push(broker);
      const endpoint = await broker.start();
      const capability = issueFor(broker, {
        taskId: `task-invalid-sanitizer-ascii-${index}`,
        runId: `run-invalid-sanitizer-ascii-${index}`,
        profileId: `profile-invalid-sanitizer-ascii-${index}`,
        model: `model-invalid-sanitizer-ascii-${index}`,
      });

      const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
        model: `model-invalid-sanitizer-ascii-${index}`,
      });
      expect(response.status).toBe(502);
      expect((await response.json()).error.category).toBe("dispatch_failed");
    }
  });

  it("snapshots dispatcher result getters exactly once before validation", async () => {
    const encoder = new TextEncoder();
    const body = (async function* () {
      yield encoder.encode("data: getter-safe\n\n");
    })();
    let kindReads = 0;
    let bodyReads = 0;
    let sanitizerReads = 0;
    const result = Object.defineProperties(
      {},
      {
        kind: {
          get: () => {
            kindReads += 1;
            return kindReads === 1 ? "stream" : "invalid";
          },
        },
        body: {
          get: () => {
            bodyReads += 1;
            return bodyReads === 1 ? body : null;
          },
        },
        sanitizer: {
          get: () => {
            sanitizerReads += 1;
            return sanitizerReads === 1 ? { secrets: [] } : { secrets: [7] };
          },
        },
      },
    );
    const broker = new ProviderBroker({ dispatcher: async () => result as never });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-result-snapshot",
      runId: "run-result-snapshot",
      profileId: "profile-result-snapshot",
      model: "model-result-snapshot",
    });

    const response = await postJson(endpoint.port, "/v1/chat/completions", capability.token, {
      model: "model-result-snapshot",
      stream: true,
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("data: getter-safe\n\n");
    expect({ kindReads, bodyReads, sanitizerReads }).toEqual({
      kindReads: 1,
      bodyReads: 1,
      sanitizerReads: 1,
    });
  });

  it("keeps the admission slot occupied while a stream iterator return never settles", async () => {
    const stream = blockingStream("data: stuck-return\n\n", { returnNeverSettles: true });
    const dispatcher: ProviderDispatcher = async (request) =>
      request.profileId === "profile-stuck-stream"
        ? { kind: "stream", body: stream.body }
        : { kind: "json", body: { profileId: request.profileId } };
    const broker = new ProviderBroker({ dispatcher, maxConcurrentRequests: 1 });
    brokers.push(broker);
    const endpoint = await broker.start();
    const stuck = issueFor(broker, {
      taskId: "task-stuck-stream",
      runId: "run-stuck-stream",
      profileId: "profile-stuck-stream",
      model: "model-stuck-stream",
    });
    const next = issueFor(broker, {
      taskId: "task-after-stuck-stream",
      runId: "run-after-stuck-stream",
      profileId: "profile-after-stuck-stream",
      model: "model-after-stuck-stream",
    });
    const stuckResponse = await postJson(endpoint.port, "/v1/chat/completions", stuck.token, {
      model: "model-stuck-stream",
      stream: true,
    });
    const reader = stuckResponse.body?.getReader();
    await reader?.read();
    await stream.secondRequested;

    broker.revoke(stuck.capabilityId);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await reader?.cancel().catch(() => {});
    const nextResponse = await postJson(endpoint.port, "/v1/chat/completions", next.token, {
      model: "model-after-stuck-stream",
    });

    expect(nextResponse.status).toBe(429);
    await expect(nextResponse.json()).resolves.toEqual({
      error: {
        category: "broker_busy",
        retryable: true,
        message: "Provider broker is busy",
      },
    });
  });

  it("retains a slot for a non-settling dispatcher and poisons restart after bounded close", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const dispatcher = vi.fn<ProviderDispatcher>(async (request) => {
      if (request.profileId === "profile-never-dispatch") {
        markStarted();
        return new Promise<never>(() => {});
      }
      return { kind: "json", body: { mustNotDispatch: true } };
    });
    const broker = new ProviderBroker({
      dispatcher,
      maxConcurrentRequests: 1,
      closeGraceMs: 30,
    });
    brokers.push(broker);
    const endpoint = await broker.start();
    const stuck = issueFor(broker, {
      taskId: "task-never-dispatch",
      runId: "run-never-dispatch",
      profileId: "profile-never-dispatch",
      model: "model-never-dispatch",
    });
    const next = issueFor(broker, {
      taskId: "task-after-never-dispatch",
      runId: "run-after-never-dispatch",
      profileId: "profile-after-never-dispatch",
      model: "model-after-never-dispatch",
    });
    const stuckResponsePromise = postJson(
      endpoint.port,
      "/v1/chat/completions",
      stuck.token,
      { model: "model-never-dispatch" },
      AbortSignal.timeout(1_000),
    );
    await started;

    broker.revoke(stuck.capabilityId);
    const stuckResponse = await stuckResponsePromise;
    const nextResponse = await postJson(endpoint.port, "/v1/chat/completions", next.token, {
      model: "model-after-never-dispatch",
    });

    expect(stuckResponse.status).toBe(401);
    expect(nextResponse.status).toBe(429);
    expect((await nextResponse.json()).error.category).toBe("broker_busy");
    expect(dispatcher).toHaveBeenCalledOnce();

    await broker.close();
    await expect(broker.start()).rejects.toThrow("Provider broker is closed");
    expect(() =>
      issueWithLease(
        broker,
        {
          taskId: "task-after-poison",
          runId: "run-after-poison",
          profileId: "profile-after-poison",
          model: "model-after-poison",
          apiMode: "chat_completions",
          ttlMs: 30_000,
        },
        { secrets: [] },
      ),
    ).toThrow("Provider broker is closed");
  });

  it("prunes expired capability digests after a bounded tombstone window", () => {
    let now = 1_000;
    const broker = new ProviderBroker({
      dispatcher: async () => ({ kind: "json", body: { ok: true } }),
      now: () => now,
    });
    brokers.push(broker);
    const expired = broker.issue(
      {
        taskId: "task-pruned",
        runId: "run-pruned",
        profileId: "profile-pruned",
        model: "model-pruned",
        apiMode: "chat_completions",
        ttlMs: 1_000,
      },
      EMPTY_CREDENTIAL_LEASE,
    );
    const expiredDigest = createHash("sha256").update(expired.token, "utf8").digest("hex");
    expect(objectGraphContains(broker, expiredDigest)).toBe(true);

    now = 32_001;
    const current = issueFor(broker, {
      taskId: "task-current",
      runId: "run-current",
      profileId: "profile-current",
      model: "model-current",
    });
    const currentDigest = createHash("sha256").update(current.token, "utf8").digest("hex");

    expect(objectGraphContains(broker, expiredDigest)).toBe(false);
    expect(objectGraphContains(broker, currentDigest)).toBe(true);
  });

  it("times out an admitted request while its JSON body is still incomplete", async () => {
    const dispatcher = vi.fn<ProviderDispatcher>();
    const broker = new ProviderBroker({ dispatcher, requestTimeoutMs: 30 });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-slow-body",
      runId: "run-slow-body",
      profileId: "profile-slow-body",
      model: "model-slow-body",
    });
    const clientRequest = httpRequest({
      host: "127.0.0.1",
      port: endpoint.port,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        authorization: `Bearer ${capability.token}`,
        "content-type": "application/json",
      },
    });
    clientRequest.on("error", () => {});
    const responsePromise = collectNodeResponse(clientRequest);
    clientRequest.write('{"model":"model-slow-body","input":"unfinished');

    let result: { status: number; body: string };
    try {
      result = await Promise.race([
        responsePromise,
        rejectAfter(500, "slow body timeout did not finish"),
      ]);
    } finally {
      clientRequest.destroy();
    }

    expect(result.status).toBe(504);
    expect(JSON.parse(result.body).error.category).toBe("request_timeout");
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it("keeps the native HTTP timeout behind the broker JSON timeout", () => {
    const requestTimeoutMs = 50_000;
    const broker = new ProviderBroker({
      dispatcher: async () => ({ kind: "json", body: { ok: true } }),
      requestTimeoutMs,
    });
    brokers.push(broker);
    const server = (broker as unknown as { server: { requestTimeout: number } }).server;

    expect(server.requestTimeout).toBeGreaterThan(requestTimeoutMs);
    expect(server.requestTimeout).toBeLessThanOrEqual(requestTimeoutMs + 10_000);
  });

  it("requires a case-sensitive single-space bearer scheme with the bound token", async () => {
    const dispatcher = vi.fn<ProviderDispatcher>();
    const broker = new ProviderBroker({ dispatcher });
    brokers.push(broker);
    const endpoint = await broker.start();
    const capability = issueFor(broker, {
      taskId: "task-bearer",
      runId: "run-bearer",
      profileId: "profile-bearer",
      model: "model-bearer",
    });
    const malformed = [
      `bearer ${capability.token}`,
      `Bearer  ${capability.token}`,
      `Bearer ${"x".repeat(43)}`,
    ];

    for (const authorization of malformed) {
      const response = await fetch(`http://127.0.0.1:${endpoint.port}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ model: "model-bearer" }),
      });
      expect(response.status).toBe(401);
      expect((await response.json()).error.category).toBe("unauthorized");
    }
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it("bounds the in-memory capability registry", () => {
    const broker = new ProviderBroker({
      dispatcher: async () => ({ kind: "json", body: { ok: true } }),
    });
    brokers.push(broker);
    for (let index = 0; index < 256; index += 1) {
      issueFor(broker, {
        taskId: `task-capacity-${index}`,
        runId: `run-capacity-${index}`,
        profileId: `profile-capacity-${index}`,
        model: `model-capacity-${index}`,
      });
    }

    expect(() =>
      issueFor(broker, {
        taskId: "task-capacity-overflow",
        runId: "run-capacity-overflow",
        profileId: "profile-capacity-overflow",
        model: "model-capacity-overflow",
      }),
    ).toThrow("Provider capability registry is full");
  });
});

function issueFor(
  broker: ProviderBroker,
  binding: { taskId: string; runId: string; profileId: string; model: string },
) {
  return broker.issue(
    {
      ...binding,
      apiMode: "chat_completions",
      ttlMs: 30_000,
    },
    EMPTY_CREDENTIAL_LEASE,
  );
}

function issueWithLease(
  broker: ProviderBroker,
  input: Parameters<ProviderBroker["issue"]>[0],
  lease: { readonly secrets: readonly string[] },
): ReturnType<ProviderBroker["issue"]> {
  const issue = broker.issue as unknown as (
    capability: Parameters<ProviderBroker["issue"]>[0],
    credentialLease: { readonly secrets: readonly string[] },
  ) => ReturnType<ProviderBroker["issue"]>;
  return issue.call(broker, input, lease);
}

function postJson(
  port: number,
  path: string,
  token: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
}

function requestJson(
  port: number,
  method: string,
  path: string,
  token: string,
  body: unknown,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function collectNodeResponse(
  request: ReturnType<typeof httpRequest>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    request.once("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("end", () => {
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
      });
      response.once("error", reject);
    });
    request.once("error", reject);
  });
}

function rejectAfter<T>(timeoutMs: number, message: string): Promise<T> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(message)), timeoutMs);
  });
}

async function readResponseUntilClosed(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let rendered = "";
  while (true) {
    try {
      const step = await reader.read();
      if (step.done) return rendered + decoder.decode();
      rendered += decoder.decode(step.value, { stream: true });
    } catch {
      return rendered + decoder.decode();
    }
  }
}

function objectGraphContains(root: unknown, needle: string, seen = new Set<object>()): boolean {
  if (typeof root === "string") return root.includes(needle);
  if (typeof root !== "object" || root === null || seen.has(root)) return false;
  seen.add(root);
  if (root instanceof Map) {
    for (const [key, value] of root) {
      if (objectGraphContains(key, needle, seen) || objectGraphContains(value, needle, seen)) {
        return true;
      }
    }
    return false;
  }
  if (root instanceof Set) {
    for (const value of root) {
      if (objectGraphContains(value, needle, seen)) return true;
    }
    return false;
  }
  for (const key of Reflect.ownKeys(root)) {
    if (objectGraphContains((root as Record<PropertyKey, unknown>)[key], needle, seen)) return true;
  }
  return false;
}

function blockingStream(
  firstChunk: string,
  options: { returnNeverSettles?: boolean } = {},
): {
  body: AsyncIterable<Uint8Array>;
  secondRequested: Promise<void>;
  returned: () => boolean;
} {
  const encoder = new TextEncoder();
  let nextCount = 0;
  let didReturn = false;
  let markSecondRequested!: () => void;
  const secondRequested = new Promise<void>((resolve) => {
    markSecondRequested = resolve;
  });
  const iterator: AsyncIterator<Uint8Array> = {
    next: () => {
      nextCount += 1;
      if (nextCount === 1) {
        return Promise.resolve({ done: false, value: encoder.encode(firstChunk) });
      }
      markSecondRequested();
      return new Promise<IteratorResult<Uint8Array>>(() => {});
    },
    return: () => {
      didReturn = true;
      if (options.returnNeverSettles) {
        return new Promise<IteratorResult<Uint8Array>>(() => {});
      }
      return Promise.resolve({ done: true, value: undefined });
    },
  };
  return {
    body: { [Symbol.asyncIterator]: () => iterator },
    secondRequested,
    returned: () => didReturn,
  };
}
