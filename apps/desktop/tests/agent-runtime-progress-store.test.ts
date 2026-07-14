import type { HermesRuntimeInstallProgress } from "@opentrad/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type AgentStoreModule = typeof import("../src/renderer/stores/agent");

let module: AgentStoreModule;
let progressSubscriptions: {
  handler: (progress: HermesRuntimeInstallProgress) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
}[];
let pendingStarts: {
  resolve: (value: { sessionId: string; resumable: boolean }) => void;
  reject: (reason: Error) => void;
}[];

const selectWorkspace = vi.fn(async () => ({ workspaceRoot: "/Users/test/workspace" }));
const startSession = vi.fn(
  () =>
    new Promise<{ sessionId: string; resumable: boolean }>((resolve, reject) => {
      pendingStarts.push({ resolve, reject });
    }),
);

beforeEach(async () => {
  vi.resetModules();
  progressSubscriptions = [];
  pendingStarts = [];
  selectWorkspace.mockClear();
  startSession.mockClear();

  (globalThis as { window?: unknown }).window = {
    api: {
      installer: {
        onHermesRuntimeInstallProgress(handler: (progress: HermesRuntimeInstallProgress) => void) {
          const unsubscribe = vi.fn();
          progressSubscriptions.push({ handler, unsubscribe });
          return unsubscribe;
        },
      },
      agent: {
        onEvent: vi.fn(() => vi.fn()),
        selectWorkspace,
        startSession,
      },
    },
  };
  module = await import("../src/renderer/stores/agent");
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("AgentStore managed Hermes runtime progress", () => {
  it("subscribes before session creation and exposes progress until creation succeeds", async () => {
    const creation = module.useAgentStore.getState().startSession({ profileId: "profile-1" });
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));

    expect(progressSubscriptions).toHaveLength(1);
    progressSubscriptions[0]?.handler({ phase: "downloading", artifact: "hermes-wheel" });
    expect(module.useAgentStore.getState().runtimeInstallProgress).toEqual({
      phase: "downloading",
      artifact: "hermes-wheel",
    });

    pendingStarts[0]?.resolve({ sessionId: "session-1", resumable: true });
    await creation;
    expect(module.useAgentStore.getState().runtimeInstallProgress).toBeNull();
    expect(module.useAgentStore.getState().sessionId).toBe("session-1");
    expect(progressSubscriptions[0]?.unsubscribe).toHaveBeenCalledOnce();

    progressSubscriptions[0]?.handler({ phase: "installing-wheel" });
    expect(module.useAgentStore.getState().runtimeInstallProgress).toBeNull();
  });

  it("clears progress when runtime-backed session creation fails", async () => {
    const creation = module.useAgentStore.getState().startSession({ profileId: "profile-1" });
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));
    progressSubscriptions[0]?.handler({ phase: "verifying-runtime" });
    expect(module.useAgentStore.getState().runtimeInstallProgress).toEqual({
      phase: "verifying-runtime",
    });

    pendingStarts[0]?.reject(new Error("managed runtime install failed"));
    await creation;

    expect(module.useAgentStore.getState().runtimeInstallProgress).toBeNull();
    expect(module.useAgentStore.getState().error).toBe("managed runtime install failed");
    expect(progressSubscriptions[0]?.unsubscribe).toHaveBeenCalledOnce();

    progressSubscriptions[0]?.handler({ phase: "installing-wheel" });
    expect(module.useAgentStore.getState().runtimeInstallProgress).toBeNull();
  });

  it("unsubscribes when workspace selection is cancelled", async () => {
    selectWorkspace.mockResolvedValueOnce(null);

    await module.useAgentStore.getState().startSession({ profileId: "profile-1" });

    expect(startSession).not.toHaveBeenCalled();
    expect(progressSubscriptions).toHaveLength(1);
    expect(progressSubscriptions[0]?.unsubscribe).toHaveBeenCalledOnce();

    progressSubscriptions[0]?.handler({ phase: "downloading", artifact: "cpython" });
    expect(module.useAgentStore.getState().runtimeInstallProgress).toBeNull();
  });

  it("isolates overlapping attempts so an older attempt cannot update or clear newer progress", async () => {
    const first = module.useAgentStore.getState().startSession({ profileId: "profile-1" });
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));
    const second = module.useAgentStore.getState().startSession({ profileId: "profile-2" });
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledTimes(2));

    expect(progressSubscriptions).toHaveLength(2);
    progressSubscriptions[0]?.handler({ phase: "downloading", artifact: "stale-runtime" });
    expect(module.useAgentStore.getState().runtimeInstallProgress).toBeNull();

    progressSubscriptions[1]?.handler({ phase: "installing-wheel" });
    expect(module.useAgentStore.getState().runtimeInstallProgress).toEqual({
      phase: "installing-wheel",
    });

    pendingStarts[0]?.resolve({ sessionId: "stale-session", resumable: true });
    await first;
    expect(progressSubscriptions[0]?.unsubscribe).toHaveBeenCalledOnce();
    expect(module.useAgentStore.getState().runtimeInstallProgress).toEqual({
      phase: "installing-wheel",
    });

    pendingStarts[1]?.resolve({ sessionId: "current-session", resumable: true });
    await second;
    expect(progressSubscriptions[1]?.unsubscribe).toHaveBeenCalledOnce();
    expect(module.useAgentStore.getState().runtimeInstallProgress).toBeNull();

    progressSubscriptions[1]?.handler({ phase: "verifying-runtime" });
    expect(module.useAgentStore.getState().runtimeInstallProgress).toBeNull();
  });
});
