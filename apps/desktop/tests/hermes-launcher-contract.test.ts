import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(testsDirectory, "..");
const launcher = join(desktopDirectory, "resources", "hermes", "opentrad_hermes_launcher.py");
const pythonTests = join(testsDirectory, "hermes_launcher_test.py");
const temporaryRoots: string[] = [];

interface PythonCandidate {
  readonly command: string;
  readonly major: number;
  readonly minor: number;
}

function probePython(command: string): PythonCandidate | undefined {
  const result = spawnSync(
    command,
    [
      "-I",
      "-S",
      "-c",
      "import json, sys; print(json.dumps({'major': sys.version_info.major, 'minor': sys.version_info.minor}))",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return undefined;
  try {
    const version = JSON.parse(result.stdout) as { major?: unknown; minor?: unknown };
    if (typeof version.major !== "number" || typeof version.minor !== "number") return undefined;
    return { command, major: version.major, minor: version.minor };
  } catch {
    return undefined;
  }
}

function supportsPinnedHermes(candidate: PythonCandidate): boolean {
  return candidate.major === 3 && candidate.minor >= 11 && candidate.minor < 14;
}

const pythonCommands = process.env.OPENTRAD_TEST_PYTHON
  ? [process.env.OPENTRAD_TEST_PYTHON]
  : ["python3.13", "python3.12", "python3.11", "python3"];
const pythonCandidates = pythonCommands
  .map((command) => probePython(command))
  .filter((candidate): candidate is PythonCandidate => candidate !== undefined);
const anyPython = pythonCandidates[0];
const supportedPython = pythonCandidates.find(supportsPinnedHermes);
const portablePython = anyPython?.command ?? "python3";

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === "win32")("OpenTrad Hermes Python launcher contract", () => {
  it.skipIf(!anyPython)(
    "passes its stdlib-only pre-import unit contracts under isolated no-site Python",
    () => {
      const result = spawnSync(
        portablePython,
        ["-I", "-S", "-B", "-u", "-X", "utf8", pythonTests],
        {
          encoding: "utf8",
          timeout: 10_000,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain("canary-secret-never-print");
      expect(result.stderr).not.toContain("canary-secret-never-print");
      expect(result.stderr).toMatch(/Ran \d+ tests/);
      expect(result.stderr).toContain("OK");
    },
  );

  it.skipIf(!anyPython)(
    "proves pre-control startup code stays disabled before a generic pre-bootstrap refusal",
    async () => {
      const rawRoot = await mkdtemp(join(tmpdir(), "opentrad-hermes-launcher-"));
      const root = await realpath(rawRoot);
      temporaryRoots.push(root);
      const hermesHome = join(root, "hermes");
      const gatewayCwd = join(hermesHome, "gateway-cwd");
      const maliciousPath = join(root, "malicious-python-path");
      const userBase = join(root, "python-user-base");
      const startupMarker = join(root, "sitecustomize-ran");
      const pthMarker = join(root, "pth-ran");
      const canary = "node-contract-capability-canary-0123456789";
      await mkdir(gatewayCwd, { recursive: true, mode: 0o700 });
      await chmod(hermesHome, 0o700);
      await chmod(gatewayCwd, 0o700);
      await mkdir(maliciousPath, { recursive: true, mode: 0o700 });

      const versionResult = spawnSync(
        portablePython,
        [
          "-I",
          "-S",
          "-c",
          "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')",
        ],
        { encoding: "utf8" },
      );
      expect(versionResult.status, versionResult.stderr).toBe(0);
      const userSite = join(
        userBase,
        "lib",
        `python${versionResult.stdout.trim()}`,
        "site-packages",
      );
      await mkdir(userSite, { recursive: true, mode: 0o700 });
      const startupSource = [
        "from pathlib import Path",
        `Path(${JSON.stringify(startupMarker)}).write_text('unsafe', encoding='utf-8')`,
      ].join("\n");
      const pthSource = `import pathlib; pathlib.Path(${JSON.stringify(pthMarker)}).write_text('unsafe', encoding='utf-8')\n`;
      await writeFile(join(maliciousPath, "sitecustomize.py"), startupSource, "utf8");
      await writeFile(join(userSite, "sitecustomize.py"), startupSource, "utf8");
      await writeFile(join(userSite, "unsafe.pth"), pthSource, "utf8");

      const child = spawn(portablePython, ["-I", "-S", "-B", "-u", "-X", "utf8", launcher], {
        cwd: gatewayCwd,
        env: {
          PATH: process.env.PATH,
          HERMES_HOME: hermesHome,
          PYTHONPATH: maliciousPath,
          PYTHONUSERBASE: userBase,
          OPENAI_API_KEY: canary,
          HTTPS_PROXY: "http://attacker.invalid:8080",
          SSL_CERT_FILE: join(root, "attacker.pem"),
          HERMES_TUI_TOOLSETS: "all",
        },
        stdio: ["ignore", "pipe", "pipe", "ignore"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (settle, reject) => {
          const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("launcher did not fail closed within three seconds"));
          }, 3_000);
          child.once("error", (error) => {
            clearTimeout(timeout);
            reject(error);
          });
          child.once("exit", (code, signal) => {
            clearTimeout(timeout);
            settle({ code, signal });
          });
        },
      );

      const renderedStdout = Buffer.concat(stdout).toString("utf8");
      const renderedStderr = Buffer.concat(stderr).toString("utf8");
      expect(exit).toEqual({ code: 78, signal: null });
      expect(renderedStdout).toBe("");
      expect(renderedStderr).toBe("OpenTrad Hermes launcher refused startup\n");
      expect(renderedStdout).not.toContain(canary);
      expect(renderedStderr).not.toContain(canary);
      await expect(readFile(startupMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(pthMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.skipIf(!supportedPython)(
    "returns from bootstrap_pre_import under a supported temporary venv",
    async () => {
      const rawRoot = await mkdtemp(join(tmpdir(), "opentrad-hermes-full-bootstrap-"));
      const root = await realpath(rawRoot);
      temporaryRoots.push(root);
      const venvRoot = join(root, "venv");
      const supportedCommand = supportedPython?.command ?? portablePython;
      const venvResult = spawnSync(supportedCommand, ["-m", "venv", "--without-pip", venvRoot], {
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(venvResult.error).toBeUndefined();
      expect(venvResult.status, venvResult.stderr).toBe(0);

      const managedPython = join(venvRoot, "bin", "python3");
      const hermesHome = join(root, "hermes");
      const gatewayCwd = join(hermesHome, "gateway-cwd");
      await mkdir(gatewayCwd, { recursive: true, mode: 0o700 });
      await chmod(hermesHome, 0o700);
      await chmod(gatewayCwd, 0o700);
      const token = "full_bootstrap_capability_token_0123456789";
      const wrapper = [
        "import importlib.util, os, pathlib, sys",
        `launcher_path = pathlib.Path(${JSON.stringify(launcher)})`,
        `gateway_cwd = pathlib.Path(${JSON.stringify(gatewayCwd)})`,
        "spec = importlib.util.spec_from_file_location('opentrad_bootstrap_contract', launcher_path)",
        "module = importlib.util.module_from_spec(spec)",
        "sys.modules[spec.name] = module",
        "spec.loader.exec_module(module)",
        "sys.argv = [str(launcher_path)]",
        "os.chdir(gateway_cwd)",
        "expected_site = pathlib.Path(sys.executable).parent.parent / 'lib' / f'python{sys.version_info.major}.{sys.version_info.minor}' / 'site-packages'",
        "expected_site = expected_site.resolve(strict=True)",
        "state = module.bootstrap_pre_import(3)",
        "if state.site_packages != expected_site: raise SystemExit(91)",
        "try:",
        "    os.kill(os.getpid(), 0)",
        "except module.LauncherRefusal:",
        "    pass",
        "else:",
        "    raise SystemExit(92)",
        "sys.stdout.write('BOOTSTRAP_COMPLETE\\n')",
      ].join("\n");
      const child = spawn(managedPython, ["-I", "-S", "-B", "-u", "-X", "utf8", "-c", wrapper], {
        cwd: gatewayCwd,
        env: {
          HERMES_HOME: hermesHome,
          LANG: "C.UTF-8",
        },
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      const exitPromise = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((settle, reject) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("full launcher bootstrap did not finish within three seconds"));
        }, 3_000);
        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once("exit", (code, signal) => {
          clearTimeout(timeout);
          settle({ code, signal });
        });
      });
      const capabilityPipe = child.stdio[3];
      if (!capabilityPipe || typeof capabilityPipe === "number") {
        throw new Error("FD3 capability pipe was not created");
      }
      let capabilityPipeError: Error | undefined;
      capabilityPipe.on("error", (error) => {
        capabilityPipeError = error;
      });
      capabilityPipe.end(
        JSON.stringify({
          v: 1,
          expiresAt: Math.floor(Date.now() / 1000) + 30,
          token,
          model: "openai/gpt-5.2",
          apiMode: "chat_completions",
          brokerPort: 43117,
        }),
      );

      const exit = await exitPromise;

      const renderedStdout = Buffer.concat(stdout).toString("utf8");
      const renderedStderr = Buffer.concat(stderr).toString("utf8");
      expect(exit).toEqual({ code: 0, signal: null });
      expect(renderedStdout).toBe("BOOTSTRAP_COMPLETE\n");
      expect(renderedStderr).toBe("");
      expect(renderedStdout).not.toContain(token);
      expect(renderedStderr).not.toContain(token);
      expect(capabilityPipeError).toBeUndefined();
      const privateHome = join(hermesHome, "process-home");
      const privateTmp = join(hermesHome, "tmp");
      expect((await stat(privateHome)).mode & 0o777).toBe(0o700);
      expect((await stat(privateTmp)).mode & 0o777).toBe(0o700);
    },
    30_000,
  );
});
