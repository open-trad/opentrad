import { execFile as nodeExecFile } from "node:child_process";
import type { EventEmitter } from "node:events";
import { win32 } from "node:path";

export const HERMES_SIDECAR_EOF_GRACE_MS = 1_500;
export const HERMES_SIDECAR_TERM_GRACE_MS = 1_000;
export const HERMES_SIDECAR_KILL_GRACE_MS = 1_000;
const HERMES_SIDECAR_MAX_GRACE_MS = 10_000;
const HERMES_SIDECAR_REAP_POLL_MS = 20;
const WINDOWS_TASKKILL_MAX_BUFFER_BYTES = 16 * 1024;

export interface HermesSidecarReapableProcess extends EventEmitter {
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
}

export interface HermesSidecarTerminationOptions {
  readonly platform?: NodeJS.Platform;
  readonly gracefulShutdownMs?: number;
  readonly termGraceMs?: number;
  readonly killGraceMs?: number;
  readonly processGroupExists?: (pid: number) => boolean;
  readonly sendPosixSignal?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  readonly runWindowsTaskkill?: (pid: number, timeoutMs: number) => Promise<boolean>;
}

export interface WindowsTaskkillExecOptions {
  readonly encoding: "utf8";
  readonly env: Readonly<Record<string, string>>;
  readonly maxBuffer: number;
  readonly shell: false;
  readonly timeout: number;
  readonly windowsHide: true;
}

export type WindowsTaskkillExec = (
  command: string,
  args: readonly string[],
  options: WindowsTaskkillExecOptions,
  callback: (error: Error | null) => void,
) => unknown;

export class HermesSidecarCleanupError extends Error {
  readonly code = "HERMES_SIDECAR_CLEANUP";

  constructor() {
    super("Hermes sidecar cleanup could not be confirmed");
    this.name = "HermesSidecarCleanupError";
  }
}

export function createHermesSidecarTerminator(
  child: HermesSidecarReapableProcess,
  options: HermesSidecarTerminationOptions = {},
): () => Promise<void> {
  validateHermesSidecarTerminationOptions(options);
  const platform = options.platform ?? process.platform;
  const gracefulShutdownMs = boundedGrace(
    options.gracefulShutdownMs,
    HERMES_SIDECAR_EOF_GRACE_MS,
    1_001,
  );
  const termGraceMs = boundedGrace(options.termGraceMs, HERMES_SIDECAR_TERM_GRACE_MS, 1);
  const killGraceMs = boundedGrace(options.killGraceMs, HERMES_SIDECAR_KILL_GRACE_MS, 1);
  const processGroupExists = options.processGroupExists ?? defaultProcessGroupExists;
  const sendPosixSignal = options.sendPosixSignal ?? defaultSendPosixSignal;
  const runWindowsTaskkill =
    options.runWindowsTaskkill ?? createWindowsTaskkillRunner({ sourceEnv: process.env });
  let closed = hasExited(child);
  let windowsTreeCleanupConfirmed = false;
  let terminationPromise: Promise<void> | undefined;

  const onClose = (): void => {
    closed = true;
  };
  const onError = (): void => {
    // Keep an error listener attached until close/reap is confirmed. Raw child errors are never
    // retained or reflected; GatewayClient independently classifies an unexpected crash.
  };
  child.once("close", onClose);
  child.on("error", onError);
  // Recheck after listener attachment so an exit racing with setup cannot be missed.
  if (hasExited(child)) closed = true;

  const detachProtection = (): void => {
    child.removeListener("close", onClose);
    child.removeListener("error", onError);
  };
  const isConfirmed = (): boolean => {
    if (!closed && !hasExited(child)) return false;
    // A parent close is not proof that Windows descendants exited. Until a Job Object with
    // KILL_ON_JOB_CLOSE owns the sidecar, require successful taskkill /T /F as the tree signal.
    if (platform === "win32") return windowsTreeCleanupConfirmed;
    const pid = child.pid;
    return isValidPid(pid) && !safeProcessGroupExists(processGroupExists, pid);
  };

  return () => {
    if (terminationPromise) return terminationPromise;
    terminationPromise = terminateOnce().then(
      () => {
        detachProtection();
      },
      () => {
        if (closed || hasExited(child)) {
          detachProtection();
        }
        throw new HermesSidecarCleanupError();
      },
    );
    return terminationPromise;
  };

  async function terminateOnce(): Promise<void> {
    const pid = child.pid;
    if (!isValidPid(pid)) {
      throw new HermesSidecarCleanupError();
    }

    if (await waitForConfirmation(isConfirmed, gracefulShutdownMs)) {
      return;
    }

    if (platform === "win32") {
      // Once the parent exits its numeric PID can be reused; taskkill on that stale PID could
      // terminate an unrelated tree. Fail closed instead. A narrow check-to-exec race remains
      // until the Windows launcher is owned by a Job Object with KILL_ON_JOB_CLOSE.
      if (closed || hasExited(child)) {
        throw new HermesSidecarCleanupError();
      }
      const taskkillSucceeded = await Promise.resolve()
        .then(() => runWindowsTaskkill(pid, killGraceMs))
        .catch(() => false);
      windowsTreeCleanupConfirmed = taskkillSucceeded;
      if (!(await waitForConfirmation(isConfirmed, killGraceMs))) {
        throw new HermesSidecarCleanupError();
      }
      return;
    }

    if (!trySendPosixSignal(sendPosixSignal, pid, "SIGTERM")) {
      throw new HermesSidecarCleanupError();
    }
    if (await waitForConfirmation(isConfirmed, termGraceMs)) {
      return;
    }

    if (!trySendPosixSignal(sendPosixSignal, pid, "SIGKILL")) {
      throw new HermesSidecarCleanupError();
    }
    if (!(await waitForConfirmation(isConfirmed, killGraceMs))) {
      throw new HermesSidecarCleanupError();
    }
  }
}

export function validateHermesSidecarTerminationOptions(
  options: HermesSidecarTerminationOptions = {},
): void {
  boundedGrace(options.gracefulShutdownMs, HERMES_SIDECAR_EOF_GRACE_MS, 1_001);
  boundedGrace(options.termGraceMs, HERMES_SIDECAR_TERM_GRACE_MS, 1);
  boundedGrace(options.killGraceMs, HERMES_SIDECAR_KILL_GRACE_MS, 1);
}

export function createWindowsTaskkillRunner(
  options: {
    readonly execFile?: WindowsTaskkillExec;
    readonly sourceEnv?: NodeJS.ProcessEnv;
    readonly systemRoot?: string;
  } = {},
): (pid: number, timeoutMs: number) => Promise<boolean> {
  const execFile = options.execFile ?? (nodeExecFile as unknown as WindowsTaskkillExec);
  const systemRoot =
    [options.systemRoot, options.sourceEnv?.SystemRoot, options.sourceEnv?.WINDIR].find(
      (candidate): candidate is string =>
        typeof candidate === "string" && win32.isAbsolute(candidate),
    ) ?? "C:\\Windows";
  const taskkill = win32.join(systemRoot, "System32", "taskkill.exe");

  return (pid, timeoutMs) =>
    new Promise<boolean>((resolve) => {
      try {
        execFile(
          taskkill,
          ["/PID", String(pid), "/T", "/F"],
          {
            encoding: "utf8",
            env: { SystemRoot: systemRoot },
            maxBuffer: WINDOWS_TASKKILL_MAX_BUFFER_BYTES,
            shell: false,
            timeout: timeoutMs,
            windowsHide: true,
          },
          (error) => resolve(error === null),
        );
      } catch {
        resolve(false);
      }
    });
}

async function waitForConfirmation(
  isConfirmed: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  if (safeCheck(isConfirmed)) return true;

  return new Promise((resolve) => {
    let settled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (confirmed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      resolve(confirmed);
    };
    const poll = (): void => {
      if (safeCheck(isConfirmed)) {
        finish(true);
        return;
      }
      pollTimer = setTimeout(poll, Math.min(HERMES_SIDECAR_REAP_POLL_MS, timeoutMs));
    };
    const deadlineTimer = setTimeout(() => finish(safeCheck(isConfirmed)), timeoutMs);
    poll();
  });
}

function trySendPosixSignal(
  send: (pid: number, signal: "SIGTERM" | "SIGKILL") => void,
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
): boolean {
  try {
    send(pid, signal);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function defaultSendPosixSignal(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  process.kill(-pid, signal);
}

function defaultProcessGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function safeProcessGroupExists(check: (pid: number) => boolean, pid: number): boolean {
  try {
    return check(pid);
  } catch {
    return true;
  }
}

function safeCheck(check: () => boolean): boolean {
  try {
    return check();
  } catch {
    return false;
  }
}

function boundedGrace(value: number | undefined, fallback: number, minimum: number): number {
  const selected = value ?? fallback;
  if (
    !Number.isSafeInteger(selected) ||
    selected < minimum ||
    selected > HERMES_SIDECAR_MAX_GRACE_MS
  ) {
    throw new RangeError("Hermes sidecar grace period must be bounded");
  }
  return selected;
}

function isValidPid(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function hasExited(child: HermesSidecarReapableProcess): boolean {
  return child.exitCode != null || child.signalCode != null;
}
