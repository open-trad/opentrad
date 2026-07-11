import { chmod, mkdir } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { HERMES_AGENT_VERSION } from "./constants";

export type HermesPlatform = "darwin" | "linux" | "win32";

export interface HermesPaths {
  readonly runtimeRoot: string;
  readonly hermesHome: string;
  readonly pythonExecutable: string;
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
): Promise<void> {
  await Promise.all(
    [paths.runtimeRoot, paths.hermesHome].map(async (dir) => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
    }),
  );
}
