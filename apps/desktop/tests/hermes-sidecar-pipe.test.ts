import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveHermesPaths } from "../src/main/services/hermes/paths";
import {
  type HermesSidecarBinding,
  type HermesSidecarCapabilityLease,
  HermesSidecarManager,
} from "../src/main/services/hermes/sidecar-manager";
import { createHermesGatewaySpawnSpec } from "../src/main/services/hermes/spawn-spec";

const tempDirs: string[] = [];
const binding: HermesSidecarBinding = {
  taskId: "pipe-task",
  runId: "pipe-run",
  profileId: "pipe-profile",
  providerSlug: "deepseek",
  authMode: "api_key",
  model: "openai/gpt-5.2",
  apiMode: "chat_completions",
  executionBackend: "local",
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("HermesSidecarManager real Node pipes", () => {
  it.skipIf(process.platform === "win32")(
    "owns a real child pipe through pinned ready and graceful stdin EOF",
    async () => {
      const dataRoot = await mkdtemp(join(tmpdir(), "opentrad-sidecar-pipe-"));
      tempDirs.push(dataRoot);
      const resolved = resolveHermesPaths(dataRoot, "darwin");
      const fixture = join(
        dirname(fileURLToPath(import.meta.url)),
        "fixtures",
        "hermes_gateway_ready.py",
      );
      const paths = { ...resolved, pythonExecutable: "/usr/bin/python3" };
      const launcherPath = fixture;
      const manager = new HermesSidecarManager({
        binding,
        dataRoot,
        workspaceRoot: dataRoot,
        issueCapability: issueTestCapability,
        launcherPath,
        paths,
        platform: "darwin",
        initializeProfileHome: async () => {},
        verifyInstallation: vi.fn(async () => {}),
        spawnSpecFactory: (managedPaths, ownedLauncherPath, workspaceRoot) =>
          createHermesGatewaySpawnSpec(managedPaths, ownedLauncherPath, workspaceRoot),
      });

      await expect(manager.start()).resolves.toBeUndefined();
      expect(manager.state).toBe("ready");

      await expect(manager.stop()).resolves.toBeUndefined();
      expect(manager.state).toBe("stopped");
    },
  );
});

async function issueTestCapability(): Promise<HermesSidecarCapabilityLease> {
  return {
    transmit: (pipe) => endPipe(pipe, Buffer.from("pipe-test-capability")),
    revoke: () => {},
  };
}

function endPipe(pipe: Writable, bytes: Buffer): Promise<void> {
  return new Promise((resolve) => {
    pipe.end(bytes, resolve);
  });
}
