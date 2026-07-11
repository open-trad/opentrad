import { HERMES_AGENT_VERSION } from "./constants";

export const HERMES_VERSION_QUERY =
  "import importlib.metadata; print(importlib.metadata.version('hermes-agent'))";

export interface HermesCommandResult {
  readonly stdout: string;
}

export type HermesCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<HermesCommandResult>;

export interface VerifiedHermesInstallation {
  readonly pythonExecutable: string;
  readonly version: typeof HERMES_AGENT_VERSION;
}

export class HermesRuntimeUnavailableError extends Error {
  readonly code = "HERMES_RUNTIME_UNAVAILABLE";

  constructor(message: string, options?: ErrorOptions) {
    super(`Managed Hermes runtime unavailable: ${message}`, options);
    this.name = "HermesRuntimeUnavailableError";
  }
}

export async function verifyHermesInstallation(
  pythonExecutable: string,
  runner: HermesCommandRunner,
): Promise<VerifiedHermesInstallation> {
  let result: HermesCommandResult;
  try {
    result = await runner(pythonExecutable, ["-c", HERMES_VERSION_QUERY]);
  } catch {
    throw new HermesRuntimeUnavailableError("version check failed");
  }

  const installedVersion = result.stdout.trim();
  if (installedVersion !== HERMES_AGENT_VERSION) {
    throw new HermesRuntimeUnavailableError(
      `expected ${HERMES_AGENT_VERSION}, managed runtime reports a different version`,
    );
  }

  return {
    pythonExecutable,
    version: HERMES_AGENT_VERSION,
  };
}
