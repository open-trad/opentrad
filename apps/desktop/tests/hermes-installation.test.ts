import { describe, expect, it, vi } from "vitest";
import { HERMES_AGENT_VERSION } from "../src/main/services/hermes/constants";
import {
  HERMES_VERSION_QUERY,
  type HermesCommandRunner,
  verifyHermesInstallation,
} from "../src/main/services/hermes/installation";

const managedPython = "/opentrad/runtimes/hermes/0.18.2/venv/bin/python3";

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
      message: expect.stringMatching(/expected 0\.18\.2.*found 0\.18\.1/i),
    });
  });

  it("rejects an empty version result", async () => {
    const runner = vi.fn<HermesCommandRunner>().mockResolvedValue({ stdout: "\n" });

    await expect(verifyHermesInstallation(managedPython, runner)).rejects.toMatchObject({
      name: "HermesRuntimeUnavailableError",
      code: "HERMES_RUNTIME_UNAVAILABLE",
      message: expect.stringMatching(/expected 0\.18\.2.*no version/i),
    });
  });

  it("reports a missing managed Python without falling back to PATH", async () => {
    const missing = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    const runner = vi.fn<HermesCommandRunner>().mockRejectedValue(missing);

    await expect(verifyHermesInstallation(managedPython, runner)).rejects.toMatchObject({
      name: "HermesRuntimeUnavailableError",
      code: "HERMES_RUNTIME_UNAVAILABLE",
      message: expect.stringMatching(/managed Hermes runtime unavailable.*version check failed/i),
      cause: missing,
    });
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith(managedPython, ["-c", HERMES_VERSION_QUERY]);
  });

  it("reports a failed version query as runtime unavailable", async () => {
    const failure = new Error("exit code 1");
    const runner = vi.fn<HermesCommandRunner>().mockRejectedValue(failure);

    await expect(verifyHermesInstallation(managedPython, runner)).rejects.toMatchObject({
      name: "HermesRuntimeUnavailableError",
      code: "HERMES_RUNTIME_UNAVAILABLE",
      cause: failure,
    });
  });
});
