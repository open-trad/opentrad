import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HERMES_AGENT_VERSION, HERMES_RELEASE_TAG } from "../src/main/services/hermes/constants";
import {
  ensureHermesStateDirs,
  HermesPathSecurityError,
  type HermesPaths,
  type HermesPlatform,
  resolveHermesPaths,
} from "../src/main/services/hermes/paths";

const tempDirs: string[] = [];
const realHostIsWindows = process.platform === "win32";
const hostPath = realHostIsWindows ? win32 : posix;
const hostPlatform: HermesPlatform = realHostIsWindows
  ? "win32"
  : process.platform === "linux"
    ? "linux"
    : "darwin";

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opentrad-hermes-paths-"));
  tempDirs.push(dir);
  return dir;
}

function resolveHostHermesPaths(dataRoot: string): HermesPaths {
  return resolveHermesPaths(dataRoot, hostPlatform);
}

function getManagedDescendants(dataRoot: string, paths: HermesPaths): string[] {
  return [
    hostPath.join(dataRoot, "runtimes"),
    hostPath.join(dataRoot, "runtimes", "hermes"),
    paths.runtimeRoot,
    paths.hermesHome,
  ];
}

async function createDirectorySymlink(target: string, path: string): Promise<void> {
  await symlink(target, path, realHostIsWindows ? "junction" : undefined);
}

afterEach(async () => {
  vi.restoreAllMocks();
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

  it("preserves an existing caller-owned data root while hardening descendants", async () => {
    const dataRoot = await createTempDir();
    const paths = resolveHostHermesPaths(dataRoot);
    if (!realHostIsWindows) {
      await chmod(dataRoot, 0o755);
    }

    await ensureHermesStateDirs(paths, { dataRoot });

    const managedDescendants = getManagedDescendants(dataRoot, paths);
    for (const dir of [dataRoot, ...managedDescendants]) {
      const metadata = await stat(dir);
      expect(metadata.isDirectory()).toBe(true);
      await expect(access(dir, fsConstants.W_OK)).resolves.toBeUndefined();
    }
    if (!realHostIsWindows) {
      expect((await stat(dataRoot)).mode & 0o777).toBe(0o755);
      for (const dir of managedDescendants) {
        expect((await stat(dir)).mode & 0o777).toBe(0o700);
      }
    }
  });

  it("creates a missing data root and POSIX-hardens it with managed descendants", async () => {
    const sandbox = await createTempDir();
    const dataRoot = hostPath.join(sandbox, "missing-data");
    const paths = resolveHostHermesPaths(dataRoot);

    await ensureHermesStateDirs(paths, { dataRoot });

    for (const dir of [dataRoot, ...getManagedDescendants(dataRoot, paths)]) {
      expect((await stat(dir)).isDirectory()).toBe(true);
      if (!realHostIsWindows) {
        expect((await stat(dir)).mode & 0o777).toBe(0o700);
      }
    }
  });

  it("rejects a symlink at a managed leaf", async () => {
    const sandbox = await createTempDir();
    const dataRoot = hostPath.join(sandbox, "data");
    const outside = hostPath.join(sandbox, "outside");
    await Promise.all([mkdir(dataRoot), mkdir(outside)]);
    await createDirectorySymlink(outside, hostPath.join(dataRoot, "hermes"));
    const paths = resolveHostHermesPaths(dataRoot);

    await expect(ensureHermesStateDirs(paths, { dataRoot })).rejects.toBeInstanceOf(
      HermesPathSecurityError,
    );
  });

  it("rejects a symlink in an intermediate managed component", async () => {
    const sandbox = await createTempDir();
    const dataRoot = hostPath.join(sandbox, "data");
    const outside = hostPath.join(sandbox, "outside");
    await Promise.all([mkdir(dataRoot), mkdir(outside)]);
    await createDirectorySymlink(outside, hostPath.join(dataRoot, "runtimes"));
    const paths = resolveHostHermesPaths(dataRoot);

    await expect(ensureHermesStateDirs(paths, { dataRoot })).rejects.toMatchObject({
      name: "HermesPathSecurityError",
      code: "HERMES_PATH_SECURITY",
      message: expect.stringMatching(/symbolic link/i),
    });
  });

  it("rejects a symlink used as the trusted data root", async () => {
    const sandbox = await createTempDir();
    const realDataRoot = hostPath.join(sandbox, "real-data");
    const linkedDataRoot = hostPath.join(sandbox, "linked-data");
    await mkdir(realDataRoot);
    await createDirectorySymlink(realDataRoot, linkedDataRoot);
    const paths = resolveHostHermesPaths(linkedDataRoot);

    await expect(ensureHermesStateDirs(paths, { dataRoot: linkedDataRoot })).rejects.toMatchObject({
      name: "HermesPathSecurityError",
      code: "HERMES_PATH_SECURITY",
    });
  });

  it("rejects a managed path outside the trusted data root before creating it", async () => {
    const sandbox = await createTempDir();
    const dataRoot = hostPath.join(sandbox, "data");
    const outsideRuntime = hostPath.join(sandbox, "outside-runtime");
    await mkdir(dataRoot);
    const paths = {
      ...resolveHostHermesPaths(dataRoot),
      runtimeRoot: outsideRuntime,
    };

    await expect(ensureHermesStateDirs(paths, { dataRoot })).rejects.toMatchObject({
      name: "HermesPathSecurityError",
      code: "HERMES_PATH_SECURITY",
      message: expect.stringMatching(/outside.*data root/i),
    });
    await expect(access(outsideRuntime)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a non-directory in a managed path", async () => {
    const dataRoot = await createTempDir();
    await mkdir(hostPath.join(dataRoot, "runtimes"));
    await writeFile(hostPath.join(dataRoot, "runtimes", "hermes"), "not a directory");
    const paths = resolveHostHermesPaths(dataRoot);

    await expect(ensureHermesStateDirs(paths, { dataRoot })).rejects.toMatchObject({
      name: "HermesPathSecurityError",
      code: "HERMES_PATH_SECURITY",
      message: expect.stringMatching(/not a directory/i),
    });
  });

  it("never chmods through a rejected symlink", async () => {
    const sandbox = await createTempDir();
    const dataRoot = hostPath.join(sandbox, "data");
    const outside = hostPath.join(sandbox, "outside");
    await Promise.all([mkdir(dataRoot), mkdir(outside)]);
    if (!realHostIsWindows) {
      await chmod(outside, 0o755);
    }
    await createDirectorySymlink(outside, hostPath.join(dataRoot, "hermes"));
    const paths = resolveHostHermesPaths(dataRoot);

    await ensureHermesStateDirs(paths, { dataRoot }).catch(() => undefined);

    expect((await stat(outside)).isDirectory()).toBe(true);
    if (!realHostIsWindows) {
      expect((await stat(outside)).mode & 0o777).toBe(0o755);
    }
  });

  it("creates managed directories on Windows without claiming POSIX mode bits", async () => {
    const dataRoot = await createTempDir();
    const paths = resolveHostHermesPaths(dataRoot);
    await Promise.all([mkdir(paths.runtimeRoot, { recursive: true }), mkdir(paths.hermesHome)]);
    const managedDirs = [dataRoot, ...getManagedDescendants(dataRoot, paths)];
    if (!realHostIsWindows) {
      await Promise.all(managedDirs.map((dir) => chmod(dir, 0o755)));
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    }

    const spoofedOptions = { dataRoot, platform: "darwin" as const };
    await ensureHermesStateDirs(paths, spoofedOptions);

    for (const dir of managedDirs) {
      expect((await stat(dir)).isDirectory()).toBe(true);
      if (!realHostIsWindows) {
        expect((await stat(dir)).mode & 0o777).toBe(0o755);
      }
    }
  });

  it.skipIf(realHostIsWindows)("does not let a caller disable host POSIX hardening", async () => {
    const dataRoot = await createTempDir();
    const paths = resolveHostHermesPaths(dataRoot);
    await Promise.all([mkdir(paths.runtimeRoot, { recursive: true }), mkdir(paths.hermesHome)]);
    const managedDirs = [dataRoot, ...getManagedDescendants(dataRoot, paths)];
    await Promise.all(managedDirs.map((dir) => chmod(dir, 0o755)));

    const spoofedOptions = { dataRoot, platform: "win32" as const };
    await ensureHermesStateDirs(paths, spoofedOptions);

    expect((await stat(dataRoot)).mode & 0o777).toBe(0o755);
    for (const dir of getManagedDescendants(dataRoot, paths)) {
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    }
  });
});
