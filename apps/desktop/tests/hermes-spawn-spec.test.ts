import { describe, expect, it } from "vitest";
import { resolveHermesPaths } from "../src/main/services/hermes/paths";
import { createHermesGatewaySpawnSpec } from "../src/main/services/hermes/spawn-spec";

describe("createHermesGatewaySpawnSpec", () => {
  const paths = resolveHermesPaths("/opentrad-data", "darwin");
  const launcherPath =
    "/Applications/OpenTrad.app/Contents/Resources/hermes/opentrad_hermes_launcher.py";

  it("runs only the absolute owned launcher with the full isolation contract", () => {
    const spec = createHermesGatewaySpawnSpec(paths, launcherPath);

    expect(spec.command).toBe(paths.pythonExecutable);
    expect(spec.args).toEqual(["-I", "-S", "-B", "-u", "-X", "utf8", launcherPath]);
    expect(spec.cwd).toBe(paths.gatewayCwd);
    expect(spec.cwd).not.toBe(paths.runtimeRoot);
    expect(spec.env).toEqual({ HERMES_HOME: paths.hermesHome });
  });

  it("does not accept or inherit any process environment", () => {
    const before = { ...process.env };
    const spec = createHermesGatewaySpawnSpec(paths, launcherPath);

    expect(process.env).toEqual(before);
    expect(spec.env).toEqual({ HERMES_HOME: paths.hermesHome });
    expect(spec.env).not.toHaveProperty("PATH");
    expect(spec.env).not.toHaveProperty("HOME");
    expect(spec.env).not.toHaveProperty("TMPDIR");
    expect(spec.env).not.toHaveProperty("PYTHONUNBUFFERED");
  });

  it("keeps credentials capabilities models ports and canaries out of spawn data", () => {
    const canaries = [
      "OPENAI_API_KEY=provider-canary",
      "capability-token-canary",
      "openai/gpt-secret-canary",
      "43117",
      "LC_CANARY_SECRET=locale-canary",
    ];
    const spec = createHermesGatewaySpawnSpec(paths, launcherPath);
    const serialized = JSON.stringify(spec);

    for (const canary of canaries) {
      expect(serialized).not.toContain(canary);
    }
    expect(serialized).not.toContain("tui_gateway.entry");
  });
});
