import { describe, expect, it } from "vitest";
import { HermesRuntimeInstallProgressSchema, IpcChannels } from "../src";

describe("Hermes managed-runtime installation progress IPC", () => {
  it("accepts only the fixed phases and pinned artifact identities", () => {
    expect(HermesRuntimeInstallProgressSchema.parse({ phase: "checking" })).toEqual({
      phase: "checking",
    });
    expect(
      HermesRuntimeInstallProgressSchema.parse({
        phase: "downloading",
        artifact: "hermes-wheel",
      }),
    ).toEqual({ phase: "downloading", artifact: "hermes-wheel" });
    expect(
      HermesRuntimeInstallProgressSchema.parse({
        phase: "verifying-download",
        artifact: "requirements-lock",
      }),
    ).toEqual({ phase: "verifying-download", artifact: "requirements-lock" });

    expect(
      HermesRuntimeInstallProgressSchema.safeParse({
        phase: "downloading",
        artifact: "arbitrary-file",
      }).success,
    ).toBe(false);
    expect(HermesRuntimeInstallProgressSchema.safeParse({ phase: "downloading" }).success).toBe(
      false,
    );
    expect(
      HermesRuntimeInstallProgressSchema.safeParse({
        phase: "ready",
        artifact: "hermes-wheel",
      }).success,
    ).toBe(false);
  });

  it("rejects unexpected fields so URLs, secrets, and installer diagnostics cannot cross IPC", () => {
    for (const payload of [
      { phase: "checking", url: "https://example.invalid/runtime" },
      { phase: "installing", secret: "never-cross-ipc" },
      { phase: "ready", message: "internal path or error" },
    ]) {
      expect(HermesRuntimeInstallProgressSchema.safeParse(payload).success).toBe(false);
    }
  });

  it("uses one renderer-safe push channel", () => {
    expect(IpcChannels.HermesRuntimeInstallProgress).toBe("installer:hermes-runtime-progress");
  });
});
