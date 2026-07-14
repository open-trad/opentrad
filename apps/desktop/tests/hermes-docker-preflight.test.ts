import type { ProviderProfile } from "@opentrad/model-providers";
import { describe, expect, it, vi } from "vitest";
import {
  createHermesDockerPreflight,
  HermesDockerPreflightError,
} from "../src/main/services/hermes/docker-preflight";

function profile(executionBackend: "local" | "docker"): ProviderProfile {
  return {
    id: "profile-1",
    displayName: "DeepSeek",
    kind: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    credentialRef: "apikey:profile-1",
    pricing: null,
    hermes: {
      providerSlug: "deepseek",
      authMode: "api_key",
      apiMode: "chat_completions",
      executionBackend,
    },
  };
}

describe("Hermes Docker preflight", () => {
  it("does not probe Docker for a local Profile", async () => {
    const runner = vi.fn();
    const resolveExecutable = vi.fn();
    const validate = createHermesDockerPreflight({ runner, resolveExecutable });

    await expect(validate(profile("local"), "/Users/test/workspace")).resolves.toBeUndefined();
    expect(resolveExecutable).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("checks the Docker daemon with a fixed absolute executable and bounded output", async () => {
    const runner = vi.fn(async () => ({ stdout: "27.5.1\n" }));
    const resolveExecutable = vi.fn(async () => "/Applications/Docker.app/bin/docker");
    const validate = createHermesDockerPreflight({ runner, resolveExecutable });

    await expect(validate(profile("docker"), "/Users/test/workspace")).resolves.toBeUndefined();
    expect(runner).toHaveBeenCalledWith("/Applications/Docker.app/bin/docker", [
      "version",
      "--format",
      "{{.Server.Version}}",
    ]);
  });

  it.each([
    ["relative workspace", async () => ({ stdout: "27.5.1\n" }), "workspace"],
    ["missing executable", async () => ({ stdout: "27.5.1\n" }), "/Users/test/workspace"],
    [
      "daemon failure",
      async () => Promise.reject(new Error("daemon-canary")),
      "/Users/test/workspace",
    ],
    [
      "malformed output",
      async () => ({ stdout: "server-secret-canary\nnext" }),
      "/Users/test/workspace",
    ],
  ] as const)("fails closed without reflecting details: %s", async (label, run, workspaceRoot) => {
    const runner = vi.fn(run);
    const resolveExecutable = vi.fn(async () => {
      if (label === "missing executable") throw new Error("path-canary");
      return "/Applications/Docker.app/bin/docker";
    });
    const validate = createHermesDockerPreflight({ runner, resolveExecutable });

    const error = await validate(profile("docker"), workspaceRoot).catch((cause) => cause);

    expect(error).toBeInstanceOf(HermesDockerPreflightError);
    expect(error).toMatchObject({ code: "HERMES_DOCKER_UNAVAILABLE" });
    expect(String(error)).not.toContain("canary");
    expect(JSON.stringify(error)).not.toContain("canary");
  });
});
