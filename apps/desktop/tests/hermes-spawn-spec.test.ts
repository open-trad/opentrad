import { describe, expect, it } from "vitest";
import { resolveInstalledHermesBundledSkillsRoot } from "../src/main/services/hermes/bundled-skills";
import { resolveHermesProfilePaths } from "../src/main/services/hermes/paths";
import {
  createHermesGatewaySpawnSpec,
  isHermesGatewayEnvironment,
  resolveHermesCopilotGhHost,
} from "../src/main/services/hermes/spawn-spec";

describe("createHermesGatewaySpawnSpec", () => {
  const paths = resolveHermesProfilePaths("/opentrad-data", "profile-789", "darwin");
  const launcherPath =
    "/Applications/OpenTrad.app/Contents/Resources/hermes/opentrad_hermes_launcher.py";
  const workspaceRoot = "/Users/example/workspaces/trade-project";
  const hostEnv = {
    HOME: "/Users/example",
    PATH: "/opt/homebrew/bin:/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    LC_CTYPE: "UTF-8",
    TERM: "xterm-256color",
    SSH_AUTH_SOCK: "/private/tmp/ssh-agent.sock",
    HERMES_HOME: "/Users/example/.hermes",
    PYTHONPATH: "/tmp/python-canary",
    PYTHONHOME: "/tmp/python-home-canary",
    DYLD_INSERT_LIBRARIES: "/tmp/dyld-canary.dylib",
    OPENAI_API_KEY: "provider-canary",
    HTTPS_PROXY: "https://proxy-canary.invalid",
    NO_PROXY: "proxy-bypass-canary",
    HERMES_BUNDLED_SKILLS: "/attacker/skills",
    GH_CONFIG_DIR: "/Users/example/.config/gh",
    XDG_CONFIG_HOME: "/Users/example/.config",
    COPILOT_GH_HOST: "github.com",
    CODEX_HOME: "/Users/example/.codex",
  } as const;

  it("runs only the absolute owned launcher with the full isolation contract", () => {
    const spec = createHermesGatewaySpawnSpec(paths, launcherPath, workspaceRoot, hostEnv);

    expect(spec.command).toBe(paths.pythonExecutable);
    expect(spec.args).toEqual(["-I", "-S", "-B", "-u", "-X", "utf8", launcherPath]);
    expect(spec.cwd).toBe(paths.gatewayCwd);
    expect(spec.cwd).not.toBe(paths.runtimeRoot);
    expect(spec.env).toEqual({
      HOME: "/Users/example",
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      LC_CTYPE: "UTF-8",
      TERM: "xterm-256color",
      SSH_AUTH_SOCK: "/private/tmp/ssh-agent.sock",
      HERMES_HOME: paths.hermesHome,
      GH_CONFIG_DIR: `${paths.hermesHome}/gh-config`,
      XDG_CONFIG_HOME: `${paths.hermesHome}/xdg-config`,
      COPILOT_GH_HOST: resolveHermesCopilotGhHost(paths.hermesHome),
      CODEX_HOME: `${paths.hermesHome}/codex-home`,
      HERMES_BUNDLED_SKILLS: resolveInstalledHermesBundledSkillsRoot(paths.runtimeRoot),
      OPENTRAD_WORKSPACE_ROOT: workspaceRoot,
    });
  });

  it("copies only the explicit tool environment allowlist without mutating the host snapshot", () => {
    const before = { ...hostEnv };
    const spec = createHermesGatewaySpawnSpec(paths, launcherPath, workspaceRoot, hostEnv);

    expect(hostEnv).toEqual(before);
    expect(spec.env.HOME).toBe(hostEnv.HOME);
    expect(spec.env.PATH).toBe(hostEnv.PATH);
    expect(spec.env.HERMES_HOME).toBe(paths.hermesHome);
    expect(spec.env.GH_CONFIG_DIR).toBe(`${paths.hermesHome}/gh-config`);
    expect(spec.env.XDG_CONFIG_HOME).toBe(`${paths.hermesHome}/xdg-config`);
    expect(spec.env.HERMES_BUNDLED_SKILLS).toBe(
      resolveInstalledHermesBundledSkillsRoot(paths.runtimeRoot),
    );
    expect(spec.env).not.toHaveProperty("TMPDIR");
    expect(spec.env).not.toHaveProperty("PYTHONPATH");
    expect(spec.env).not.toHaveProperty("PYTHONHOME");
    expect(spec.env).not.toHaveProperty("DYLD_INSERT_LIBRARIES");
    expect(spec.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(spec.env).not.toHaveProperty("HTTPS_PROXY");
    expect(spec.env).not.toHaveProperty("NO_PROXY");
  });

  it("passes only an explicit trusted proxy snapshot through private launcher inputs", () => {
    const spec = createHermesGatewaySpawnSpec(paths, launcherPath, workspaceRoot, hostEnv, {
      HTTP_PROXY: "http://127.0.0.1:7897",
      HTTPS_PROXY: "http://127.0.0.1:7897",
      NO_PROXY: "localhost,127.0.0.1,::1",
    });

    expect(spec.env).toMatchObject({
      OPENTRAD_NETWORK_HTTP_PROXY: "http://127.0.0.1:7897",
      OPENTRAD_NETWORK_HTTPS_PROXY: "http://127.0.0.1:7897",
      OPENTRAD_NETWORK_NO_PROXY: "localhost,127.0.0.1,::1",
    });
    expect(spec.env).not.toHaveProperty("HTTP_PROXY");
    expect(spec.env).not.toHaveProperty("HTTPS_PROXY");
    expect(spec.env).not.toHaveProperty("NO_PROXY");
    expect(JSON.stringify(spec)).not.toContain("proxy-canary.invalid");
  });

  it("rejects incomplete private proxy input groups before spawning", () => {
    const base = createHermesGatewaySpawnSpec(paths, launcherPath, workspaceRoot, hostEnv).env;
    const isValid = (env: Readonly<Record<string, string>>): boolean =>
      isHermesGatewayEnvironment(env, paths.hermesHome, workspaceRoot, paths.runtimeRoot);

    expect(isValid({ ...base, OPENTRAD_NETWORK_HTTPS_PROXY: "http://127.0.0.1:7897" })).toBe(false);
    expect(isValid({ ...base, OPENTRAD_NETWORK_NO_PROXY: "localhost,127.0.0.1,::1" })).toBe(false);
  });

  it("omits non-UTF-8 locale values", () => {
    const spec = createHermesGatewaySpawnSpec(paths, launcherPath, workspaceRoot, {
      HOME: hostEnv.HOME,
      PATH: hostEnv.PATH,
      LANG: "C",
      LC_ALL: "POSIX",
      LC_CTYPE: "en_US.ISO8859-1",
    });

    expect(spec.env).toEqual({
      HOME: hostEnv.HOME,
      PATH: hostEnv.PATH,
      HERMES_HOME: paths.hermesHome,
      GH_CONFIG_DIR: `${paths.hermesHome}/gh-config`,
      XDG_CONFIG_HOME: `${paths.hermesHome}/xdg-config`,
      COPILOT_GH_HOST: resolveHermesCopilotGhHost(paths.hermesHome),
      CODEX_HOME: `${paths.hermesHome}/codex-home`,
      HERMES_BUNDLED_SKILLS: resolveInstalledHermesBundledSkillsRoot(paths.runtimeRoot),
      OPENTRAD_WORKSPACE_ROOT: workspaceRoot,
    });
  });

  it("keeps credentials capabilities models ports and canaries out of spawn data", () => {
    const canaries = [
      "OPENAI_API_KEY=provider-canary",
      "capability-token-canary",
      "openai/gpt-secret-canary",
      "43117",
      "LC_CANARY_SECRET=locale-canary",
    ];
    const spec = createHermesGatewaySpawnSpec(paths, launcherPath, workspaceRoot, hostEnv);
    const serialized = JSON.stringify(spec);

    for (const canary of canaries) {
      expect(serialized).not.toContain(canary);
    }
    expect(serialized).not.toContain("tui_gateway.entry");
  });

  it("creates distinct immutable trusted inputs for concurrent Docker workspace shards", () => {
    const first = createHermesGatewaySpawnSpec(
      paths,
      launcherPath,
      "/Users/example/workspaces/first",
      hostEnv,
    );
    const second = createHermesGatewaySpawnSpec(
      paths,
      launcherPath,
      "/Users/example/workspaces/second",
      hostEnv,
    );

    expect(first.env.OPENTRAD_WORKSPACE_ROOT).toBe("/Users/example/workspaces/first");
    expect(second.env.OPENTRAD_WORKSPACE_ROOT).toBe("/Users/example/workspaces/second");
    expect(first.env).not.toBe(second.env);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.env)).toBe(true);
    expect(Object.isFrozen(second.env)).toBe(true);
  });

  it.each([
    "workspace/relative",
    "/workspace/with\0nul",
  ])("rejects an untrusted workspace value: %s", (workspace) => {
    expect(() => createHermesGatewaySpawnSpec(paths, launcherPath, workspace, hostEnv)).toThrow();
  });
});
