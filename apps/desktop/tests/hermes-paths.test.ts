import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { posix, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HERMES_AGENT_VERSION, HERMES_RELEASE_TAG } from "../src/main/services/hermes/constants";
import { ensureHermesStateDirs, resolveHermesPaths } from "../src/main/services/hermes/paths";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Hermes managed paths", () => {
  it("pins the supported Hermes Agent release", () => {
    expect(HERMES_AGENT_VERSION).toBe("0.18.2");
    expect(HERMES_RELEASE_TAG).toBe("v2026.7.7.2");
  });

  it.each([
    "darwin",
    "linux",
  ] as const)("resolves the %s runtime inside the injected OpenTrad data root", (platform) => {
    const paths = resolveHermesPaths("/var/lib/opentrad", platform);

    expect(paths).toEqual({
      runtimeRoot: "/var/lib/opentrad/runtimes/hermes/0.18.2",
      hermesHome: "/var/lib/opentrad/hermes",
      pythonExecutable: "/var/lib/opentrad/runtimes/hermes/0.18.2/venv/bin/python3",
    });
  });

  it("resolves the Windows venv executable inside the injected OpenTrad data root", () => {
    const paths = resolveHermesPaths("C:\\OpenTrad\\Data", "win32");

    expect(paths).toEqual({
      runtimeRoot: win32.join("C:\\OpenTrad\\Data", "runtimes", "hermes", "0.18.2"),
      hermesHome: win32.join("C:\\OpenTrad\\Data", "hermes"),
      pythonExecutable: win32.join(
        "C:\\OpenTrad\\Data",
        "runtimes",
        "hermes",
        "0.18.2",
        "venv",
        "Scripts",
        "python.exe",
      ),
    });
  });

  it("keeps HERMES_HOME isolated from the user's ~/.hermes directory", () => {
    const dataRoot = "/private/tmp/opentrad-test-data";
    const paths = resolveHermesPaths(dataRoot, "darwin");

    expect(paths.hermesHome).toBe(posix.join(dataRoot, "hermes"));
    expect(paths.hermesHome).not.toContain("/.hermes");
  });

  it("creates managed runtime and state directories writable with mode 0700", async () => {
    const dataRoot = await mkdtemp(posix.join(tmpdir(), "opentrad-hermes-paths-"));
    tempDirs.push(dataRoot);
    const paths = resolveHermesPaths(dataRoot, "darwin");

    await ensureHermesStateDirs(paths);

    for (const dir of [paths.runtimeRoot, paths.hermesHome]) {
      const metadata = await stat(dir);
      expect(metadata.isDirectory()).toBe(true);
      expect(metadata.mode & 0o777).toBe(0o700);
      await expect(access(dir, fsConstants.W_OK)).resolves.toBeUndefined();
    }
  });
});
