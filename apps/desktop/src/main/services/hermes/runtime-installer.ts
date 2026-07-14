import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { HermesRuntimeInstallProgress } from "@opentrad/shared";
import {
  extractVerifiedHermesBundledSkills,
  HermesBundledSkillsError,
  resolveInstalledHermesBundledSkillsRoot,
  verifyInstalledHermesBundledSkills,
} from "./bundled-skills";
import { HERMES_AGENT_VERSION, HERMES_RELEASE_TAG } from "./constants";
import {
  type HermesCommandRunner,
  type VerifiedHermesInstallation,
  verifyHermesInstallation,
} from "./installation";
import {
  type BundledHermesRuntimeArtifact,
  HERMES_CPYTHON_VERSION,
  type HermesRuntimeArtifactKind,
  type HermesRuntimeArtifactManifest,
  type HermesSourceRuntimeArtifact,
  PINNED_HERMES_RUNTIME_MANIFEST,
  type RemoteHermesRuntimeArtifact,
  type VerifiedHermesRuntimeArtifact,
} from "./runtime-artifact-manifest";

const ARTIFACT_ORDER = [
  "cpython",
  "uv",
  "hermes-wheel",
  "requirements-lock",
  "hermes-source",
] as const satisfies readonly HermesRuntimeArtifactKind[];
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CONSOLE_SCRIPT_BYTES = 4 * 1024 * 1024;
const MAX_WHEEL_RECORD_BYTES = 128 * 1024;
const MAX_UV_CACHE_BYTES = 1024 * 1024;
const TAR_EXECUTABLE = "/usr/bin/tar";
const HERMES_CONSOLE_SCRIPTS = ["hermes", "hermes-agent", "hermes-acp"] as const;
const HERMES_DIST_INFO_DIRECTORY = `hermes_agent-${HERMES_AGENT_VERSION}.dist-info`;
const HERMES_UV_CACHE_RECORD_PATH = `${HERMES_DIST_INFO_DIRECTORY}/uv_cache.json`;

export type HermesRuntimeInstallErrorCode =
  | "HERMES_RUNTIME_INSTALL_INVALID"
  | "HERMES_RUNTIME_PLATFORM_UNSUPPORTED"
  | "HERMES_RUNTIME_MANIFEST_UNVERIFIED"
  | "HERMES_RUNTIME_DOWNLOAD_FAILED"
  | "HERMES_RUNTIME_ARTIFACT_INVALID"
  | "HERMES_RUNTIME_INSTALL_FAILED"
  | "HERMES_RUNTIME_ACTIVATION_FAILED";

export class HermesRuntimeInstallError extends Error {
  readonly code: HermesRuntimeInstallErrorCode;

  constructor(code: HermesRuntimeInstallErrorCode, message: string) {
    super(`Managed Hermes runtime installation ${message}`);
    this.name = "HermesRuntimeInstallError";
    this.code = code;
  }
}

export type { HermesRuntimeInstallProgress } from "@opentrad/shared";
export type HermesRuntimeInstallPhase = HermesRuntimeInstallProgress["phase"];

export type HermesRuntimeInstallProgressListener = (progress: HermesRuntimeInstallProgress) => void;

export interface InstalledHermesRuntime {
  readonly runtimeRoot: string;
  readonly pythonExecutable: string;
  readonly bundledSkillsRoot: string;
  readonly version: typeof HERMES_AGENT_VERSION;
  readonly releaseTag: typeof HERMES_RELEASE_TAG;
  readonly didInstall: boolean;
}

export type HermesArtifactDownloader = (
  artifact: RemoteHermesRuntimeArtifact,
  destination: string,
) => Promise<void>;

export type HermesInstallationVerifier = (
  pythonExecutable: string,
  runner: HermesCommandRunner,
) => Promise<VerifiedHermesInstallation>;

export type HermesCurrentPointerSwitcher = (
  runtimeFamilyRoot: string,
  version: typeof HERMES_AGENT_VERSION,
) => Promise<void>;

export interface HermesRuntimeInstallerOptions {
  readonly dataRoot: string;
  readonly runner: HermesCommandRunner;
  readonly manifest?: HermesRuntimeArtifactManifest;
  readonly resourcesRoot?: string;
  readonly downloadArtifact?: HermesArtifactDownloader;
  readonly verifyInstallation?: HermesInstallationVerifier;
  readonly switchCurrentPointer?: HermesCurrentPointerSwitcher;
  readonly hostPlatform?: NodeJS.Platform;
  readonly hostArch?: string;
}

interface InstallFlight {
  readonly listeners: Set<HermesRuntimeInstallProgressListener>;
  readonly promise: Promise<InstalledHermesRuntime>;
}

interface ActivationTransactionCandidate {
  readonly kind: "rollback" | "failed";
  readonly path: string;
}

const activeInstallations = new Map<string, InstallFlight>();

export class HermesRuntimeInstaller {
  private readonly dataRoot: string;
  private readonly runner: HermesCommandRunner;
  private readonly manifest: HermesRuntimeArtifactManifest;
  private readonly resourcesRoot: string;
  private readonly downloadArtifact: HermesArtifactDownloader;
  private readonly verifyInstallation: HermesInstallationVerifier;
  private readonly switchCurrentPointer: HermesCurrentPointerSwitcher;
  private readonly hostPlatform: NodeJS.Platform;
  private readonly hostArch: string;

  constructor(options: HermesRuntimeInstallerOptions) {
    this.dataRoot = options.dataRoot;
    this.runner = options.runner;
    this.manifest = options.manifest ?? PINNED_HERMES_RUNTIME_MANIFEST;
    this.resourcesRoot = resolve(options.resourcesRoot ?? defaultHermesResourcesRoot());
    this.downloadArtifact = options.downloadArtifact ?? downloadHermesRuntimeArtifact;
    this.verifyInstallation = options.verifyInstallation ?? verifyHermesInstallation;
    this.switchCurrentPointer = options.switchCurrentPointer ?? switchHermesCurrentPointer;
    this.hostPlatform = options.hostPlatform ?? process.platform;
    this.hostArch = options.hostArch ?? process.arch;
  }

  ensureInstalled(
    onProgress?: HermesRuntimeInstallProgressListener,
  ): Promise<InstalledHermesRuntime> {
    const key = this.installationKey();
    let flight = activeInstallations.get(key);
    if (!flight) {
      const listeners = new Set<HermesRuntimeInstallProgressListener>();
      const promise = Promise.resolve().then(() =>
        this.performInstallation((progress) => notifyListeners(listeners, progress)),
      );
      flight = { listeners, promise };
      activeInstallations.set(key, flight);
      const clearFlight = (): void => {
        if (activeInstallations.get(key) === flight) activeInstallations.delete(key);
      };
      void promise.then(clearFlight, clearFlight);
    }

    if (onProgress) flight.listeners.add(onProgress);
    return observeFlight(flight, onProgress);
  }

  private installationKey(): string {
    return resolve(this.dataRoot, "runtimes", "hermes", this.manifest.hermesAgentVersion);
  }

  private async performInstallation(
    emit: (progress: HermesRuntimeInstallProgress) => void,
  ): Promise<InstalledHermesRuntime> {
    emit({ phase: "checking" });
    this.validateIdentity();

    const runtimeFamilyRoot = resolve(this.dataRoot, "runtimes", "hermes");
    const runtimeRoot = join(runtimeFamilyRoot, HERMES_AGENT_VERSION);
    const pythonExecutable = join(runtimeRoot, "venv", "bin", "python3");
    const artifacts = this.requireVerifiedArtifacts();
    const sourceArtifact = requiredHermesSourceArtifact(artifacts);
    const recoveredInstallation = await this.reconcileInterruptedActivation(
      runtimeFamilyRoot,
      runtimeRoot,
      sourceArtifact,
    );
    const installed =
      recoveredInstallation ??
      (await this.verifyExistingInstallation(runtimeRoot, pythonExecutable, sourceArtifact));
    if (installed) {
      emit({ phase: "switching" });
      try {
        await this.switchCurrentPointer(runtimeFamilyRoot, HERMES_AGENT_VERSION);
      } catch {
        throw new HermesRuntimeInstallError(
          "HERMES_RUNTIME_ACTIVATION_FAILED",
          "could not activate the verified runtime",
        );
      }
      emit({ phase: "ready" });
      return toInstalledRuntime(runtimeRoot, false);
    }

    await mkdir(runtimeFamilyRoot, { recursive: true, mode: 0o700 });
    await assertRealDirectory(runtimeFamilyRoot);
    const stagingRoot = await mkdtemp(join(runtimeFamilyRoot, ".staging-"));

    try {
      const downloadsRoot = join(stagingRoot, "downloads");
      const venvRoot = join(stagingRoot, "venv");
      const uvRoot = join(stagingRoot, "tools", "uv");
      await mkdir(downloadsRoot, { mode: 0o700 });
      await mkdir(venvRoot, { recursive: true, mode: 0o700 });
      await mkdir(uvRoot, { recursive: true, mode: 0o700 });

      const artifactPaths = new Map<HermesRuntimeArtifactKind, string>();
      for (const artifact of artifacts) {
        const destination = join(downloadsRoot, artifactFileName(artifact));
        emit({ phase: "downloading", artifact: artifact.kind });
        try {
          if (artifact.source === "bundled") {
            await copyBundledArtifact(artifact, this.resourcesRoot, destination);
          } else {
            await this.downloadArtifact(artifact, destination);
          }
        } catch (error) {
          if (error instanceof HermesRuntimeInstallError) throw error;
          throw new HermesRuntimeInstallError(
            "HERMES_RUNTIME_DOWNLOAD_FAILED",
            "could not download a pinned artifact",
          );
        }
        emit({ phase: "verifying-download", artifact: artifact.kind });
        await verifyDownloadedArtifact(artifact, destination);
        artifactPaths.set(artifact.kind, destination);
      }

      emit({ phase: "preparing" });
      await this.runner(TAR_EXECUTABLE, [
        "-xzf",
        requiredArtifactPath(artifactPaths, "cpython"),
        "-C",
        venvRoot,
        "--strip-components=1",
      ]);
      try {
        await extractVerifiedHermesBundledSkills(
          requiredArtifactPath(artifactPaths, "hermes-source"),
          stagingRoot,
          sourceArtifact,
        );
      } catch (error) {
        if (error instanceof HermesBundledSkillsError) {
          throw new HermesRuntimeInstallError(
            "HERMES_RUNTIME_ARTIFACT_INVALID",
            "rejected the pinned Hermes source skills subtree",
          );
        }
        throw error;
      }
      await this.runner(TAR_EXECUTABLE, [
        "-xzf",
        requiredArtifactPath(artifactPaths, "uv"),
        "-C",
        uvRoot,
        "--strip-components=1",
      ]);

      const stagingPython = join(venvRoot, "bin", "python3");
      const managedUv = join(uvRoot, "uv");
      await chmod(managedUv, 0o700);

      emit({ phase: "installing" });
      await this.runner(managedUv, [
        "pip",
        "install",
        "--python",
        stagingPython,
        "--no-cache",
        "--no-build",
        "--no-deps",
        "--require-hashes",
        "-r",
        requiredArtifactPath(artifactPaths, "requirements-lock"),
      ]);
      await this.runner(managedUv, [
        "pip",
        "install",
        "--python",
        stagingPython,
        "--no-cache",
        "--no-build",
        "--no-deps",
        requiredArtifactPath(artifactPaths, "hermes-wheel"),
      ]);
      await relocateHermesConsoleScripts(venvRoot, stagingPython, pythonExecutable);

      emit({ phase: "verifying-runtime" });
      try {
        await this.verifyInstallation(stagingPython, this.runner);
        await verifyInstalledHermesBundledSkills(stagingRoot, sourceArtifact);
      } catch {
        throw new HermesRuntimeInstallError(
          "HERMES_RUNTIME_INSTALL_FAILED",
          "failed its complete integrity verification",
        );
      }
      await rm(downloadsRoot, { recursive: true, force: true });

      emit({ phase: "switching" });
      await this.activateStaging(stagingRoot, runtimeFamilyRoot, runtimeRoot);
      emit({ phase: "ready" });
      return toInstalledRuntime(runtimeRoot, true);
    } catch (error) {
      if (error instanceof HermesRuntimeInstallError) throw error;
      throw new HermesRuntimeInstallError(
        "HERMES_RUNTIME_INSTALL_FAILED",
        "failed before activation",
      );
    } finally {
      await removeManagedRuntimeTree(stagingRoot);
    }
  }

  private validateIdentity(): void {
    if (!isAbsolute(this.dataRoot)) {
      throw new HermesRuntimeInstallError(
        "HERMES_RUNTIME_INSTALL_INVALID",
        "requires an absolute data root",
      );
    }
    if (
      this.manifest.schema !== 1 ||
      this.manifest.cpythonVersion !== HERMES_CPYTHON_VERSION ||
      this.manifest.hermesAgentVersion !== HERMES_AGENT_VERSION ||
      this.manifest.hermesReleaseTag !== HERMES_RELEASE_TAG
    ) {
      throw new HermesRuntimeInstallError(
        "HERMES_RUNTIME_INSTALL_INVALID",
        "received an invalid lock manifest",
      );
    }
    if (
      this.hostPlatform !== "darwin" ||
      this.hostArch !== "arm64" ||
      this.manifest.platform !== "darwin" ||
      this.manifest.arch !== "arm64"
    ) {
      throw new HermesRuntimeInstallError(
        "HERMES_RUNTIME_PLATFORM_UNSUPPORTED",
        "supports only macOS arm64",
      );
    }
  }

  private requireVerifiedArtifacts(): readonly VerifiedHermesRuntimeArtifact[] {
    if (!this.manifest.uvVersion) {
      throw new HermesRuntimeInstallError(
        "HERMES_RUNTIME_MANIFEST_UNVERIFIED",
        "is blocked by unaudited artifact metadata",
      );
    }
    const byKind = new Map<HermesRuntimeArtifactKind, VerifiedHermesRuntimeArtifact>();
    for (const artifact of this.manifest.artifacts) {
      if (artifact.status !== "verified") {
        throw new HermesRuntimeInstallError(
          "HERMES_RUNTIME_MANIFEST_UNVERIFIED",
          "is blocked by unaudited artifact metadata",
        );
      }
      validateVerifiedArtifact(artifact);
      if (byKind.has(artifact.kind)) {
        throw new HermesRuntimeInstallError(
          "HERMES_RUNTIME_INSTALL_INVALID",
          "received a duplicate artifact",
        );
      }
      byKind.set(artifact.kind, artifact);
    }
    if (byKind.size !== ARTIFACT_ORDER.length) {
      throw new HermesRuntimeInstallError(
        "HERMES_RUNTIME_MANIFEST_UNVERIFIED",
        "is missing a required pinned artifact",
      );
    }
    return ARTIFACT_ORDER.map((kind) => {
      const artifact = byKind.get(kind);
      if (!artifact) {
        throw new HermesRuntimeInstallError(
          "HERMES_RUNTIME_MANIFEST_UNVERIFIED",
          "is missing a required pinned artifact",
        );
      }
      return artifact;
    });
  }

  private async verifyExistingInstallation(
    runtimeRoot: string,
    pythonExecutable: string,
    sourceArtifact: HermesSourceRuntimeArtifact,
    expectedConsolePython = pythonExecutable,
  ): Promise<boolean> {
    if (!(await pathExists(pythonExecutable))) return false;
    try {
      await this.verifyInstallation(pythonExecutable, this.runner);
      await verifyInstalledHermesBundledSkills(runtimeRoot, sourceArtifact);
      await verifyHermesConsoleScripts(runtimeRoot, expectedConsolePython);
      return true;
    } catch {
      return false;
    }
  }

  private async reconcileInterruptedActivation(
    runtimeFamilyRoot: string,
    runtimeRoot: string,
    sourceArtifact: HermesSourceRuntimeArtifact,
  ): Promise<true | undefined> {
    try {
      const candidates = await findActivationTransactionCandidates(runtimeFamilyRoot);
      if (candidates.length === 0) return undefined;
      const rollbacks = candidates.filter(({ kind }) => kind === "rollback");
      const failed = candidates.filter(({ kind }) => kind === "failed");
      if (rollbacks.length > 1 || failed.length > 1) throw activationRecoveryError();

      const rollback = rollbacks[0];
      const failedRuntime = failed[0];

      const pythonExecutable = join(runtimeRoot, "venv", "bin", "python3");
      if (await this.verifyExistingInstallation(runtimeRoot, pythonExecutable, sourceArtifact)) {
        for (const candidate of candidates) await removeManagedRuntimeTree(candidate.path);
        return true;
      }
      if (await pathExists(runtimeRoot)) throw activationRecoveryError();

      if (!rollback) {
        if (failedRuntime) await removeManagedRuntimeTree(failedRuntime.path);
        return undefined;
      }

      const rollbackPython = join(rollback.path, "venv", "bin", "python3");
      if (
        !(await this.verifyExistingInstallation(
          rollback.path,
          rollbackPython,
          sourceArtifact,
          pythonExecutable,
        ))
      ) {
        throw activationRecoveryError();
      }

      await rename(rollback.path, runtimeRoot);
      if (!(await this.verifyExistingInstallation(runtimeRoot, pythonExecutable, sourceArtifact))) {
        await rename(runtimeRoot, rollback.path);
        throw activationRecoveryError();
      }
      if (failedRuntime) await removeManagedRuntimeTree(failedRuntime.path);
      return true;
    } catch (error) {
      if (error instanceof HermesRuntimeInstallError) throw error;
      throw activationRecoveryError();
    }
  }

  private async activateStaging(
    stagingRoot: string,
    runtimeFamilyRoot: string,
    runtimeRoot: string,
  ): Promise<void> {
    const backupRoot = join(runtimeFamilyRoot, `.rollback-${HERMES_AGENT_VERSION}-${randomUUID()}`);
    const failedRoot = join(runtimeFamilyRoot, `.failed-${HERMES_AGENT_VERSION}-${randomUUID()}`);
    let movedExisting = false;
    let movedStaging = false;
    try {
      if (await pathExists(runtimeRoot)) {
        await rename(runtimeRoot, backupRoot);
        movedExisting = true;
      }
      await rename(stagingRoot, runtimeRoot);
      movedStaging = true;
      await this.switchCurrentPointer(runtimeFamilyRoot, HERMES_AGENT_VERSION);
    } catch {
      try {
        if (movedStaging) {
          try {
            await removeManagedRuntimeTree(runtimeRoot);
          } catch {
            await rename(runtimeRoot, failedRoot);
          }
        }
        if (movedExisting) await rename(backupRoot, runtimeRoot);
        await removeManagedRuntimeTree(failedRoot);
      } catch {
        throw new HermesRuntimeInstallError(
          "HERMES_RUNTIME_ACTIVATION_FAILED",
          "could not restore the previous runtime after activation failed",
        );
      }
      throw new HermesRuntimeInstallError(
        "HERMES_RUNTIME_ACTIVATION_FAILED",
        "could not atomically activate the verified runtime",
      );
    }
    if (movedExisting) {
      try {
        await removeManagedRuntimeTree(backupRoot);
      } catch {
        throw new HermesRuntimeInstallError(
          "HERMES_RUNTIME_ACTIVATION_FAILED",
          "could not clean the previous runtime after activation",
        );
      }
    }
  }
}

async function relocateHermesConsoleScripts(
  venvRoot: string,
  stagingPython: string,
  finalPython: string,
): Promise<void> {
  try {
    const relocatedScripts: RelocatedHermesConsoleScript[] = [];
    for (const commandName of HERMES_CONSOLE_SCRIPTS) {
      const scriptPath = join(venvRoot, "bin", commandName);
      const contents = await readConsoleScript(scriptPath);
      const newline = contents.indexOf(0x0a);
      if (newline <= 2 || contents.subarray(0, newline).toString("utf8") !== `#!${stagingPython}`) {
        throw new Error("unexpected console script shebang");
      }
      const relocatedContents = Buffer.concat([
        Buffer.from(`#!${finalPython}\n`, "utf8"),
        contents.subarray(newline + 1),
      ]);
      await writeFile(scriptPath, relocatedContents);
      relocatedScripts.push({ commandName, originalContents: contents, relocatedContents });
    }
    await rewriteHermesGeneratedRecordRows(venvRoot, relocatedScripts);
    await verifyHermesConsoleScripts(resolve(venvRoot, ".."), finalPython);
  } catch {
    throw new HermesRuntimeInstallError(
      "HERMES_RUNTIME_INSTALL_FAILED",
      "could not relocate its managed console scripts",
    );
  }
}

interface RelocatedHermesConsoleScript {
  readonly commandName: (typeof HERMES_CONSOLE_SCRIPTS)[number];
  readonly originalContents: Buffer;
  readonly relocatedContents: Buffer;
}

async function rewriteHermesGeneratedRecordRows(
  venvRoot: string,
  scripts: readonly RelocatedHermesConsoleScript[],
): Promise<void> {
  if (scripts.length !== HERMES_CONSOLE_SCRIPTS.length) throw new Error("missing console script");

  const distInfoRoot = join(
    venvRoot,
    "lib",
    "python3.12",
    "site-packages",
    HERMES_DIST_INFO_DIRECTORY,
  );
  const recordPath = join(distInfoRoot, "RECORD");
  const uvCachePath = join(distInfoRoot, "uv_cache.json");
  const record = await readManagedRuntimeFile(recordPath, MAX_WHEEL_RECORD_BYTES);
  const uvCache = await readManagedRuntimeFile(uvCachePath, MAX_UV_CACHE_BYTES);
  const recordText = record.toString("utf8");
  if (!Buffer.from(recordText, "utf8").equals(record) || !recordText.endsWith("\n")) {
    throw new Error("invalid wheel record encoding");
  }

  const scriptsByPath = new Map(
    scripts.map((script) => [`../../../bin/${script.commandName}`, script] as const),
  );
  const seenScripts = new Set<string>();
  let sawUvCache = false;
  const rewrittenLines: string[] = [];

  for (const line of recordText.slice(0, -1).split("\n")) {
    let matchedScript = false;
    for (const [recordName, script] of scriptsByPath) {
      if (!line.startsWith(`${recordName},`)) continue;
      if (
        seenScripts.has(recordName) ||
        line !== generatedRecordRow(recordName, script.originalContents)
      ) {
        throw new Error("invalid console script record");
      }
      seenScripts.add(recordName);
      rewrittenLines.push(generatedRecordRow(recordName, script.relocatedContents));
      matchedScript = true;
      break;
    }
    if (matchedScript) continue;

    if (line.startsWith(`${HERMES_UV_CACHE_RECORD_PATH},`)) {
      if (sawUvCache || line !== generatedRecordRow(HERMES_UV_CACHE_RECORD_PATH, uvCache)) {
        throw new Error("invalid uv cache record");
      }
      sawUvCache = true;
      continue;
    }
    rewrittenLines.push(line);
  }

  if (seenScripts.size !== scriptsByPath.size || !sawUvCache) {
    throw new Error("missing generated wheel record row");
  }

  const temporaryRecord = join(distInfoRoot, `.RECORD.opentrad-${randomUUID()}`);
  try {
    await writeFile(temporaryRecord, Buffer.from(`${rewrittenLines.join("\n")}\n`, "utf8"), {
      flag: "wx",
      mode: 0o600,
    });
    const temporaryHandle = await open(temporaryRecord, "r");
    try {
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }
    await rename(temporaryRecord, recordPath);
    await rm(uvCachePath);
    const directoryHandle = await open(dirname(recordPath), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await rm(temporaryRecord, { force: true }).catch(() => undefined);
  }
}

function generatedRecordRow(recordName: string, contents: Buffer): string {
  return `${recordName},sha256=${createHash("sha256").update(contents).digest("base64url")},${contents.length}`;
}

async function verifyHermesConsoleScripts(
  runtimeRoot: string,
  expectedPython: string,
): Promise<void> {
  for (const commandName of HERMES_CONSOLE_SCRIPTS) {
    const contents = await readConsoleScript(join(runtimeRoot, "venv", "bin", commandName));
    const newline = contents.indexOf(0x0a);
    if (newline <= 2 || contents.subarray(0, newline).toString("utf8") !== `#!${expectedPython}`) {
      throw new Error("invalid managed console script");
    }
  }
}

async function readConsoleScript(scriptPath: string): Promise<Buffer> {
  return readManagedRuntimeFile(scriptPath, MAX_CONSOLE_SCRIPT_BYTES);
}

async function readManagedRuntimeFile(filePath: string, maxBytes: number): Promise<Buffer> {
  const metadata = await lstat(filePath);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size <= 0 ||
    metadata.size > maxBytes ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o022) !== 0 ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    throw new Error("invalid managed console script");
  }
  const contents = await readFile(filePath);
  if (contents.length !== metadata.size) throw new Error("managed runtime file changed");
  return contents;
}

export async function downloadHermesRuntimeArtifact(
  artifact: RemoteHermesRuntimeArtifact,
  destination: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let complete = false;
  try {
    const url = new URL(artifact.url);
    if (url.protocol !== "https:") throw new Error("invalid transport");
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/octet-stream" },
    });
    if (!response.ok || !response.body) throw new Error("download failed");
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) !== artifact.sizeBytes) {
      throw new Error("download size mismatch");
    }

    handle = await open(destination, "wx", 0o600);
    const reader = response.body.getReader();
    let bytesWritten = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytesWritten += result.value.byteLength;
      if (bytesWritten > artifact.sizeBytes) {
        await reader.cancel();
        throw new Error("download too large");
      }
      let chunkOffset = 0;
      while (chunkOffset < result.value.byteLength) {
        const writeResult = await handle.write(
          result.value,
          chunkOffset,
          result.value.byteLength - chunkOffset,
          null,
        );
        if (writeResult.bytesWritten <= 0) throw new Error("download write failed");
        chunkOffset += writeResult.bytesWritten;
      }
    }
    if (bytesWritten !== artifact.sizeBytes) throw new Error("download truncated");
    await handle.sync();
    complete = true;
  } catch {
    throw new HermesRuntimeInstallError(
      "HERMES_RUNTIME_DOWNLOAD_FAILED",
      "could not download a pinned artifact",
    );
  } finally {
    await handle?.close().catch(() => undefined);
    if (!complete) await rm(destination, { force: true }).catch(() => undefined);
  }
}

export async function switchHermesCurrentPointer(
  runtimeFamilyRoot: string,
  version: typeof HERMES_AGENT_VERSION,
): Promise<void> {
  const temporaryPointer = join(runtimeFamilyRoot, `.current-${randomUUID()}.json`);
  try {
    await writeFile(temporaryPointer, `${JSON.stringify({ schema: 1, version })}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const handle = await open(temporaryPointer, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPointer, join(runtimeFamilyRoot, "current.json"));
  } finally {
    await rm(temporaryPointer, { force: true }).catch(() => undefined);
  }
}

async function verifyDownloadedArtifact(
  artifact: VerifiedHermesRuntimeArtifact,
  sourcePath: string,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const metadata = await lstat(sourcePath);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== artifact.sizeBytes) {
      throw new Error("invalid artifact");
    }
    handle = await open(sourcePath, "r");
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (total < artifact.sizeBytes) {
      const requested = Math.min(buffer.length, artifact.sizeBytes - total);
      const { bytesRead } = await handle.read(buffer, 0, requested, total);
      if (bytesRead === 0) throw new Error("truncated artifact");
      digest.update(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (digest.digest("hex") !== artifact.sha256) throw new Error("artifact hash mismatch");
  } catch {
    throw new HermesRuntimeInstallError(
      "HERMES_RUNTIME_ARTIFACT_INVALID",
      "rejected an artifact that failed integrity verification",
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function validateVerifiedArtifact(artifact: VerifiedHermesRuntimeArtifact): void {
  if (
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.sizeBytes) ||
    artifact.sizeBytes <= 0 ||
    artifact.sizeBytes > MAX_ARTIFACT_BYTES
  ) {
    throw new HermesRuntimeInstallError(
      "HERMES_RUNTIME_INSTALL_INVALID",
      "received invalid artifact metadata",
    );
  }

  if (artifact.source === "remote") {
    let url: URL;
    try {
      url = new URL(artifact.url);
    } catch {
      throw new HermesRuntimeInstallError(
        "HERMES_RUNTIME_INSTALL_INVALID",
        "received an invalid artifact URL",
      );
    }
    if (url.protocol !== "https:" || !isSafeArtifactName(artifact.fileName)) {
      throw new HermesRuntimeInstallError(
        "HERMES_RUNTIME_INSTALL_INVALID",
        "received invalid artifact metadata",
      );
    }
    if (artifact.kind === "hermes-source") validateHermesSourceArtifact(artifact);
    return;
  }

  let provenanceUrl: URL;
  try {
    provenanceUrl = new URL(artifact.provenanceUrl);
  } catch {
    throw new HermesRuntimeInstallError(
      "HERMES_RUNTIME_INSTALL_INVALID",
      "received an invalid artifact URL",
    );
  }
  if (
    artifact.kind !== "requirements-lock" ||
    provenanceUrl.protocol !== "https:" ||
    !isSafeArtifactName(artifact.resourceName)
  ) {
    throw new HermesRuntimeInstallError(
      "HERMES_RUNTIME_INSTALL_INVALID",
      "received invalid artifact metadata",
    );
  }
}

async function copyBundledArtifact(
  artifact: BundledHermesRuntimeArtifact,
  resourcesRoot: string,
  destination: string,
): Promise<void> {
  try {
    const source = join(resourcesRoot, artifact.resourceName);
    const metadata = await lstat(source);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== artifact.sizeBytes) {
      throw new Error("invalid bundled artifact");
    }
    await copyFile(source, destination);
    await chmod(destination, 0o600);
  } catch {
    throw new HermesRuntimeInstallError(
      "HERMES_RUNTIME_ARTIFACT_INVALID",
      "rejected a bundled artifact that failed integrity verification",
    );
  }
}

function artifactFileName(artifact: VerifiedHermesRuntimeArtifact): string {
  return artifact.source === "bundled" ? artifact.resourceName : artifact.fileName;
}

function isSafeArtifactName(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

function defaultHermesResourcesRoot(): string {
  if (typeof process.resourcesPath === "string" && process.resourcesPath.length > 0) {
    return join(process.resourcesPath, "hermes");
  }
  return resolve(process.cwd(), "apps", "desktop", "resources", "hermes");
}

async function assertRealDirectory(directory: string): Promise<void> {
  const metadata = await lstat(directory);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (metadata.mode & 0o022) !== 0 ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    throw new HermesRuntimeInstallError(
      "HERMES_RUNTIME_INSTALL_INVALID",
      "rejected an unsafe runtime directory",
    );
  }
}

async function findActivationTransactionCandidates(
  runtimeFamilyRoot: string,
): Promise<readonly ActivationTransactionCandidate[]> {
  if (!(await pathExists(runtimeFamilyRoot))) return [];
  await assertRealDirectory(runtimeFamilyRoot);

  const candidates: ActivationTransactionCandidate[] = [];
  for (const entry of await readdir(runtimeFamilyRoot)) {
    const kind = activationTransactionKind(entry);
    if (!kind) continue;
    if (!isValidActivationTransactionName(entry, kind)) throw activationRecoveryError();

    const path = join(runtimeFamilyRoot, entry);
    const metadata = await lstat(path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      (metadata.mode & 0o022) !== 0 ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    ) {
      throw activationRecoveryError();
    }
    candidates.push({ kind, path });
  }
  return candidates;
}

function activationTransactionKind(entry: string): ActivationTransactionCandidate["kind"] | null {
  if (
    entry === `.rollback-${HERMES_AGENT_VERSION}` ||
    entry.startsWith(`.rollback-${HERMES_AGENT_VERSION}-`)
  ) {
    return "rollback";
  }
  if (
    entry === `.failed-${HERMES_AGENT_VERSION}` ||
    entry.startsWith(`.failed-${HERMES_AGENT_VERSION}-`)
  ) {
    return "failed";
  }
  return null;
}

function isValidActivationTransactionName(
  entry: string,
  kind: ActivationTransactionCandidate["kind"],
): boolean {
  const prefix = `.${kind}-${HERMES_AGENT_VERSION}-`;
  const identifier = entry.slice(prefix.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(identifier);
}

function activationRecoveryError(): HermesRuntimeInstallError {
  return new HermesRuntimeInstallError(
    "HERMES_RUNTIME_ACTIVATION_FAILED",
    "could not safely recover an interrupted activation",
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function removeManagedRuntimeTree(path: string): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) {
      await removeManagedRuntimeTree(join(path, entry));
    }
  }
  await rm(path, { recursive: true, force: true });
}

function requiredArtifactPath(
  paths: ReadonlyMap<HermesRuntimeArtifactKind, string>,
  kind: HermesRuntimeArtifactKind,
): string {
  const path = paths.get(kind);
  if (!path) {
    throw new HermesRuntimeInstallError(
      "HERMES_RUNTIME_MANIFEST_UNVERIFIED",
      "is missing a required pinned artifact",
    );
  }
  return path;
}

function requiredHermesSourceArtifact(
  artifacts: readonly VerifiedHermesRuntimeArtifact[],
): HermesSourceRuntimeArtifact {
  const source = artifacts.find(
    (artifact): artifact is HermesSourceRuntimeArtifact => artifact.kind === "hermes-source",
  );
  if (!source) {
    throw new HermesRuntimeInstallError(
      "HERMES_RUNTIME_MANIFEST_UNVERIFIED",
      "is missing the pinned Hermes source artifact",
    );
  }
  return source;
}

function validateHermesSourceArtifact(artifact: HermesSourceRuntimeArtifact): void {
  const { skills } = artifact;
  if (
    !skills.archivePrefix.endsWith("/skills/") ||
    skills.archivePrefix.startsWith("/") ||
    skills.archivePrefix.includes("\\") ||
    skills.archivePrefix.split("/").includes("..") ||
    !/^[a-f0-9]{64}$/.test(skills.treeSha256) ||
    !Number.isSafeInteger(skills.fileCount) ||
    skills.fileCount <= 0 ||
    !Number.isSafeInteger(skills.totalBytes) ||
    skills.totalBytes <= 0 ||
    !Number.isSafeInteger(skills.skillManifestCount) ||
    skills.skillManifestCount <= 0 ||
    skills.skillManifestCount > skills.fileCount ||
    !Number.isSafeInteger(skills.executableFileCount) ||
    skills.executableFileCount < 0 ||
    skills.executableFileCount > skills.fileCount ||
    !/^[a-f0-9]{64}$/.test(skills.executablePathsSha256)
  ) {
    throw new HermesRuntimeInstallError(
      "HERMES_RUNTIME_INSTALL_INVALID",
      "received invalid bundled skills audit metadata",
    );
  }
}

function notifyListeners(
  listeners: ReadonlySet<HermesRuntimeInstallProgressListener>,
  progress: HermesRuntimeInstallProgress,
): void {
  for (const listener of listeners) {
    try {
      listener(progress);
    } catch {
      // Progress reporting must never change installation outcome.
    }
  }
}

function observeFlight(
  flight: InstallFlight,
  listener: HermesRuntimeInstallProgressListener | undefined,
): Promise<InstalledHermesRuntime> {
  return flight.promise.then(
    (result) => {
      if (listener) flight.listeners.delete(listener);
      return result;
    },
    (error: unknown) => {
      if (listener) flight.listeners.delete(listener);
      throw error;
    },
  );
}

function toInstalledRuntime(runtimeRoot: string, didInstall: boolean): InstalledHermesRuntime {
  return {
    runtimeRoot,
    pythonExecutable: join(runtimeRoot, "venv", "bin", "python3"),
    bundledSkillsRoot: resolveInstalledHermesBundledSkillsRoot(runtimeRoot),
    version: HERMES_AGENT_VERSION,
    releaseTag: HERMES_RELEASE_TAG,
    didInstall,
  };
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}
