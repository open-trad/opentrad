import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHermesSidecarTerminator,
  createWindowsTaskkillRunner,
  HERMES_SIDECAR_EOF_GRACE_MS,
  type HermesSidecarReapableProcess,
  type WindowsTaskkillExec,
} from "../src/main/services/hermes/sidecar-process-tree";

class FakeReapableProcess extends EventEmitter implements HermesSidecarReapableProcess {
  readonly pid = 42_424;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  close(): void {
    this.exitCode = 0;
    this.emit("close", 0, null);
  }
}

const liveProcessGroups: number[] = [];

afterEach(() => {
  for (const pid of liveProcessGroups.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The expected successful path already removed the process group.
    }
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Hermes sidecar POSIX process-tree termination", () => {
  it("recognizes a child that exited before the terminator attached when its pgid is gone", async () => {
    const child = new FakeReapableProcess();
    child.exitCode = 0;
    const sendSignal = vi.fn();
    const terminate = createHermesSidecarTerminator(child, {
      platform: "darwin",
      processGroupExists: () => false,
      sendPosixSignal: sendSignal,
    });

    await expect(terminate()).resolves.toBeUndefined();
    expect(sendSignal).not.toHaveBeenCalled();
    expect(child.listenerCount("error")).toBe(0);
  });

  it("rechecks exitCode after attachment even if a close event is not observable", async () => {
    vi.useFakeTimers();
    const child = new FakeReapableProcess();
    let groupExists = true;
    const sendSignal = vi.fn();
    const terminate = createHermesSidecarTerminator(child, {
      platform: "darwin",
      processGroupExists: () => groupExists,
      sendPosixSignal: sendSignal,
    });

    const stopping = terminate();
    child.exitCode = 0;
    groupExists = false;
    await vi.advanceTimersByTimeAsync(20);

    await expect(stopping).resolves.toBeUndefined();
    expect(sendSignal).not.toHaveBeenCalled();
    expect(child.listenerCount("error")).toBe(0);
  });

  it("allows more than one second for official EOF shutdown before sending a signal", async () => {
    expect(HERMES_SIDECAR_EOF_GRACE_MS).toBeGreaterThan(1_000);
    const child = new FakeReapableProcess();
    let groupExists = true;
    const sendSignal = vi.fn();
    const terminate = createHermesSidecarTerminator(child, {
      platform: "darwin",
      processGroupExists: () => groupExists,
      sendPosixSignal: sendSignal,
    });

    child.close();
    groupExists = false;

    await expect(terminate()).resolves.toBeUndefined();
    expect(sendSignal).not.toHaveBeenCalled();
    expect(child.listenerCount("error")).toBe(0);
  });

  it("escalates a stuck detached process group from SIGTERM to SIGKILL and confirms close", async () => {
    vi.useFakeTimers();
    const child = new FakeReapableProcess();
    let groupExists = true;
    const sendSignal = vi.fn((pid: number, signal: "SIGTERM" | "SIGKILL") => {
      expect(pid).toBe(child.pid);
      if (signal === "SIGKILL") {
        groupExists = false;
        child.signalCode = "SIGKILL";
        child.emit("close", null, "SIGKILL");
      }
    });
    const terminate = createHermesSidecarTerminator(child, {
      platform: "darwin",
      gracefulShutdownMs: 1_001,
      termGraceMs: 1,
      killGraceMs: 1,
      processGroupExists: () => groupExists,
      sendPosixSignal: sendSignal,
    });

    const stopping = terminate();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(sendSignal).toHaveBeenNthCalledWith(1, child.pid, "SIGTERM");
    await vi.advanceTimersByTimeAsync(1);
    expect(sendSignal).toHaveBeenNthCalledWith(2, child.pid, "SIGKILL");

    await expect(stopping).resolves.toBeUndefined();
    expect(child.listenerCount("error")).toBe(0);
  });

  it("coalesces cleanup and rejects when close/reap cannot be confirmed", async () => {
    vi.useFakeTimers();
    const child = new FakeReapableProcess();
    const sendSignal = vi.fn();
    const terminate = createHermesSidecarTerminator(child, {
      platform: "linux",
      gracefulShutdownMs: 1_001,
      termGraceMs: 1,
      killGraceMs: 1,
      processGroupExists: () => true,
      sendPosixSignal: sendSignal,
    });

    const first = terminate();
    const second = terminate();
    const failure = first.catch((cause: unknown) => cause);
    expect(first).toBe(second);
    await vi.advanceTimersByTimeAsync(1_003);

    await expect(failure).resolves.toMatchObject({
      name: "HermesSidecarCleanupError",
      code: "HERMES_SIDECAR_CLEANUP",
    });
    expect(sendSignal).toHaveBeenNthCalledWith(1, child.pid, "SIGTERM");
    expect(sendSignal).toHaveBeenNthCalledWith(2, child.pid, "SIGKILL");
    expect(child.listenerCount("error")).toBe(1);
    expect(() => child.emit("error", new Error("late-error-canary"))).not.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "kills a real detached Node fixture and its stuck descendant process group",
    async () => {
      const fixture = join(
        dirname(fileURLToPath(import.meta.url)),
        "fixtures",
        "hermes-sidecar-stuck-tree.cjs",
      );
      const child = nodeSpawn(process.execPath, [fixture], {
        detached: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const pid = child.pid;
      if (pid === undefined) throw new Error("fixture did not receive a pid");
      liveProcessGroups.push(pid);
      child.stderr.resume();
      const descendantPid = Number(await readFirstLine(child.stdout));
      expect(descendantPid).toBeGreaterThan(0);
      expect(processExists(descendantPid)).toBe(true);
      const terminate = createHermesSidecarTerminator(child, {
        platform: process.platform === "linux" ? "linux" : "darwin",
        gracefulShutdownMs: 1_001,
        termGraceMs: 25,
        killGraceMs: 1_000,
      });

      child.stdin.end();
      const startedAt = Date.now();
      await expect(terminate()).resolves.toBeUndefined();

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_000);
      expect(processGroupExists(pid)).toBe(false);
      expect(processExists(descendantPid)).toBe(false);
      liveProcessGroups.splice(liveProcessGroups.indexOf(pid), 1);
    },
    5_000,
  );
});

describe("Hermes sidecar Windows process-tree termination", () => {
  it("runs only absolute taskkill /PID <pid> /T /F with a minimal environment", async () => {
    const execFile = vi.fn<WindowsTaskkillExec>((_command, _args, _options, callback) => {
      callback(null);
    });
    const runTaskkill = createWindowsTaskkillRunner({
      execFile,
      sourceEnv: { SystemRoot: "C:\\Windows", CANARY_SECRET: "must-not-inherit" },
    });

    await expect(runTaskkill(321, 1_000)).resolves.toBe(true);

    expect(execFile).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/PID", "321", "/T", "/F"],
      {
        encoding: "utf8",
        env: { SystemRoot: "C:\\Windows" },
        maxBuffer: 16 * 1024,
        shell: false,
        timeout: 1_000,
        windowsHide: true,
      },
      expect.any(Function),
    );
    expect(JSON.stringify(execFile.mock.calls[0])).not.toContain("canary");
  });

  it("rejects relative SystemRoot and WINDIR inputs and keeps taskkill absolute", async () => {
    const execFile = vi.fn<WindowsTaskkillExec>((_command, _args, _options, callback) => {
      callback(null);
    });
    const runTaskkill = createWindowsTaskkillRunner({
      execFile,
      sourceEnv: {
        SystemRoot: "relative-systemroot-canary",
        WINDIR: "relative-windir-canary",
      },
    });

    await expect(runTaskkill(654, 1_000)).resolves.toBe(true);

    expect(execFile.mock.calls[0]?.[0]).toBe("C:\\Windows\\System32\\taskkill.exe");
    expect(execFile.mock.calls[0]?.[2].env).toEqual({ SystemRoot: "C:\\Windows" });
    expect(JSON.stringify(execFile.mock.calls[0])).not.toContain("canary");
  });

  it("uses taskkill after the EOF grace and requires a close event", async () => {
    vi.useFakeTimers();
    const child = new FakeReapableProcess();
    const taskkill = vi.fn(async () => {
      child.close();
      return true;
    });
    const terminate = createHermesSidecarTerminator(child, {
      platform: "win32",
      gracefulShutdownMs: 1_001,
      killGraceMs: 1,
      runWindowsTaskkill: taskkill,
    });

    const stopping = terminate();
    await vi.advanceTimersByTimeAsync(1_001);

    await expect(stopping).resolves.toBeUndefined();
    expect(taskkill).toHaveBeenCalledOnce();
    expect(taskkill).toHaveBeenCalledWith(child.pid, 1);
  });

  it("fails closed when only the parent exited and taskkill cannot confirm tree cleanup", async () => {
    vi.useFakeTimers();
    const child = new FakeReapableProcess();
    const taskkill = vi.fn(async () => false);
    const terminate = createHermesSidecarTerminator(child, {
      platform: "win32",
      gracefulShutdownMs: 1_001,
      killGraceMs: 1,
      runWindowsTaskkill: taskkill,
    });
    child.close();

    const stopping = terminate();
    const failure = stopping.catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(1_002);

    await expect(failure).resolves.toMatchObject({ code: "HERMES_SIDECAR_CLEANUP" });
    expect(taskkill).not.toHaveBeenCalled();
    expect(child.listenerCount("error")).toBe(0);
  });
});

function readFirstLine(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    const onData = (chunk: Buffer | string): void => {
      text += chunk.toString();
      const newline = text.indexOf("\n");
      if (newline >= 0) finish(() => resolve(text.slice(0, newline)));
    };
    const onError = (): void => finish(() => reject(new Error("fixture pipe failed")));
    const timer = setTimeout(
      () => finish(() => reject(new Error("fixture pipe timed out"))),
      2_000,
    );
    const finish = (settle: () => void): void => {
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("error", onError);
      settle();
    };
    stream.on("data", onData);
    stream.once("error", onError);
  });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
