import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ProviderProfile } from "@opentrad/model-providers";
import type { HermesCommandRunner } from "./installation";

const DOCKER_EXECUTABLE_CANDIDATES = [
  "/Applications/Docker.app/Contents/Resources/bin/docker",
  "/opt/homebrew/bin/docker",
  "/usr/local/bin/docker",
] as const;
const DOCKER_VERSION_PATTERN = /^[0-9][0-9A-Za-z.+-]{0,63}$/u;

export type HermesExecutionBackendValidator = (
  profile: ProviderProfile,
  workspaceRoot: string,
) => Promise<void>;

export type DockerExecutableResolver = () => Promise<string>;

export interface HermesDockerPreflightOptions {
  readonly runner: HermesCommandRunner;
  readonly resolveExecutable?: DockerExecutableResolver;
}

export class HermesDockerPreflightError extends Error {
  readonly code = "HERMES_DOCKER_UNAVAILABLE";

  constructor() {
    super("Hermes Docker execution backend is unavailable");
    this.name = "HermesDockerPreflightError";
  }
}

export function createHermesDockerPreflight(
  options: HermesDockerPreflightOptions,
): HermesExecutionBackendValidator {
  const runner = options?.runner;
  const resolveExecutable = options?.resolveExecutable ?? resolveDockerExecutable;
  if (typeof runner !== "function" || typeof resolveExecutable !== "function") {
    throw new HermesDockerPreflightError();
  }

  return async (profile, workspaceRoot) => {
    if (profile.hermes.executionBackend === "local") return;
    try {
      if (
        typeof workspaceRoot !== "string" ||
        workspaceRoot.length === 0 ||
        workspaceRoot.length > 4_096 ||
        workspaceRoot.includes("\0") ||
        !isAbsolute(workspaceRoot)
      ) {
        throw new Error();
      }
      const executable = await resolveExecutable();
      if (
        typeof executable !== "string" ||
        executable.length === 0 ||
        executable.length > 4_096 ||
        executable.includes("\0") ||
        !isAbsolute(executable)
      ) {
        throw new Error();
      }
      const result = await runner(executable, ["version", "--format", "{{.Server.Version}}"]);
      const version = result.stdout.trim();
      if (!DOCKER_VERSION_PATTERN.test(version)) throw new Error();
    } catch {
      throw new HermesDockerPreflightError();
    }
  };
}

async function resolveDockerExecutable(): Promise<string> {
  for (const candidate of DOCKER_EXECUTABLE_CANDIDATES) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue through the fixed macOS arm64 Docker CLI locations.
    }
  }
  throw new HermesDockerPreflightError();
}
