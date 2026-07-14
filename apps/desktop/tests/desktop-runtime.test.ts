import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialStore } from "@opentrad/model-providers";
import { load } from "js-yaml";
import { describe, expect, it, vi } from "vitest";
import { createDesktopRuntime } from "../src/main/services/desktop-runtime";
import type { HermesSidecarManagerOptions } from "../src/main/services/hermes/sidecar-manager";
import type { HermesRuntimeManagerPort } from "../src/main/services/hermes-runtime-adapter";

const credentials: CredentialStore = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
};

describe("desktop runtime selection", () => {
  it("constructs Hermes by default without installing eagerly", () => {
    const installer = { ensureInstalled: vi.fn() };

    const runtime = createDesktopRuntime({
      envRuntime: undefined,
      dataRoot: "/data/opentrad",
      launcherPath: "/app/opentrad_hermes_launcher.py",
      listProfiles: () => [],
      credentials,
      installer,
    });

    expect(runtime?.kind).toBe("hermes");
    expect(installer.ensureInstalled).not.toHaveBeenCalled();
  });

  it("uses legacy only for the exact emergency environment switch", () => {
    for (const envRuntime of ["legacy", "hermes", "invalid", undefined]) {
      const runtime = createDesktopRuntime({
        envRuntime,
        dataRoot: "/data/opentrad",
        launcherPath: "/app/opentrad_hermes_launcher.py",
        listProfiles: () => [],
        credentials,
        installer: { ensureInstalled: vi.fn() },
      });
      expect(runtime?.kind ?? "legacy").toBe(envRuntime === "legacy" ? "legacy" : "hermes");
    }
  });

  it("constructs the production Profile Home initializer from the live listProfiles closure", async () => {
    const root = await mkdtemp(join(tmpdir(), "opentrad-desktop-runtime-"));
    const hermesHome = join(root, "hermes", "profiles", "custom-profile");
    await mkdir(hermesHome, { mode: 0o700, recursive: true });
    await chmod(hermesHome, 0o700);
    const managerOptions: HermesSidecarManagerOptions[] = [];
    const runtime = createDesktopRuntime({
      envRuntime: undefined,
      dataRoot: root,
      launcherPath: "/app/opentrad_hermes_launcher.py",
      listProfiles: () => [customProfile()],
      credentials,
      installer: { ensureInstalled: vi.fn(async () => installedRuntime(root)) },
      networkEnvironment: {
        HTTPS_PROXY: "http://127.0.0.1:7897",
        NO_PROXY: "localhost,127.0.0.1,::1",
      },
      createManager: (options) => {
        managerOptions.push(options);
        return fakeManager();
      },
    });

    try {
      await runtime?.create({
        canonicalSessionId: "canonical-1",
        taskId: "task-1",
        runId: "run-1",
        workspaceRoot: "/workspace/project",
        provider: {
          profileId: "custom-profile",
          providerSlug: "custom:trade-endpoint",
          authMode: "api_key",
          model: "vendor/model-v1",
          apiMode: "chat_completions",
          executionBackend: "local",
        },
      });
      const options = managerOptions[0];
      if (!options) throw new Error("manager was not created");

      expect(options.networkEnvironment).toEqual({
        HTTPS_PROXY: "http://127.0.0.1:7897",
        NO_PROXY: "localhost,127.0.0.1,::1",
      });

      await options.initializeProfileHome(options.binding, { hermesHome });

      expect(load(await readFile(join(hermesHome, "config.yaml"), "utf8"))).toMatchObject({
        model: { default: "vendor/model-v1", provider: "custom:trade-endpoint" },
        providers: {
          "trade-endpoint": {
            api: "https://models.example.test/v1",
            key_env: "OPENTRAD_PROVIDER_API_KEY",
          },
        },
      });
    } finally {
      await runtime?.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });
});

function customProfile(): Record<string, unknown> {
  return {
    id: "custom-profile",
    displayName: "Trade endpoint",
    kind: "openai-compatible",
    baseUrl: "https://models.example.test/v1",
    model: "vendor/model-v1",
    credentialRef: "apikey:custom-profile",
    pricing: null,
    hermes: {
      providerSlug: "custom:trade-endpoint",
      authMode: "api_key",
      apiMode: "chat_completions",
      executionBackend: "local",
    },
  };
}

function installedRuntime(root: string) {
  return {
    runtimeRoot: join(root, "runtimes", "hermes", "0.18.2"),
    pythonExecutable: join(root, "runtimes", "hermes", "0.18.2", "venv", "bin", "python3"),
    bundledSkillsRoot: join(root, "runtimes", "hermes", "0.18.2", "share", "hermes", "skills"),
    version: "0.18.2",
    releaseTag: "v2026.7.7.2",
    didInstall: false,
  } as const;
}

function fakeManager(): HermesRuntimeManagerPort {
  return {
    start: async () => {},
    stop: async () => {},
    request: (async (method: string) => {
      if (method === "session.create") {
        return {
          session_id: "deadbeef",
          stored_session_id: "20260713_123456_abcdef",
          message_count: 0,
          messages: [],
          info: {},
        };
      }
      if (method === "session.close") return { closed: true };
      throw new Error("unexpected request");
    }) as HermesRuntimeManagerPort["request"],
    subscribe: () => () => {},
    onCrash: () => () => {},
  };
}
