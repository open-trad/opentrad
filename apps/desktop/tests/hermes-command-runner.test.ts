import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHermesCommandRunner,
  HERMES_COMMAND_MAX_BUFFER_BYTES,
  HERMES_COMMAND_MAX_TIMEOUT_MS,
  HERMES_COMMAND_TIMEOUT_MS,
  type HermesExecFileLike,
} from "../src/main/services/hermes/command-runner";

const managedPython = "/opentrad/runtimes/hermes/0.18.2/venv/bin/python3";
const cwd = "/opentrad/runtimes/hermes/0.18.2";
const filteredEnv = {
  PATH: "/usr/bin:/bin",
  HERMES_HOME: "/opentrad/hermes",
};
const integrationTempDirs: string[] = [];
const integrationPids = new Set<number>();

afterEach(async () => {
  vi.useRealTimers();
  for (const pid of integrationPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The expected path is that process-tree cleanup already removed it.
    }
  }
  integrationPids.clear();
  await Promise.all(
    integrationTempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("createHermesCommandRunner", () => {
  it.each([
    ["zero timeout", { timeoutMs: 0 }],
    ["negative timeout", { timeoutMs: -1 }],
    ["fractional timeout", { timeoutMs: 1.5 }],
    ["sub-integer timeout", { timeoutMs: Number.MIN_VALUE }],
    ["NaN timeout", { timeoutMs: Number.NaN }],
    ["infinite timeout", { timeoutMs: Number.POSITIVE_INFINITY }],
    ["timeout over maximum", { timeoutMs: HERMES_COMMAND_MAX_TIMEOUT_MS + 1 }],
    ["zero buffer", { maxBufferBytes: 0 }],
    ["negative buffer", { maxBufferBytes: -1 }],
    ["fractional buffer", { maxBufferBytes: 1.5 }],
    ["sub-integer buffer", { maxBufferBytes: Number.MIN_VALUE }],
    ["NaN buffer", { maxBufferBytes: Number.NaN }],
    ["infinite buffer", { maxBufferBytes: Number.POSITIVE_INFINITY }],
    ["buffer over maximum", { maxBufferBytes: HERMES_COMMAND_MAX_BUFFER_BYTES + 1 }],
  ] as const)("rejects unsafe command limit: %s", (_label, limits) => {
    expect(() =>
      createHermesCommandRunner({
        execFile: vi.fn<HermesExecFileLike>(),
        cwd,
        env: filteredEnv,
        ...limits,
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "HermesCommandExecutionError",
        code: "HERMES_COMMAND_INVALID",
      }),
    );
  });

  it("uses execFile without a shell and with bounded injected options", async () => {
    const child = { kill: vi.fn(() => true) };
    const execFile = vi.fn<HermesExecFileLike>((_command, _args, _options, callback) => {
      queueMicrotask(() => callback(null, "0.18.2\n", ""));
      return child;
    });
    const runner = createHermesCommandRunner({ execFile, cwd, env: filteredEnv });

    await expect(runner(managedPython, ["-c", "print('version')"])).resolves.toEqual({
      stdout: "0.18.2\n",
    });
    expect(execFile).toHaveBeenCalledOnce();
    expect(execFile).toHaveBeenCalledWith(
      managedPython,
      ["-c", "print('version')"],
      {
        cwd,
        detached: process.platform !== "win32",
        encoding: "utf8",
        env: filteredEnv,
        maxBuffer: HERMES_COMMAND_MAX_BUFFER_BYTES,
        shell: false,
        windowsHide: true,
      },
      expect.any(Function),
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("allows a bounded installer timeout without changing the short default", async () => {
    const execFile = vi.fn<HermesExecFileLike>((_command, _args, options, callback) => {
      expect(options).toMatchObject({ shell: false, windowsHide: true });
      queueMicrotask(() => callback(null, "", ""));
      return {};
    });
    const runner = createHermesCommandRunner({
      execFile,
      cwd,
      env: filteredEnv,
      timeoutMs: HERMES_COMMAND_MAX_TIMEOUT_MS,
    });

    await expect(runner(managedPython, ["-V"])).resolves.toEqual({ stdout: "" });
  });

  it("rejects relative commands before invoking execFile", async () => {
    const execFile = vi.fn<HermesExecFileLike>();
    const runner = createHermesCommandRunner({ execFile, cwd, env: filteredEnv });

    await expect(runner("python3", ["-V"])).rejects.toMatchObject({
      name: "HermesCommandExecutionError",
      code: "HERMES_COMMAND_INVALID",
      message: expect.stringMatching(/absolute command/i),
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("settles at the default timeout and kills a child that never calls back", async () => {
    vi.useFakeTimers();
    const child = { pid: 12_345, kill: vi.fn(() => true) };
    const execFile = vi.fn<HermesExecFileLike>(() => child);
    let confirmCleanup: ((confirmed: boolean) => void) | undefined;
    const terminateProcessTree = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          confirmCleanup = resolve;
        }),
    );
    const runner = createHermesCommandRunner({
      execFile,
      cwd,
      env: filteredEnv,
      terminateProcessTree,
    });

    let rejected = false;
    const observed = runner(managedPython, ["-V"]).catch((error: unknown) => {
      rejected = true;
      throw error;
    });
    const result = expect(observed).rejects.toMatchObject({
      name: "HermesCommandExecutionError",
      code: "HERMES_COMMAND_TIMEOUT",
      message: "Managed Hermes command timed out",
    });
    await vi.advanceTimersByTimeAsync(HERMES_COMMAND_TIMEOUT_MS);

    expect(terminateProcessTree).toHaveBeenCalledOnce();
    expect(terminateProcessTree).toHaveBeenCalledWith(child, expect.any(Number));
    expect(rejected).toBe(false);
    confirmCleanup?.(true);
    await result;
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("keeps timeout classification when killing triggers a synchronous callback", async () => {
    vi.useFakeTimers();
    let callback: Parameters<HermesExecFileLike>[3] | undefined;
    const child = { pid: 12_345, kill: vi.fn(() => true) };
    const terminateProcessTree = vi.fn(async () => {
      callback?.(new Error("late kill callback canary"), "", "late stderr canary");
      return true;
    });
    const execFile = vi.fn<HermesExecFileLike>((_command, _args, _options, receivedCallback) => {
      callback = receivedCallback;
      return child;
    });
    const runner = createHermesCommandRunner({
      execFile,
      cwd,
      env: filteredEnv,
      terminateProcessTree,
    });

    const result = expect(runner(managedPython, ["-V"])).rejects.toMatchObject({
      code: "HERMES_COMMAND_TIMEOUT",
      message: "Managed Hermes command timed out",
    });
    await vi.advanceTimersByTimeAsync(HERMES_COMMAND_TIMEOUT_MS);

    await result;
    expect(terminateProcessTree).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("fails safely when process-tree cleanup cannot be confirmed", async () => {
    vi.useFakeTimers();
    const child = { pid: 12_345, kill: vi.fn(() => true) };
    const execFile = vi.fn<HermesExecFileLike>(() => child);
    const terminateProcessTree = vi.fn().mockResolvedValue(false);
    const runner = createHermesCommandRunner({
      execFile,
      cwd,
      env: filteredEnv,
      terminateProcessTree,
    });

    const result = expect(runner(managedPython, ["-V"])).rejects.toMatchObject({
      name: "HermesCommandExecutionError",
      code: "HERMES_COMMAND_CLEANUP_FAILED",
      message: "Managed Hermes command cleanup could not be confirmed",
    });
    await vi.advanceTimersByTimeAsync(HERMES_COMMAND_TIMEOUT_MS);

    await result;
    expect(terminateProcessTree).toHaveBeenCalledOnce();
  });

  it("converts spawn failures without leaking raw errors or stderr", async () => {
    const child = { kill: vi.fn(() => true) };
    const execFile = vi.fn<HermesExecFileLike>((_command, _args, _options, callback) => {
      const cause = Object.assign(new Error("spawn failure spawn-canary"), { code: "ENOENT" });
      queueMicrotask(() => callback(cause, "", "stderr-canary"));
      return child;
    });
    const runner = createHermesCommandRunner({ execFile, cwd, env: filteredEnv });

    const error = await runner(managedPython, ["-V"]).catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      name: "HermesCommandExecutionError",
      code: "HERMES_COMMAND_FAILED",
      message: "Managed Hermes command failed",
    });
    expect(String(error)).not.toContain("canary");
    expect(JSON.stringify(error)).not.toContain("canary");
  });

  it("rejects oversized output even when an injected execFile ignores maxBuffer", async () => {
    const child = { kill: vi.fn(() => true) };
    const execFile = vi.fn<HermesExecFileLike>((_command, _args, _options, callback) => {
      queueMicrotask(() => callback(null, "x".repeat(17), ""));
      return child;
    });
    const runner = createHermesCommandRunner({
      execFile,
      cwd,
      env: filteredEnv,
      maxBufferBytes: 16,
    });

    await expect(runner(managedPython, ["-V"])).rejects.toMatchObject({
      name: "HermesCommandExecutionError",
      code: "HERMES_COMMAND_FAILED",
      message: "Managed Hermes command failed",
    });
  });

  it("kills a real long-lived descendant before timeout rejection settles", {
    timeout: 10_000,
  }, async () => {
    const runtimeCwd = await mkdtemp(join(tmpdir(), "opentrad-hermes-runner-"));
    integrationTempDirs.push(runtimeCwd);
    const pidFile = join(runtimeCwd, "descendant.pid");
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "writeFileSync(process.argv[1], String(child.pid));",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const runner = createHermesCommandRunner({
      cwd: runtimeCwd,
      env: {},
      timeoutMs: 1_000,
    });

    await expect(runner(process.execPath, ["-e", script, pidFile])).rejects.toMatchObject({
      code: "HERMES_COMMAND_TIMEOUT",
      message: "Managed Hermes command timed out",
    });
    const descendantPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
    integrationPids.add(descendantPid);

    expect(await waitForProcessExit(descendantPid, 1_500)).toBe(true);
    integrationPids.delete(descendantPid);
  });
});

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}
