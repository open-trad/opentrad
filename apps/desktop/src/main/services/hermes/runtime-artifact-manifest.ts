import { HERMES_AGENT_VERSION, HERMES_RELEASE_TAG, HERMES_WHEEL_SHA256 } from "./constants";

export const HERMES_CPYTHON_VERSION = "3.12.11";

export type HermesRuntimeArtifactKind =
  | "cpython"
  | "uv"
  | "hermes-wheel"
  | "requirements-lock"
  | "hermes-source";

interface VerifiedHermesRuntimeArtifactBase {
  readonly kind: HermesRuntimeArtifactKind;
  readonly status: "verified";
  readonly sha256: string;
  readonly sizeBytes: number;
}

interface StandardRemoteHermesRuntimeArtifact extends VerifiedHermesRuntimeArtifactBase {
  readonly kind: "cpython" | "uv" | "hermes-wheel" | "requirements-lock";
  readonly source: "remote";
  readonly fileName: string;
  readonly url: string;
}

export interface HermesBundledSkillsAudit {
  /** Exact archive prefix; extraction never accepts a sibling or parent path. */
  readonly archivePrefix: string;
  /** Canonical SHA-256 over every extracted relative path and file body. */
  readonly treeSha256: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly skillManifestCount: number;
  /** Exact executable-path set, independent from file contents. */
  readonly executableFileCount: number;
  readonly executablePathsSha256: string;
}

export interface HermesSourceRuntimeArtifact extends VerifiedHermesRuntimeArtifactBase {
  readonly kind: "hermes-source";
  readonly source: "remote";
  readonly fileName: string;
  readonly url: string;
  readonly skills: HermesBundledSkillsAudit;
}

export type RemoteHermesRuntimeArtifact =
  | StandardRemoteHermesRuntimeArtifact
  | HermesSourceRuntimeArtifact;

export interface BundledHermesRuntimeArtifact extends VerifiedHermesRuntimeArtifactBase {
  readonly source: "bundled";
  readonly resourceName: string;
  readonly provenanceUrl: string;
}

export type VerifiedHermesRuntimeArtifact =
  | RemoteHermesRuntimeArtifact
  | BundledHermesRuntimeArtifact;

export interface UnverifiedHermesRuntimeArtifact {
  readonly kind: HermesRuntimeArtifactKind;
  readonly status: "unverified";
  readonly sourcePage: string;
  readonly reason: string;
}

export type HermesRuntimeArtifact = VerifiedHermesRuntimeArtifact | UnverifiedHermesRuntimeArtifact;

export interface HermesRuntimeArtifactManifest {
  readonly schema: 1;
  readonly platform: "darwin";
  readonly arch: "arm64";
  readonly cpythonVersion: typeof HERMES_CPYTHON_VERSION;
  readonly uvVersion: string | null;
  readonly hermesAgentVersion: typeof HERMES_AGENT_VERSION;
  readonly hermesReleaseTag: typeof HERMES_RELEASE_TAG;
  readonly artifacts: readonly HermesRuntimeArtifact[];
}

/**
 * Every remote URL below is pinned to an upstream release. GitHub's official release API supplies
 * the archive sizes and SHA-256 digests for CPython and uv; PyPI's 0.18.2 release JSON supplies the
 * wheel metadata. The Hermes tag archive and its skills subtree were audited directly. The
 * generated requirements file is bundled with the app and checked before uv sees it.
 */
export const PINNED_HERMES_RUNTIME_MANIFEST = Object.freeze({
  schema: 1,
  platform: "darwin",
  arch: "arm64",
  cpythonVersion: HERMES_CPYTHON_VERSION,
  uvVersion: "0.11.8",
  hermesAgentVersion: HERMES_AGENT_VERSION,
  hermesReleaseTag: HERMES_RELEASE_TAG,
  artifacts: Object.freeze([
    Object.freeze({
      kind: "cpython",
      status: "verified",
      source: "remote",
      fileName: "cpython-3.12.11+20250712-aarch64-apple-darwin-install_only.tar.gz",
      url: "https://releases.astral.sh/github/python-build-standalone/releases/download/20250712/cpython-3.12.11%2B20250712-aarch64-apple-darwin-install_only.tar.gz",
      sha256: "8e8c0c478feefefdfb851d834f87fddb155f9eaf90694cd5a370399e6a8572aa",
      sizeBytes: 15_675_516,
    }),
    Object.freeze({
      kind: "uv",
      status: "verified",
      source: "remote",
      fileName: "uv-aarch64-apple-darwin.tar.gz",
      url: "https://releases.astral.sh/github/uv/releases/download/0.11.8/uv-aarch64-apple-darwin.tar.gz",
      sha256: "c729adb365114e844dd7f9316313a7ed6443b89bb5681d409eebac78b0bd06c8",
      sizeBytes: 20_800_166,
    }),
    Object.freeze({
      kind: "hermes-wheel",
      status: "verified",
      source: "remote",
      fileName: "hermes_agent-0.18.2-py3-none-any.whl",
      url: "https://files.pythonhosted.org/packages/0c/4c/91652c61450763bfe165c65b83026503de0ac9ddad2c11ee522490bf4c2d/hermes_agent-0.18.2-py3-none-any.whl",
      sha256: HERMES_WHEEL_SHA256,
      sizeBytes: 9_569_078,
    }),
    Object.freeze({
      kind: "requirements-lock",
      status: "verified",
      source: "bundled",
      resourceName: "hermes-agent-0.18.2-base-requirements.txt",
      provenanceUrl: "https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/uv.lock",
      sha256: "f852f46604256f6d5a5d4adf550fcfac411756c5dc264414add0361b7d7d8f2d",
      sizeBytes: 57_841,
    }),
    Object.freeze({
      kind: "hermes-source",
      status: "verified",
      source: "remote",
      fileName: "hermes-agent-v2026.7.7.2.tar.gz",
      url: "https://codeload.github.com/NousResearch/hermes-agent/tar.gz/refs/tags/v2026.7.7.2",
      sha256: "f5d1022eed3763a768cf7b0f0844831f0170a35f54eb8d18223f2e93f503025e",
      sizeBytes: 64_174_593,
      skills: Object.freeze({
        archivePrefix: "hermes-agent-2026.7.7.2/skills/",
        treeSha256: "01a1566f62933e845b876fc71814fa4b35e9e2ce48f9f31530df47b9cfc3a09c",
        fileCount: 451,
        totalBytes: 5_939_100,
        skillManifestCount: 72,
        executableFileCount: 17,
        executablePathsSha256: "d9751894675ca578d9d5700e561c3253c7818833534b077b26b9a52bd0e1290a",
      }),
    }),
  ]),
} as const satisfies HermesRuntimeArtifactManifest);
