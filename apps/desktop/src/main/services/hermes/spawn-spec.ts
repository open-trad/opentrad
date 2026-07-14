import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { resolveInstalledHermesBundledSkillsRoot } from "./bundled-skills";
import {
  type HermesNetworkEnvironment,
  isValidHermesProxyUrl,
  snapshotHermesNetworkEnvironment,
} from "./network-environment";
import type { HermesPaths } from "./paths";

const HERMES_GATEWAY_PASSTHROUGH_ENV_KEYS = ["HOME", "PATH", "TERM", "SSH_AUTH_SOCK"] as const;
const HERMES_GATEWAY_LOCALE_ENV_KEYS = ["LANG", "LC_ALL", "LC_CTYPE"] as const;
const HERMES_GATEWAY_NETWORK_INPUT_KEYS = [
  "OPENTRAD_NETWORK_HTTP_PROXY",
  "OPENTRAD_NETWORK_HTTPS_PROXY",
  "OPENTRAD_NETWORK_NO_PROXY",
] as const;
const HERMES_GATEWAY_ENV_KEYS = new Set<string>([
  ...HERMES_GATEWAY_PASSTHROUGH_ENV_KEYS,
  ...HERMES_GATEWAY_LOCALE_ENV_KEYS,
  ...HERMES_GATEWAY_NETWORK_INPUT_KEYS,
  "HERMES_HOME",
  "GH_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "COPILOT_GH_HOST",
  "CODEX_HOME",
  "HERMES_BUNDLED_SKILLS",
  "OPENTRAD_WORKSPACE_ROOT",
]);
const UTF8_LOCALE_PATTERN = /(?:^|[._-])UTF-?8(?:$|@)/i;
const MAX_ENV_VALUE_CHARACTERS = 32_768;

export type HermesHostEnvironment = Readonly<Record<string, string | undefined>>;

export interface HermesGatewaySpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export function createHermesGatewaySpawnSpec(
  paths: HermesPaths,
  launcherPath: string,
  workspaceRoot: string,
  hostEnv: HermesHostEnvironment = process.env,
  networkEnvironment?: HermesNetworkEnvironment,
): HermesGatewaySpawnSpec {
  if (!isSafeEnvironmentValue(workspaceRoot) || !isAbsolute(workspaceRoot)) throw new Error();
  const env = Object.freeze({
    ...createHermesProfileEnvironment(paths.hermesHome, hostEnv),
    ...createHermesGatewayNetworkInputs(networkEnvironment),
    HERMES_BUNDLED_SKILLS: resolveInstalledHermesBundledSkillsRoot(paths.runtimeRoot),
    OPENTRAD_WORKSPACE_ROOT: workspaceRoot,
  });
  return Object.freeze({
    command: paths.pythonExecutable,
    args: Object.freeze(["-I", "-S", "-B", "-u", "-X", "utf8", launcherPath]),
    cwd: paths.gatewayCwd,
    env,
  });
}

export function isHermesGatewayEnvironment(
  env: Readonly<Record<string, unknown>>,
  hermesHome: string,
  workspaceRoot: string,
  runtimeRoot: string,
): boolean {
  const entries = Object.entries(env);
  const hasNetworkProxy =
    env.OPENTRAD_NETWORK_HTTP_PROXY !== undefined || env.OPENTRAD_NETWORK_HTTPS_PROXY !== undefined;
  const hasNoProxy = env.OPENTRAD_NETWORK_NO_PROXY !== undefined;
  return (
    env.HERMES_HOME === hermesHome &&
    env.HERMES_BUNDLED_SKILLS === resolveInstalledHermesBundledSkillsRoot(runtimeRoot) &&
    env.OPENTRAD_WORKSPACE_ROOT === workspaceRoot &&
    env.GH_CONFIG_DIR === join(hermesHome, "gh-config") &&
    env.XDG_CONFIG_HOME === join(hermesHome, "xdg-config") &&
    env.COPILOT_GH_HOST === resolveHermesCopilotGhHost(hermesHome) &&
    env.CODEX_HOME === join(hermesHome, "codex-home") &&
    hasNetworkProxy === hasNoProxy &&
    entries.every(
      ([key, value]) =>
        HERMES_GATEWAY_ENV_KEYS.has(key) &&
        isSafeEnvironmentValue(value) &&
        (!isLocaleKey(key) || UTF8_LOCALE_PATTERN.test(value)) &&
        isSafeGatewayNetworkInput(key, value),
    )
  );
}

export function createHermesProfileEnvironment(
  hermesHome: string,
  hostEnv: HermesHostEnvironment,
  networkEnvironment?: HermesNetworkEnvironment,
): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const key of HERMES_GATEWAY_PASSTHROUGH_ENV_KEYS) {
    const value = hostEnv[key];
    if (isSafeEnvironmentValue(value)) env[key] = value;
  }
  for (const key of HERMES_GATEWAY_LOCALE_ENV_KEYS) {
    const value = hostEnv[key];
    if (isSafeEnvironmentValue(value) && UTF8_LOCALE_PATTERN.test(value)) env[key] = value;
  }
  env.HERMES_HOME = hermesHome;
  env.GH_CONFIG_DIR = join(hermesHome, "gh-config");
  env.XDG_CONFIG_HOME = join(hermesHome, "xdg-config");
  env.COPILOT_GH_HOST = resolveHermesCopilotGhHost(hermesHome);
  env.CODEX_HOME = join(hermesHome, "codex-home");
  Object.assign(env, snapshotHermesNetworkEnvironment(networkEnvironment));
  return Object.freeze(env);
}

export function resolveHermesCopilotGhHost(hermesHome: string): string {
  const profileHash = createHash("sha256").update(hermesHome, "utf8").digest("hex").slice(0, 24);
  return `${profileHash}.opentrad.invalid`;
}

function isLocaleKey(value: string): value is (typeof HERMES_GATEWAY_LOCALE_ENV_KEYS)[number] {
  return HERMES_GATEWAY_LOCALE_ENV_KEYS.some((key) => key === value);
}

function isSafeEnvironmentValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ENV_VALUE_CHARACTERS &&
    !value.includes("\0") &&
    !value.includes("\n") &&
    !value.includes("\r")
  );
}

function createHermesGatewayNetworkInputs(
  networkEnvironment: HermesNetworkEnvironment | undefined,
): Readonly<Record<string, string>> {
  const trusted = snapshotHermesNetworkEnvironment(networkEnvironment);
  const inputs: Record<string, string> = {};
  if (trusted.HTTP_PROXY) inputs.OPENTRAD_NETWORK_HTTP_PROXY = trusted.HTTP_PROXY;
  if (trusted.HTTPS_PROXY) inputs.OPENTRAD_NETWORK_HTTPS_PROXY = trusted.HTTPS_PROXY;
  if (trusted.NO_PROXY) inputs.OPENTRAD_NETWORK_NO_PROXY = trusted.NO_PROXY;
  return Object.freeze(inputs);
}

function isSafeGatewayNetworkInput(key: string, value: string): boolean {
  if (key === "OPENTRAD_NETWORK_HTTP_PROXY" || key === "OPENTRAD_NETWORK_HTTPS_PROXY") {
    return isValidHermesProxyUrl(value);
  }
  if (key === "OPENTRAD_NETWORK_NO_PROXY") {
    return value === "localhost,127.0.0.1,::1";
  }
  return true;
}
