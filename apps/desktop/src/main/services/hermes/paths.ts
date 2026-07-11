import { constants as fsConstants, type Stats } from "node:fs";
import { type FileHandle, lstat, mkdir, open } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import { HERMES_AGENT_VERSION } from "./constants";

export type HermesPlatform = "darwin" | "linux" | "win32";

export interface HermesPaths {
  readonly runtimeRoot: string;
  readonly hermesHome: string;
  readonly pythonExecutable: string;
}

export interface EnsureHermesStateDirsOptions {
  readonly dataRoot: string;
}

export class HermesPathSecurityError extends Error {
  readonly code = "HERMES_PATH_SECURITY";

  constructor(message: string, options?: ErrorOptions) {
    super(`Unsafe managed Hermes path: ${message}`, options);
    this.name = "HermesPathSecurityError";
  }
}

export function resolveHermesPaths(dataRoot: string, platform: HermesPlatform): HermesPaths {
  const path = platform === "win32" ? win32 : posix;
  const runtimeRoot = path.join(dataRoot, "runtimes", "hermes", HERMES_AGENT_VERSION);
  const hermesHome = path.join(dataRoot, "hermes");
  const pythonExecutable =
    platform === "win32"
      ? path.join(runtimeRoot, "venv", "Scripts", "python.exe")
      : path.join(runtimeRoot, "venv", "bin", "python3");

  return { runtimeRoot, hermesHome, pythonExecutable };
}

export async function ensureHermesStateDirs(
  paths: Pick<HermesPaths, "runtimeRoot" | "hermesHome">,
  options: EnsureHermesStateDirsOptions,
): Promise<void> {
  if (!isAbsolute(options.dataRoot)) {
    throw new HermesPathSecurityError("data root must be absolute");
  }

  const dataRoot = resolve(options.dataRoot);
  const targets = [paths.runtimeRoot, paths.hermesHome].map((target) => {
    if (!isAbsolute(target)) {
      throw new HermesPathSecurityError("managed path must be absolute");
    }

    const normalizedTarget = resolve(target);
    const relativeTarget = relative(dataRoot, normalizedTarget);
    if (
      relativeTarget === "" ||
      relativeTarget === ".." ||
      relativeTarget.startsWith(`..${sep}`) ||
      isAbsolute(relativeTarget)
    ) {
      throw new HermesPathSecurityError("managed path is outside the trusted data root");
    }

    return relativeTarget;
  });

  const managedMode = process.platform === "win32" ? undefined : 0o700;
  await ensureRealDirectory(dataRoot, managedMode, false);
  for (const relativeTarget of targets) {
    let current = dataRoot;
    for (const component of relativeTarget.split(sep)) {
      current = join(current, component);
      await ensureRealDirectory(current, managedMode);
    }
  }
}

async function ensureRealDirectory(
  dir: string,
  managedMode: number | undefined,
  hardenExisting = true,
): Promise<void> {
  let metadata: Stats;
  let created = false;
  try {
    metadata = await lstat(dir);
  } catch (cause) {
    if (!isNodeError(cause) || cause.code !== "ENOENT") {
      throw cause;
    }

    try {
      if (managedMode === undefined) {
        await mkdir(dir);
      } else {
        await mkdir(dir, { mode: managedMode });
      }
      created = true;
    } catch (mkdirCause) {
      if (!isNodeError(mkdirCause) || mkdirCause.code !== "EEXIST") {
        throw mkdirCause;
      }
    }
    metadata = await lstat(dir);
  }

  if (metadata.isSymbolicLink()) {
    throw new HermesPathSecurityError(`symbolic link rejected at ${dir}`);
  }
  if (!metadata.isDirectory()) {
    throw new HermesPathSecurityError(`component is not a directory: ${dir}`);
  }

  if (managedMode !== undefined && (created || hardenExisting)) {
    await chmodDirectoryWithoutFollowingLinks(dir, managedMode);
  }
}

async function chmodDirectoryWithoutFollowingLinks(
  dir: string,
  managedMode: number,
): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(
      dir,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
  } catch (cause) {
    throw new HermesPathSecurityError(`directory changed during validation: ${dir}`, { cause });
  }

  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory()) {
      throw new HermesPathSecurityError(`component is not a directory: ${dir}`);
    }
    // Node has no portable fd-relative traversal/mkdir. The trusted caller-owned root and all
    // managed components must not be concurrently replaced by another same-user process.
    await handle.chmod(managedMode);
  } finally {
    await handle.close();
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}
