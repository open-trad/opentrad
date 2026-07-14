import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractVerifiedHermesBundledSkills } from "../src/main/services/hermes/bundled-skills";
import {
  HERMES_AGENT_VERSION,
  HERMES_RELEASE_TAG,
  HERMES_WHEEL_SHA256,
} from "../src/main/services/hermes/constants";
import type { HermesCommandRunner } from "../src/main/services/hermes/installation";
import {
  type HermesRuntimeArtifactKind,
  type HermesRuntimeArtifactManifest,
  PINNED_HERMES_RUNTIME_MANIFEST,
} from "../src/main/services/hermes/runtime-artifact-manifest";
import {
  downloadHermesRuntimeArtifact,
  HermesRuntimeInstaller,
  type HermesRuntimeInstallProgress,
} from "../src/main/services/hermes/runtime-installer";

const temporaryRoots: string[] = [];
const hermesResourcesRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "resources",
  "hermes",
);
const artifactBodies: Readonly<Record<HermesRuntimeArtifactKind, Buffer>> = {
  cpython: Buffer.from("pinned-cpython-archive"),
  uv: Buffer.from("pinned-uv-archive"),
  "hermes-wheel": Buffer.from("pinned-hermes-wheel"),
  "requirements-lock": Buffer.from("dependency==1.0 --hash=sha256:00\n"),
  "hermes-source": createTarGzip([
    {
      name: "hermes-agent-2026.7.7.2/skills/general/example/SKILL.md",
      contents: Buffer.from("---\nname: example\n---\n", "utf8"),
      mode: 0o644,
    },
    {
      name: "hermes-agent-2026.7.7.2/skills/general/example/scripts/run.sh",
      contents: Buffer.from("#!/bin/sh\nexit 0\n", "utf8"),
      mode: 0o755,
    },
  ]),
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (directory) => {
      await makeWritableForCleanup(directory);
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("HermesRuntimeInstaller", () => {
  it.runIf(process.env.OPENTRAD_HERMES_SOURCE_ARCHIVE)(
    "extracts and verifies the audited official bundled skills archive",
    async () => {
      const dataRoot = await createTemporaryDataRoot();
      const source = PINNED_HERMES_RUNTIME_MANIFEST.artifacts.find(
        (artifact) => artifact.kind === "hermes-source",
      );
      if (!source || source.source !== "remote") throw new Error("missing Hermes source artifact");

      await expect(
        extractVerifiedHermesBundledSkills(
          process.env.OPENTRAD_HERMES_SOURCE_ARCHIVE ?? "",
          dataRoot,
          source,
        ),
      ).resolves.toMatchObject({
        treeSha256: source.skills.treeSha256,
        fileCount: 451,
        totalBytes: 5_939_100,
        skillManifestCount: 72,
        executableFileCount: 17,
        executablePathsSha256: "d9751894675ca578d9d5700e561c3253c7818833534b077b26b9a52bd0e1290a",
      });
    },
  );

  it("removes a partial artifact when a download is truncated", async () => {
    const dataRoot = await createTemporaryDataRoot();
    const destination = join(dataRoot, "partial-artifact");
    const artifact = createVerifiedFixtureManifest().artifacts.find(
      (candidate) => candidate.kind === "cpython",
    );
    if (!artifact || artifact.status !== "verified") throw new Error("missing fixture artifact");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(artifactBodies.cpython.subarray(0, -1), {
        status: 200,
      }),
    );

    await expect(
      downloadHermesRuntimeArtifact(artifact, destination, fetchImpl),
    ).rejects.toMatchObject({ code: "HERMES_RUNTIME_DOWNLOAD_FAILED" });
    await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("pins every production artifact and a fully hashed bundled dependency lock", async () => {
    expect(PINNED_HERMES_RUNTIME_MANIFEST.uvVersion).toBe("0.11.8");
    expect(PINNED_HERMES_RUNTIME_MANIFEST.artifacts).toHaveLength(5);
    expect(
      PINNED_HERMES_RUNTIME_MANIFEST.artifacts.every(({ status }) => status === "verified"),
    ).toBe(true);
    expect(PINNED_HERMES_RUNTIME_MANIFEST.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "cpython",
        source: "remote",
        sha256: "8e8c0c478feefefdfb851d834f87fddb155f9eaf90694cd5a370399e6a8572aa",
        sizeBytes: 15_675_516,
      }),
    );
    expect(PINNED_HERMES_RUNTIME_MANIFEST.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "uv",
        source: "remote",
        sha256: "c729adb365114e844dd7f9316313a7ed6443b89bb5681d409eebac78b0bd06c8",
        sizeBytes: 20_800_166,
      }),
    );
    expect(PINNED_HERMES_RUNTIME_MANIFEST.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "hermes-wheel",
        source: "remote",
        sha256: HERMES_WHEEL_SHA256,
        sizeBytes: 9_569_078,
      }),
    );
    expect(PINNED_HERMES_RUNTIME_MANIFEST.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "hermes-source",
        source: "remote",
        fileName: "hermes-agent-v2026.7.7.2.tar.gz",
        url: "https://codeload.github.com/NousResearch/hermes-agent/tar.gz/refs/tags/v2026.7.7.2",
        sha256: "f5d1022eed3763a768cf7b0f0844831f0170a35f54eb8d18223f2e93f503025e",
        sizeBytes: 64_174_593,
        skills: {
          archivePrefix: "hermes-agent-2026.7.7.2/skills/",
          treeSha256: "01a1566f62933e845b876fc71814fa4b35e9e2ce48f9f31530df47b9cfc3a09c",
          fileCount: 451,
          totalBytes: 5_939_100,
          skillManifestCount: 72,
          executableFileCount: 17,
          executablePathsSha256: "d9751894675ca578d9d5700e561c3253c7818833534b077b26b9a52bd0e1290a",
        },
      }),
    );

    const lockArtifact = PINNED_HERMES_RUNTIME_MANIFEST.artifacts.find(
      ({ kind }) => kind === "requirements-lock",
    );
    if (!lockArtifact || lockArtifact.status !== "verified" || lockArtifact.source !== "bundled") {
      throw new Error("missing bundled requirements lock");
    }
    const lock = await readFile(join(hermesResourcesRoot, lockArtifact.resourceName));
    expect(lock).toHaveLength(lockArtifact.sizeBytes);
    expect(createHash("sha256").update(lock).digest("hex")).toBe(lockArtifact.sha256);

    const requirements = lock
      .toString("utf8")
      .split("\n")
      .filter((line) => /^[A-Za-z0-9_.-]+==/.test(line));
    expect(requirements).toHaveLength(65);
    expect(lock.toString("utf8")).not.toMatch(/^hermes-agent==/m);
    for (const requirement of requirements) {
      const start = lock.toString("utf8").indexOf(requirement);
      const next = lock.toString("utf8").indexOf("\n", start) + 1;
      expect(lock.toString("utf8").slice(next, next + 90)).toContain("--hash=sha256:");
    }
  });

  it("fails closed before network or process use when a manifest artifact is unverified", async () => {
    const dataRoot = await createTemporaryDataRoot();
    const downloadArtifact = vi.fn();
    const runner = vi.fn<HermesCommandRunner>();
    const manifest: HermesRuntimeArtifactManifest = {
      ...PINNED_HERMES_RUNTIME_MANIFEST,
      uvVersion: null,
      artifacts: PINNED_HERMES_RUNTIME_MANIFEST.artifacts.map((artifact) =>
        artifact.kind === "cpython"
          ? {
              kind: "cpython",
              status: "unverified" as const,
              sourcePage: "https://github.com/astral-sh/python-build-standalone/releases",
              reason: "test fixture",
            }
          : artifact,
      ),
    };
    const installer = new HermesRuntimeInstaller({
      dataRoot,
      downloadArtifact,
      manifest,
      runner,
    });

    await expect(installer.ensureInstalled()).rejects.toMatchObject({
      name: "HermesRuntimeInstallError",
      code: "HERMES_RUNTIME_MANIFEST_UNVERIFIED",
    });

    expect(downloadArtifact).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("copies and verifies the packaged dependency lock without downloading it", async () => {
    const dataRoot = await createTemporaryDataRoot();
    const resourcesRoot = join(dataRoot, "resources");
    await mkdir(resourcesRoot, { recursive: true });
    await writeFile(
      join(resourcesRoot, "requirements-lock.fixture"),
      artifactBodies["requirements-lock"],
    );
    const fixture = createFixtureDependencies();
    const fixtureManifest = createVerifiedFixtureManifest();
    const manifest: HermesRuntimeArtifactManifest = {
      ...fixtureManifest,
      artifacts: fixtureManifest.artifacts.map((artifact) =>
        artifact.kind === "requirements-lock" && artifact.status === "verified"
          ? {
              kind: "requirements-lock",
              status: "verified" as const,
              source: "bundled" as const,
              resourceName: "requirements-lock.fixture",
              provenanceUrl:
                "https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/uv.lock",
              sha256: artifact.sha256,
              sizeBytes: artifact.sizeBytes,
            }
          : artifact,
      ),
    };
    const installer = new HermesRuntimeInstaller({
      dataRoot,
      resourcesRoot,
      manifest,
      ...fixture,
    });

    await expect(installer.ensureInstalled()).resolves.toMatchObject({ didInstall: true });
    expect(fixture.downloadArtifact).toHaveBeenCalledTimes(4);
    expect(fixture.downloadArtifact).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "requirements-lock" }),
      expect.any(String),
    );
  });

  it("installs through staging, verifies before an atomic current switch, and keeps old versions", async () => {
    const dataRoot = await createTemporaryDataRoot();
    const familyRoot = join(dataRoot, "runtimes", "hermes");
    const oldRoot = join(familyRoot, "0.18.1");
    await mkdir(oldRoot, { recursive: true });
    await writeFile(join(oldRoot, "rollback-marker"), "keep", "utf8");
    await writeFile(
      join(familyRoot, "current.json"),
      `${JSON.stringify({ schema: 1, version: "0.18.1" })}\n`,
      "utf8",
    );
    const fixture = createFixtureDependencies();
    const progress: HermesRuntimeInstallProgress[] = [];
    const installer = new HermesRuntimeInstaller({
      dataRoot,
      manifest: createVerifiedFixtureManifest(),
      ...fixture,
    });

    await expect(installer.ensureInstalled((event) => progress.push(event))).resolves.toEqual({
      runtimeRoot: join(familyRoot, HERMES_AGENT_VERSION),
      pythonExecutable: join(familyRoot, HERMES_AGENT_VERSION, "venv", "bin", "python3"),
      bundledSkillsRoot: join(familyRoot, HERMES_AGENT_VERSION, "share", "hermes", "skills"),
      version: HERMES_AGENT_VERSION,
      releaseTag: HERMES_RELEASE_TAG,
      didInstall: true,
    });

    expect(await readFile(join(oldRoot, "rollback-marker"), "utf8")).toBe("keep");
    expect(JSON.parse(await readFile(join(familyRoot, "current.json"), "utf8"))).toEqual({
      schema: 1,
      version: HERMES_AGENT_VERSION,
    });
    expect(await readdir(familyRoot)).not.toContainEqual(expect.stringMatching(/^\.staging-/));
    expect(await readdir(familyRoot)).not.toContainEqual(expect.stringMatching(/^\.current-/));
    expect(fixture.verifyInstallation).toHaveBeenCalledWith(
      expect.stringMatching(/\.staging-[^/]+\/venv\/bin\/python3$/),
      fixture.runner,
    );
    expect(progress.map(({ phase }) => phase)).toEqual([
      "checking",
      "downloading",
      "verifying-download",
      "downloading",
      "verifying-download",
      "downloading",
      "verifying-download",
      "downloading",
      "verifying-download",
      "downloading",
      "verifying-download",
      "preparing",
      "installing",
      "verifying-runtime",
      "switching",
      "ready",
    ]);

    const commands = fixture.runner.mock.calls.map(([command]) => command);
    expect(commands).toEqual([
      "/usr/bin/tar",
      "/usr/bin/tar",
      expect.stringMatching(/\.staging-[^/]+\/tools\/uv\/uv$/),
      expect.stringMatching(/\.staging-[^/]+\/tools\/uv\/uv$/),
    ]);
    expect(commands).not.toContain("python3");
    expect(commands).not.toContain("/usr/bin/python3");
    const uvCalls = fixture.runner.mock.calls.filter(([command]) =>
      command.endsWith("/tools/uv/uv"),
    );
    expect(uvCalls[0]?.[1]).toEqual(
      expect.arrayContaining(["--no-build", "--no-deps", "--require-hashes"]),
    );
    expect(uvCalls[1]?.[1]).toEqual(expect.arrayContaining(["--no-build", "--no-deps"]));

    const finalPython = join(familyRoot, HERMES_AGENT_VERSION, "venv", "bin", "python3");
    const record = await readFile(
      join(
        familyRoot,
        HERMES_AGENT_VERSION,
        "venv",
        "lib",
        "python3.12",
        "site-packages",
        "hermes_agent-0.18.2.dist-info",
        "RECORD",
      ),
      "utf8",
    );
    expect(record).not.toContain("hermes_agent-0.18.2.dist-info/uv_cache.json");
    await expect(
      lstat(
        join(
          familyRoot,
          HERMES_AGENT_VERSION,
          "venv",
          "lib",
          "python3.12",
          "site-packages",
          "hermes_agent-0.18.2.dist-info",
          "uv_cache.json",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    for (const commandName of ["hermes", "hermes-agent", "hermes-acp"]) {
      const scriptPath = join(familyRoot, HERMES_AGENT_VERSION, "venv", "bin", commandName);
      const script = await readFile(scriptPath, "utf8");
      expect(script).toMatch(new RegExp(`^#!${escapeRegExp(finalPython)}\\n`));
      expect(script).not.toContain("/.staging-");
      expect(record.split("\n")).toContain(
        `../../../bin/${commandName},sha256=${createHash("sha256")
          .update(script)
          .digest("base64url")},${Buffer.byteLength(script, "utf8")}`,
      );
    }

    const bundledSkillsRoot = join(familyRoot, HERMES_AGENT_VERSION, "share", "hermes", "skills");
    expect(
      await readFile(join(bundledSkillsRoot, "general", "example", "SKILL.md"), "utf8"),
    ).toContain("name: example");
    expect((await stat(bundledSkillsRoot)).mode & 0o777).toBe(0o500);
    expect(
      (await stat(join(bundledSkillsRoot, "general", "example", "SKILL.md"))).mode & 0o777,
    ).toBe(0o400);
    expect(
      (await stat(join(bundledSkillsRoot, "general", "example", "scripts", "run.sh"))).mode & 0o777,
    ).toBe(0o500);
  });

  it("reuses only an intact read-only skills tree and atomically repairs later drift", async () => {
    const dataRoot = await createTemporaryDataRoot();
    const manifest = createVerifiedFixtureManifest();
    const firstFixture = createFixtureDependencies();
    const first = new HermesRuntimeInstaller({ dataRoot, manifest, ...firstFixture });
    await expect(first.ensureInstalled()).resolves.toMatchObject({ didInstall: true });

    const noDownload = vi.fn();
    const second = new HermesRuntimeInstaller({
      dataRoot,
      manifest,
      ...createFixtureDependencies(),
      downloadArtifact: noDownload,
    });
    await expect(second.ensureInstalled()).resolves.toMatchObject({ didInstall: false });
    expect(noDownload).not.toHaveBeenCalled();

    const executablePath = join(
      dataRoot,
      "runtimes",
      "hermes",
      HERMES_AGENT_VERSION,
      "share",
      "hermes",
      "skills",
      "general",
      "example",
      "scripts",
      "run.sh",
    );
    await chmod(executablePath, 0o400);

    const modeRepairFixture = createFixtureDependencies();
    const modeRepair = new HermesRuntimeInstaller({
      dataRoot,
      manifest,
      ...modeRepairFixture,
    });
    await expect(modeRepair.ensureInstalled()).resolves.toMatchObject({ didInstall: true });
    expect(modeRepairFixture.downloadArtifact).toHaveBeenCalledTimes(5);
    expect((await stat(executablePath)).mode & 0o777).toBe(0o500);

    const skillPath = join(
      dataRoot,
      "runtimes",
      "hermes",
      HERMES_AGENT_VERSION,
      "share",
      "hermes",
      "skills",
      "general",
      "example",
      "SKILL.md",
    );
    await chmod(skillPath, 0o600);
    await writeFile(skillPath, "tampered", "utf8");

    const repairFixture = createFixtureDependencies();
    const repair = new HermesRuntimeInstaller({ dataRoot, manifest, ...repairFixture });
    await expect(repair.ensureInstalled()).resolves.toMatchObject({ didInstall: true });
    expect(repairFixture.downloadArtifact).toHaveBeenCalledTimes(5);
    expect(await readFile(skillPath, "utf8")).toContain("name: example");
    expect((await stat(skillPath)).mode & 0o777).toBe(0o400);
  });

  it("rejects and atomically repairs console scripts that still target a staging runtime", async () => {
    const dataRoot = await createTemporaryDataRoot();
    const manifest = createVerifiedFixtureManifest();
    await new HermesRuntimeInstaller({
      dataRoot,
      manifest,
      ...createFixtureDependencies(),
    }).ensureInstalled();
    const runtimeRoot = join(dataRoot, "runtimes", "hermes", HERMES_AGENT_VERSION);
    const hermesScript = join(runtimeRoot, "venv", "bin", "hermes");
    await writeFile(
      hermesScript,
      "#!/tmp/.staging-abandoned/venv/bin/python3\nprint('broken')\n",
      "utf8",
    );

    const repairFixture = createFixtureDependencies();
    await expect(
      new HermesRuntimeInstaller({ dataRoot, manifest, ...repairFixture }).ensureInstalled(),
    ).resolves.toMatchObject({ didInstall: true });

    expect(repairFixture.downloadArtifact).toHaveBeenCalledTimes(5);
    expect(await readFile(hermesScript, "utf8")).toMatch(
      new RegExp(`^#!${escapeRegExp(join(runtimeRoot, "venv", "bin", "python3"))}\\n`),
    );
  });

  it("repairs hard-linked skill files and symlinked managed ancestors", async () => {
    const dataRoot = await createTemporaryDataRoot();
    const manifest = createVerifiedFixtureManifest();
    await new HermesRuntimeInstaller({
      dataRoot,
      manifest,
      ...createFixtureDependencies(),
    }).ensureInstalled();

    const runtimeRoot = join(dataRoot, "runtimes", "hermes", HERMES_AGENT_VERSION);
    const skillPath = join(
      runtimeRoot,
      "share",
      "hermes",
      "skills",
      "general",
      "example",
      "SKILL.md",
    );
    const linkedCopy = join(dataRoot, "linked-skill-copy");
    await link(skillPath, linkedCopy);

    const linkRepair = new HermesRuntimeInstaller({
      dataRoot,
      manifest,
      ...createFixtureDependencies(),
    });
    await expect(linkRepair.ensureInstalled()).resolves.toMatchObject({ didInstall: true });
    expect((await lstat(skillPath)).nlink).toBe(1);

    const shareRoot = join(runtimeRoot, "share");
    const redirectedShare = join(dataRoot, "redirected-share");
    await rename(shareRoot, redirectedShare);
    await symlink(redirectedShare, shareRoot, "dir");

    const ancestorRepair = new HermesRuntimeInstaller({
      dataRoot,
      manifest,
      ...createFixtureDependencies(),
    });
    await expect(ancestorRepair.ensureInstalled()).resolves.toMatchObject({ didInstall: true });
    expect((await lstat(shareRoot)).isSymbolicLink()).toBe(false);
  });

  it("repairs writable installed ancestors and rejects an unsafe runtime family root", async () => {
    const dataRoot = await createTemporaryDataRoot();
    const manifest = createVerifiedFixtureManifest();
    await new HermesRuntimeInstaller({
      dataRoot,
      manifest,
      ...createFixtureDependencies(),
    }).ensureInstalled();

    const familyRoot = join(dataRoot, "runtimes", "hermes");
    const shareRoot = join(familyRoot, HERMES_AGENT_VERSION, "share");
    await chmod(shareRoot, 0o777);

    const repairFixture = createFixtureDependencies();
    const repair = new HermesRuntimeInstaller({ dataRoot, manifest, ...repairFixture });
    await expect(repair.ensureInstalled()).resolves.toMatchObject({ didInstall: true });
    expect(repairFixture.downloadArtifact).toHaveBeenCalledTimes(5);
    expect((await stat(shareRoot)).mode & 0o022).toBe(0);

    await chmod(familyRoot, 0o777);
    const noDownload = vi.fn();
    const unsafeFamily = new HermesRuntimeInstaller({
      dataRoot,
      manifest,
      ...createFixtureDependencies(),
      downloadArtifact: noDownload,
    });
    await expect(unsafeFamily.ensureInstalled()).rejects.toMatchObject({
      code: "HERMES_RUNTIME_INSTALL_INVALID",
    });
    expect(noDownload).not.toHaveBeenCalled();
  });

  it("rejects links in the audited skills subtree before activation", async () => {
    const dataRoot = await createTemporaryDataRoot();
    const familyRoot = join(dataRoot, "runtimes", "hermes");
    const maliciousSource = createTarGzip([
      {
        name: "hermes-agent-2026.7.7.2/skills/example/SKILL.md",
        contents: Buffer.from("---\nname: example\n---\n", "utf8"),
        mode: 0o644,
      },
      {
        name: "hermes-agent-2026.7.7.2/skills/example/escape",
        contents: Buffer.alloc(0),
        mode: 0o777,
        type: "2",
        linkName: "../../../../outside",
      },
    ]);
    const fixture = createFixtureDependencies();
    const fixtureManifest = createVerifiedFixtureManifest();
    const manifest: HermesRuntimeArtifactManifest = {
      ...fixtureManifest,
      artifacts: fixtureManifest.artifacts.map((artifact) => {
        if (artifact.kind !== "hermes-source" || artifact.status !== "verified") return artifact;
        return {
          ...artifact,
          sha256: createHash("sha256").update(maliciousSource).digest("hex"),
          sizeBytes: maliciousSource.length,
        };
      }),
    };
    const downloadArtifact = vi.fn(async (artifact, destination) => {
      await writeFile(
        destination,
        artifact.kind === "hermes-source" ? maliciousSource : artifactBodies[artifact.kind],
        { mode: 0o600 },
      );
    });
    const installer = new HermesRuntimeInstaller({
      dataRoot,
      manifest,
      ...fixture,
      downloadArtifact,
    });

    await expect(installer.ensureInstalled()).rejects.toMatchObject({
      code: "HERMES_RUNTIME_ARTIFACT_INVALID",
    });
    await expect(stat(join(familyRoot, HERMES_AGENT_VERSION))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(dataRoot, "outside"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects traversal in the audited skills subtree without writing outside staging", async () => {
    const dataRoot = await createTemporaryDataRoot();
    const familyRoot = join(dataRoot, "runtimes", "hermes");
    const traversalSource = createTarGzip([
      {
        name: "hermes-agent-2026.7.7.2/skills/example/SKILL.md",
        contents: Buffer.from("---\nname: example\n---\n", "utf8"),
        mode: 0o644,
      },
      {
        name: "hermes-agent-2026.7.7.2/skills/../../outside",
        contents: Buffer.from("escape", "utf8"),
        mode: 0o644,
      },
    ]);
    const fixture = createFixtureDependencies();
    const fixtureManifest = createVerifiedFixtureManifest();
    const manifest: HermesRuntimeArtifactManifest = {
      ...fixtureManifest,
      artifacts: fixtureManifest.artifacts.map((artifact) =>
        artifact.kind === "hermes-source" && artifact.status === "verified"
          ? {
              ...artifact,
              sha256: createHash("sha256").update(traversalSource).digest("hex"),
              sizeBytes: traversalSource.length,
            }
          : artifact,
      ),
    };
    const installer = new HermesRuntimeInstaller({
      dataRoot,
      manifest,
      ...fixture,
      downloadArtifact: vi.fn(async (artifact, destination) => {
        await writeFile(
          destination,
          artifact.kind === "hermes-source" ? traversalSource : artifactBodies[artifact.kind],
          { mode: 0o600 },
        );
      }),
    });

    await expect(installer.ensureInstalled()).rejects.toMatchObject({
      code: "HERMES_RUNTIME_ARTIFACT_INVALID",
    });
    await expect(stat(join(familyRoot, "outside"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(dataRoot, "outside"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects hash drift before extraction, cleans staging, and permits a retry", async () => {
    const dataRoot = await createTemporaryDataRoot();
    const familyRoot = join(dataRoot, "runtimes", "hermes");
    const fixture = createFixtureDependencies();
    let corruptFirstDownload = true;
    const downloadArtifact = vi.fn(async (artifact, destination) => {
      const contents = corruptFirstDownload
        ? Buffer.from("hash-drift-canary")
        : artifactBodies[artifact.kind];
      corruptFirstDownload = false;
      await writeFile(destination, contents, { mode: 0o600 });
    });
    const installer = new HermesRuntimeInstaller({
      dataRoot,
      manifest: createVerifiedFixtureManifest(),
      ...fixture,
      downloadArtifact,
    });

    const error = await installer.ensureInstalled().catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      name: "HermesRuntimeInstallError",
      code: "HERMES_RUNTIME_ARTIFACT_INVALID",
    });
    expect(String(error)).not.toContain("canary");
    expect(fixture.runner).not.toHaveBeenCalled();
    expect(await readdir(familyRoot)).not.toContainEqual(expect.stringMatching(/^\.staging-/));

    await expect(installer.ensureInstalled()).resolves.toMatchObject({ didInstall: true });
    expect(downloadArtifact).toHaveBeenCalledTimes(6);
  });

  it("single-flights concurrent callers and reports completion to both listeners", async () => {
    const dataRoot = await createTemporaryDataRoot();
    const fixture = createFixtureDependencies();
    let releaseFirstDownload: (() => void) | undefined;
    const firstDownloadGate = new Promise<void>((resolve) => {
      releaseFirstDownload = resolve;
    });
    let downloadCount = 0;
    const downloadArtifact = vi.fn(async (artifact, destination) => {
      downloadCount += 1;
      if (downloadCount === 1) await firstDownloadGate;
      await writeFile(destination, artifactBodies[artifact.kind], { mode: 0o600 });
    });
    const installer = new HermesRuntimeInstaller({
      dataRoot,
      manifest: createVerifiedFixtureManifest(),
      ...fixture,
      downloadArtifact,
    });
    const firstProgress: string[] = [];
    const secondProgress: string[] = [];

    const first = installer.ensureInstalled(({ phase }) => firstProgress.push(phase));
    const second = installer.ensureInstalled(({ phase }) => secondProgress.push(phase));
    releaseFirstDownload?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual(secondResult);
    expect(downloadArtifact).toHaveBeenCalledTimes(5);
    expect(firstProgress.at(-1)).toBe("ready");
    expect(secondProgress.at(-1)).toBe("ready");
  });

  it("restores the only verified rollback left by an interrupted activation", async () => {
    const dataRoot = await createTemporaryDataRoot();
    const familyRoot = join(dataRoot, "runtimes", "hermes");
    const runtimeRoot = join(familyRoot, HERMES_AGENT_VERSION);
    const rollbackName = `.rollback-${HERMES_AGENT_VERSION}-00000000-0000-4000-8000-000000000001`;
    const rollbackRoot = join(familyRoot, rollbackName);
    const manifest = createVerifiedFixtureManifest();
    await new HermesRuntimeInstaller({
      dataRoot,
      manifest,
      ...createFixtureDependencies(),
    }).ensureInstalled();
    await rename(runtimeRoot, rollbackRoot);

    const noDownload = vi.fn();
    const switchCurrentPointer = vi.fn(async () => undefined);
    const recovery = new HermesRuntimeInstaller({
      dataRoot,
      manifest,
      ...createFixtureDependencies(),
      downloadArtifact: noDownload,
      switchCurrentPointer,
    });

    await expect(recovery.ensureInstalled()).resolves.toMatchObject({
      runtimeRoot,
      didInstall: false,
    });
    expect(noDownload).not.toHaveBeenCalled();
    expect(switchCurrentPointer).toHaveBeenCalledWith(familyRoot, HERMES_AGENT_VERSION);
    expect(
      await readFile(
        join(runtimeRoot, "share", "hermes", "skills", "general", "example", "SKILL.md"),
        "utf8",
      ),
    ).toContain("name: example");
    expect(await readdir(familyRoot)).not.toContain(rollbackName);
  });

  it("restores a verified rollback and removes the failed new runtime left by the same activation", async () => {
    const dataRoot = await createTemporaryDataRoot();
    const familyRoot = join(dataRoot, "runtimes", "hermes");
    const runtimeRoot = join(familyRoot, HERMES_AGENT_VERSION);
    const rollbackName = `.rollback-${HERMES_AGENT_VERSION}-00000000-0000-4000-8000-000000000011`;
    const failedName = `.failed-${HERMES_AGENT_VERSION}-00000000-0000-4000-8000-000000000012`;
    const rollbackRoot = join(familyRoot, rollbackName);
    const failedRoot = join(familyRoot, failedName);
    const manifest = createVerifiedFixtureManifest();
    await new HermesRuntimeInstaller({
      dataRoot,
      manifest,
      ...createFixtureDependencies(),
    }).ensureInstalled();
    await rename(runtimeRoot, rollbackRoot);
    await mkdir(failedRoot);
    await writeFile(join(failedRoot, "unverified-new-runtime"), "discard", "utf8");

    const noDownload = vi.fn();
    const recovery = new HermesRuntimeInstaller({
      dataRoot,
      manifest,
      ...createFixtureDependencies(),
      downloadArtifact: noDownload,
    });

    await expect(recovery.ensureInstalled()).resolves.toMatchObject({
      runtimeRoot,
      didInstall: false,
    });
    expect(noDownload).not.toHaveBeenCalled();
    expect(await readdir(familyRoot)).not.toContain(rollbackName);
    expect(await readdir(familyRoot)).not.toContain(failedName);
    expect(
      await readFile(
        join(runtimeRoot, "share", "hermes", "skills", "general", "example", "SKILL.md"),
        "utf8",
      ),
    ).toContain("name: example");
  });

  it.each([
    "rollback",
    "failed",
  ] as const)("cleans a safe leftover %s transaction when the target runtime is complete", async (kind) => {
    const dataRoot = await createTemporaryDataRoot();
    const familyRoot = join(dataRoot, "runtimes", "hermes");
    const manifest = createVerifiedFixtureManifest();
    await new HermesRuntimeInstaller({
      dataRoot,
      manifest,
      ...createFixtureDependencies(),
    }).ensureInstalled();
    const transactionName = `.${kind}-${HERMES_AGENT_VERSION}-00000000-0000-4000-8000-000000000002`;
    await mkdir(join(familyRoot, transactionName));

    const noDownload = vi.fn();
    const recovery = new HermesRuntimeInstaller({
      dataRoot,
      manifest,
      ...createFixtureDependencies(),
      downloadArtifact: noDownload,
    });

    await expect(recovery.ensureInstalled()).resolves.toMatchObject({ didInstall: false });
    expect(noDownload).not.toHaveBeenCalled();
    expect(await readdir(familyRoot)).not.toContain(transactionName);
  });

  it("rejects a symlinked activation transaction without touching its target", async () => {
    const dataRoot = await createTemporaryDataRoot();
    const familyRoot = join(dataRoot, "runtimes", "hermes");
    const outsideRoot = join(dataRoot, "outside-rollback");
    const rollbackRoot = join(
      familyRoot,
      `.rollback-${HERMES_AGENT_VERSION}-00000000-0000-4000-8000-000000000003`,
    );
    await mkdir(familyRoot, { recursive: true });
    await mkdir(outsideRoot);
    await writeFile(join(outsideRoot, "canary"), "keep", "utf8");
    await symlink(outsideRoot, rollbackRoot);
    const fixture = createFixtureDependencies();
    const installer = new HermesRuntimeInstaller({
      dataRoot,
      manifest: createVerifiedFixtureManifest(),
      ...fixture,
    });

    await expect(installer.ensureInstalled()).rejects.toMatchObject({
      code: "HERMES_RUNTIME_ACTIVATION_FAILED",
    });
    expect(fixture.downloadArtifact).not.toHaveBeenCalled();
    expect(fixture.runner).not.toHaveBeenCalled();
    expect(await readFile(join(outsideRoot, "canary"), "utf8")).toBe("keep");
  });

  it("rejects multiple activation transaction candidates before recovery", async () => {
    const dataRoot = await createTemporaryDataRoot();
    const familyRoot = join(dataRoot, "runtimes", "hermes");
    await mkdir(
      join(familyRoot, `.rollback-${HERMES_AGENT_VERSION}-00000000-0000-4000-8000-000000000004`),
      { recursive: true },
    );
    await mkdir(
      join(familyRoot, `.rollback-${HERMES_AGENT_VERSION}-00000000-0000-4000-8000-000000000005`),
    );
    const fixture = createFixtureDependencies();
    const installer = new HermesRuntimeInstaller({
      dataRoot,
      manifest: createVerifiedFixtureManifest(),
      ...fixture,
    });

    await expect(installer.ensureInstalled()).rejects.toMatchObject({
      code: "HERMES_RUNTIME_ACTIVATION_FAILED",
    });
    expect(fixture.downloadArtifact).not.toHaveBeenCalled();
    expect(fixture.runner).not.toHaveBeenCalled();
  });

  it("propagates an interrupted-activation restore failure and preserves the rollback", async () => {
    const dataRoot = await createTemporaryDataRoot();
    const familyRoot = join(dataRoot, "runtimes", "hermes");
    const runtimeRoot = join(familyRoot, HERMES_AGENT_VERSION);
    const rollbackName = `.rollback-${HERMES_AGENT_VERSION}-00000000-0000-4000-8000-000000000006`;
    const rollbackRoot = join(familyRoot, rollbackName);
    const manifest = createVerifiedFixtureManifest();
    await new HermesRuntimeInstaller({
      dataRoot,
      manifest,
      ...createFixtureDependencies(),
    }).ensureInstalled();
    await rename(runtimeRoot, rollbackRoot);
    await chmod(familyRoot, 0o500);

    const noDownload = vi.fn();
    const recovery = new HermesRuntimeInstaller({
      dataRoot,
      manifest,
      ...createFixtureDependencies(),
      downloadArtifact: noDownload,
    });

    await expect(recovery.ensureInstalled()).rejects.toMatchObject({
      code: "HERMES_RUNTIME_ACTIVATION_FAILED",
    });
    await chmod(familyRoot, 0o700);
    expect(noDownload).not.toHaveBeenCalled();
    expect(await readdir(familyRoot)).toContain(rollbackName);
    await expect(stat(runtimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("propagates leftover cleanup failure instead of reporting the runtime ready", async () => {
    const dataRoot = await createTemporaryDataRoot();
    const familyRoot = join(dataRoot, "runtimes", "hermes");
    const rollbackName = `.rollback-${HERMES_AGENT_VERSION}-00000000-0000-4000-8000-000000000007`;
    const manifest = createVerifiedFixtureManifest();
    await new HermesRuntimeInstaller({
      dataRoot,
      manifest,
      ...createFixtureDependencies(),
    }).ensureInstalled();
    await mkdir(join(familyRoot, rollbackName));
    await chmod(familyRoot, 0o500);

    const noDownload = vi.fn();
    const recovery = new HermesRuntimeInstaller({
      dataRoot,
      manifest,
      ...createFixtureDependencies(),
      downloadArtifact: noDownload,
    });

    await expect(recovery.ensureInstalled()).rejects.toMatchObject({
      code: "HERMES_RUNTIME_ACTIVATION_FAILED",
    });
    await chmod(familyRoot, 0o700);
    expect(noDownload).not.toHaveBeenCalled();
    expect(await readdir(familyRoot)).toContain(rollbackName);
  });

  it("restores an existing target and pointer when activation fails after the new runtime rename", async () => {
    const dataRoot = await createTemporaryDataRoot();
    const familyRoot = join(dataRoot, "runtimes", "hermes");
    const finalRoot = join(familyRoot, HERMES_AGENT_VERSION);
    const currentPath = join(familyRoot, "current.json");
    await mkdir(join(finalRoot, "venv", "bin"), { recursive: true });
    await writeFile(join(finalRoot, "old-marker"), "old", "utf8");
    await writeFile(currentPath, `${JSON.stringify({ schema: 1, version: "0.18.1" })}\n`, "utf8");
    const fixture = createFixtureDependencies({ rejectExistingTarget: finalRoot });
    const installer = new HermesRuntimeInstaller({
      dataRoot,
      manifest: createVerifiedFixtureManifest(),
      ...fixture,
      switchCurrentPointer: vi.fn(async () => {
        throw new Error("activation-failure-canary");
      }),
    });

    const error = await installer.ensureInstalled().catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      name: "HermesRuntimeInstallError",
      code: "HERMES_RUNTIME_ACTIVATION_FAILED",
    });
    expect(String(error)).not.toContain("canary");
    expect(await readFile(join(finalRoot, "old-marker"), "utf8")).toBe("old");
    expect(JSON.parse(await readFile(currentPath, "utf8"))).toEqual({
      schema: 1,
      version: "0.18.1",
    });
    expect(await readdir(familyRoot)).not.toContainEqual(expect.stringMatching(/^\.staging-/));
    expect(await readdir(familyRoot)).not.toContainEqual(expect.stringMatching(/^\.rollback-/));
  });
});

async function createTemporaryDataRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opentrad-hermes-installer-"));
  temporaryRoots.push(root);
  return root;
}

function createVerifiedFixtureManifest(): HermesRuntimeArtifactManifest {
  return {
    schema: 1,
    platform: "darwin",
    arch: "arm64",
    cpythonVersion: "3.12.11",
    uvVersion: "0.7.12-test-fixture",
    hermesAgentVersion: HERMES_AGENT_VERSION,
    hermesReleaseTag: HERMES_RELEASE_TAG,
    artifacts: (
      ["cpython", "uv", "hermes-wheel", "requirements-lock", "hermes-source"] as const
    ).map((kind) => {
      const contents = artifactBodies[kind];
      if (kind === "hermes-source") {
        return {
          kind,
          status: "verified" as const,
          source: "remote" as const,
          fileName: `${kind}.fixture`,
          url: `https://example.invalid/${kind}.fixture`,
          sha256: createHash("sha256").update(contents).digest("hex"),
          sizeBytes: contents.length,
          skills: {
            archivePrefix: "hermes-agent-2026.7.7.2/skills/",
            treeSha256: computeFixtureSkillsTreeSha256(),
            fileCount: 2,
            totalBytes: 39,
            skillManifestCount: 1,
            executableFileCount: 1,
            executablePathsSha256: computeFixtureExecutablePathsSha256(),
          },
        };
      }
      return {
        kind,
        status: "verified" as const,
        source: "remote" as const,
        fileName: `${kind}.fixture`,
        url: `https://example.invalid/${kind}.fixture`,
        sha256: createHash("sha256").update(contents).digest("hex"),
        sizeBytes: contents.length,
      };
    }),
  };
}

interface TarFixtureEntry {
  readonly name: string;
  readonly contents: Buffer;
  readonly mode: number;
  readonly type?: "0" | "2";
  readonly linkName?: string;
}

function createTarGzip(entries: readonly TarFixtureEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    writeTarString(header, 0, 100, entry.name);
    writeTarOctal(header, 100, 8, entry.mode);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, entry.contents.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = (entry.type ?? "0").charCodeAt(0);
    writeTarString(header, 157, 100, entry.linkName ?? "");
    writeTarString(header, 257, 6, "ustar");
    writeTarString(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeTarOctal(header, 148, 8, checksum);
    blocks.push(header, entry.contents);
    const padding = (512 - (entry.contents.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9, mtime: 0 });
}

function writeTarString(target: Buffer, offset: number, length: number, value: string): void {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > length) throw new Error(`tar fixture field is too long: ${value}`);
  encoded.copy(target, offset);
}

function writeTarOctal(target: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 2, "0");
  target.write(`${encoded}\0 `, offset, length, "ascii");
}

function computeFixtureSkillsTreeSha256(): string {
  const files = [
    ["general/example/SKILL.md", Buffer.from("---\nname: example\n---\n", "utf8")],
    ["general/example/scripts/run.sh", Buffer.from("#!/bin/sh\nexit 0\n", "utf8")],
  ] as const;
  const digest = createHash("sha256");
  for (const [relativePath, contents] of files) {
    const pathBytes = Buffer.from(relativePath, "utf8");
    const header = Buffer.alloc(12);
    header.writeUInt32BE(pathBytes.length, 0);
    header.writeBigUInt64BE(BigInt(contents.length), 4);
    digest.update(header);
    digest.update(pathBytes);
    digest.update(contents);
  }
  return digest.digest("hex");
}

function computeFixtureExecutablePathsSha256(): string {
  const path = Buffer.from("general/example/scripts/run.sh", "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(path.length, 0);
  return createHash("sha256").update(header).update(path).digest("hex");
}

async function makeWritableForCleanup(path: string): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch {
    return;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
  await chmod(path, 0o700);
  for (const entry of await readdir(path)) await makeWritableForCleanup(join(path, entry));
}

function createFixtureDependencies(options?: { readonly rejectExistingTarget?: string }) {
  const downloadArtifact = vi.fn(async (artifact, destination) => {
    await writeFile(destination, artifactBodies[artifact.kind], { mode: 0o600 });
  });
  const runner = vi.fn<HermesCommandRunner>(async (command, args) => {
    if (command === "/usr/bin/tar") {
      const destinationIndex = args.indexOf("-C") + 1;
      const destination = args[destinationIndex];
      if (!destination) throw new Error("missing fixture extraction destination");
      if (destination.endsWith("/venv")) {
        await mkdir(join(destination, "bin"), { recursive: true });
        await writeFile(join(destination, "bin", "python3"), "managed-python", { mode: 0o700 });
      } else {
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, "uv"), "managed-uv", { mode: 0o700 });
      }
    }
    if (command.endsWith("/tools/uv/uv") && args.at(-1)?.includes("hermes-wheel")) {
      const pythonIndex = args.indexOf("--python") + 1;
      const pythonExecutable = args[pythonIndex];
      if (!pythonExecutable) throw new Error("missing fixture Python executable");
      const binRoot = dirname(pythonExecutable);
      const generatedRows: string[] = [];
      for (const commandName of ["hermes", "hermes-agent", "hermes-acp"]) {
        const contents = `#!${pythonExecutable}\nprint('managed Hermes')\n`;
        await writeFile(join(binRoot, commandName), contents, { mode: 0o700 });
        generatedRows.push(
          `../../../bin/${commandName},sha256=${createHash("sha256")
            .update(contents)
            .digest("base64url")},${Buffer.byteLength(contents, "utf8")}`,
        );
      }
      const distInfo = join(
        dirname(binRoot),
        "lib",
        "python3.12",
        "site-packages",
        "hermes_agent-0.18.2.dist-info",
      );
      await mkdir(distInfo, { recursive: true });
      const uvCacheContents = `${JSON.stringify({ timestamp: { secs_since_epoch: 1 } })}\n`;
      await writeFile(join(distInfo, "uv_cache.json"), uvCacheContents, { mode: 0o600 });
      generatedRows.push(
        `hermes_agent-0.18.2.dist-info/uv_cache.json,sha256=${createHash("sha256")
          .update(uvCacheContents)
          .digest("base64url")},${Buffer.byteLength(uvCacheContents, "utf8")}`,
      );
      await writeFile(join(distInfo, "RECORD"), `${generatedRows.join("\n")}\n`, {
        mode: 0o600,
      });
    }
    return { stdout: "" };
  });
  const verifyInstallation = vi.fn(async (pythonExecutable: string) => {
    if (
      options?.rejectExistingTarget &&
      pythonExecutable === join(options.rejectExistingTarget, "venv", "bin", "python3")
    ) {
      throw new Error("existing target is not verified");
    }
    return {
      pythonExecutable,
      version: HERMES_AGENT_VERSION,
      releaseTag: HERMES_RELEASE_TAG,
    } as const;
  });
  return { downloadArtifact, runner, verifyInstallation };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
