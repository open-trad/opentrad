import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { link, lstat, open, readdir, rename, rm, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type ProviderProfile, ProviderProfileSchema } from "@opentrad/model-providers";
import { dump, JSON_SCHEMA, load } from "js-yaml";
import { type HermesPaths, type HermesPlatform, resolveHermesProfilePaths } from "./paths";
import type { HermesSidecarBinding } from "./sidecar-manager";

export interface HermesProfileHomeInitializerOptions {
  readonly listProfiles: () => readonly unknown[];
}

export type HermesProfileHomeInitializer = (
  binding: HermesSidecarBinding,
  paths: Pick<HermesPaths, "hermesHome">,
) => Promise<void>;

export interface HermesProfileHomeDeleterOptions {
  readonly dataRoot: string;
  readonly platform: HermesPlatform;
  readonly syncDirectory?: (path: string) => Promise<void>;
}

export interface HermesProfileHomeAuthorityTransition {
  readonly oldAuthorityHash: string;
  readonly newAuthorityHash: string | null;
}

export interface HermesProfileHomeQuarantine {
  finalize(): Promise<void>;
  rollback(): Promise<void>;
}

export interface HermesProfileHomeRecoveryResult {
  readonly blockedProfileIds: readonly string[];
}

export interface HermesProfileHomeDeleter {
  (
    profileId: string,
    transition: HermesProfileHomeAuthorityTransition,
  ): Promise<HermesProfileHomeQuarantine>;
  recover(profiles: readonly unknown[]): Promise<HermesProfileHomeRecoveryResult>;
}

export class HermesProfileHomeError extends Error {
  readonly code = "HERMES_PROFILE_HOME_UNAVAILABLE";

  constructor() {
    super("Hermes Profile Home is unavailable");
    this.name = "HermesProfileHomeError";
  }
}

export class HermesProfileHomeDeletionError extends Error {
  readonly code = "HERMES_PROFILE_HOME_DELETE_FAILED";

  constructor() {
    super("Hermes Profile Home deletion failed");
    this.name = "HermesProfileHomeDeletionError";
  }
}

interface InFlightInitialization {
  readonly hermesHome: string;
  readonly binding: HermesSidecarBinding;
  readonly promise: Promise<void>;
}

interface ExistingConfig {
  readonly config: Record<string, unknown>;
  readonly identity: FileIdentity | undefined;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

const CONFIG_FILE_MODE = 0o600;
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_BASE_URL_LENGTH = 2_048;
const CUSTOM_PROVIDER_PREFIX = "custom:";
const CUSTOM_PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AUTHORITY_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const QUARANTINE_MARKER_VERSION = 1;
const MAX_QUARANTINE_MARKER_BYTES = 4_096;
const QUARANTINE_MARKER_PREFIX = ".opentrad-profile-home-marker-";
const QUARANTINE_MARKER_SUFFIX = ".json";
const QUARANTINE_STAGED_PREFIX = ".opentrad-profile-home-staged-";
const QUARANTINE_PURGE_PREFIX = ".opentrad-profile-home-purge-";
const MODEL_TUNING_FIELDS = new Set([
  "context_length",
  "frequency_penalty",
  "max_completion_tokens",
  "max_tokens",
  "presence_penalty",
  "reasoning_effort",
  "seed",
  "service_tier",
  "stop",
  "temperature",
  "top_k",
  "top_p",
  "verbosity",
]);
const ROOT_ROUTING_FIELDS = new Set([
  "api_base",
  "apiBase",
  "api_key",
  "apiKey",
  "api_key_env",
  "apiKeyEnv",
  "api_mode",
  "apiMode",
  "base_url",
  "baseUrl",
  "custom_providers",
  "customProviders",
  "default_model",
  "defaultModel",
  "fallback_model",
  "fallbackModel",
  "fallback_providers",
  "fallbackProviders",
  "key_env",
  "keyEnv",
  "model_routing",
  "modelRouting",
  "provider",
  "provider_routing",
  "providerRouting",
  "routing",
]);

interface ProfileHomeQuarantineMarker {
  readonly version: typeof QUARANTINE_MARKER_VERSION;
  readonly profileId: string;
  readonly oldAuthorityHash: string;
  readonly newAuthorityHash: string | null;
}

interface ProfileHomeQuarantinePaths {
  readonly dataRoot: string;
  readonly profilesRoot: string;
  readonly hermesHome: string;
  readonly marker: string;
  readonly staged: string;
  readonly purge: string;
  readonly syncDirectory: (path: string) => Promise<void>;
}

export function profileHomeAuthorityHash(profile: ProviderProfile): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        profile.kind,
        profile.baseUrl ?? null,
        profile.credentialRef ?? null,
        profile.hermes.providerSlug,
        profile.hermes.authMode,
        profile.hermes.apiMode,
      ]),
      "utf8",
    )
    .digest("hex");
}

export function createHermesProfileHomeDeleter(
  options: HermesProfileHomeDeleterOptions,
): HermesProfileHomeDeleter {
  let dataRoot: string;
  const platform = options?.platform;
  const syncManagedDirectory = options?.syncDirectory ?? syncDirectory;
  try {
    if (
      typeof options?.dataRoot !== "string" ||
      options.dataRoot.includes("\0") ||
      !isAbsolute(options.dataRoot) ||
      (platform !== "darwin" && platform !== "linux" && platform !== "win32")
    ) {
      throw new Error();
    }
    dataRoot = resolve(options.dataRoot);
  } catch {
    const reject = async (): Promise<HermesProfileHomeQuarantine> => {
      throw new HermesProfileHomeDeletionError();
    };
    return Object.assign(reject, {
      recover: async (profiles: readonly unknown[]) => ({
        blockedProfileIds: persistedProfileIds(profiles),
      }),
    });
  }

  const stage = async (
    profileId: string,
    transition: HermesProfileHomeAuthorityTransition,
  ): Promise<HermesProfileHomeQuarantine> => {
    try {
      const marker = snapshotTransition(profileId, transition);
      const paths = resolveQuarantinePaths(dataRoot, profileId, platform, syncManagedDirectory);
      if (!(await assertManagedAncestors(paths))) return NOOP_PROFILE_HOME_QUARANTINE;
      if (
        (await pathExists(paths.marker)) ||
        (await pathExists(paths.staged)) ||
        (await pathExists(paths.purge))
      ) {
        throw new Error();
      }
      if (!(await pathExists(paths.hermesHome))) return NOOP_PROFILE_HOME_QUARANTINE;
      await assertManagedDirectory(paths.hermesHome, true, false);
      await writeQuarantineMarker(paths, marker);
      // Once the marker is durable it is the recovery authority. A failed rename or directory
      // sync must leave it in place; startup can then resolve the transition from SQLite.
      await rename(paths.hermesHome, paths.staged);
      await paths.syncDirectory(paths.profilesRoot);
      return createQuarantineHandle(paths, marker);
    } catch {
      throw new HermesProfileHomeDeletionError();
    }
  };

  return Object.assign(stage, {
    recover: async (profiles: readonly unknown[]): Promise<HermesProfileHomeRecoveryResult> =>
      recoverQuarantinedProfileHomes(dataRoot, platform, profiles, syncManagedDirectory),
  });
}

const NOOP_PROFILE_HOME_QUARANTINE: HermesProfileHomeQuarantine = Object.freeze({
  finalize: async () => {},
  rollback: async () => {},
});

function snapshotTransition(
  profileId: string,
  transition: HermesProfileHomeAuthorityTransition,
): ProfileHomeQuarantineMarker {
  if (
    !AUTHORITY_HASH_PATTERN.test(transition?.oldAuthorityHash) ||
    (transition.newAuthorityHash !== null &&
      !AUTHORITY_HASH_PATTERN.test(transition.newAuthorityHash))
  ) {
    throw new Error();
  }
  return Object.freeze({
    version: QUARANTINE_MARKER_VERSION,
    profileId,
    oldAuthorityHash: transition.oldAuthorityHash,
    newAuthorityHash: transition.newAuthorityHash,
  });
}

function resolveQuarantinePaths(
  dataRoot: string,
  profileId: string,
  platform: HermesPlatform,
  syncManagedDirectory: (path: string) => Promise<void>,
): ProfileHomeQuarantinePaths {
  const hermesHome = resolveHermesProfilePaths(dataRoot, profileId, platform).hermesHome;
  const profilesRoot = join(dataRoot, "hermes", "profile-homes");
  const normalizedHome = resolve(hermesHome);
  const relativeHome = relative(profilesRoot, normalizedHome);
  if (
    relativeHome !== profileId ||
    relativeHome === ".." ||
    relativeHome.startsWith(`..${sep}`) ||
    isAbsolute(relativeHome)
  ) {
    throw new Error();
  }
  return {
    dataRoot,
    profilesRoot,
    hermesHome: normalizedHome,
    marker: join(profilesRoot, quarantineMarkerName(profileId)),
    staged: join(profilesRoot, `${QUARANTINE_STAGED_PREFIX}${profileId}`),
    purge: join(profilesRoot, `${QUARANTINE_PURGE_PREFIX}${profileId}`),
    syncDirectory: syncManagedDirectory,
  };
}

function quarantineMarkerName(profileId: string): string {
  return `${QUARANTINE_MARKER_PREFIX}${profileId}${QUARANTINE_MARKER_SUFFIX}`;
}

async function assertManagedAncestors(paths: ProfileHomeQuarantinePaths): Promise<boolean> {
  const managedAncestors = [paths.dataRoot, join(paths.dataRoot, "hermes"), paths.profilesRoot];
  for (let index = 0; index < managedAncestors.length; index += 1) {
    const exists = await assertManagedDirectory(managedAncestors[index] ?? "", index > 0);
    if (!exists) return false;
  }
  return true;
}

async function writeQuarantineMarker(
  paths: ProfileHomeQuarantinePaths,
  marker: ProfileHomeQuarantineMarker,
): Promise<void> {
  const temporary = join(paths.profilesRoot, `.opentrad-marker-${process.pid}-${randomUUID()}.tmp`);
  let temporaryExists = false;
  try {
    const handle = await open(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      CONFIG_FILE_MODE,
    );
    temporaryExists = true;
    try {
      await handle.chmod(CONFIG_FILE_MODE);
      await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, paths.marker);
    await unlink(temporary);
    temporaryExists = false;
    await paths.syncDirectory(paths.profilesRoot);
  } finally {
    if (temporaryExists) await unlink(temporary).catch(() => {});
  }
}

function createQuarantineHandle(
  paths: ProfileHomeQuarantinePaths,
  marker: ProfileHomeQuarantineMarker,
): HermesProfileHomeQuarantine {
  let state: "staged" | "finalized" | "rolled_back" = "staged";
  return Object.freeze({
    async finalize(): Promise<void> {
      if (state === "finalized") return;
      if (state !== "staged") throw new HermesProfileHomeDeletionError();
      try {
        await assertManagedAncestors(paths);
        await assertMarkerMatches(paths.marker, marker);
        const homeExists = await pathExists(paths.hermesHome);
        const stagedExists = await pathExists(paths.staged);
        const purgeExists = await pathExists(paths.purge);
        if (homeExists || (stagedExists && purgeExists)) throw new Error();
        if (stagedExists) {
          await assertManagedDirectory(paths.staged, true, false);
          await rename(paths.staged, paths.purge);
        } else if (!purgeExists) {
          throw new Error();
        }
        // Persist the terminal directory layout before removing the recovery authority. This is
        // required even when a prior process already renamed staged -> purge but did not sync it.
        await paths.syncDirectory(paths.profilesRoot);
        await unlink(paths.marker);
        state = "finalized";
        await paths.syncDirectory(paths.profilesRoot).catch(() => {
          console.error("[hermes-profile-home] quarantine commit sync failed");
        });
        await removeQuarantinedTree(paths.purge).catch(() => {
          console.error("[hermes-profile-home] deferred purge failed");
        });
      } catch {
        throw new HermesProfileHomeDeletionError();
      }
    },
    async rollback(): Promise<void> {
      if (state === "rolled_back") return;
      if (state !== "staged") throw new HermesProfileHomeDeletionError();
      try {
        await assertManagedAncestors(paths);
        await assertMarkerMatches(paths.marker, marker);
        const homeExists = await pathExists(paths.hermesHome);
        const stagedExists = await pathExists(paths.staged);
        const purgeExists = await pathExists(paths.purge);
        if (homeExists && (stagedExists || purgeExists)) throw new Error();
        const quarantined = stagedExists ? paths.staged : purgeExists ? paths.purge : undefined;
        if (!homeExists) {
          if (!quarantined) throw new Error();
          await assertManagedDirectory(quarantined, true, false);
          await rename(quarantined, paths.hermesHome);
        }
        // Home must be durable before marker removal can commit the rollback.
        await paths.syncDirectory(paths.profilesRoot);
        await unlink(paths.marker);
        state = "rolled_back";
        await paths.syncDirectory(paths.profilesRoot).catch(() => {
          console.error("[hermes-profile-home] rollback commit sync failed");
        });
      } catch {
        throw new HermesProfileHomeDeletionError();
      }
    },
  });
}

async function recoverQuarantinedProfileHomes(
  dataRoot: string,
  platform: HermesPlatform,
  profiles: readonly unknown[],
  syncManagedDirectory: (path: string) => Promise<void>,
): Promise<HermesProfileHomeRecoveryResult> {
  const authorities = persistedProfileAuthorities(profiles);
  const blocked = new Set<string>();
  const profilesRoot = join(dataRoot, "hermes", "profile-homes");
  try {
    const probe = resolveQuarantinePaths(
      dataRoot,
      "recovery-probe",
      platform,
      syncManagedDirectory,
    );
    if (!(await assertManagedAncestors(probe))) return { blockedProfileIds: [] };
    const entries = await readdir(profilesRoot);
    const entryNames = new Set(entries);
    for (const entry of entries) {
      if (entry.startsWith(QUARANTINE_PURGE_PREFIX)) {
        const profileId = entry.slice(QUARANTINE_PURGE_PREFIX.length);
        if (entryNames.has(quarantineMarkerName(profileId))) continue;
        const purgePath = join(profilesRoot, entry);
        await removeQuarantinedTree(purgePath).catch(() => {
          console.error("[hermes-profile-home] deferred purge failed");
        });
        continue;
      }
      if (entry.startsWith(QUARANTINE_STAGED_PREFIX)) {
        const profileId = entry.slice(QUARANTINE_STAGED_PREFIX.length);
        if (!entryNames.has(quarantineMarkerName(profileId)) && authorities.has(profileId)) {
          blocked.add(profileId);
        }
        continue;
      }
      if (
        !entry.startsWith(QUARANTINE_MARKER_PREFIX) ||
        !entry.endsWith(QUARANTINE_MARKER_SUFFIX)
      ) {
        continue;
      }
      let marker: ProfileHomeQuarantineMarker;
      try {
        marker = await readQuarantineMarker(join(profilesRoot, entry));
        const paths = resolveQuarantinePaths(
          dataRoot,
          marker.profileId,
          platform,
          syncManagedDirectory,
        );
        if (paths.marker !== join(profilesRoot, entry)) throw new Error();
        const handle = createQuarantineHandle(paths, marker);
        const currentAuthority = authorities.get(marker.profileId);
        if (currentAuthority === marker.oldAuthorityHash) {
          await handle.rollback();
        } else if (currentAuthority === undefined || currentAuthority === marker.newAuthorityHash) {
          await handle.finalize();
        } else {
          blocked.add(marker.profileId);
        }
      } catch {
        const candidateId = entry.slice(
          QUARANTINE_MARKER_PREFIX.length,
          -QUARANTINE_MARKER_SUFFIX.length,
        );
        if (authorities.has(candidateId)) blocked.add(candidateId);
        else for (const profileId of authorities.keys()) blocked.add(profileId);
      }
    }
  } catch {
    for (const profileId of authorities.keys()) blocked.add(profileId);
  }
  return { blockedProfileIds: [...blocked] };
}

async function readQuarantineMarker(path: string): Promise<ProfileHomeQuarantineMarker> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size <= 0 ||
      metadata.size > MAX_QUARANTINE_MARKER_BYTES ||
      (metadata.mode & 0o777) !== CONFIG_FILE_MODE
    ) {
      throw new Error();
    }
    assertOwnedByCurrentUser(metadata);
    const parsed = JSON.parse(await handle.readFile("utf8")) as unknown;
    if (!isPlainRecord(parsed) || parsed.version !== QUARANTINE_MARKER_VERSION) throw new Error();
    return snapshotTransition(requireString(parsed.profileId), {
      oldAuthorityHash: requireString(parsed.oldAuthorityHash),
      newAuthorityHash:
        parsed.newAuthorityHash === null ? null : requireString(parsed.newAuthorityHash),
    });
  } finally {
    await handle.close();
  }
}

async function assertMarkerMatches(
  path: string,
  expected: ProfileHomeQuarantineMarker,
): Promise<void> {
  const actual = await readQuarantineMarker(path);
  if (
    actual.profileId !== expected.profileId ||
    actual.oldAuthorityHash !== expected.oldAuthorityHash ||
    actual.newAuthorityHash !== expected.newAuthorityHash
  ) {
    throw new Error();
  }
}

function persistedProfileAuthorities(profiles: readonly unknown[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const raw of profiles) {
    const parsed = ProviderProfileSchema.safeParse(raw);
    if (parsed.success) result.set(parsed.data.id, profileHomeAuthorityHash(parsed.data));
  }
  return result;
}

function persistedProfileIds(profiles: readonly unknown[]): string[] {
  return [...persistedProfileAuthorities(profiles).keys()];
}

async function removeQuarantinedTree(root: string): Promise<void> {
  await assertManagedDirectory(root, true, false);
  // fs.rm unlinks symlinks and special files encountered below this real top-level directory;
  // it does not follow them outside the quarantined tree.
  await rm(root, { force: false, maxRetries: 2, recursive: true });
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertManagedDirectory(
  path: string,
  requirePrivatePermissions: boolean,
  allowMissing = true,
): Promise<boolean> {
  let metadata: Stats;
  try {
    metadata = await lstat(path);
  } catch (cause) {
    if (allowMissing && isNodeError(cause) && cause.code === "ENOENT") return false;
    throw cause;
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (requirePrivatePermissions && !hasPrivatePermissions(metadata))
  ) {
    throw new Error();
  }
  assertOwnedByCurrentUser(metadata);
  return true;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if (isNodeError(cause) && cause.code === "ENOENT") return false;
    throw cause;
  }
}

export function createHermesProfileHomeInitializer(
  options: HermesProfileHomeInitializerOptions,
): HermesProfileHomeInitializer {
  const listProfiles = options?.listProfiles;
  if (typeof listProfiles !== "function") throw new HermesProfileHomeError();
  const inFlight = new Map<string, InFlightInitialization>();

  return (rawBinding, rawPaths) => {
    let binding: HermesSidecarBinding;
    let hermesHome: string;
    try {
      binding = snapshotBinding(rawBinding);
      hermesHome = snapshotHermesHome(rawPaths);
    } catch {
      return Promise.reject(new HermesProfileHomeError());
    }

    const active = inFlight.get(binding.profileId);
    if (active) {
      return active.hermesHome === hermesHome && sameProfileMetadata(active.binding, binding)
        ? active.promise
        : Promise.reject(new HermesProfileHomeError());
    }

    const operation = Promise.resolve()
      .then(async () => {
        const profile = findProfile(listProfiles(), binding.profileId);
        assertBindingMatchesProfile(binding, profile);
        await mergeProfileConfig(hermesHome, profile);
      })
      .catch(() => {
        throw new HermesProfileHomeError();
      });
    const settled = operation.finally(() => {
      if (inFlight.get(binding.profileId)?.promise === settled) {
        inFlight.delete(binding.profileId);
      }
    });
    void settled.catch(() => {});
    inFlight.set(binding.profileId, { hermesHome, binding, promise: settled });
    return settled;
  };
}

async function mergeProfileConfig(hermesHome: string, profile: ProviderProfile): Promise<void> {
  await assertSafeHome(hermesHome);
  const configPath = join(hermesHome, "config.yaml");
  const existing = await readExistingConfig(configPath);
  const merged = mergeConfig(existing.config, profile);
  const yaml = dump(merged, {
    schema: JSON_SCHEMA,
    noRefs: true,
    lineWidth: -1,
    noCompatMode: true,
  });
  await replaceConfigAtomically(configPath, hermesHome, yaml, existing.identity);
}

async function assertSafeHome(hermesHome: string): Promise<void> {
  const metadata = await lstat(hermesHome);
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || !hasPrivatePermissions(metadata)) {
    throw new Error();
  }
  assertOwnedByCurrentUser(metadata);
}

async function readExistingConfig(configPath: string): Promise<ExistingConfig> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      configPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | nonBlockingFlag(),
    );
  } catch (cause) {
    if (isNodeError(cause) && cause.code === "ENOENT") {
      return { config: {}, identity: undefined };
    }
    throw cause;
  }

  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size <= 0 ||
      metadata.size > MAX_CONFIG_BYTES ||
      !hasPrivatePermissions(metadata)
    ) {
      throw new Error();
    }
    assertOwnedByCurrentUser(metadata);
    const raw = await handle.readFile({ encoding: "utf8" });
    const afterRead = await handle.stat();
    if (!sameFile(metadata, afterRead) || metadata.size !== afterRead.size) throw new Error();
    const parsed = load(raw, { schema: JSON_SCHEMA, json: false });
    assertConfigValue(parsed, new Set());
    if (!isPlainRecord(parsed)) throw new Error();
    const model = parsed.model;
    const providers = parsed.providers;
    if (model !== undefined && !isPlainRecord(model)) throw new Error();
    if (providers !== undefined && !isPlainRecord(providers)) throw new Error();
    return {
      config: parsed,
      identity: { dev: metadata.dev, ino: metadata.ino },
    };
  } finally {
    await handle.close();
  }
}

function mergeConfig(
  existing: Record<string, unknown>,
  profile: ProviderProfile,
): Record<string, unknown> {
  const existingModel = isPlainRecord(existing.model) ? existing.model : {};
  const model = {
    ...pickModelTuning(existingModel),
    default: profile.model,
    provider: profile.hermes.providerSlug,
  };
  const existingProviders = isPlainRecord(existing.providers) ? existing.providers : {};
  let providers: Record<string, unknown> = { ...existingProviders };
  delete providers[profile.hermes.providerSlug];

  if (profile.hermes.providerSlug.startsWith(CUSTOM_PROVIDER_PREFIX)) {
    const providerId = profile.hermes.providerSlug.slice(CUSTOM_PROVIDER_PREFIX.length);
    if (!CUSTOM_PROVIDER_ID_PATTERN.test(providerId)) throw new Error();
    const baseUrl = requireCustomBaseUrl(profile.baseUrl);
    providers = {
      ...providers,
      [providerId]: {
        api: baseUrl,
        key_env: "OPENTRAD_PROVIDER_API_KEY",
        default_model: profile.model,
        transport: profile.hermes.apiMode,
      },
    };
  }

  return {
    ...discardRootRouting(existing),
    model,
    providers,
  };
}

function pickModelTuning(model: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(model).filter(([field]) => MODEL_TUNING_FIELDS.has(field)),
  );
}

function discardRootRouting(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).filter(
      ([field]) => field !== "model" && field !== "providers" && !ROOT_ROUTING_FIELDS.has(field),
    ),
  );
}

async function replaceConfigAtomically(
  configPath: string,
  hermesHome: string,
  yaml: string,
  expectedIdentity: FileIdentity | undefined,
): Promise<void> {
  const temporaryPath = join(
    hermesHome,
    `.config.yaml.opentrad-${process.pid}-${randomUUID()}.tmp`,
  );
  let temporaryExists = false;
  try {
    const handle = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      CONFIG_FILE_MODE,
    );
    temporaryExists = true;
    try {
      await handle.chmod(CONFIG_FILE_MODE);
      await handle.writeFile(yaml, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }

    await assertTargetUnchanged(configPath, expectedIdentity);
    await assertSafeHome(hermesHome);
    await rename(temporaryPath, configPath);
    temporaryExists = false;
    const installed = await lstat(configPath);
    if (
      installed.isSymbolicLink() ||
      !installed.isFile() ||
      (installed.mode & 0o777) !== CONFIG_FILE_MODE
    ) {
      throw new Error();
    }
    assertOwnedByCurrentUser(installed);
  } finally {
    if (temporaryExists) await unlink(temporaryPath).catch(() => {});
  }
}

async function assertTargetUnchanged(
  configPath: string,
  expectedIdentity: FileIdentity | undefined,
): Promise<void> {
  try {
    const current = await lstat(configPath);
    if (
      !expectedIdentity ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.dev !== expectedIdentity.dev ||
      current.ino !== expectedIdentity.ino
    ) {
      throw new Error();
    }
  } catch (cause) {
    if (isNodeError(cause) && cause.code === "ENOENT" && !expectedIdentity) return;
    throw cause;
  }
}

function findProfile(rows: readonly unknown[], profileId: string): ProviderProfile {
  if (!Array.isArray(rows)) throw new Error();
  for (const row of rows) {
    try {
      const profile = ProviderProfileSchema.parse(row);
      if (profile.id === profileId) return profile;
    } catch {
      // A corrupt unrelated row must not block a valid selected Profile.
    }
  }
  throw new Error();
}

function assertBindingMatchesProfile(
  binding: HermesSidecarBinding,
  profile: ProviderProfile,
): void {
  const hermes = profile.hermes;
  if (
    binding.profileId !== profile.id ||
    binding.providerSlug !== hermes.providerSlug ||
    binding.authMode !== hermes.authMode ||
    binding.apiMode !== hermes.apiMode ||
    binding.executionBackend !== hermes.executionBackend ||
    binding.model !== profile.model
  ) {
    throw new Error();
  }
}

function sameProfileMetadata(left: HermesSidecarBinding, right: HermesSidecarBinding): boolean {
  return (
    left.profileId === right.profileId &&
    left.providerSlug === right.providerSlug &&
    left.authMode === right.authMode &&
    left.apiMode === right.apiMode &&
    left.executionBackend === right.executionBackend &&
    left.model === right.model
  );
}

function snapshotBinding(value: unknown): HermesSidecarBinding {
  if (!value || typeof value !== "object") throw new Error();
  const binding = value as HermesSidecarBinding;
  return Object.freeze({
    taskId: requireString(binding.taskId),
    runId: requireString(binding.runId),
    profileId: requireString(binding.profileId),
    providerSlug: requireString(binding.providerSlug),
    authMode: binding.authMode,
    model: requireString(binding.model),
    apiMode: binding.apiMode,
    executionBackend: binding.executionBackend,
  });
}

function snapshotHermesHome(value: unknown): string {
  if (!value || typeof value !== "object") throw new Error();
  const hermesHome = Reflect.get(value, "hermesHome");
  if (
    typeof hermesHome !== "string" ||
    hermesHome.length === 0 ||
    hermesHome.includes("\0") ||
    !isAbsolute(hermesHome)
  ) {
    throw new Error();
  }
  return hermesHome;
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new Error();
  return value;
}

function requireCustomBaseUrl(value: string | undefined): string {
  if (!value || value.length > MAX_BASE_URL_LENGTH) throw new Error();
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error();
  }
  return value;
}

function assertConfigValue(value: unknown, ancestors: Set<object>): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (!value || typeof value !== "object" || ancestors.has(value)) throw new Error();
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertConfigValue(item, ancestors);
  } else if (isPlainRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key.includes("\0")) throw new Error();
      assertConfigValue(item, ancestors);
    }
  } else {
    throw new Error();
  }
  ancestors.delete(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasPrivatePermissions(metadata: Stats): boolean {
  return process.platform === "win32" || (metadata.mode & 0o077) === 0;
}

function assertOwnedByCurrentUser(metadata: Stats): void {
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new Error();
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function nonBlockingFlag(): number {
  return process.platform === "win32" ? 0 : fsConstants.O_NONBLOCK;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}
