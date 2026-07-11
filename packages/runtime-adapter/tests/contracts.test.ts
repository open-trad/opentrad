import { describe, expect, it } from "vitest";
import {
  type RuntimeAdapter,
  type RuntimeBinding,
  type RuntimeCrash,
  type RuntimeCreateInput,
  type RuntimeEventSink,
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

  it("identifies unsupported legacy resume attempts", () => {
    const error = new RuntimeResumeUnsupportedError("legacy");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("RuntimeResumeUnsupportedError");
    expect(error.runtimeKind).toBe("legacy");
    expect(error.message).toContain("legacy");
  });
});

function bindingOf(canonicalSessionId: string, durableRuntimeSessionId: string | null = null) {
  return {
    canonicalSessionId,
    liveRuntimeSessionId: canonicalSessionId,
    durableRuntimeSessionId,
  } satisfies RuntimeBinding;
}
