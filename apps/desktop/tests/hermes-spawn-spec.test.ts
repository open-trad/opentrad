import { describe, expect, it } from "vitest";
import { HERMES_GATEWAY_MODULE } from "../src/main/services/hermes/constants";
import { resolveHermesPaths } from "../src/main/services/hermes/paths";
import { createHermesGatewaySpawnSpec } from "../src/main/services/hermes/spawn-spec";

describe("createHermesGatewaySpawnSpec", () => {
  const paths = resolveHermesPaths("/opentrad-data", "darwin");

  it("runs the pinned managed Python gateway module unbuffered", () => {
    const spec = createHermesGatewaySpawnSpec(paths, {});

    expect(HERMES_GATEWAY_MODULE).toBe("tui_gateway.entry");
    expect(spec.command).toBe(paths.pythonExecutable);
    expect(spec.args).toEqual(["-u", "-m", "tui_gateway.entry"]);
    expect(spec.cwd).toBe(paths.gatewayCwd);
    expect(spec.cwd).not.toBe(paths.runtimeRoot);
    expect(spec.env).toMatchObject({
      HERMES_HOME: paths.hermesHome,
      PYTHONUNBUFFERED: "1",
    });
  });

  it("drops provider credentials and arbitrary canary secrets", () => {
    const sourceEnv: NodeJS.ProcessEnv = {
      OPENAI_API_KEY: "openai-canary",
      ANTHROPIC_API_KEY: "anthropic-canary",
      DEEPSEEK_API_KEY: "deepseek-canary",
      GOOGLE_API_KEY: "google-canary",
      OPENTRAD_CANARY_SECRET: "arbitrary-canary",
      NODE_OPTIONS: "--require=/tmp/canary-secret.js",
      PYTHONPATH: "/tmp/canary-secret",
    };

    const spec = createHermesGatewaySpawnSpec(paths, sourceEnv);

    expect(spec.env).toEqual({
      HERMES_HOME: paths.hermesHome,
      PYTHONUNBUFFERED: "1",
    });
    expect(JSON.stringify([spec.args, spec.cwd])).not.toContain("canary");
  });

  it("retains only allowlisted process runtime fields", () => {
    const sourceEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/Users/example",
      TMPDIR: "/private/tmp/example/",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      LC_CTYPE: "UTF-8",
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
      SSL_CERT_DIR: "/etc/ssl/certs",
      SSH_AUTH_SOCK: "/private/tmp/agent.sock",
    };

    expect(createHermesGatewaySpawnSpec(paths, sourceEnv).env).toEqual({
      PATH: sourceEnv.PATH,
      HOME: sourceEnv.HOME,
      TMPDIR: sourceEnv.TMPDIR,
      LANG: sourceEnv.LANG,
      LC_ALL: sourceEnv.LC_ALL,
      LC_CTYPE: sourceEnv.LC_CTYPE,
      SSL_CERT_FILE: sourceEnv.SSL_CERT_FILE,
      SSL_CERT_DIR: sourceEnv.SSL_CERT_DIR,
      HERMES_HOME: paths.hermesHome,
      PYTHONUNBUFFERED: "1",
    });
  });

  it("does not treat arbitrary LC_ names as allowlisted locale fields", () => {
    const spec = createHermesGatewaySpawnSpec(paths, {
      LC_ALL: "en_US.UTF-8",
      LC_CTYPE: "UTF-8",
      LC_CANARY_SECRET: "leak",
    });

    expect(spec.env).toEqual({
      LC_ALL: "en_US.UTF-8",
      LC_CTYPE: "UTF-8",
      HERMES_HOME: paths.hermesHome,
      PYTHONUNBUFFERED: "1",
    });
    expect(spec.env).not.toHaveProperty("LC_CANARY_SECRET");
  });

  it("forces the isolated Hermes home without modifying the input environment", () => {
    const sourceEnv: NodeJS.ProcessEnv = {
      PATH: "/bin",
      HERMES_HOME: "/Users/example/.hermes",
      PYTHONUNBUFFERED: "0",
      CANARY_SECRET: "do-not-copy",
    };
    const original = { ...sourceEnv };

    const spec = createHermesGatewaySpawnSpec(paths, sourceEnv);

    expect(sourceEnv).toEqual(original);
    expect(spec.env).not.toBe(sourceEnv);
    expect(spec.env.HERMES_HOME).toBe(paths.hermesHome);
    expect(spec.env.PYTHONUNBUFFERED).toBe("1");
    expect(spec.env).not.toHaveProperty("CANARY_SECRET");
  });

  it("canonicalizes exact allowlisted environment names on Windows", () => {
    const spec = createHermesGatewaySpawnSpec(
      paths,
      {
        Path: "C:\\Windows\\System32",
        home: "C:\\Users\\example",
      },
      "win32",
    );

    expect(spec.env).toMatchObject({
      PATH: "C:\\Windows\\System32",
      HOME: "C:\\Users\\example",
    });
    expect(spec.env).not.toHaveProperty("Path");
    expect(spec.env).not.toHaveProperty("home");
  });

  it("rejects duplicate Windows casing for the same allowlisted key deterministically", () => {
    expect(() =>
      createHermesGatewaySpawnSpec(
        paths,
        {
          Path: "first",
          PATH: "second",
        },
        "win32",
      ),
    ).toThrowError(/duplicate Windows environment variable: PATH/i);
  });

  it("filters unknown mixed-case secrets on Windows", () => {
    const spec = createHermesGatewaySpawnSpec(
      paths,
      {
        pAtH: "C:\\Windows\\System32",
        OpenAi_Api_Key: "mixed-case-canary",
        CanArY_SeCrEt: "arbitrary-canary",
      },
      "win32",
    );

    expect(spec.env.PATH).toBe("C:\\Windows\\System32");
    expect(JSON.stringify(spec.env)).not.toContain("canary");
    expect(spec.env).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("keeps allowlist matching exact-case strict on POSIX", () => {
    const spec = createHermesGatewaySpawnSpec(paths, { Path: "/canary/bin" }, "darwin");

    expect(spec.env).not.toHaveProperty("PATH");
    expect(JSON.stringify(spec.env)).not.toContain("canary");
  });
});
