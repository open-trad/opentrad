import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const pythonTests = join(testsDirectory, "hermes_runtime_test.py");

interface PythonVersion {
  readonly major: number;
  readonly minor: number;
}

type PythonVersionProbe = (command: string) => PythonVersion | undefined;

interface PythonProbeOptions {
  readonly encoding: "utf8";
  readonly timeout: number;
}

interface PythonProbeResult {
  readonly status: number | null;
  readonly stdout: string;
}

type PythonProbeRunner = (
  command: string,
  args: readonly string[],
  options: PythonProbeOptions,
) => PythonProbeResult;

const runPythonProbe: PythonProbeRunner = (command, args, options) =>
  spawnSync(command, [...args], options);

function pythonCommands(override = process.env.OPENTRAD_TEST_PYTHON): readonly string[] {
  const configured = override?.trim();
  return [
    ...new Set([
      ...(configured ? [configured] : []),
      "python3.11",
      "python3.12",
      "python3.13",
      "python3",
    ]),
  ];
}

function findPython(
  commands: readonly string[] = pythonCommands(),
  probe: PythonVersionProbe = probePythonVersion,
): string | undefined {
  for (const command of commands) {
    const version = probe(command);
    if (version?.major === 3 && version.minor >= 11 && version.minor <= 13) return command;
  }
  return undefined;
}

function probePythonVersion(
  command: string,
  run: PythonProbeRunner = runPythonProbe,
): PythonVersion | undefined {
  const result = run(
    command,
    [
      "-I",
      "-S",
      "-c",
      "import json, sys; print(json.dumps({'major': sys.version_info.major, 'minor': sys.version_info.minor}))",
    ],
    { encoding: "utf8", timeout: 2_000 },
  );
  if (result.status !== 0) return undefined;
  try {
    const version = JSON.parse(result.stdout) as { major?: unknown; minor?: unknown };
    if (typeof version.major !== "number" || typeof version.minor !== "number") return undefined;
    return { major: version.major, minor: version.minor };
  } catch {
    return undefined;
  }
}

const python = findPython();

describe("OpenTrad Hermes owned runtime contract", () => {
  it("selects only Python versions supported by pinned Hermes", () => {
    expect(findPython(["python3"], () => ({ major: 3, minor: 10 }))).toBeUndefined();
    expect(findPython(["python3"], () => ({ major: 3, minor: 14 }))).toBeUndefined();
    expect(findPython(["python3"], () => ({ major: 3, minor: 13 }))).toBe("python3");
  });

  it("prefers the repository Python override without bypassing version checks", () => {
    const observed: string[] = [];
    const commands = pythonCommands("/opt/OpenTrad Python/bin/python3");
    const selected = findPython(commands, (command) => {
      observed.push(command);
      return command === commands[0] ? { major: 3, minor: 13 } : undefined;
    });

    expect(selected).toBe("/opt/OpenTrad Python/bin/python3");
    expect(observed).toEqual(["/opt/OpenTrad Python/bin/python3"]);
  });

  it("bounds interpreter probes and treats a timed-out shim as unavailable", () => {
    let observedTimeout: number | undefined;
    const version = probePythonVersion("/opt/stuck-python", (_command, _args, options) => {
      observedTimeout = options.timeout;
      return { status: null, stdout: "" };
    });

    expect(version).toBeUndefined();
    expect(observedTimeout).toBe(2_000);
  });

  it.skipIf(!python)("passes all base contracts under isolated no-site Python", () => {
    const result = spawnSync(
      python ?? "python3",
      ["-I", "-S", "-B", "-u", "-X", "utf8", pythonTests],
      {
        encoding: "utf8",
        timeout: 30_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("runtime-canary-secret-never-render");
    expect(result.stderr).not.toContain("runtime-canary-secret-never-render");
    expect(result.stderr).toMatch(/Ran 31 tests/);
    expect(result.stderr).toContain("OK");
  });
});
