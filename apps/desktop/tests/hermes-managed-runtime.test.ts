import type {
  RuntimeAdapter,
  RuntimeBinding,
  RuntimeCreateInput,
  RuntimeResumeInput,
} from "@opentrad/runtime-adapter";
import { describe, expect, it, vi } from "vitest";
import { createManagedHermesRuntime } from "../src/main/services/hermes/managed-runtime";
import type { InstalledHermesRuntime } from "../src/main/services/hermes/runtime-installer";

const installed: InstalledHermesRuntime = {
  runtimeRoot: "/data/runtimes/hermes/0.18.2",
  pythonExecutable: "/data/runtimes/hermes/0.18.2/venv/bin/python3",
  bundledSkillsRoot: "/data/runtimes/hermes/0.18.2/share/hermes/skills",
  version: "0.18.2",
  releaseTag: "v2026.7.7.2",
  didInstall: true,
};

describe("managed Hermes runtime gate", () => {
  it("installs once before ready/create/resume and forwards progress", async () => {
    const inner = fakeRuntime();
    const progress = vi.fn();
    const installer = {
      ensureInstalled: vi.fn(async (listener) => {
        listener?.({ phase: "checking" });
        listener?.({ phase: "ready" });
        return installed;
      }),
    };
    const runtime = createManagedHermesRuntime({
      runtime: inner.runtime,
      installer,
      onInstallProgress: progress,
    });

    await Promise.all([
      runtime.ready(),
      runtime.create(createInput()),
      runtime.resume({ ...createInput(), durableRuntimeSessionId: "durable-1" }),
    ]);

    expect(installer.ensureInstalled).toHaveBeenCalledTimes(1);
    expect(progress.mock.calls.map(([event]) => event.phase)).toEqual(["checking", "ready"]);
    expect(inner.ready).toHaveBeenCalledTimes(1);
    expect(inner.create).toHaveBeenCalledTimes(1);
    expect(inner.resume).toHaveBeenCalledTimes(1);
  });

  it("fails before runtime work and permits an installation retry", async () => {
    const inner = fakeRuntime();
    const installer = {
      ensureInstalled: vi
        .fn()
        .mockRejectedValueOnce(new Error("install failed"))
        .mockResolvedValueOnce(installed),
    };
    const runtime = createManagedHermesRuntime({ runtime: inner.runtime, installer });

    await expect(runtime.create(createInput())).rejects.toThrow("install failed");
    expect(inner.create).not.toHaveBeenCalled();
    await expect(runtime.create(createInput())).resolves.toMatchObject({
      canonicalSessionId: "session-1",
    });
    expect(installer.ensureInstalled).toHaveBeenCalledTimes(2);
  });

  it("waits for an in-flight installation before disposing the inner runtime", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = fakeRuntime();
    const installer = {
      ensureInstalled: vi.fn(async () => {
        await gate;
        return installed;
      }),
    };
    const runtime = createManagedHermesRuntime({ runtime: inner.runtime, installer });
    const readiness = runtime.ready();
    const disposing = runtime.dispose();
    expect(inner.dispose).not.toHaveBeenCalled();
    release();

    await expect(readiness).rejects.toThrow("disposed");
    await disposing;
    expect(inner.dispose).toHaveBeenCalledTimes(1);
  });

  it("forwards interaction responses and guards them after disposal", async () => {
    const inner = fakeRuntime();
    const installer = { ensureInstalled: vi.fn(async () => installed) };
    const runtime = createManagedHermesRuntime({ runtime: inner.runtime, installer });
    const binding = await runtime.create(createInput());

    expect(runtime.respondApproval).toBeTypeOf("function");
    expect(runtime.respondSudo).toBeTypeOf("function");
    expect(runtime.respondSecret).toBeTypeOf("function");
    await runtime.respondApproval?.(binding, "once");
    await runtime.respondSudo?.(binding, "feedface", "sudo-secret-canary");
    await runtime.respondSecret?.(binding, "feedface", "tool-secret-canary");

    expect(inner.respondApproval).toHaveBeenCalledWith(binding, "once");
    expect(inner.respondSudo).toHaveBeenCalledWith(binding, "feedface", "sudo-secret-canary");
    expect(inner.respondSecret).toHaveBeenCalledWith(binding, "feedface", "tool-secret-canary");

    await runtime.dispose();
    await expect(runtime.respondApproval?.(binding, "deny")).rejects.toThrow("disposed");
    await expect(
      runtime.respondSudo?.(binding, "feedface", "not-forwarded-secret"),
    ).rejects.toThrow("disposed");
    await expect(
      runtime.respondSecret?.(binding, "feedface", "not-forwarded-secret"),
    ).rejects.toThrow("disposed");
    expect(inner.respondApproval).toHaveBeenCalledTimes(1);
    expect(inner.respondSudo).toHaveBeenCalledTimes(1);
    expect(inner.respondSecret).toHaveBeenCalledTimes(1);
  });

  it("forwards Profile invalidation without triggering a runtime installation", async () => {
    const inner = fakeRuntime();
    const installer = { ensureInstalled: vi.fn(async () => installed) };
    const runtime = createManagedHermesRuntime({ runtime: inner.runtime, installer });

    expect(runtime.invalidateProfile).toBeTypeOf("function");
    await runtime.invalidateProfile?.("profile-1");

    expect(inner.invalidateProfile).toHaveBeenCalledWith("profile-1");
    expect(installer.ensureInstalled).not.toHaveBeenCalled();
  });
});

function createInput(): RuntimeCreateInput {
  return {
    canonicalSessionId: "session-1",
    taskId: "task-1",
    runId: "run-1",
    workspaceRoot: "/workspace",
    provider: {
      profileId: "profile-1",
      providerSlug: "deepseek",
      authMode: "api_key",
      model: "deepseek-chat",
      apiMode: "chat_completions",
      executionBackend: "local",
    },
  };
}

function fakeRuntime() {
  const binding: RuntimeBinding = {
    canonicalSessionId: "session-1",
    liveRuntimeSessionId: "live-1",
    durableRuntimeSessionId: "durable-1",
  };
  const ready = vi.fn(async () => ({ version: "hermes-agent/0.18.2" }));
  const create = vi.fn(async (_input: RuntimeCreateInput) => binding);
  const resume = vi.fn(async (_input: RuntimeResumeInput) => binding);
  const respondApproval = vi.fn(async (_binding: RuntimeBinding, _choice: string) => {});
  const respondSudo = vi.fn(
    async (_binding: RuntimeBinding, _requestId: string, _password: string) => {},
  );
  const respondSecret = vi.fn(
    async (_binding: RuntimeBinding, _requestId: string, _value: string) => {},
  );
  const invalidateProfile = vi.fn(async (_profileId: string) => {});
  const dispose = vi.fn(async () => {});
  const runtime: RuntimeAdapter = {
    kind: "hermes",
    ready,
    create,
    resume,
    respondApproval,
    respondSudo,
    respondSecret,
    invalidateProfile,
    stream: async () => {},
    interrupt: async () => {},
    close: async () => {},
    onCrash: () => () => {},
    dispose,
  };
  return {
    runtime,
    ready,
    create,
    resume,
    respondApproval,
    respondSudo,
    respondSecret,
    invalidateProfile,
    dispose,
  };
}
