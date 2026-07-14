import { type ProviderProfile, ProviderProfileSchema } from "@opentrad/model-providers";
import type { RuntimeAdapter } from "@opentrad/runtime-adapter";
import type { WebContents } from "electron";
import type { PtySpawnOptions } from "../pty-manager";
import type { HermesNetworkEnvironment } from "./network-environment";
import {
  ensureHermesStateDirs,
  type HermesPaths,
  type HermesPlatform,
  resolveHermesProfilePaths,
} from "./paths";
import { createHermesProfileEnvironment, type HermesHostEnvironment } from "./spawn-spec";

export interface HermesOAuthLoginSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly profileId: string;
  readonly hermesHome: string;
}

export class HermesOAuthLoginError extends Error {
  readonly code = "HERMES_OAUTH_LOGIN_INVALID";

  constructor() {
    super("Hermes OAuth login configuration is invalid");
    this.name = "HermesOAuthLoginError";
  }
}

export type HermesOAuthPtyErrorCode =
  | "HERMES_OAUTH_LEGACY_RUNTIME"
  | "HERMES_OAUTH_PROFILE_INVALID"
  | "HERMES_OAUTH_PROFILE_INVALIDATED"
  | "HERMES_OAUTH_PTY_DRAIN_TIMEOUT"
  | "HERMES_OAUTH_PTY_INVALIDATION_FAILED";

export class HermesOAuthPtyError extends Error {
  constructor(
    readonly code: HermesOAuthPtyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HermesOAuthPtyError";
  }
}

export interface HermesOAuthPtyPort {
  spawn(options: PtySpawnOptions): string;
  kill(ptyId: string): void;
  on(event: "exit", listener: (event: { readonly ptyId: string }) => void): unknown;
}

export interface HermesOAuthPtyRouterPort {
  bind(ptyId: string, owner: WebContents, options?: { readonly deferUntilAttach?: boolean }): void;
}

export interface HermesOAuthPtyCoordinatorOptions {
  readonly dataRoot: string;
  readonly platform: HermesPlatform;
  /** Undefined is the exact global OPENTRAD_RUNTIME=legacy emergency switch. */
  readonly runtime?: Pick<RuntimeAdapter, "ready">;
  readonly listProfiles: () => readonly unknown[];
  readonly isProfileAvailable?: (profileId: string) => boolean;
  readonly pty: HermesOAuthPtyPort;
  readonly ptyRouter: HermesOAuthPtyRouterPort;
  readonly hostEnv?: HermesHostEnvironment;
  readonly networkEnvironment?: HermesNetworkEnvironment;
  readonly invalidationTimeoutMs?: number;
  readonly ensureStateDirs?: (
    paths: Pick<HermesPaths, "runtimeRoot" | "hermesHome" | "gatewayCwd">,
    options: { dataRoot: string },
  ) => Promise<void>;
}

export interface HermesOAuthPtyCoordinator {
  start(profileId: string, owner: WebContents): Promise<{ ptyId: string }>;
  invalidateProfile(profileId: string): Promise<void>;
}

interface TrackedOAuthPty {
  readonly profileId: string;
  readonly exited: Promise<void>;
  readonly resolveExit: () => void;
}

const DEFAULT_OAUTH_INVALIDATION_TIMEOUT_MS = 5_000;

/**
 * Main-owned OAuth launcher. It derives every executable argument from a persisted Profile,
 * installs/verifies the managed runtime before use, and only routes PTY bytes to the requesting
 * renderer. No token API or credential read exists on this path.
 */
export function createHermesOAuthPtyCoordinator(
  options: HermesOAuthPtyCoordinatorOptions,
): HermesOAuthPtyCoordinator {
  const prepareStateDirs = options.ensureStateDirs ?? ensureHermesStateDirs;
  const invalidationTimeoutMs = positiveInteger(
    options.invalidationTimeoutMs,
    DEFAULT_OAUTH_INVALIDATION_TIMEOUT_MS,
  );
  const generations = new Map<string, number>();
  const pendingStarts = new Map<string, Set<Promise<unknown>>>();
  const trackedPtys = new Map<string, TrackedOAuthPty>();
  const ptyIdsByProfile = new Map<string, Set<string>>();
  const invalidatingProfiles = new Set<string>();
  const invalidations = new Map<string, Promise<void>>();

  options.pty.on("exit", ({ ptyId }) => {
    releaseTrackedPty(ptyId);
  });

  const coordinator: HermesOAuthPtyCoordinator = {
    start(profileId: string, owner: WebContents): Promise<{ ptyId: string }> {
      if (invalidatingProfiles.has(profileId) || !isProfileAvailable(profileId)) {
        return Promise.reject(profileInvalidatedError());
      }
      const generation = generations.get(profileId) ?? 0;
      const operation = start(profileId, owner, generation);
      trackPendingStart(profileId, operation);
      return operation;
    },

    invalidateProfile(profileId: string): Promise<void> {
      const existing = invalidations.get(profileId);
      if (existing) return existing;
      const operation = invalidateProfile(profileId);
      invalidations.set(profileId, operation);
      const release = (): void => {
        if (invalidations.get(profileId) === operation) invalidations.delete(profileId);
      };
      void operation.then(release, release);
      return operation;
    },
  };

  return Object.freeze(coordinator);

  async function start(
    profileId: string,
    owner: WebContents,
    generation: number,
  ): Promise<{ ptyId: string }> {
    if (!options.runtime) {
      throw new HermesOAuthPtyError(
        "HERMES_OAUTH_LEGACY_RUNTIME",
        "Hermes OAuth is unavailable while OPENTRAD_RUNTIME=legacy",
      );
    }

    const profile = findOAuthProfile(options.listProfiles(), profileId);
    const spec = createHermesOAuthLoginSpec(
      options.dataRoot,
      profile,
      options.platform,
      options.hostEnv,
      options.networkEnvironment,
    );
    await options.runtime.ready();
    assertCurrentGeneration(profileId, generation);
    const paths = resolveHermesProfilePaths(options.dataRoot, profile.id, options.platform);
    await prepareStateDirs(paths, { dataRoot: options.dataRoot });
    assertCurrentGeneration(profileId, generation);
    const ptyId = options.pty.spawn({
      command: spec.command,
      args: [...spec.args],
      cwd: spec.cwd,
      env: { ...spec.env },
      inheritEnv: false,
    });
    trackPty(profileId, ptyId);
    try {
      options.ptyRouter.bind(ptyId, owner, { deferUntilAttach: true });
    } catch (cause) {
      options.pty.kill(ptyId);
      throw cause;
    }
    return { ptyId };
  }

  function assertCurrentGeneration(profileId: string, generation: number): void {
    if ((generations.get(profileId) ?? 0) !== generation || !isProfileAvailable(profileId)) {
      throw profileInvalidatedError();
    }
  }

  function isProfileAvailable(profileId: string): boolean {
    if (!options.isProfileAvailable) return true;
    try {
      return options.isProfileAvailable(profileId);
    } catch {
      return false;
    }
  }

  function trackPendingStart(profileId: string, operation: Promise<unknown>): void {
    let operations = pendingStarts.get(profileId);
    if (!operations) {
      operations = new Set();
      pendingStarts.set(profileId, operations);
    }
    operations.add(operation);
    const release = (): void => {
      operations?.delete(operation);
      if (operations?.size === 0 && pendingStarts.get(profileId) === operations) {
        pendingStarts.delete(profileId);
      }
    };
    void operation.then(release, release);
  }

  function trackPty(profileId: string, ptyId: string): void {
    if (trackedPtys.has(ptyId)) {
      options.pty.kill(ptyId);
      throw new HermesOAuthPtyError(
        "HERMES_OAUTH_PTY_INVALIDATION_FAILED",
        "Hermes OAuth PTY tracking failed",
      );
    }
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    trackedPtys.set(ptyId, { profileId, exited, resolveExit });
    let ptyIds = ptyIdsByProfile.get(profileId);
    if (!ptyIds) {
      ptyIds = new Set();
      ptyIdsByProfile.set(profileId, ptyIds);
    }
    ptyIds.add(ptyId);
  }

  function releaseTrackedPty(ptyId: string): void {
    const tracked = trackedPtys.get(ptyId);
    if (!tracked) return;
    trackedPtys.delete(ptyId);
    const ptyIds = ptyIdsByProfile.get(tracked.profileId);
    ptyIds?.delete(ptyId);
    if (ptyIds?.size === 0) ptyIdsByProfile.delete(tracked.profileId);
    tracked.resolveExit();
  }

  async function invalidateProfile(profileId: string): Promise<void> {
    generations.set(profileId, (generations.get(profileId) ?? 0) + 1);
    invalidatingProfiles.add(profileId);
    let succeeded = false;
    try {
      await withTimeout(drainProfile(profileId), invalidationTimeoutMs);
      succeeded = true;
    } finally {
      if (succeeded) invalidatingProfiles.delete(profileId);
    }
  }

  async function drainProfile(profileId: string): Promise<void> {
    const starts = [...(pendingStarts.get(profileId) ?? [])];
    if (starts.length > 0) await Promise.allSettled(starts);

    const tracked = [...(ptyIdsByProfile.get(profileId) ?? [])]
      .map((ptyId) => [ptyId, trackedPtys.get(ptyId)] as const)
      .filter((entry): entry is readonly [string, TrackedOAuthPty] => entry[1] !== undefined);
    let killFailed = false;
    for (const [ptyId] of tracked) {
      try {
        options.pty.kill(ptyId);
      } catch {
        killFailed = true;
      }
    }
    if (killFailed) {
      throw new HermesOAuthPtyError(
        "HERMES_OAUTH_PTY_INVALIDATION_FAILED",
        "Hermes OAuth PTY invalidation failed",
      );
    }
    await Promise.all(tracked.map(([, record]) => record.exited));
  }
}

function profileInvalidatedError(): HermesOAuthPtyError {
  return new HermesOAuthPtyError(
    "HERMES_OAUTH_PROFILE_INVALIDATED",
    "Hermes OAuth profile changed during login launch",
  );
}

async function withTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(
        new HermesOAuthPtyError(
          "HERMES_OAUTH_PTY_DRAIN_TIMEOUT",
          "Hermes OAuth PTY invalidation timed out",
        ),
      );
    }, timeoutMs);
    if (typeof timeout === "object" && "unref" in timeout) timeout.unref();
  });
  try {
    await Promise.race([operation, expired]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}

export function createHermesOAuthLoginSpec(
  dataRoot: string,
  profile: ProviderProfile,
  platform: HermesPlatform,
  hostEnv: HermesHostEnvironment = process.env,
  networkEnvironment?: HermesNetworkEnvironment,
): HermesOAuthLoginSpec {
  try {
    const definition = HERMES_OAUTH_PROVIDER_ALLOWLIST[profile.hermes.providerSlug];
    if (!definition || !isSupportedHermesOAuthProfile(profile)) throw new Error();
    const paths = resolveHermesProfilePaths(dataRoot, profile.id, platform);
    const invocation = definition.createInvocation(paths, platform);
    return Object.freeze({
      command: invocation.command,
      args: Object.freeze(invocation.args),
      cwd: paths.gatewayCwd,
      env: createHermesProfileEnvironment(paths.hermesHome, hostEnv, networkEnvironment),
      profileId: profile.id,
      hermesHome: paths.hermesHome,
    });
  } catch {
    throw new HermesOAuthLoginError();
  }
}

export function isSupportedHermesOAuthProfile(profile: ProviderProfile): boolean {
  const definition = HERMES_OAUTH_PROVIDER_ALLOWLIST[profile.hermes.providerSlug];
  return Boolean(
    profile.hermes.authMode === "oauth" &&
      definition?.apiModes.has(profile.hermes.apiMode) &&
      definition.acceptsProfile(profile),
  );
}

interface HermesOAuthInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

interface HermesOAuthProviderDefinition {
  readonly apiModes: ReadonlySet<ProviderProfile["hermes"]["apiMode"]>;
  acceptsProfile(profile: ProviderProfile): boolean;
  createInvocation(paths: HermesPaths, platform: HermesPlatform): HermesOAuthInvocation;
}

const HERMES_OAUTH_ENVIRONMENT_GUARD = [
  "import os",
  "from hermes_cli import env_loader as _opentrad_env_loader",
  "_opentrad_fixed = dict(os.environ)",
  '_opentrad_controls = frozenset("ANTHROPIC_BASE_URL BASH_ENV BASHOPTS CDPATH COPILOT_API_BASE_URL ENV GLOBIGNORE IFS SHELL SHELLOPTS ZDOTDIR DOCKER_CERT_PATH DOCKER_CONFIG DOCKER_CONTEXT DOCKER_HOST DOCKER_TLS_VERIFY GIT_ASKPASS GIT_DIR GIT_EXEC_PATH GIT_SSH GIT_SSH_COMMAND GIT_WORK_TREE HERMES_BUNDLED_SKILLS HERMES_CA_BUNDLE HERMES_CODEX_BASE_URL HERMES_CONFIG HERMES_ENV HERMES_HOME HERMES_PORTAL_BASE_URL HERMES_PROFILE HERMES_RESOURCE_PATH HERMES_SHARED_AUTH_DIR HERMES_SKILL_DIR HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy SSL_CERT_FILE SSL_CERT_DIR REQUESTS_CA_BUNDLE CURL_CA_BUNDLE NODE_EXTRA_CA_CERTS OPENSSL_CONF SSLKEYLOGFILE NODE_OPTIONS NODE_PATH NOUS_INFERENCE_BASE_URL NOUS_PORTAL_BASE_URL PYTHONBREAKPOINT PYTHONEXECUTABLE PYTHONHOME PYTHONINSPECT PYTHONNOUSERSITE PYTHONPATH PYTHONSAFEPATH PYTHONSTARTUP PYTHONUSERBASE SSH_ASKPASS".split())',
  '_opentrad_prefixes = ("DYLD_", "GIT_CONFIG_", "LD_", "OPENTRAD_", "TERMINAL_")',
  "_opentrad_original_load = _opentrad_env_loader.load_hermes_dotenv",
  "def _opentrad_load(*args, **kwargs):",
  "    try:",
  "        return _opentrad_original_load(*args, **kwargs)",
  "    finally:",
  "        target = os.environ",
  "        for name in tuple(target):",
  "            if name not in _opentrad_fixed and (name in _opentrad_controls or name.startswith(_opentrad_prefixes)):",
  "                target.pop(name, None)",
  "        target.update(_opentrad_fixed)",
  "_opentrad_env_loader.load_hermes_dotenv = _opentrad_load",
] as const;

const HERMES_COPILOT_DEVICE_CODE_SOURCE = [
  ...HERMES_OAUTH_ENVIRONMENT_GUARD,
  "from hermes_cli.config import save_env_value",
  "from hermes_cli.copilot_auth import copilot_device_code_login",
  "token = copilot_device_code_login()",
  "if not token:",
  "    raise SystemExit(1)",
  'save_env_value("COPILOT_GITHUB_TOKEN", token)',
  'print("Copilot OAuth login complete.")',
].join("\n");

const HERMES_ANTHROPIC_OAUTH_SOURCE = [
  ...HERMES_OAUTH_ENVIRONMENT_GUARD,
  "import sys",
  "from agent import anthropic_adapter as _anthropic_adapter",
  "_opentrad_no_external = lambda: None",
  "_anthropic_adapter.read_claude_code_credentials = _opentrad_no_external",
  "_anthropic_adapter._read_claude_code_credentials_from_keychain = _opentrad_no_external",
  "_anthropic_adapter._read_claude_code_credentials_from_file = _opentrad_no_external",
  "from hermes_cli.main import main as _main",
  'sys.argv = ["hermes", "auth", "add", "anthropic", "--type", "oauth"]',
  "_main()",
].join("\n");

const HERMES_CLI_SOURCE_ARGS = ["-I", "-B", "-u", "-X", "utf8", "-c"] as const;

function createHermesCliOAuthSource(providerSlug: "openai-codex" | "nous"): string {
  return [
    ...HERMES_OAUTH_ENVIRONMENT_GUARD,
    "import sys",
    "from hermes_cli.main import main as _main",
    `sys.argv = ${JSON.stringify(["hermes", "auth", "add", providerSlug, "--type", "oauth"])}`,
    "_main()",
  ].join("\n");
}

const HERMES_OAUTH_PROVIDER_ALLOWLIST: Readonly<
  Record<string, HermesOAuthProviderDefinition | undefined>
> = Object.freeze({
  "openai-codex": Object.freeze({
    apiModes: new Set(["codex_responses"] as const),
    acceptsProfile: (profile: ProviderProfile) =>
      profile.kind === "openai" && profile.model === "gpt-5.4" && profile.baseUrl === undefined,
    createInvocation: (paths: HermesPaths) => ({
      command: paths.pythonExecutable,
      args: [...HERMES_CLI_SOURCE_ARGS, createHermesCliOAuthSource("openai-codex")],
    }),
  }),
  nous: Object.freeze({
    apiModes: new Set(["chat_completions"] as const),
    acceptsProfile: (profile: ProviderProfile) =>
      profile.kind === "openai" &&
      profile.model === "anthropic/claude-fable-5" &&
      profile.baseUrl === undefined,
    createInvocation: (paths: HermesPaths) => ({
      command: paths.pythonExecutable,
      args: [...HERMES_CLI_SOURCE_ARGS, createHermesCliOAuthSource("nous")],
    }),
  }),
  anthropic: Object.freeze({
    apiModes: new Set(["chat_completions"] as const),
    acceptsProfile: (profile: ProviderProfile) =>
      profile.kind === "claude-subscription" &&
      /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(profile.model) &&
      profile.model.toLowerCase().includes("claude") &&
      profile.baseUrl === undefined,
    createInvocation: (paths: HermesPaths) => ({
      command: paths.pythonExecutable,
      args: ["-I", "-B", "-u", "-X", "utf8", "-c", HERMES_ANTHROPIC_OAUTH_SOURCE],
    }),
  }),
  copilot: Object.freeze({
    apiModes: new Set(["chat_completions", "codex_responses"] as const),
    acceptsProfile: (profile: ProviderProfile) =>
      profile.kind === "openai" &&
      profile.model === "gpt-5.4" &&
      profile.hermes.apiMode === "codex_responses" &&
      profile.baseUrl === undefined,
    createInvocation: (paths: HermesPaths) => ({
      command: paths.pythonExecutable,
      args: ["-I", "-B", "-u", "-X", "utf8", "-c", HERMES_COPILOT_DEVICE_CODE_SOURCE],
    }),
  }),
});

function findOAuthProfile(profiles: readonly unknown[], profileId: string): ProviderProfile {
  for (const raw of profiles) {
    const parsed = ProviderProfileSchema.safeParse(raw);
    if (parsed.success && parsed.data.id === profileId && parsed.data.hermes.authMode === "oauth") {
      return parsed.data;
    }
  }
  throw new HermesOAuthPtyError(
    "HERMES_OAUTH_PROFILE_INVALID",
    "Hermes OAuth profile is unavailable",
  );
}
