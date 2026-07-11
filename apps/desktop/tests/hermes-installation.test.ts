import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { HERMES_AGENT_VERSION } from "../src/main/services/hermes/constants";
import {
  HERMES_VERSION_QUERY,
  type HermesCommandRunner,
  verifyHermesInstallation,
} from "../src/main/services/hermes/installation";

const managedPython = "/opentrad/runtimes/hermes/0.18.2/venv/bin/python3";
const versionMismatchMessage =
  "Managed Hermes runtime unavailable: expected 0.18.2, managed runtime reports a different version";

describe("verifyHermesInstallation", () => {
  it("accepts only the exact pinned hermes-agent version from the managed Python", async () => {
    const runner = vi.fn<HermesCommandRunner>().mockResolvedValue({
      stdout: `${HERMES_AGENT_VERSION}\n`,
    });

    await expect(verifyHermesInstallation(managedPython, runner)).resolves.toEqual({
      pythonExecutable: managedPython,
      version: "0.18.2",
    });
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith(managedPython, ["-c", HERMES_VERSION_QUERY]);
    expect(HERMES_VERSION_QUERY).toContain("importlib.metadata.version('hermes-agent')");
  });

  it("rejects a different installed version", async () => {
    const runner = vi.fn<HermesCommandRunner>().mockResolvedValue({ stdout: "0.18.1\n" });

    await expect(verifyHermesInstallation(managedPython, runner)).rejects.toMatchObject({
      name: "HermesRuntimeUnavailableError",
      code: "HERMES_RUNTIME_UNAVAILABLE",
      message: versionMismatchMessage,
    });
  });

  it("rejects an empty version result", async () => {
    const runner = vi.fn<HermesCommandRunner>().mockResolvedValue({ stdout: "\n" });

    await expect(verifyHermesInstallation(managedPython, runner)).rejects.toMatchObject({
      name: "HermesRuntimeUnavailableError",
      code: "HERMES_RUNTIME_UNAVAILABLE",
      message: versionMismatchMessage,
    });
  });

  it("does not reflect arbitrary version output into an error", async () => {
    const runner = vi.fn<HermesCommandRunner>().mockResolvedValue({
      stdout: "version-output-canary\nsecond-line-canary\n",
    });

    const error = await verifyHermesInstallation(managedPython, runner).catch(
      (cause: unknown) => cause,
    );

    expect(error).toMatchObject({
      name: "HermesRuntimeUnavailableError",
      code: "HERMES_RUNTIME_UNAVAILABLE",
      message: versionMismatchMessage,
    });
    expect(String(error)).not.toContain("canary");
  });

  it("does not reflect SemVer build metadata from the managed child", async () => {
    const reportedVersion = "0.18.1+version-canary-secret";
    const runner = vi.fn<HermesCommandRunner>().mockResolvedValue({
      stdout: `${reportedVersion}\n`,
    });

    const error = await verifyHermesInstallation(managedPython, runner).catch(
      (cause: unknown) => cause,
    );

    expect(error).toMatchObject({
      name: "HermesRuntimeUnavailableError",
      code: "HERMES_RUNTIME_UNAVAILABLE",
      message: versionMismatchMessage,
    });
    expect(String(error)).not.toContain("canary");
    expect(String(error)).not.toContain(reportedVersion);
    expect(String(error)).not.toContain("0.18.1+");
  });

  it("reports a missing managed Python without falling back to PATH", async () => {
    const missing = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    const runner = vi.fn<HermesCommandRunner>().mockRejectedValue(missing);

    const error = await verifyHermesInstallation(managedPython, runner).catch(
      (cause: unknown) => cause,
    );

    expect(error).toMatchObject({
      name: "HermesRuntimeUnavailableError",
      code: "HERMES_RUNTIME_UNAVAILABLE",
      message: expect.stringMatching(/managed Hermes runtime unavailable.*version check failed/i),
    });
    expect(error).not.toHaveProperty("cause");
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith(managedPython, ["-c", HERMES_VERSION_QUERY]);
  });

  it("reports a failed version query without retaining an inspectable raw cause", async () => {
    const failure = new Error("exit code 1 runner-cause-canary");
    const runner = vi.fn<HermesCommandRunner>().mockRejectedValue(failure);

    const error = await verifyHermesInstallation(managedPython, runner).catch(
      (cause: unknown) => cause,
    );

    expect(error).toMatchObject({
      name: "HermesRuntimeUnavailableError",
      code: "HERMES_RUNTIME_UNAVAILABLE",
    });
    expect(error).not.toHaveProperty("cause");
    expect(inspect(error, { depth: 5, showHidden: true })).not.toContain("canary");
  });
});
