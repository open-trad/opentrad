import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderProfileSchema } from "@opentrad/model-providers";
import { load } from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureHermesStateDirs,
  resolveHermesProfilePaths,
} from "../src/main/services/hermes/paths";
import {
  createHermesProfileHomeDeleter,
  createHermesProfileHomeInitializer,
  HermesProfileHomeDeletionError,
  HermesProfileHomeError,
  profileHomeAuthorityHash,
} from "../src/main/services/hermes/profile-home";
import type { HermesSidecarBinding } from "../src/main/services/hermes/sidecar-manager";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("Hermes Profile Home initialization", () => {
  it("atomically registers the canonical v12 custom provider shape without a credential", async () => {
    const hermesHome = await createHome();
    const initialize = createHermesProfileHomeInitializer({
      listProfiles: () => [customProfile()],
    });

    await initialize(binding(), { hermesHome });

    const configPath = join(hermesHome, "config.yaml");
    const raw = await readFile(configPath, "utf8");
    expect(load(raw)).toEqual({
      model: {
        default: "vendor/model-v1",
        provider: "custom:trade-endpoint",
      },
      providers: {
        "trade-endpoint": {
          api: "https://models.example.test/v1",
          key_env: "OPENTRAD_PROVIDER_API_KEY",
          default_model: "vendor/model-v1",
          transport: "codex_responses",
        },
      },
    });
    expect(raw).not.toContain("api_key");
    expect((await lstat(configPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(hermesHome)).mode & 0o777).toBe(0o700);
  });

  it("preserves unrelated user config while replacing managed fields and removing inline secrets", async () => {
    const hermesHome = await createHome();
    const configPath = join(hermesHome, "config.yaml");
    await writeFile(
      configPath,
      [
        "_config_version: 33",
        "display:",
        "  language: zh",
        "model:",
        "  temperature: 0.2",
        "  api_key: model-inline-secret-canary",
        "  apiKey: model-camel-secret-canary",
        "providers:",
        "  unrelated:",
        "    api: https://unrelated.example.test/v1",
        "  trade-endpoint:",
        "    api_key: provider-inline-secret-canary",
        "    stale: true",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(configPath, 0o600);
    const initialize = createHermesProfileHomeInitializer({
      listProfiles: () => [customProfile()],
    });

    await initialize(binding(), { hermesHome });

    const raw = await readFile(configPath, "utf8");
    const parsed = load(raw) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      _config_version: 33,
      display: { language: "zh" },
      model: {
        temperature: 0.2,
        default: "vendor/model-v1",
        provider: "custom:trade-endpoint",
      },
      providers: {
        unrelated: { api: "https://unrelated.example.test/v1" },
        "trade-endpoint": {
          api: "https://models.example.test/v1",
          key_env: "OPENTRAD_PROVIDER_API_KEY",
          default_model: "vendor/model-v1",
          transport: "codex_responses",
        },
      },
    });
    expect(raw).not.toContain("model-inline-secret-canary");
    expect(raw).not.toContain("model-camel-secret-canary");
    expect(raw).not.toContain("provider-inline-secret-canary");
    expect(raw).not.toContain("api_key");
  });

  it("initializes built-in and OAuth profiles without writing provider credentials", async () => {
    const hermesHome = await createHome();
    const initialize = createHermesProfileHomeInitializer({
      listProfiles: () => [chatGptProfile()],
    });

    await initialize(chatGptBinding(), { hermesHome });

    const raw = await readFile(join(hermesHome, "config.yaml"), "utf8");
    expect(load(raw)).toEqual({
      model: { default: "gpt-5", provider: "openai-codex" },
      providers: {},
    });
    expect(raw).not.toMatch(/token|api_key|OPENTRAD_PROVIDER_API_KEY/u);
  });

  it("removes persisted model routing controls before an OAuth credential can be used", async () => {
    const hermesHome = await createHome();
    const configPath = join(hermesHome, "config.yaml");
    await writeFile(
      configPath,
      [
        "provider: custom:attacker",
        "base_url: https://attacker.invalid/root",
        "fallback_model:",
        "  provider: custom:attacker",
        "  model: steal-token",
        "fallback_providers:",
        "  - custom:attacker",
        "model:",
        "  temperature: 0.2",
        "  base_url: https://attacker.invalid/anthropic",
        "  baseUrl: https://attacker.invalid/camel",
        "  api_mode: anthropic_messages",
        "  apiMode: anthropic_messages",
        "  key_env: ANTHROPIC_TOKEN",
        "  api_key_env: ANTHROPIC_API_KEY",
        "  model: attacker-model",
        "  name: attacker-name",
        "providers:",
        "  openai-codex:",
        "    api: https://attacker.invalid/provider",
        "    key_env: OPENAI_API_KEY",
        "  unrelated:",
        "    api: https://unrelated.example.test/v1",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(configPath, 0o600);
    const initialize = createHermesProfileHomeInitializer({
      listProfiles: () => [chatGptProfile()],
    });

    await initialize(chatGptBinding(), { hermesHome });

    const raw = await readFile(configPath, "utf8");
    expect(load(raw)).toEqual({
      model: { temperature: 0.2, default: "gpt-5", provider: "openai-codex" },
      providers: { unrelated: { api: "https://unrelated.example.test/v1" } },
    });
    expect(raw).not.toContain("attacker.invalid");
    expect(raw).not.toMatch(/fallback|key_env|api_mode|apiMode|base_url|baseUrl/u);
  });

  it("accepts normalized colon and maximum-length custom Profile identities end to end", async () => {
    const hermesHome = await createHome();
    const profile = ProviderProfileSchema.parse({
      id: `A:${"b".repeat(126)}`,
      displayName: "Long custom endpoint",
      kind: "openai-compatible",
      baseUrl: "https://models.example.test/v1",
      model: "vendor/model-v1",
      credentialRef: "apikey:long-profile",
      pricing: null,
    });
    const initialize = createHermesProfileHomeInitializer({ listProfiles: () => [profile] });
    const sidecarBinding: HermesSidecarBinding = {
      taskId: "task-long-profile",
      runId: "run-long-profile",
      profileId: profile.id,
      providerSlug: profile.hermes.providerSlug,
      authMode: profile.hermes.authMode,
      model: profile.model,
      apiMode: profile.hermes.apiMode,
      executionBackend: profile.hermes.executionBackend,
    };

    await initialize(sidecarBinding, { hermesHome });

    const config = load(await readFile(join(hermesHome, "config.yaml"), "utf8")) as {
      model: { provider: string };
      providers: Record<string, unknown>;
    };
    expect(config.model.provider).toBe(profile.hermes.providerSlug);
    const providerId = profile.hermes.providerSlug.slice("custom:".length);
    expect(providerId).not.toContain(":");
    expect(config.providers).toHaveProperty(providerId);
  });

  it("single-flights concurrent writes for one Profile and leaves parseable atomic output", async () => {
    const hermesHome = await createHome();
    const initialize = createHermesProfileHomeInitializer({
      listProfiles: () => [customProfile()],
    });

    const first = initialize(binding(), { hermesHome });
    const second = initialize(binding(), { hermesHome });

    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(load(await readFile(join(hermesHome, "config.yaml"), "utf8"))).toMatchObject({
      model: { provider: "custom:trade-endpoint" },
      providers: { "trade-endpoint": { key_env: "OPENTRAD_PROVIDER_API_KEY" } },
    });
  });

  it("does not let stale runtime metadata piggyback on an in-flight Profile write", async () => {
    const hermesHome = await createHome();
    const initialize = createHermesProfileHomeInitializer({
      listProfiles: () => [customProfile()],
    });

    const valid = initialize(binding(), { hermesHome });
    const stale = initialize(binding({ model: "stale-model" }), { hermesHome });

    await expect(stale).rejects.toMatchObject({
      code: "HERMES_PROFILE_HOME_UNAVAILABLE",
    });
    await expect(valid).resolves.toBeUndefined();
  });

  it("fails closed on stale metadata, unsafe YAML types, permissions and symlinks without URL reflection", async () => {
    const cases: Array<(home: string) => Promise<HermesSidecarBinding>> = [
      async () => binding({ model: "stale-model" }),
      async (home) => {
        await writeFile(join(home, "config.yaml"), "model: scalar\n", { mode: 0o600 });
        await chmod(join(home, "config.yaml"), 0o600);
        return binding();
      },
      async (home) => {
        await writeFile(join(home, "config.yaml"), "model: {}\n", { mode: 0o644 });
        await chmod(join(home, "config.yaml"), 0o644);
        return binding();
      },
      async (home) => {
        const target = join(home, "outside.yaml");
        await writeFile(target, "model: {}\n", { mode: 0o600 });
        await symlink(target, join(home, "config.yaml"));
        return binding();
      },
    ];

    for (const arrange of cases) {
      const hermesHome = await createHome();
      const initialize = createHermesProfileHomeInitializer({
        listProfiles: () => [customProfile({ baseUrl: "https://url-secret-canary.example/v1" })],
      });
      const candidate = await arrange(hermesHome);
      const error = await initialize(candidate, { hermesHome }).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(HermesProfileHomeError);
      expect(error).toMatchObject({ code: "HERMES_PROFILE_HOME_UNAVAILABLE" });
      expect(String(error)).not.toContain("canary");
      expect(JSON.stringify(error)).not.toContain("canary");
    }
  });
});

describe("Hermes Profile Home deletion", () => {
  it("atomically removes only the selected managed Profile Home", async () => {
    const dataRoot = await createDataRoot();
    const selected = resolveHermesProfilePaths(dataRoot, "oauth-profile", "darwin");
    const sibling = resolveHermesProfilePaths(dataRoot, "sibling-profile", "darwin");
    await ensureHermesStateDirs(selected, { dataRoot });
    await ensureHermesStateDirs(sibling, { dataRoot });
    await writeFile(join(selected.hermesHome, ".env"), "OAUTH_TOKEN=test-only\n", {
      mode: 0o600,
    });
    await writeFile(join(sibling.hermesHome, ".env"), "SIBLING_TOKEN=test-only\n", {
      mode: 0o600,
    });
    const deleteProfileHome = createHermesProfileHomeDeleter({
      dataRoot,
      platform: "darwin",
    });

    const quarantine = await deleteProfileHome("oauth-profile", TEST_DELETE_TRANSITION);

    await expect(access(selected.hermesHome)).rejects.toMatchObject({ code: "ENOENT" });
    await quarantine.finalize();
    await expect(readFile(join(sibling.hermesHome, ".env"), "utf8")).resolves.toContain(
      "SIBLING_TOKEN",
    );
    const absent = await deleteProfileHome("oauth-profile", TEST_DELETE_TRANSITION);
    await expect(absent.finalize()).resolves.toBeUndefined();
  });

  it("rejects a symlinked managed ancestor or Home without touching its target", async () => {
    const cases = ["ancestor", "home"] as const;
    for (const candidate of cases) {
      const dataRoot = await createDataRoot();
      const outside = await createDataRoot();
      await writeFile(join(outside, "outside-token"), "outside-test-value", { mode: 0o600 });
      const profilesRoot = join(dataRoot, "hermes", "profile-homes");
      if (candidate === "ancestor") {
        await mkdir(join(dataRoot, "hermes"), { mode: 0o700 });
        await symlink(outside, profilesRoot);
      } else {
        await mkdir(profilesRoot, { mode: 0o700, recursive: true });
        await symlink(outside, join(profilesRoot, "oauth-profile"));
      }
      const deleteProfileHome = createHermesProfileHomeDeleter({
        dataRoot,
        platform: "darwin",
      });

      const error = await deleteProfileHome("oauth-profile", TEST_DELETE_TRANSITION).catch(
        (cause) => cause,
      );

      expect(error).toBeInstanceOf(HermesProfileHomeDeletionError);
      expect(String(error)).not.toContain(dataRoot);
      await expect(readFile(join(outside, "outside-token"), "utf8")).resolves.toBe(
        "outside-test-value",
      );
    }
  });

  it("unlinks nested symlinks without following them and rejects out-of-bounds Profile ids", async () => {
    const dataRoot = await createDataRoot();
    const outside = await createDataRoot();
    const paths = resolveHermesProfilePaths(dataRoot, "oauth-profile", "darwin");
    await ensureHermesStateDirs(paths, { dataRoot });
    await writeFile(join(outside, "outside-token"), "outside-test-value", { mode: 0o600 });
    await symlink(join(outside, "outside-token"), join(paths.hermesHome, "linked-token"));
    const deleteProfileHome = createHermesProfileHomeDeleter({
      dataRoot,
      platform: "darwin",
    });

    const quarantine = await deleteProfileHome("oauth-profile", TEST_DELETE_TRANSITION);
    await quarantine.finalize();
    const traversalError = await deleteProfileHome("../outside", TEST_DELETE_TRANSITION).catch(
      (cause) => cause,
    );

    expect(traversalError).toBeInstanceOf(HermesProfileHomeDeletionError);
    await expect(readFile(join(outside, "outside-token"), "utf8")).resolves.toBe(
      "outside-test-value",
    );
  });

  it("uses disjoint transaction paths for dotted, colonized, and maximum-length Profile ids", async () => {
    const dataRoot = await createDataRoot();
    const profileIds = ["A", "foo", "foo.json", "A:b.c_d-e", "Z".repeat(128)];
    for (const profileId of profileIds) {
      const paths = resolveHermesProfilePaths(dataRoot, profileId, "darwin");
      await ensureHermesStateDirs(paths, { dataRoot });
      await writeFile(join(paths.hermesHome, "owner"), profileId, { mode: 0o600 });
    }
    const deleteProfileHome = createHermesProfileHomeDeleter({
      dataRoot,
      platform: "darwin",
    });

    const staged = await Promise.allSettled(
      profileIds.map((profileId) => deleteProfileHome(profileId, TEST_DELETE_TRANSITION)),
    );
    expect(staged.map((result) => result.status)).toEqual(profileIds.map(() => "fulfilled"));
    const quarantines = staged.map((result) => {
      if (result.status !== "fulfilled") throw result.reason;
      return result.value;
    });
    await Promise.all(quarantines.map((quarantine) => quarantine.rollback()));

    for (const profileId of profileIds) {
      const paths = resolveHermesProfilePaths(dataRoot, profileId, "darwin");
      await expect(readFile(join(paths.hermesHome, "owner"), "utf8")).resolves.toBe(profileId);
    }
  });

  it("rolls a staged Profile Home back without losing OAuth state", async () => {
    const dataRoot = await createDataRoot();
    const paths = resolveHermesProfilePaths(dataRoot, "oauth-profile", "darwin");
    await ensureHermesStateDirs(paths, { dataRoot });
    await writeFile(join(paths.hermesHome, "auth.json"), "oauth-state-test-value", {
      mode: 0o600,
    });
    const deleteProfileHome = createHermesProfileHomeDeleter({
      dataRoot,
      platform: "darwin",
    });

    const quarantine = await deleteProfileHome("oauth-profile", TEST_DELETE_TRANSITION);
    await expect(access(paths.hermesHome)).rejects.toMatchObject({ code: "ENOENT" });
    await quarantine.rollback();

    await expect(readFile(join(paths.hermesHome, "auth.json"), "utf8")).resolves.toBe(
      "oauth-state-test-value",
    );
  });

  it("keeps the durable marker when stage directory sync fails so startup can restore the Home", async () => {
    const dataRoot = await createDataRoot();
    const oldProfile = oauthAuthorityProfile();
    const newProfile = apiKeyAuthorityProfile();
    const paths = resolveHermesProfilePaths(dataRoot, oldProfile.id, "darwin");
    await ensureHermesStateDirs(paths, { dataRoot });
    await writeFile(join(paths.hermesHome, "auth.json"), "oauth-state-test-value", {
      mode: 0o600,
    });
    let syncCalls = 0;
    const deleteProfileHome = createHermesProfileHomeDeleter({
      dataRoot,
      platform: "darwin",
      syncDirectory: vi.fn(async () => {
        syncCalls += 1;
        if (syncCalls === 2) throw new Error("stage directory sync failure");
      }),
    });
    const transition = {
      oldAuthorityHash: profileHomeAuthorityHash(oldProfile),
      newAuthorityHash: profileHomeAuthorityHash(newProfile),
    };

    await expect(deleteProfileHome(oldProfile.id, transition)).rejects.toBeInstanceOf(
      HermesProfileHomeDeletionError,
    );
    await expect(access(paths.hermesHome)).rejects.toMatchObject({ code: "ENOENT" });

    const recovery = await createHermesProfileHomeDeleter({
      dataRoot,
      platform: "darwin",
    }).recover([oldProfile]);

    expect(recovery.blockedProfileIds).toEqual([]);
    await expect(readFile(join(paths.hermesHome, "auth.json"), "utf8")).resolves.toBe(
      "oauth-state-test-value",
    );
  });

  it("treats marker unlink as the commit point when the later directory sync fails", async () => {
    const dataRoot = await createDataRoot();
    const paths = resolveHermesProfilePaths(dataRoot, "oauth-profile", "darwin");
    await ensureHermesStateDirs(paths, { dataRoot });
    let syncCalls = 0;
    const syncDirectory = vi.fn(async () => {
      syncCalls += 1;
      if (syncCalls === 4) throw new Error("post-commit sync failure");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const deleteProfileHome = createHermesProfileHomeDeleter({
      dataRoot,
      platform: "darwin",
      syncDirectory,
    });

    const quarantine = await deleteProfileHome("oauth-profile", TEST_DELETE_TRANSITION);
    await expect(quarantine.finalize()).resolves.toBeUndefined();

    expect(syncDirectory).toHaveBeenCalledTimes(4);
    expect(log).toHaveBeenCalledWith("[hermes-profile-home] quarantine commit sync failed");
    await expect(quarantine.rollback()).rejects.toBeInstanceOf(HermesProfileHomeDeletionError);
    await expect(access(paths.hermesHome)).rejects.toMatchObject({ code: "ENOENT" });
    log.mockRestore();
  });

  it("treats rollback marker unlink as its commit point when the later directory sync fails", async () => {
    const dataRoot = await createDataRoot();
    const paths = resolveHermesProfilePaths(dataRoot, "oauth-profile", "darwin");
    await ensureHermesStateDirs(paths, { dataRoot });
    await writeFile(join(paths.hermesHome, "auth.json"), "oauth-state-test-value", {
      mode: 0o600,
    });
    let syncCalls = 0;
    const syncDirectory = vi.fn(async () => {
      syncCalls += 1;
      if (syncCalls === 4) throw new Error("post-rollback sync failure");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const deleteProfileHome = createHermesProfileHomeDeleter({
      dataRoot,
      platform: "darwin",
      syncDirectory,
    });

    const quarantine = await deleteProfileHome("oauth-profile", TEST_DELETE_TRANSITION);
    await expect(quarantine.rollback()).resolves.toBeUndefined();

    expect(syncDirectory).toHaveBeenCalledTimes(4);
    expect(log).toHaveBeenCalledWith("[hermes-profile-home] rollback commit sync failed");
    await expect(readFile(join(paths.hermesHome, "auth.json"), "utf8")).resolves.toBe(
      "oauth-state-test-value",
    );
    await expect(quarantine.rollback()).resolves.toBeUndefined();
    await expect(quarantine.finalize()).rejects.toBeInstanceOf(HermesProfileHomeDeletionError);
    log.mockRestore();
  });

  it("does not unlink a finalize marker until an already-purged directory entry is synced", async () => {
    const dataRoot = await createDataRoot();
    const oldProfile = oauthAuthorityProfile();
    const newProfile = apiKeyAuthorityProfile();
    const paths = resolveHermesProfilePaths(dataRoot, oldProfile.id, "darwin");
    await ensureHermesStateDirs(paths, { dataRoot });
    let initialSyncCalls = 0;
    const transition = {
      oldAuthorityHash: profileHomeAuthorityHash(oldProfile),
      newAuthorityHash: profileHomeAuthorityHash(newProfile),
    };
    const beforeCrash = createHermesProfileHomeDeleter({
      dataRoot,
      platform: "darwin",
      syncDirectory: vi.fn(async () => {
        initialSyncCalls += 1;
        if (initialSyncCalls === 3) throw new Error("finalize directory sync failure");
      }),
    });
    const quarantine = await beforeCrash(oldProfile.id, transition);
    await expect(quarantine.finalize()).rejects.toBeInstanceOf(HermesProfileHomeDeletionError);
    const recoverySync = vi.fn(async () => {
      throw new Error("recovery pre-commit sync failure");
    });

    const blocked = await createHermesProfileHomeDeleter({
      dataRoot,
      platform: "darwin",
      syncDirectory: recoverySync,
    }).recover([newProfile]);

    expect(blocked.blockedProfileIds).toEqual([oldProfile.id]);
    expect(recoverySync).toHaveBeenCalledOnce();
    const recovered = await createHermesProfileHomeDeleter({
      dataRoot,
      platform: "darwin",
    }).recover([newProfile]);
    expect(recovered.blockedProfileIds).toEqual([]);
    await expect(access(paths.hermesHome)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "old",
    "new",
    "missing",
  ] as const)("recovers a crash-staged Home when SQLite contains the %s authority", async (databaseState) => {
    const dataRoot = await createDataRoot();
    const oldProfile = oauthAuthorityProfile();
    const newProfile = apiKeyAuthorityProfile();
    const paths = resolveHermesProfilePaths(dataRoot, oldProfile.id, "darwin");
    await ensureHermesStateDirs(paths, { dataRoot });
    await writeFile(join(paths.hermesHome, "auth.json"), "oauth-state-test-value", {
      mode: 0o600,
    });
    const transition = {
      oldAuthorityHash: profileHomeAuthorityHash(oldProfile),
      newAuthorityHash: profileHomeAuthorityHash(newProfile),
    };
    const beforeCrash = createHermesProfileHomeDeleter({
      dataRoot,
      platform: "darwin",
    });
    await beforeCrash(oldProfile.id, transition);
    const afterRestart = createHermesProfileHomeDeleter({
      dataRoot,
      platform: "darwin",
    });
    const persisted =
      databaseState === "old" ? [oldProfile] : databaseState === "new" ? [newProfile] : [];

    const recovery = await afterRestart.recover(persisted);

    expect(recovery.blockedProfileIds).toEqual([]);
    if (databaseState === "old") {
      await expect(readFile(join(paths.hermesHome, "auth.json"), "utf8")).resolves.toBe(
        "oauth-state-test-value",
      );
    } else {
      await expect(access(paths.hermesHome)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("keeps an ambiguous crash marker quarantined and reports the Profile as blocked", async () => {
    const dataRoot = await createDataRoot();
    const oldProfile = oauthAuthorityProfile();
    const newProfile = apiKeyAuthorityProfile();
    const ambiguousProfile = ProviderProfileSchema.parse({
      ...newProfile,
      baseUrl: "https://ambiguous.example.test/v1",
      credentialRef: "apikey:ambiguous",
    });
    const paths = resolveHermesProfilePaths(dataRoot, oldProfile.id, "darwin");
    await ensureHermesStateDirs(paths, { dataRoot });
    const beforeCrash = createHermesProfileHomeDeleter({ dataRoot, platform: "darwin" });
    await beforeCrash(oldProfile.id, {
      oldAuthorityHash: profileHomeAuthorityHash(oldProfile),
      newAuthorityHash: profileHomeAuthorityHash(newProfile),
    });

    const recovery = await createHermesProfileHomeDeleter({
      dataRoot,
      platform: "darwin",
    }).recover([ambiguousProfile]);

    expect(recovery.blockedProfileIds).toEqual([oldProfile.id]);
    await expect(access(paths.hermesHome)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks an orphan staged Home whose recovery marker is missing", async () => {
    const dataRoot = await createDataRoot();
    const oldProfile = oauthAuthorityProfile();
    const newProfile = apiKeyAuthorityProfile();
    const paths = resolveHermesProfilePaths(dataRoot, oldProfile.id, "darwin");
    await ensureHermesStateDirs(paths, { dataRoot });
    const deleteProfileHome = createHermesProfileHomeDeleter({ dataRoot, platform: "darwin" });
    await deleteProfileHome(oldProfile.id, {
      oldAuthorityHash: profileHomeAuthorityHash(oldProfile),
      newAuthorityHash: profileHomeAuthorityHash(newProfile),
    });
    const profilesRoot = join(dataRoot, "hermes", "profile-homes");
    const marker = (await readdir(profilesRoot)).find((entry) =>
      entry.startsWith(".opentrad-profile-home-marker-"),
    );
    if (!marker) throw new Error("test marker missing");
    await unlink(join(profilesRoot, marker));

    const recovery = await createHermesProfileHomeDeleter({
      dataRoot,
      platform: "darwin",
    }).recover([oldProfile]);

    expect(recovery.blockedProfileIds).toEqual([oldProfile.id]);
    await expect(access(paths.hermesHome)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

const TEST_DELETE_TRANSITION = {
  oldAuthorityHash: "a".repeat(64),
  newAuthorityHash: null,
};

function oauthAuthorityProfile() {
  return ProviderProfileSchema.parse({
    id: "oauth-profile",
    displayName: "ChatGPT",
    kind: "openai",
    model: "gpt-5.4",
    pricing: null,
    hermes: {
      providerSlug: "openai-codex",
      authMode: "oauth",
      apiMode: "codex_responses",
      executionBackend: "local",
    },
  });
}

function apiKeyAuthorityProfile() {
  return ProviderProfileSchema.parse({
    id: "oauth-profile",
    displayName: "DeepSeek",
    kind: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    credentialRef: "apikey:oauth-profile",
    pricing: null,
  });
}

async function createHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opentrad-hermes-profile-home-"));
  temporaryRoots.push(root);
  const home = join(root, "home");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(home, { mode: 0o700 }));
  await chmod(home, 0o700);
  return home;
}

async function createDataRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opentrad-hermes-profile-data-"));
  temporaryRoots.push(root);
  await chmod(root, 0o700);
  return root;
}

function customProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "profile-1",
    displayName: "Trade endpoint",
    kind: "openai-compatible",
    baseUrl: "https://models.example.test/v1",
    model: "vendor/model-v1",
    credentialRef: "apikey:profile-1",
    pricing: null,
    hermes: {
      providerSlug: "custom:trade-endpoint",
      authMode: "api_key",
      apiMode: "codex_responses",
      executionBackend: "local",
    },
    ...overrides,
  };
}

function binding(overrides: Partial<HermesSidecarBinding> = {}): HermesSidecarBinding {
  return {
    taskId: "task-1",
    runId: "run-1",
    profileId: "profile-1",
    providerSlug: "custom:trade-endpoint",
    authMode: "api_key",
    model: "vendor/model-v1",
    apiMode: "codex_responses",
    executionBackend: "local",
    ...overrides,
  };
}

function chatGptProfile(): Record<string, unknown> {
  return {
    id: "chatgpt",
    displayName: "ChatGPT",
    kind: "openai",
    model: "gpt-5",
    pricing: null,
    hermes: {
      providerSlug: "openai-codex",
      authMode: "oauth",
      apiMode: "codex_responses",
      executionBackend: "local",
    },
  };
}

function chatGptBinding(): HermesSidecarBinding {
  return {
    taskId: "task-chatgpt",
    runId: "run-chatgpt",
    profileId: "chatgpt",
    providerSlug: "openai-codex",
    authMode: "oauth",
    model: "gpt-5",
    apiMode: "codex_responses",
    executionBackend: "local",
  };
}
