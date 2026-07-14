import { execFileSync } from "node:child_process";
import type { ProviderProfile } from "@opentrad/model-providers";
import { describe, expect, it } from "vitest";
import {
  createHermesOAuthLoginSpec,
  HermesOAuthLoginError,
} from "../src/main/services/hermes/oauth-login";

describe("Hermes official OAuth login spec", () => {
  it("runs the managed official ChatGPT OAuth command in the isolated Profile Home", () => {
    const spec = createHermesOAuthLoginSpec("/Users/me/.opentrad", oauthProfile(), "darwin", {
      HOME: "/Users/me",
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      OPENAI_API_KEY: "must-not-inherit",
      OPENTRAD_CANARY: "must-not-inherit",
    });

    expect(spec).toEqual({
      command: "/Users/me/.opentrad/runtimes/hermes/0.18.2/venv/bin/python3",
      args: [
        "-I",
        "-B",
        "-u",
        "-X",
        "utf8",
        "-c",
        expect.stringContaining(
          'sys.argv = ["hermes","auth","add","openai-codex","--type","oauth"]',
        ),
      ],
      cwd: "/Users/me/.opentrad/hermes/profile-homes/chatgpt/gateway-cwd",
      env: {
        HOME: "/Users/me",
        PATH: "/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        HERMES_HOME: "/Users/me/.opentrad/hermes/profile-homes/chatgpt",
        GH_CONFIG_DIR: "/Users/me/.opentrad/hermes/profile-homes/chatgpt/gh-config",
        XDG_CONFIG_HOME: "/Users/me/.opentrad/hermes/profile-homes/chatgpt/xdg-config",
        COPILOT_GH_HOST: expect.stringMatching(/^[a-f0-9]{24}\.opentrad\.invalid$/),
        CODEX_HOME: "/Users/me/.opentrad/hermes/profile-homes/chatgpt/codex-home",
      },
      profileId: "chatgpt",
      hermesHome: "/Users/me/.opentrad/hermes/profile-homes/chatgpt",
    });
    expect(JSON.stringify(spec)).not.toContain("must-not-inherit");
  });

  it("passes a trusted proxy snapshot to the official OAuth command without inheriting host proxies", () => {
    const spec = createHermesOAuthLoginSpec(
      "/Users/me/.opentrad",
      oauthProfile(),
      "darwin",
      {
        HOME: "/Users/me",
        HTTPS_PROXY: "http://proxy-canary.invalid:4444",
      },
      {
        HTTP_PROXY: "http://127.0.0.1:7897",
        HTTPS_PROXY: "http://127.0.0.1:7897",
        NO_PROXY: "localhost,127.0.0.1,::1",
      },
    );

    expect(spec.env).toMatchObject({
      HTTP_PROXY: "http://127.0.0.1:7897",
      HTTPS_PROXY: "http://127.0.0.1:7897",
      NO_PROXY: "localhost,127.0.0.1,::1",
    });
    expect(JSON.stringify(spec)).not.toContain("proxy-canary.invalid");
  });

  it("uses the fixed official Nous OAuth command and isolated metadata tuple", () => {
    const spec = createHermesOAuthLoginSpec(
      "/Users/me/.opentrad",
      {
        ...oauthProfile({ providerSlug: "nous", apiMode: "chat_completions" }),
        model: "anthropic/claude-fable-5",
      },
      "darwin",
      {},
    );

    expect(spec.command).toBe("/Users/me/.opentrad/runtimes/hermes/0.18.2/venv/bin/python3");
    expect(spec.args.slice(0, 6)).toEqual(["-I", "-B", "-u", "-X", "utf8", "-c"]);
    expect(spec.args[6]).toContain('sys.argv = ["hermes","auth","add","nous","--type","oauth"]');
    expect(spec.hermesHome).toBe("/Users/me/.opentrad/hermes/profile-homes/chatgpt");
  });

  it("uses the fixed official Anthropic OAuth command for migrated Claude subscriptions", () => {
    const spec = createHermesOAuthLoginSpec(
      "/Users/me/.opentrad",
      {
        ...oauthProfile({ providerSlug: "anthropic", apiMode: "chat_completions" }),
        kind: "claude-subscription",
        model: "claude-sonnet-5",
      },
      "darwin",
      {},
    );

    expect(spec.args.slice(0, 6)).toEqual(["-I", "-B", "-u", "-X", "utf8", "-c"]);
    const source = spec.args[6];
    expect(source).toContain("from agent import anthropic_adapter");
    expect(source).toContain("read_claude_code_credentials = _opentrad_no_external");
    expect(source).toContain("hermes_cli.main import main");
    expect(source).toContain('auth", "add", "anthropic", "--type", "oauth');
    expect(source).not.toContain("accessToken");
    expect(source).not.toContain("Claude Code-credentials");
  });

  it("uses the fixed upstream Copilot device-code entry without exposing its token", () => {
    const spec = createHermesOAuthLoginSpec(
      "/Users/me/.opentrad",
      oauthProfile({ providerSlug: "copilot", apiMode: "codex_responses" }),
      "darwin",
      {},
    );

    expect(spec.command).toBe("/Users/me/.opentrad/runtimes/hermes/0.18.2/venv/bin/python3");
    expect(spec.args.slice(0, 6)).toEqual(["-I", "-B", "-u", "-X", "utf8", "-c"]);
    const source = spec.args[6];
    expect(source).toContain("from hermes_cli.copilot_auth import copilot_device_code_login");
    expect(source).toContain('save_env_value("COPILOT_GITHUB_TOKEN", token)');
    expect(source).not.toContain("print(token");
    expect(spec.env).not.toHaveProperty("COPILOT_GITHUB_TOKEN");
  });

  it("restores fixed Profile controls after every official CLI dotenv load", () => {
    const profiles: ProviderProfile[] = [
      oauthProfile(),
      {
        ...oauthProfile({ providerSlug: "nous", apiMode: "chat_completions" }),
        model: "anthropic/claude-fable-5",
      },
      {
        ...oauthProfile({ providerSlug: "anthropic", apiMode: "chat_completions" }),
        kind: "claude-subscription",
        model: "claude-sonnet-5",
      },
      oauthProfile({ providerSlug: "copilot", apiMode: "codex_responses" }),
    ];

    for (const profile of profiles) {
      const spec = createHermesOAuthLoginSpec("/Users/me/.opentrad", profile, "darwin", {});
      const source = spec.args[6];
      expect(spec.args.slice(0, 6)).toEqual(["-I", "-B", "-u", "-X", "utf8", "-c"]);
      expect(source).toContain("_opentrad_fixed = dict(os.environ)");
      expect(source).toContain("_opentrad_env_loader.load_hermes_dotenv = _opentrad_load");
      expect(source).toContain("target.update(_opentrad_fixed)");
      expect(source).toContain("HERMES_PROFILE");
      expect(source).toContain("NODE_OPTIONS");
      expect(source).toContain("TERMINAL_");
      expect(source).not.toContain("must-not-inherit");
    }
  });

  it("executes the shared CLI guard without accepting dotenv control overrides", () => {
    const source = createHermesOAuthLoginSpec("/Users/me/.opentrad", oauthProfile(), "darwin", {})
      .args[6];
    const harness = [
      "import os, sys, types",
      'package = types.ModuleType("hermes_cli")',
      "package.__path__ = []",
      'env_loader = types.ModuleType("hermes_cli.env_loader")',
      "def load_hermes_dotenv(*args, **kwargs):",
      '    os.environ["HERMES_HOME"] = "/attacker/home"',
      '    os.environ["CODEX_HOME"] = "/attacker/codex"',
      '    os.environ["GH_CONFIG_DIR"] = "/attacker/gh"',
      '    os.environ["XDG_CONFIG_HOME"] = "/attacker/xdg"',
      '    os.environ["COPILOT_GH_HOST"] = "github.com"',
      '    os.environ["HOME"] = "/attacker/host-home"',
      '    os.environ["PATH"] = "/attacker/bin"',
      '    os.environ["HERMES_PROFILE"] = "host-profile"',
      '    os.environ["NODE_OPTIONS"] = "--require=/attacker.js"',
      '    os.environ["HTTPS_PROXY"] = "http://attacker.invalid:4444"',
      '    os.environ["https_proxy"] = "http://attacker.invalid:5555"',
      '    os.environ["SSL_CERT_FILE"] = "/attacker/ca.pem"',
      '    os.environ["SSL_CERT_DIR"] = "/attacker/ca-dir"',
      '    os.environ["REQUESTS_CA_BUNDLE"] = "/attacker/requests-ca.pem"',
      '    os.environ["CURL_CA_BUNDLE"] = "/attacker/curl-ca.pem"',
      '    os.environ["NODE_EXTRA_CA_CERTS"] = "/attacker/node-ca.pem"',
      '    os.environ["OPENSSL_CONF"] = "/attacker/openssl.cnf"',
      '    os.environ["SSLKEYLOGFILE"] = "/attacker/tls-keys.log"',
      '    os.environ["ANTHROPIC_BASE_URL"] = "https://attacker.invalid/anthropic"',
      '    os.environ["COPILOT_API_BASE_URL"] = "https://attacker.invalid/copilot"',
      '    os.environ["NOUS_PORTAL_BASE_URL"] = "https://attacker.invalid/oauth"',
      '    os.environ["NOUS_INFERENCE_BASE_URL"] = "https://attacker.invalid/inference"',
      '    os.environ["TERMINAL_DOCKER_IMAGE"] = "attacker/image"',
      '    os.environ["HERMES_LANGFUSE_SECRET_KEY"] = "tool-secret"',
      '    os.environ["NODE_AUTH_TOKEN"] = "registry-secret"',
      "    return []",
      "env_loader.load_hermes_dotenv = load_hermes_dotenv",
      "package.env_loader = env_loader",
      'main_module = types.ModuleType("hermes_cli.main")',
      "def main():",
      "    env_loader.load_hermes_dotenv()",
      '    assert os.environ["HERMES_HOME"] == "/profile/home"',
      '    assert os.environ["CODEX_HOME"] == "/profile/home/codex-home"',
      '    assert os.environ["GH_CONFIG_DIR"] == "/profile/home/gh-config"',
      '    assert os.environ["XDG_CONFIG_HOME"] == "/profile/home/xdg-config"',
      '    assert os.environ["COPILOT_GH_HOST"] == "profile.opentrad.invalid"',
      '    assert os.environ["HOME"] == "/host/home"',
      '    assert "HERMES_PROFILE" not in os.environ',
      '    assert "NODE_OPTIONS" not in os.environ',
      '    assert os.environ["HTTPS_PROXY"] == "http://127.0.0.1:7897"',
      '    assert "https_proxy" not in os.environ',
      '    assert "SSL_CERT_FILE" not in os.environ',
      '    assert "SSL_CERT_DIR" not in os.environ',
      '    assert "REQUESTS_CA_BUNDLE" not in os.environ',
      '    assert "CURL_CA_BUNDLE" not in os.environ',
      '    assert "NODE_EXTRA_CA_CERTS" not in os.environ',
      '    assert "OPENSSL_CONF" not in os.environ',
      '    assert "SSLKEYLOGFILE" not in os.environ',
      '    assert "ANTHROPIC_BASE_URL" not in os.environ',
      '    assert "COPILOT_API_BASE_URL" not in os.environ',
      '    assert "NOUS_PORTAL_BASE_URL" not in os.environ',
      '    assert "NOUS_INFERENCE_BASE_URL" not in os.environ',
      '    assert "TERMINAL_DOCKER_IMAGE" not in os.environ',
      '    assert os.environ["HERMES_LANGFUSE_SECRET_KEY"] == "tool-secret"',
      '    assert os.environ["NODE_AUTH_TOKEN"] == "registry-secret"',
      '    print("oauth-env-guard-ok")',
      "main_module.main = main",
      'sys.modules["hermes_cli"] = package',
      'sys.modules["hermes_cli.env_loader"] = env_loader',
      'sys.modules["hermes_cli.main"] = main_module',
      `exec(${JSON.stringify(source)})`,
    ].join("\n");

    const output = execFileSync("python3", ["-I", "-S", "-B", "-c", harness], {
      encoding: "utf8",
      env: {
        HOME: "/host/home",
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HERMES_HOME: "/profile/home",
        CODEX_HOME: "/profile/home/codex-home",
        GH_CONFIG_DIR: "/profile/home/gh-config",
        XDG_CONFIG_HOME: "/profile/home/xdg-config",
        COPILOT_GH_HOST: "profile.opentrad.invalid",
        HTTPS_PROXY: "http://127.0.0.1:7897",
        NO_PROXY: "localhost,127.0.0.1,::1",
      },
    });

    expect(output.trim()).toBe("oauth-env-guard-ok");
  });

  it("rejects API-key Profiles, unsupported slugs, and provider-specific metadata mismatches", () => {
    const apiKey = {
      ...oauthProfile(),
      hermes: { ...oauthProfile().hermes, authMode: "api_key" as const },
    };
    const unsupported = {
      ...oauthProfile(),
      hermes: { ...oauthProfile().hermes, providerSlug: "unsupported-oauth" },
    };
    const wrongChatGptMode = oauthProfile({ apiMode: "chat_completions" });
    const wrongNousMode = oauthProfile({ providerSlug: "nous", apiMode: "codex_responses" });
    const wrongChatGptModel = { ...oauthProfile(), model: "gpt-5" };
    const wrongNousModel = {
      ...oauthProfile({ providerSlug: "nous", apiMode: "chat_completions" }),
      model: "gpt-5.4",
    };
    const wrongCopilotModel = {
      ...oauthProfile({ providerSlug: "copilot", apiMode: "codex_responses" }),
      model: "claude-sonnet-5",
    };
    const wrongAnthropicKind = {
      ...oauthProfile({ providerSlug: "anthropic", apiMode: "chat_completions" }),
      kind: "openai" as const,
      model: "claude-sonnet-5",
    };
    const oauthEndpointOverride = {
      ...oauthProfile(),
      baseUrl: "https://attacker.invalid/anthropic",
    };

    for (const profile of [
      apiKey,
      unsupported,
      wrongChatGptMode,
      wrongNousMode,
      wrongChatGptModel,
      wrongNousModel,
      wrongCopilotModel,
      wrongAnthropicKind,
      oauthEndpointOverride,
    ]) {
      expect(() =>
        createHermesOAuthLoginSpec("/Users/me/.opentrad", profile, "darwin", {}),
      ).toThrowError(HermesOAuthLoginError);
    }
  });
});

function oauthProfile(metadata: Partial<ProviderProfile["hermes"]> = {}): ProviderProfile {
  return {
    id: "chatgpt",
    displayName: "ChatGPT",
    kind: "openai",
    model: "gpt-5.4",
    pricing: null,
    hermes: {
      providerSlug: "openai-codex",
      authMode: "oauth",
      apiMode: "codex_responses",
      executionBackend: "local",
      ...metadata,
    },
  };
}
