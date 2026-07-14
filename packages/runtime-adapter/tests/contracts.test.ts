import { describe, expect, it } from "vitest";
import {
  type RuntimeAdapter,
  type RuntimeBinding,
  type RuntimeCrash,
  type RuntimeCreateInput,
  type RuntimeEventSink,
  RuntimeOperationQuarantinedError,
  type RuntimeProviderSelection,
  type RuntimeResumeInput,
  RuntimeResumeUnsupportedError,
  selectRuntimeKind,
} from "../src";

describe("runtime adapter public contract", () => {
  it("exports the selector from the package entrypoint", () => {
    expect(selectRuntimeKind({ persistedPreference: "hermes" })).toBe("hermes");
  });

  it("exposes a binding with canonical, live, and durable runtime identifiers", () => {
    const binding: RuntimeBinding = {
      canonicalSessionId: "canonical-1",
      liveRuntimeSessionId: "live-1",
      durableRuntimeSessionId: "durable-1",
    };

    expect(binding).toEqual({
      canonicalSessionId: "canonical-1",
      liveRuntimeSessionId: "live-1",
      durableRuntimeSessionId: "durable-1",
    });
  });

  it("provides the complete adapter method surface", () => {
    const adapter = {
      kind: "legacy",
      ready: async () => ({ version: "test" }),
      create: async (input: RuntimeCreateInput) => bindingOf(input.canonicalSessionId),
      stream: async (_binding: RuntimeBinding, _prompt: string, _emit: RuntimeEventSink) => {},
      interrupt: async (_binding: RuntimeBinding) => {},
      close: async (_binding: RuntimeBinding) => {},
      resume: async (input: RuntimeResumeInput) =>
        bindingOf(input.canonicalSessionId, input.durableRuntimeSessionId),
      onCrash: (_listener: (crash: RuntimeCrash) => void) => () => {},
      dispose: async () => {},
    } satisfies RuntimeAdapter;

    expect(adapter.kind).toBe("legacy");
  });

  it("permits runtimes to expose optional interaction response methods", async () => {
    const respondApproval = async (
      _binding: RuntimeBinding,
      _choice: "once" | "session" | "always" | "deny",
    ) => {};
    const respondSudo = async (
      _binding: RuntimeBinding,
      _requestId: string,
      _password: string,
    ) => {};
    const respondSecret = async (
      _binding: RuntimeBinding,
      _requestId: string,
      _value: string,
    ) => {};
    const adapter = {
      kind: "hermes",
      ready: async () => ({ version: "test" }),
      create: async (input: RuntimeCreateInput) => bindingOf(input.canonicalSessionId),
      stream: async (_binding: RuntimeBinding, _prompt: string, _emit: RuntimeEventSink) => {},
      interrupt: async (_binding: RuntimeBinding) => {},
      close: async (_binding: RuntimeBinding) => {},
      resume: async (input: RuntimeResumeInput) =>
        bindingOf(input.canonicalSessionId, input.durableRuntimeSessionId),
      respondApproval,
      respondSudo,
      respondSecret,
      onCrash: (_listener: (crash: RuntimeCrash) => void) => () => {},
      dispose: async () => {},
    } satisfies RuntimeAdapter;
    const binding = bindingOf("canonical-1");

    await adapter.respondApproval(binding, "session");
    await adapter.respondSudo(binding, "feedface", "sudo-secret-canary");
    await adapter.respondSecret(binding, "feedface", "tool-secret-canary");

    expect(adapter.kind).toBe("hermes");
  });

  it("permits runtimes to expose an explicit Profile invalidation channel", async () => {
    const invalidated: string[] = [];
    const adapter = {
      kind: "hermes",
      ready: async () => ({ version: "test" }),
      create: async (input: RuntimeCreateInput) => bindingOf(input.canonicalSessionId),
      stream: async (_binding: RuntimeBinding, _prompt: string, _emit: RuntimeEventSink) => {},
      interrupt: async (_binding: RuntimeBinding) => {},
      close: async (_binding: RuntimeBinding) => {},
      resume: async (input: RuntimeResumeInput) =>
        bindingOf(input.canonicalSessionId, input.durableRuntimeSessionId),
      invalidateProfile: async (profileId: string) => {
        invalidated.push(profileId);
      },
      onCrash: (_listener: (crash: RuntimeCrash) => void) => () => {},
      dispose: async () => {},
    } satisfies RuntimeAdapter;

    await adapter.invalidateProfile("profile-1");

    expect(invalidated).toEqual(["profile-1"]);
  });

  it("carries immutable task, run, workspace, and provider launch context", () => {
    const provider = {
      profileId: "profile-1",
      providerSlug: "anthropic",
      authMode: "api_key",
      model: "claude-sonnet-4",
      apiMode: "chat_completions",
      executionBackend: "local",
    } satisfies RuntimeProviderSelection;
    const createInput: RuntimeCreateInput = {
      canonicalSessionId: "canonical-1",
      taskId: "task-1",
      runId: "run-1",
      workspaceRoot: "/workspace/project",
      provider,
    };
    const resumeInput: RuntimeResumeInput = {
      ...createInput,
      durableRuntimeSessionId: "durable-1",
    };

    expect(createInput.provider.apiMode).toBe("chat_completions");
    expect(createInput.provider.providerSlug).toBe("anthropic");
    expect(resumeInput.durableRuntimeSessionId).toBe("durable-1");
  });

  it("identifies unsupported legacy resume attempts", () => {
    const error = new RuntimeResumeUnsupportedError("legacy");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("RuntimeResumeUnsupportedError");
    expect(error.runtimeKind).toBe("legacy");
    expect(error.message).toContain("legacy");
  });

  it.each([
    "stream",
    "interrupt",
  ] as const)("exposes a fixed safe quarantine error for %s", (operation) => {
    const error = new RuntimeOperationQuarantinedError(operation);

    expect(error).toMatchObject({
      name: "RuntimeOperationQuarantinedError",
      code: "RUNTIME_OPERATION_QUARANTINED",
      operation,
      message: "Runtime operation is unavailable while Hermes is quarantined",
    });
  });
});

function bindingOf(canonicalSessionId: string, durableRuntimeSessionId: string | null = null) {
  return {
    canonicalSessionId,
    liveRuntimeSessionId: canonicalSessionId,
    durableRuntimeSessionId,
  } satisfies RuntimeBinding;
}
