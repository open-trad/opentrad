import { HERMES_GATEWAY_MODULE } from "./constants";
import type { HermesPaths } from "./paths";

export const HERMES_GATEWAY_ALLOWED_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;
const ALLOWED_ENV_KEYS = new Set<string>(HERMES_GATEWAY_ALLOWED_ENV_KEYS);
const REQUIRED_GATEWAY_ENV_KEYS = new Set(["HERMES_HOME", "PYTHONUNBUFFERED"]);

export interface HermesGatewaySpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export function createHermesGatewaySpawnSpec(
  paths: HermesPaths,
  sourceEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): HermesGatewaySpawnSpec {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) {
      continue;
    }

    const canonicalKey = platform === "win32" ? key.toUpperCase() : key;
    if (!ALLOWED_ENV_KEYS.has(canonicalKey)) {
      continue;
    }
    if (platform === "win32" && Object.hasOwn(env, canonicalKey)) {
      throw new Error(`Duplicate Windows environment variable: ${canonicalKey}`);
    }
    env[canonicalKey] = value;
  }
  env.HERMES_HOME = paths.hermesHome;
  env.PYTHONUNBUFFERED = "1";

  return {
    command: paths.pythonExecutable,
    args: ["-u", "-m", HERMES_GATEWAY_MODULE],
    cwd: paths.gatewayCwd,
    env,
  };
}

export function isHermesGatewaySpawnEnvKeyAllowed(key: string, platform: NodeJS.Platform): boolean {
  if (REQUIRED_GATEWAY_ENV_KEYS.has(key)) return true;
  if (platform === "win32" && key !== key.toUpperCase()) return false;
  return ALLOWED_ENV_KEYS.has(key);
}
