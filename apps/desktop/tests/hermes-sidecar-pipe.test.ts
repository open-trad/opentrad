import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveHermesPaths } from "../src/main/services/hermes/paths";
import { HermesSidecarManager } from "../src/main/services/hermes/sidecar-manager";
import { createHermesGatewaySpawnSpec } from "../src/main/services/hermes/spawn-spec";

const tempDirs: string[] = [];

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
        "hermes-gateway-ready.cjs",
      );
      const paths = { ...resolved, pythonExecutable: fixture };
      const manager = new HermesSidecarManager({
        dataRoot,
        paths,
        platform: "darwin",
        sourceEnv: {},
        verifyInstallation: vi.fn(async () => {}),
        spawnSpecFactory: (managedPaths) =>
          createHermesGatewaySpawnSpec(managedPaths, { PATH: process.env.PATH }, "darwin"),
      });

      await expect(manager.start()).resolves.toBeUndefined();
      expect(manager.state).toBe("ready");

      await expect(manager.stop()).resolves.toBeUndefined();
      expect(manager.state).toBe("stopped");
    },
  );
});
