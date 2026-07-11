import { HERMES_GATEWAY_MODULE } from "./constants";
import type { HermesPaths } from "./paths";

const ALLOWED_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

export interface HermesGatewaySpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export function createHermesGatewaySpawnSpec(
  paths: HermesPaths,
  sourceEnv: NodeJS.ProcessEnv,
): HermesGatewaySpawnSpec {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value !== undefined && ALLOWED_ENV_KEYS.has(key)) {
      env[key] = value;
    }
  }
  env.HERMES_HOME = paths.hermesHome;
  env.PYTHONUNBUFFERED = "1";

  return {
    command: paths.pythonExecutable,
    args: ["-u", "-m", HERMES_GATEWAY_MODULE],
    cwd: paths.runtimeRoot,
    env,
  };
}
