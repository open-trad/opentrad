import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(testsDirectory, "..");
const launcher = join(desktopDirectory, "resources", "hermes", "opentrad_hermes_launcher.py");
const pythonTests = join(testsDirectory, "hermes_launcher_test.py");

interface PythonVersion {
  readonly major: number;
  readonly minor: number;
  readonly micro: number;
}

function probePython(command: string): PythonVersion | undefined {
  const result = spawnSync(
    command,
    ["-I", "-S", "-c", "import json, sys; print(json.dumps(list(sys.version_info[:3])))"],
    { encoding: "utf8", timeout: 2_000 },
  );
  if (result.status !== 0) return undefined;
  try {
    const value = JSON.parse(result.stdout) as unknown;
    if (
      !Array.isArray(value) ||
      value.length !== 3 ||
      !value.every((part) => typeof part === "number")
    ) {
      return undefined;
    }
    return { major: value[0], minor: value[1], micro: value[2] };
  } catch {
    return undefined;
  }
}

const pythonCommands = process.env.OPENTRAD_TEST_PYTHON
  ? [process.env.OPENTRAD_TEST_PYTHON, "python3"]
  : ["python3.12", "python3.13", "python3.11", "python3"];
const python = [...new Set(pythonCommands)].find((command) => probePython(command) !== undefined);

describe.skipIf(process.platform === "win32")("OpenTrad native Hermes launcher contract", () => {
  it.skipIf(!python)("passes its stdlib-only bootstrap contracts", () => {
    const result = spawnSync(
      python ?? "python3",
      ["-I", "-S", "-B", "-u", "-X", "utf8", pythonTests],
      { encoding: "utf8", timeout: 10_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("canary-secret-never-print");
    expect(result.stderr).not.toContain("canary-secret-never-print");
    expect(result.stderr).toMatch(/Ran 40 tests/);
    expect(result.stderr).toContain("OK");
  });

  it("pins production to CPython 3.12.11 exactly", () => {
    const isPinned = (version: PythonVersion): boolean =>
      version.major === 3 && version.minor === 12 && version.micro === 11;

    expect(isPinned({ major: 3, minor: 12, micro: 11 })).toBe(true);
    expect(isPinned({ major: 3, minor: 12, micro: 10 })).toBe(false);
    expect(isPinned({ major: 3, minor: 12, micro: 12 })).toBe(false);
    expect(isPinned({ major: 3, minor: 13, micro: 0 })).toBe(false);
  });

  it.skipIf(!python)("fails closed before import when FD3 is unavailable", () => {
    const canary = "node-launcher-secret-never-print-0123456789";
    const result = spawnSync(
      python ?? "python3",
      ["-I", "-S", "-B", "-u", "-X", "utf8", launcher],
      {
        cwd: dirname(launcher),
        encoding: "utf8",
        env: {
          HERMES_HOME: desktopDirectory,
          OPENAI_API_KEY: canary,
          PATH: process.env.PATH,
          PYTHONPATH: "/attacker",
        },
        timeout: 3_000,
      },
    );

    expect(result.status).toBe(78);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("OpenTrad Hermes launcher refused startup\n");
    expect(result.stderr).not.toContain(canary);
  });
});
