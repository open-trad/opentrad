import { Buffer } from "node:buffer";
import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import { isAbsolute, win32 } from "node:path";
import type { HermesCommandRunner } from "./installation";

export const HERMES_COMMAND_TIMEOUT_MS = 5_000;
export const HERMES_COMMAND_MAX_TIMEOUT_MS = 15 * 60_000;
export const HERMES_COMMAND_MAX_BUFFER_BYTES = 64 * 1024;
export const HERMES_COMMAND_CLEANUP_GRACE_MS = 1_000;

const WINDOWS_TASKKILL_MAX_BUFFER_BYTES = 16 * 1024;

export interface HermesExecFileChild {
  readonly pid?: number;
  readonly once?: (event: "close", listener: () => void) => unknown;
}

export interface HermesExecFileOptions {
  readonly cwd: string;
  readonly detached: boolean;
  readonly encoding: "utf8";
  readonly env: Readonly<Record<string, string>>;
  readonly maxBuffer: number;
  readonly shell: false;
  readonly windowsHide: true;
}

export type HermesExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

export type HermesExecFileLike = (
  command: string,
  args: readonly string[],
  options: HermesExecFileOptions,
  callback: HermesExecFileCallback,
) => HermesExecFileChild;

export type HermesProcessTreeTerminator = (
  child: HermesExecFileChild,
  cleanupGraceMs: number,
) => Promise<boolean>;

export interface CreateHermesCommandRunnerOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly execFile?: HermesExecFileLike;
  readonly terminateProcessTree?: HermesProcessTreeTerminator;
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
}

export type HermesCommandExecutionErrorCode =
  | "HERMES_COMMAND_INVALID"
  | "HERMES_COMMAND_TIMEOUT"
  | "HERMES_COMMAND_FAILED"
  | "HERMES_COMMAND_CLEANUP_FAILED";

export class HermesCommandExecutionError extends Error {
  readonly code: HermesCommandExecutionErrorCode;

  constructor(code: HermesCommandExecutionErrorCode, message: string) {
    super(`Managed Hermes command ${message}`);
    this.name = "HermesCommandExecutionError";
    this.code = code;
  }
}

export function createHermesCommandRunner(
  options: CreateHermesCommandRunnerOptions,
): HermesCommandRunner {
  if (!isAbsolute(options.cwd)) {
    throw new HermesCommandExecutionError("HERMES_COMMAND_INVALID", "requires an absolute cwd");
  }

  const timeoutMs = options.timeoutMs ?? HERMES_COMMAND_TIMEOUT_MS;
  const maxBufferBytes = options.maxBufferBytes ?? HERMES_COMMAND_MAX_BUFFER_BYTES;
  if (
    !isSafePositiveIntegerAtMost(timeoutMs, HERMES_COMMAND_MAX_TIMEOUT_MS) ||
    !isSafePositiveIntegerAtMost(maxBufferBytes, HERMES_COMMAND_MAX_BUFFER_BYTES)
  ) {
    throw new HermesCommandExecutionError("HERMES_COMMAND_INVALID", "requires bounded limits");
  }

  const execFile = options.execFile ?? defaultExecFile;
  const terminateProcessTree = options.terminateProcessTree ?? defaultProcessTreeTerminator;
  const execOptions: HermesExecFileOptions = {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    encoding: "utf8",
    env: { ...options.env },
    maxBuffer: maxBufferBytes,
    shell: false,
    windowsHide: true,
  };

  return async (command, args) => {
    if (!isAbsolute(command)) {
      throw new HermesCommandExecutionError(
        "HERMES_COMMAND_INVALID",
        "requires an absolute command",
      );
    }

    return new Promise((resolvePromise, rejectPromise) => {
      let child: HermesExecFileChild | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      let cleanupStarted = false;

      const clearTimer = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
      const reject = (code: HermesCommandExecutionErrorCode, message: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimer();
        rejectPromise(new HermesCommandExecutionError(code, message));
      };
      const callback: HermesExecFileCallback = (error, stdout, stderr) => {
        if (settled || cleanupStarted) {
          return;
        }
        if (error) {
          reject("HERMES_COMMAND_FAILED", "failed");
          return;
        }
        if (
          Buffer.byteLength(stdout, "utf8") > maxBufferBytes ||
          Buffer.byteLength(stderr, "utf8") > maxBufferBytes
        ) {
          reject("HERMES_COMMAND_FAILED", "failed");
          return;
        }

        settled = true;
        clearTimer();
        resolvePromise({ stdout });
      };
      const cleanupAfterTimeout = async (): Promise<void> => {
        if (settled || cleanupStarted) {
          return;
        }
        cleanupStarted = true;
        clearTimer();

        const cleanupConfirmed =
          child !== undefined &&
          (await confirmCleanupWithinGrace(
            terminateProcessTree,
            child,
            HERMES_COMMAND_CLEANUP_GRACE_MS,
          ));
        if (cleanupConfirmed) {
          reject("HERMES_COMMAND_TIMEOUT", "timed out");
        } else {
          reject("HERMES_COMMAND_CLEANUP_FAILED", "cleanup could not be confirmed");
        }
      };

      try {
        child = execFile(command, [...args], execOptions, callback);
      } catch {
        reject("HERMES_COMMAND_FAILED", "failed");
        return;
      }

      if (!settled) {
        timer = setTimeout(() => {
          void cleanupAfterTimeout();
        }, timeoutMs);
      }
    });
  };
}

const defaultExecFile: HermesExecFileLike = (command, args, options, callback) => {
  const child = nodeSpawn(command, [...args], {
    cwd: options.cwd,
    detached: options.detached,
    env: { ...options.env },
    shell: options.shell,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: options.windowsHide,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputOverflow = false;
  let spawnError: Error | null = null;

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= options.maxBuffer) {
      stdout.push(chunk);
    } else {
      outputOverflow = true;
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= options.maxBuffer) {
      stderr.push(chunk);
    } else {
      outputOverflow = true;
    }
  });
  child.once("error", (error) => {
    spawnError = error;
  });
  child.once("close", (code) => {
    const error =
      spawnError ??
      (outputOverflow || code !== 0 ? new Error("Managed command process failed") : null);
    callback(
      error,
      Buffer.concat(stdout).toString(options.encoding),
      Buffer.concat(stderr).toString(options.encoding),
    );
  });
  return child;
};

async function confirmCleanupWithinGrace(
  terminateProcessTree: HermesProcessTreeTerminator,
  child: HermesExecFileChild,
  cleanupGraceMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (confirmed: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(confirmed);
    };
    const timer = setTimeout(() => finish(false), cleanupGraceMs);

    Promise.resolve()
      .then(() => terminateProcessTree(child, cleanupGraceMs))
      .then(
        (confirmed) => finish(confirmed === true),
        () => finish(false),
      );
  });
}

async function defaultProcessTreeTerminator(
  child: HermesExecFileChild,
  cleanupGraceMs: number,
): Promise<boolean> {
  return process.platform === "win32"
    ? terminateWindowsProcessTree(child, cleanupGraceMs)
    : terminatePosixProcessGroup(child, cleanupGraceMs);
}

async function terminatePosixProcessGroup(
  child: HermesExecFileChild,
  cleanupGraceMs: number,
): Promise<boolean> {
  const pid = child.pid;
  const closeState = observeChildClose(child);
  if (!isValidPid(pid) || closeState === undefined) {
    return false;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      return false;
    }
  }

  const deadline = Date.now() + cleanupGraceMs;
  do {
    if (closeState.isClosed() && !processGroupExists(pid)) {
      return true;
    }
    await delay(20);
  } while (Date.now() < deadline);

  return closeState.isClosed() && !processGroupExists(pid);
}

async function terminateWindowsProcessTree(
  child: HermesExecFileChild,
  cleanupGraceMs: number,
): Promise<boolean> {
  const pid = child.pid;
  const closeState = observeChildClose(child);
  if (!isValidPid(pid) || closeState === undefined) {
    return false;
  }

  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const taskkill = win32.join(systemRoot, "System32", "taskkill.exe");
  const taskkillSucceeded = await new Promise<boolean>((resolve) => {
    nodeExecFile(
      taskkill,
      ["/PID", String(pid), "/T", "/F"],
      {
        encoding: "utf8",
        env: { SystemRoot: systemRoot },
        killSignal: "SIGKILL",
        maxBuffer: WINDOWS_TASKKILL_MAX_BUFFER_BYTES,
        shell: false,
        timeout: cleanupGraceMs,
        windowsHide: true,
      },
      (error) => resolve(error === null),
    );
  });
  if (!taskkillSucceeded) {
    return false;
  }

  const deadline = Date.now() + cleanupGraceMs;
  do {
    if (closeState.isClosed()) {
      return true;
    }
    await delay(20);
  } while (Date.now() < deadline);
  return closeState.isClosed();
}

function observeChildClose(
  child: HermesExecFileChild,
): { readonly isClosed: () => boolean } | undefined {
  if (child.once === undefined) {
    return undefined;
  }
  let closed = false;
  child.once("close", () => {
    closed = true;
  });
  return { isClosed: () => closed };
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function isValidPid(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0;
}

function isSafePositiveIntegerAtMost(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
