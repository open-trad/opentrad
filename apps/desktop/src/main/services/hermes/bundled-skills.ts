import { createHash } from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { Transform } from "node:stream";
import { createGunzip } from "node:zlib";
import type {
  HermesBundledSkillsAudit,
  HermesSourceRuntimeArtifact,
} from "./runtime-artifact-manifest";

const TAR_BLOCK_BYTES = 512;
const MAX_TAR_METADATA_BYTES = 1024 * 1024;
const READ_ONLY_DIRECTORY_MODE = 0o500;
const READ_ONLY_FILE_MODE = 0o400;
const READ_ONLY_EXECUTABLE_MODE = 0o500;
const BUNDLED_SKILLS_RELATIVE_COMPONENTS = ["share", "hermes", "skills"] as const;

export class HermesBundledSkillsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Managed Hermes bundled skills ${message}`, options);
    this.name = "HermesBundledSkillsError";
  }
}

export interface VerifiedHermesBundledSkills {
  readonly bundledSkillsRoot: string;
  readonly treeSha256: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly skillManifestCount: number;
  readonly executableFileCount: number;
  readonly executablePathsSha256: string;
}

export function resolveInstalledHermesBundledSkillsRoot(runtimeRoot: string): string {
  return join(runtimeRoot, ...BUNDLED_SKILLS_RELATIVE_COMPONENTS);
}

/**
 * Extract only the audited skills subtree from the pinned Hermes source archive.
 *
 * This intentionally does not delegate the skills archive to `tar`: every header is checksum
 * validated, links and special files are rejected, and every output path is rebuilt from safe
 * relative components below a fresh staging directory.
 */
export async function extractVerifiedHermesBundledSkills(
  archivePath: string,
  runtimeRoot: string,
  artifact: HermesSourceRuntimeArtifact,
): Promise<VerifiedHermesBundledSkills> {
  validateSkillsAudit(artifact.skills);
  const bundledSkillsRoot = resolveInstalledHermesBundledSkillsRoot(runtimeRoot);
  const managedParent = resolve(runtimeRoot, "share", "hermes");
  await ensureFreshRealDirectory(managedParent, bundledSkillsRoot);

  const extractor = new SkillsTarExtractor(bundledSkillsRoot, artifact.skills);
  try {
    const archiveDigest = createHash("sha256");
    let archiveBytes = 0;
    const integrityStream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        archiveBytes += chunk.length;
        archiveDigest.update(chunk);
        callback(null, chunk);
      },
    });
    const stream = createReadStream(archivePath).pipe(integrityStream).pipe(createGunzip());
    for await (const chunk of stream) {
      await extractor.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    await extractor.finish();
    if (archiveBytes !== artifact.sizeBytes || archiveDigest.digest("hex") !== artifact.sha256) {
      throw new HermesBundledSkillsError("rejected source archive integrity drift");
    }
    await hardenExtractedSkills(bundledSkillsRoot, extractor.executableFiles);
    await validateManagedSkillsAncestors(runtimeRoot, bundledSkillsRoot);
    const verified = await auditInstalledSkills(bundledSkillsRoot, true);
    assertExpectedAudit(verified, artifact.skills);
    return verified;
  } catch (cause) {
    await extractor.abort();
    await removeManagedSkillsTree(bundledSkillsRoot);
    if (cause instanceof HermesBundledSkillsError) throw cause;
    throw new HermesBundledSkillsError("failed archive extraction or verification", { cause });
  }
}

export async function verifyInstalledHermesBundledSkills(
  runtimeRoot: string,
  artifact: HermesSourceRuntimeArtifact,
): Promise<VerifiedHermesBundledSkills> {
  validateSkillsAudit(artifact.skills);
  const bundledSkillsRoot = resolveInstalledHermesBundledSkillsRoot(runtimeRoot);
  await validateManagedSkillsAncestors(runtimeRoot, bundledSkillsRoot);
  const verified = await auditInstalledSkills(bundledSkillsRoot, true);
  assertExpectedAudit(verified, artifact.skills);
  return verified;
}

interface ActiveTarEntry {
  readonly kind: "ignore" | "metadata" | "file";
  readonly type: string;
  readonly relativePath?: string;
  readonly executable?: boolean;
  readonly metadataChunks?: Buffer[];
  readonly handle?: Awaited<ReturnType<typeof open>>;
  remaining: number;
  padding: number;
}

class SkillsTarExtractor {
  readonly executableFiles = new Set<string>();
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private entry: ActiveTarEntry | undefined;
  private nextPath: string | undefined;
  private zeroBlockCount = 0;
  private sawEndOfArchive = false;
  private extractedFileCount = 0;
  private extractedTotalBytes = 0;

  constructor(
    private readonly root: string,
    private readonly audit: HermesBundledSkillsAudit,
  ) {}

  async push(chunk: Buffer): Promise<void> {
    if (chunk.length === 0) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    await this.processAvailable();
  }

  async finish(): Promise<void> {
    await this.processAvailable();
    if (this.entry || this.buffer.some((byte) => byte !== 0) || this.zeroBlockCount < 2) {
      throw new HermesBundledSkillsError("rejected a truncated tar archive");
    }
    if (!this.sawEndOfArchive) {
      throw new HermesBundledSkillsError("rejected a tar archive without a valid terminator");
    }
    if (
      this.extractedFileCount !== this.audit.fileCount ||
      this.extractedTotalBytes !== this.audit.totalBytes
    ) {
      throw new HermesBundledSkillsError("rejected a skills subtree with unexpected contents");
    }
  }

  async abort(): Promise<void> {
    await this.entry?.handle?.close().catch(() => undefined);
    this.entry = undefined;
  }

  private async processAvailable(): Promise<void> {
    while (true) {
      if (this.entry) {
        if (this.entry.remaining > 0) {
          if (this.buffer.length === 0) return;
          const length = Math.min(this.buffer.length, this.entry.remaining);
          const piece = this.take(length);
          if (this.entry.handle) await this.entry.handle.write(piece);
          this.entry.metadataChunks?.push(piece);
          this.entry.remaining -= length;
          if (this.entry.remaining > 0) return;
        }

        if (this.entry.padding > 0) {
          if (this.buffer.length < this.entry.padding) return;
          const padding = this.take(this.entry.padding);
          if (padding.some((byte) => byte !== 0)) {
            throw new HermesBundledSkillsError("rejected non-zero tar padding");
          }
          this.entry.padding = 0;
        }

        await this.completeEntry(this.entry);
        this.entry = undefined;
        continue;
      }

      if (this.buffer.length < TAR_BLOCK_BYTES) return;
      const header = this.take(TAR_BLOCK_BYTES);
      if (header.every((byte) => byte === 0)) {
        this.zeroBlockCount += 1;
        if (this.zeroBlockCount >= 2) this.sawEndOfArchive = true;
        continue;
      }
      if (this.sawEndOfArchive || this.zeroBlockCount > 0) {
        throw new HermesBundledSkillsError("rejected data after the tar terminator");
      }
      this.entry = await this.startEntry(header);
    }
  }

  private take(length: number): Buffer {
    const result = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return result;
  }

  private async startEntry(header: Buffer): Promise<ActiveTarEntry> {
    verifyTarHeaderChecksum(header);
    const size = parseTarNumber(header.subarray(124, 136), "size");
    const mode = parseTarNumber(header.subarray(100, 108), "mode");
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new HermesBundledSkillsError("rejected an invalid tar entry size");
    }
    const type = decodeTarType(header[156]);
    const headerPath = decodeTarPath(header);
    const archivePath = this.nextPath ?? headerPath;
    if (!isMetadataType(type)) this.nextPath = undefined;
    const padding = (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;

    if (isMetadataType(type)) {
      if (size > MAX_TAR_METADATA_BYTES) {
        throw new HermesBundledSkillsError("rejected oversized tar metadata");
      }
      return { kind: "metadata", type, remaining: size, padding, metadataChunks: [] };
    }

    const relativePath = toSelectedRelativePath(archivePath, this.audit.archivePrefix);
    if (relativePath === undefined) return { kind: "ignore", type, remaining: size, padding };
    if (type === "5") {
      if (size !== 0) throw new HermesBundledSkillsError("rejected a directory with file data");
      if (relativePath !== "") await ensureRelativeDirectory(this.root, relativePath);
      return { kind: "ignore", type, remaining: 0, padding: 0 };
    }
    if (relativePath === "") {
      throw new HermesBundledSkillsError("rejected file data at the skills root");
    }
    if (type !== "0" && type !== "") {
      throw new HermesBundledSkillsError("rejected a link or special file in bundled skills");
    }
    if (size > this.audit.totalBytes || this.extractedTotalBytes + size > this.audit.totalBytes) {
      throw new HermesBundledSkillsError("rejected oversized bundled skill data");
    }
    if (this.extractedFileCount + 1 > this.audit.fileCount) {
      throw new HermesBundledSkillsError("rejected excess bundled skill files");
    }

    const parent = posix.dirname(relativePath);
    if (parent !== ".") await ensureRelativeDirectory(this.root, parent);
    const destination = join(this.root, ...relativePath.split("/"));
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(
        destination,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
    } catch (cause) {
      throw new HermesBundledSkillsError("rejected a duplicate or unsafe output path", { cause });
    }
    const executable = (mode & 0o111) !== 0;
    this.extractedFileCount += 1;
    this.extractedTotalBytes += size;
    if (executable) this.executableFiles.add(relativePath);
    return {
      kind: "file",
      type,
      relativePath,
      executable,
      handle,
      remaining: size,
      padding,
    };
  }

  private async completeEntry(entry: ActiveTarEntry): Promise<void> {
    if (entry.handle) {
      try {
        await entry.handle.sync();
      } finally {
        await entry.handle.close();
      }
    }
    if (entry.kind !== "metadata") return;
    const metadata = Buffer.concat(entry.metadataChunks ?? []);
    if (entry.type === "x") {
      const path = parsePaxPath(metadata);
      if (path) this.nextPath = path;
    } else if (entry.type === "L") {
      this.nextPath = trimTarString(metadata);
    }
  }
}

function validateSkillsAudit(audit: HermesBundledSkillsAudit): void {
  if (
    !isSafeArchivePrefix(audit.archivePrefix) ||
    !/^[a-f0-9]{64}$/.test(audit.treeSha256) ||
    !Number.isSafeInteger(audit.fileCount) ||
    audit.fileCount <= 0 ||
    !Number.isSafeInteger(audit.totalBytes) ||
    audit.totalBytes <= 0 ||
    !Number.isSafeInteger(audit.skillManifestCount) ||
    audit.skillManifestCount <= 0 ||
    audit.skillManifestCount > audit.fileCount ||
    !Number.isSafeInteger(audit.executableFileCount) ||
    audit.executableFileCount < 0 ||
    audit.executableFileCount > audit.fileCount ||
    !/^[a-f0-9]{64}$/.test(audit.executablePathsSha256)
  ) {
    throw new HermesBundledSkillsError("received invalid skills audit metadata");
  }
}

function isSafeArchivePrefix(prefix: string): boolean {
  if (!prefix.endsWith("/") || prefix.startsWith("/") || prefix.includes("\\")) return false;
  const components = prefix.slice(0, -1).split("/");
  return components.length >= 2 && components.every(isSafePathComponent);
}

function toSelectedRelativePath(path: string, prefix: string): string | undefined {
  const directoryPath = prefix.slice(0, -1);
  if (path === directoryPath || path === prefix) return "";
  if (!path.startsWith(prefix)) return undefined;
  const relativePath = path.slice(prefix.length).replace(/\/$/, "");
  if (relativePath.length === 0) return "";
  if (relativePath.includes("\\") || relativePath.startsWith("/")) {
    throw new HermesBundledSkillsError("rejected an unsafe bundled skill path");
  }
  const components = relativePath.split("/");
  if (!components.every(isSafePathComponent)) {
    throw new HermesBundledSkillsError("rejected bundled skill path traversal");
  }
  return components.join("/");
}

function isSafePathComponent(component: string): boolean {
  return (
    component.length > 0 && component !== "." && component !== ".." && !component.includes("\0")
  );
}

function verifyTarHeaderChecksum(header: Buffer): void {
  const expected = parseTarNumber(header.subarray(148, 156), "checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  if (actual !== expected) {
    throw new HermesBundledSkillsError("rejected a tar header checksum mismatch");
  }
}

function parseTarNumber(field: Buffer, label: string): number {
  if ((field[0] ?? 0) & 0x80) {
    throw new HermesBundledSkillsError(`rejected unsupported base-256 tar ${label}`);
  }
  const value = trimTarString(field).trim();
  if (value.length === 0) return 0;
  if (!/^[0-7]+$/.test(value)) {
    throw new HermesBundledSkillsError(`rejected invalid tar ${label}`);
  }
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) {
    throw new HermesBundledSkillsError(`rejected oversized tar ${label}`);
  }
  return parsed;
}

function decodeTarPath(header: Buffer): string {
  const name = trimTarString(header.subarray(0, 100));
  const prefix = trimTarString(header.subarray(345, 500));
  return prefix ? `${prefix}/${name}` : name;
}

function decodeTarType(value: number | undefined): string {
  return !value ? "" : String.fromCharCode(value);
}

function trimTarString(value: Buffer): string {
  const end = value.indexOf(0);
  return value.subarray(0, end < 0 ? value.length : end).toString("utf8");
}

function isMetadataType(type: string): boolean {
  return type === "x" || type === "g" || type === "L" || type === "K";
}

function parsePaxPath(value: Buffer): string | undefined {
  let offset = 0;
  let path: string | undefined;
  while (offset < value.length) {
    const space = value.indexOf(0x20, offset);
    if (space < 0) throw new HermesBundledSkillsError("rejected invalid pax metadata");
    const lengthText = value.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(lengthText)) {
      throw new HermesBundledSkillsError("rejected invalid pax record length");
    }
    const length = Number.parseInt(lengthText, 10);
    if (
      !Number.isSafeInteger(length) ||
      length <= space - offset + 1 ||
      offset + length > value.length
    ) {
      throw new HermesBundledSkillsError("rejected truncated pax metadata");
    }
    const record = value.subarray(space + 1, offset + length - 1).toString("utf8");
    const separator = record.indexOf("=");
    if (separator > 0 && record.slice(0, separator) === "path") path = record.slice(separator + 1);
    offset += length;
  }
  return path;
}

async function ensureFreshRealDirectory(parent: string, destination: string): Promise<void> {
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentMetadata = await lstat(parent);
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new HermesBundledSkillsError("rejected an unsafe managed parent directory");
  }
  try {
    await mkdir(destination, { mode: 0o700 });
  } catch (cause) {
    throw new HermesBundledSkillsError("requires a fresh extraction directory", { cause });
  }
}

async function ensureRelativeDirectory(root: string, relativePath: string): Promise<void> {
  let current = root;
  for (const component of relativePath.split("/")) {
    if (!isSafePathComponent(component)) {
      throw new HermesBundledSkillsError("rejected an unsafe output directory");
    }
    current = join(current, component);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (cause) {
      if (!isNodeError(cause) || cause.code !== "EEXIST") throw cause;
    }
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new HermesBundledSkillsError("rejected a non-directory output component");
    }
  }
}

async function hardenExtractedSkills(
  root: string,
  executables: ReadonlySet<string>,
): Promise<void> {
  const directories: string[] = [];
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    directories.push(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new HermesBundledSkillsError("rejected a symbolic link after extraction");
      }
      if (metadata.isDirectory()) {
        await visit(path, relativePath);
      } else if (metadata.isFile()) {
        await chmod(
          path,
          executables.has(relativePath) ? READ_ONLY_EXECUTABLE_MODE : READ_ONLY_FILE_MODE,
        );
      } else {
        throw new HermesBundledSkillsError("rejected a special file after extraction");
      }
    }
  }
  await visit(root, "");
  for (const directory of directories.reverse()) await chmod(directory, READ_ONLY_DIRECTORY_MODE);
}

async function auditInstalledSkills(
  root: string,
  requireReadOnly: boolean,
): Promise<VerifiedHermesBundledSkills> {
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new HermesBundledSkillsError("rejected a missing or unsafe installed skills root");
  }

  const files: {
    readonly relativePath: string;
    readonly path: string;
    readonly executable: boolean;
  }[] = [];
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const directoryMetadata = await lstat(directory);
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
      throw new HermesBundledSkillsError("rejected an unsafe installed skills directory");
    }
    if (requireReadOnly && (directoryMetadata.mode & 0o777) !== READ_ONLY_DIRECTORY_MODE) {
      throw new HermesBundledSkillsError("rejected writable installed skills metadata");
    }
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new HermesBundledSkillsError("rejected a symbolic link in installed skills");
      }
      if (metadata.isDirectory()) {
        await visit(path, relativePath);
      } else if (metadata.isFile()) {
        const mode = metadata.mode & 0o777;
        if (metadata.nlink !== 1) {
          throw new HermesBundledSkillsError("rejected a hard-linked installed skill file");
        }
        if (requireReadOnly && mode !== READ_ONLY_FILE_MODE && mode !== READ_ONLY_EXECUTABLE_MODE) {
          throw new HermesBundledSkillsError("rejected writable installed skill data");
        }
        files.push({ relativePath, path, executable: mode === READ_ONLY_EXECUTABLE_MODE });
      } else {
        throw new HermesBundledSkillsError("rejected a special file in installed skills");
      }
    }
  }
  await visit(root, "");
  files.sort((left, right) =>
    Buffer.from(left.relativePath).compare(Buffer.from(right.relativePath)),
  );

  const digest = createHash("sha256");
  const executableDigest = createHash("sha256");
  let totalBytes = 0;
  let skillManifestCount = 0;
  let executableFileCount = 0;
  for (const file of files) {
    const contents = await readFile(file.path);
    const pathBytes = Buffer.from(file.relativePath, "utf8");
    const header = Buffer.alloc(12);
    header.writeUInt32BE(pathBytes.length, 0);
    header.writeBigUInt64BE(BigInt(contents.length), 4);
    digest.update(header);
    digest.update(pathBytes);
    digest.update(contents);
    totalBytes += contents.length;
    if (posix.basename(file.relativePath) === "SKILL.md") skillManifestCount += 1;
    if (file.executable) {
      const executableHeader = Buffer.alloc(4);
      executableHeader.writeUInt32BE(pathBytes.length, 0);
      executableDigest.update(executableHeader);
      executableDigest.update(pathBytes);
      executableFileCount += 1;
    }
  }
  return {
    bundledSkillsRoot: root,
    treeSha256: digest.digest("hex"),
    fileCount: files.length,
    totalBytes,
    skillManifestCount,
    executableFileCount,
    executablePathsSha256: executableDigest.digest("hex"),
  };
}

function assertExpectedAudit(
  actual: VerifiedHermesBundledSkills,
  expected: HermesBundledSkillsAudit,
): void {
  if (
    actual.treeSha256 !== expected.treeSha256 ||
    actual.fileCount !== expected.fileCount ||
    actual.totalBytes !== expected.totalBytes ||
    actual.skillManifestCount !== expected.skillManifestCount ||
    actual.executableFileCount !== expected.executableFileCount ||
    actual.executablePathsSha256 !== expected.executablePathsSha256
  ) {
    throw new HermesBundledSkillsError("failed the pinned skills tree audit");
  }
}

async function validateManagedSkillsAncestors(
  runtimeRoot: string,
  bundledSkillsRoot: string,
): Promise<void> {
  const canonicalRuntimeRoot = resolve(runtimeRoot);
  const expectedSkillsRoot = resolveInstalledHermesBundledSkillsRoot(canonicalRuntimeRoot);
  if (runtimeRoot !== canonicalRuntimeRoot || bundledSkillsRoot !== expectedSkillsRoot) {
    throw new HermesBundledSkillsError("rejected a redirected installed skills path");
  }
  for (const path of [
    canonicalRuntimeRoot,
    join(canonicalRuntimeRoot, "share"),
    join(canonicalRuntimeRoot, "share", "hermes"),
    expectedSkillsRoot,
  ]) {
    const metadata = await lstat(path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      (metadata.mode & 0o022) !== 0 ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    ) {
      throw new HermesBundledSkillsError("rejected a linked installed skills ancestor");
    }
  }
}

async function removeManagedSkillsTree(root: string): Promise<void> {
  try {
    await makeTreeWritable(root);
  } catch {
    // The final rm remains fail-safe and is scoped to the fresh staging root.
  }
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

async function makeTreeWritable(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || metadata.isFile()) return;
  if (!metadata.isDirectory()) return;
  await chmod(path, 0o700);
  const entries = await readdir(path);
  for (const entry of entries) await makeTreeWritable(join(path, entry));
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}
