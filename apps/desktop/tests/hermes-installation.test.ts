import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HERMES_AGENT_VERSION,
  HERMES_RELEASE_TAG,
  HERMES_WHEEL_SHA256,
} from "../src/main/services/hermes/constants";
import {
  HERMES_INSTALLATION_QUERY,
  HERMES_SOURCE_CONTRACT,
  type HermesCommandRunner,
  verifyHermesInstallation,
} from "../src/main/services/hermes/installation";

const managedPython = "/opentrad/runtimes/hermes/0.18.2/venv/bin/python3";
const verifiedEnvelope = JSON.stringify({
  schema: 1,
  ok: true,
  version: HERMES_AGENT_VERSION,
  releaseTag: HERMES_RELEASE_TAG,
});
const integrityFailureMessage =
  "Managed Hermes runtime unavailable: installation integrity check failed";
const auditedWheel = process.env.OPENTRAD_TEST_HERMES_WHEEL;
const temporaryRoots: string[] = [];

function findSupportedPython(): string | undefined {
  const commands = process.env.OPENTRAD_TEST_PYTHON
    ? [process.env.OPENTRAD_TEST_PYTHON]
    : ["python3.12", "python3"];
  for (const command of commands) {
    const probe = spawnSync(
      command,
      [
        "-I",
        "-S",
        "-B",
        "-c",
        "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')",
      ],
      { encoding: "utf8" },
    );
    if (probe.status === 0 && probe.stdout.trim() === "3.12.11") {
      return command;
    }
  }
  return undefined;
}

const supportedPython = findSupportedPython();

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("verifyHermesInstallation", () => {
  it("accepts only the pinned version and physical source contract", async () => {
    const runner = vi.fn<HermesCommandRunner>().mockResolvedValue({
      stdout: `${verifiedEnvelope}\n`,
    });

    await expect(verifyHermesInstallation(managedPython, runner)).resolves.toEqual({
      pythonExecutable: managedPython,
      version: "0.18.2",
      releaseTag: "v2026.7.7.2",
    });
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith(managedPython, [
      "-I",
      "-S",
      "-B",
      "-c",
      HERMES_INSTALLATION_QUERY,
    ]);
  });

  it("pins the audited Hermes files without importing their modules", () => {
    expect(HERMES_SOURCE_CONTRACT).toEqual({
      "tui_gateway/server.py": "cb51fc44ded4dad584a1f19c55a4bfa11a88ed10e2f4f0952d886e748d470eb1",
      "tui_gateway/transport.py":
        "75be87f545aeaffce9c2c72854fecc74e564de00df2c1cfb739ac4befaf30c8d",
      "hermes_cli/plugins.py": "3eeb699cae4e93a15c83bb4bef111ddc8ede6f2deb54176bf815666afc57cdac",
    });
    expect(HERMES_INSTALLATION_QUERY).toContain("hashlib.sha256");
    expect(HERMES_INSTALLATION_QUERY).toContain("Scripts");
    expect(HERMES_INSTALLATION_QUERY).toContain("Lib");
    expect(HERMES_INSTALLATION_QUERY).toContain("site-packages");
    expect(HERMES_INSTALLATION_QUERY).toContain(String.raw`[-_.].+\.dist-info`);
    expect(HERMES_INSTALLATION_QUERY).not.toMatch(/(?:from|import)\s+(?:tui_gateway|hermes_cli)/);
    expect(HERMES_INSTALLATION_QUERY).not.toContain("import site");
    expect(HERMES_INSTALLATION_QUERY).not.toContain("sitecustomize");
    expect(HERMES_INSTALLATION_QUERY).not.toContain(".pth");
  });

  it("rejects every interpreter except the pinned CPython 3.12.11 build", () => {
    expect(HERMES_INSTALLATION_QUERY).toContain("EXPECTED_PYTHON = (3, 12, 11)");
    expect(HERMES_INSTALLATION_QUERY).toContain("if sys.version_info[:3] != EXPECTED_PYTHON:");
    expect(HERMES_INSTALLATION_QUERY).not.toContain("SUPPORTED_PYTHONS");
  });

  it("pins and fully verifies the audited wheel RECORD within bounded reads", () => {
    expect(HERMES_WHEEL_SHA256).toBe(
      "8f02155cfc84b28bd98551cd18dffec0efa9ec070dd08f90f1a850f1c779492f",
    );
    expect(HERMES_INSTALLATION_QUERY).toContain(
      "9243f13f4f767ead25ef5079ddd3b4969cfa84918d902e86172dc8439084e6c4",
    );
    expect(HERMES_INSTALLATION_QUERY).toContain("EXPECTED_RECORD_ENTRIES = 921");
    expect(HERMES_INSTALLATION_QUERY).toContain("MAX_RECORD_BYTES = 128 * 1024");
    expect(HERMES_INSTALLATION_QUERY).toContain("MAX_FILE_BYTES = 4 * 1024 * 1024");
    expect(HERMES_INSTALLATION_QUERY).toContain("MAX_TOTAL_BYTES = 40 * 1024 * 1024");
    expect(HERMES_INSTALLATION_QUERY).toContain("import base64");
    expect(HERMES_INSTALLATION_QUERY).toContain("import csv");
    expect(HERMES_INSTALLATION_QUERY).toContain("csv.reader");
    expect(HERMES_INSTALLATION_QUERY).toContain("urlsafe_b64encode");
  });

  it.each([
    ["reported failure", JSON.stringify({ schema: 1, ok: false })],
    ["old version output", "0.18.1"],
    ["empty output", ""],
    [
      "wrong tag",
      JSON.stringify({
        schema: 1,
        ok: true,
        version: HERMES_AGENT_VERSION,
        releaseTag: "v2026.7.7.1",
      }),
    ],
    [
      "extra output field",
      JSON.stringify({
        schema: 1,
        ok: true,
        version: HERMES_AGENT_VERSION,
        releaseTag: HERMES_RELEASE_TAG,
        path: "/secret/runtime-canary",
      }),
    ],
  ])("rejects %s with the unified integrity error", async (_label, stdout) => {
    const runner = vi.fn<HermesCommandRunner>().mockResolvedValue({ stdout });

    await expect(verifyHermesInstallation(managedPython, runner)).rejects.toMatchObject({
      name: "HermesRuntimeUnavailableError",
      code: "HERMES_RUNTIME_UNAVAILABLE",
      message: integrityFailureMessage,
    });
  });

  it("does not reflect malformed child output into an error", async () => {
    const runner = vi.fn<HermesCommandRunner>().mockResolvedValue({
      stdout: '{"schema":1,"ok":false,"detail":"output-canary-secret"',
    });

    const error = await verifyHermesInstallation(managedPython, runner).catch(
      (cause: unknown) => cause,
    );

    expect(error).toMatchObject({
      name: "HermesRuntimeUnavailableError",
      code: "HERMES_RUNTIME_UNAVAILABLE",
      message: integrityFailureMessage,
    });
    expect(String(error)).not.toContain("canary");
    expect(inspect(error, { depth: 5, showHidden: true })).not.toContain("canary");
  });

  it("reports command failure without retaining an inspectable raw cause", async () => {
    const failure = new Error("spawn failure runner-cause-canary");
    const runner = vi.fn<HermesCommandRunner>().mockRejectedValue(failure);

    const error = await verifyHermesInstallation(managedPython, runner).catch(
      (cause: unknown) => cause,
    );

    expect(error).toMatchObject({
      name: "HermesRuntimeUnavailableError",
      code: "HERMES_RUNTIME_UNAVAILABLE",
      message: integrityFailureMessage,
    });
    expect(error).not.toHaveProperty("cause");
    expect(inspect(error, { depth: 5, showHidden: true })).not.toContain("canary");
  });

  it.skipIf(
    process.platform === "win32" || !supportedPython || !auditedWheel || !existsSync(auditedWheel),
  )("rejects tampering in a non-critical file from the real audited wheel", async () => {
    const rawRoot = await mkdtemp(join(tmpdir(), "opentrad-hermes-installation-"));
    const root = await realpath(rawRoot);
    temporaryRoots.push(root);
    const venv = join(root, "venv");
    const python = supportedPython ?? "python3";
    const created = spawnSync(python, ["-m", "venv", venv], {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(created.error).toBeUndefined();
    expect(created.status, created.stderr).toBe(0);
    const managedVenvPython = join(venv, "bin", "python3");
    const version = spawnSync(
      managedVenvPython,
      [
        "-I",
        "-S",
        "-B",
        "-c",
        "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')",
      ],
      { encoding: "utf8" },
    );
    expect(version.status, version.stderr).toBe(0);
    const installed = spawnSync(
      managedVenvPython,
      ["-m", "pip", "install", "--no-deps", "--no-compile", auditedWheel ?? ""],
      { encoding: "utf8", timeout: 20_000 },
    );
    expect(installed.error).toBeUndefined();
    expect(installed.status, installed.stderr).toBe(0);
    const sitePackages = join(venv, "lib", `python${version.stdout.trim()}`, "site-packages");

    const args = ["-I", "-S", "-B", "-c", HERMES_INSTALLATION_QUERY];
    const clean = spawnSync(managedVenvPython, args, {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(clean.error).toBeUndefined();
    expect(clean.status, clean.stderr).toBe(0);
    expect(JSON.parse(clean.stdout)).toEqual({
      schema: 1,
      ok: true,
      version: HERMES_AGENT_VERSION,
      releaseTag: HERMES_RELEASE_TAG,
    });

    const recordPath = join(sitePackages, "hermes_agent-0.18.2.dist-info", "RECORD");
    const originalRecord = await readFile(recordPath, "utf8");
    const generatedRow = originalRecord
      .split(/\r?\n/)
      .find((row) => row.startsWith("../../../bin/hermes,"));
    expect(generatedRow).toBeDefined();
    await writeFile(recordPath, `${originalRecord}${generatedRow}\n`, "utf8");
    const duplicateGenerated = spawnSync(managedVenvPython, args, {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(duplicateGenerated.error).toBeUndefined();
    expect(duplicateGenerated.status, duplicateGenerated.stderr).toBe(0);
    expect(JSON.parse(duplicateGenerated.stdout)).toEqual({ schema: 1, ok: false });
    await writeFile(recordPath, originalRecord, "utf8");

    const rogueCatalogDirectory = join(venv, "optional-mcps", "untrusted-catalog");
    await mkdir(rogueCatalogDirectory, { recursive: true });
    await writeFile(join(rogueCatalogDirectory, "manifest.yaml"), "command: untrusted\n", "utf8");
    const extraRelocatedData = spawnSync(managedVenvPython, args, {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(extraRelocatedData.error).toBeUndefined();
    expect(extraRelocatedData.status, extraRelocatedData.stderr).toBe(0);
    expect(JSON.parse(extraRelocatedData.stdout)).toEqual({ schema: 1, ok: false });
    await rm(rogueCatalogDirectory, { recursive: true, force: true });

    const installerPath = join(sitePackages, "hermes_agent-0.18.2.dist-info", "INSTALLER");
    const installerContents = await readFile(installerPath);
    await rm(installerPath, { force: true });
    const missingGeneratedFile = spawnSync(managedVenvPython, args, {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(missingGeneratedFile.error).toBeUndefined();
    expect(missingGeneratedFile.status, missingGeneratedFile.stderr).toBe(0);
    expect(JSON.parse(missingGeneratedFile.stdout)).toEqual({ schema: 1, ok: false });
    await writeFile(installerPath, installerContents);

    const nativeShadow = join(sitePackages, "hermes_constants.so");
    await writeFile(nativeShadow, Buffer.from("untrusted-native-shadow"));
    const shadowed = spawnSync(managedVenvPython, args, {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(shadowed.error).toBeUndefined();
    expect(shadowed.status, shadowed.stderr).toBe(0);
    expect(JSON.parse(shadowed.stdout)).toEqual({ schema: 1, ok: false });
    await rm(nativeShadow, { force: true });

    const bytecodeDirectory = join(sitePackages, "__pycache__");
    const bytecode = join(
      bytecodeDirectory,
      `hermes_constants.cpython-${version.stdout.trim().replace(".", "")}.pyc`,
    );
    await mkdir(bytecodeDirectory, { recursive: true });
    await writeFile(bytecode, Buffer.from("untrusted-bytecode"));
    const compiled = spawnSync(managedVenvPython, args, {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(compiled.error).toBeUndefined();
    expect(compiled.status, compiled.stderr).toBe(0);
    expect(JSON.parse(compiled.stdout)).toEqual({ schema: 1, ok: false });
    await rm(bytecode, { force: true });

    await appendFile(
      join(sitePackages, "hermes_constants.py"),
      "\n# non-critical-tamper\n",
      "utf8",
    );
    const tampered = spawnSync(managedVenvPython, args, {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(tampered.error).toBeUndefined();
    expect(tampered.status, tampered.stderr).toBe(0);
    expect(JSON.parse(tampered.stdout)).toEqual({ schema: 1, ok: false });
  });
});
