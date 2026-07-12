import type { HermesPaths } from "./paths";

export interface HermesGatewaySpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export function createHermesGatewaySpawnSpec(
  paths: HermesPaths,
  launcherPath: string,
): HermesGatewaySpawnSpec {
  return {
    command: paths.pythonExecutable,
    args: ["-I", "-S", "-B", "-u", "-X", "utf8", launcherPath],
    cwd: paths.gatewayCwd,
    env: { HERMES_HOME: paths.hermesHome },
  };
}
