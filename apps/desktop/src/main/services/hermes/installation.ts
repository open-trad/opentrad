import { HERMES_AGENT_VERSION, HERMES_RELEASE_TAG } from "./constants";

export const HERMES_SOURCE_CONTRACT = Object.freeze({
  "tui_gateway/server.py": "cb51fc44ded4dad584a1f19c55a4bfa11a88ed10e2f4f0952d886e748d470eb1",
  "tui_gateway/transport.py": "75be87f545aeaffce9c2c72854fecc74e564de00df2c1cfb739ac4befaf30c8d",
  "hermes_cli/plugins.py": "3eeb699cae4e93a15c83bb4bef111ddc8ede6f2deb54176bf815666afc57cdac",
});

export const HERMES_RECORD_CANONICAL_SHA256 =
  "9243f13f4f767ead25ef5079ddd3b4969cfa84918d902e86172dc8439084e6c4";
export const HERMES_RECORD_ENTRY_COUNT = 921;

export const HERMES_INSTALLATION_QUERY = `
import base64
import csv
import hashlib
import io
import json
import pathlib
import re
import sys

EXPECTED_VERSION = ${JSON.stringify(HERMES_AGENT_VERSION)}
EXPECTED_RELEASE_TAG = ${JSON.stringify(HERMES_RELEASE_TAG)}
EXPECTED_FILES = ${JSON.stringify(HERMES_SOURCE_CONTRACT)}
EXPECTED_DIST_INFO = "hermes_agent-0.18.2.dist-info"
EXPECTED_RECORD_PATH = EXPECTED_DIST_INFO + "/RECORD"
EXPECTED_RECORD_CANONICAL_SHA256 = ${JSON.stringify(HERMES_RECORD_CANONICAL_SHA256)}
EXPECTED_RECORD_ENTRIES = ${HERMES_RECORD_ENTRY_COUNT}
DATA_PREFIX = "hermes_agent-0.18.2.data/data/"
GENERATED_RECORD_ROWS = {
    "hermes_agent-0.18.2.dist-info/INSTALLER",
    "hermes_agent-0.18.2.dist-info/REQUESTED",
    "hermes_agent-0.18.2.dist-info/direct_url.json",
    "../../../bin/hermes",
    "../../../bin/hermes-acp",
    "../../../bin/hermes-agent",
}
GENERATED_SITE_PACKAGE_ROWS = {
    value for value in GENERATED_RECORD_ROWS if not value.startswith("../../../")
}
SUPPORTED_PYTHONS = {(3, 11), (3, 12), (3, 13)}
MAX_RECORD_BYTES = 128 * 1024
MAX_FILE_BYTES = 4 * 1024 * 1024
MAX_TOTAL_BYTES = 40 * 1024 * 1024
MAX_METADATA_BYTES = 1024 * 1024
MAX_RELATIVE_PATH_CHARS = 1024

def _runtime_paths():
    executable = pathlib.Path(sys.executable)
    venv_root = executable.parent.parent
    if sys.platform == "win32":
        scripts_dir = "Scripts"
        if executable.parent.name.lower() != scripts_dir.lower():
            raise RuntimeError("invalid managed runtime")
        return venv_root / "Lib" / "site-packages", venv_root
    if executable.parent.name != "bin":
        raise RuntimeError("invalid managed runtime")
    return venv_root / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages", venv_root

def _dist_info(site_packages):
    candidates = []
    for candidate in site_packages.iterdir():
        if re.fullmatch(r"hermes[-_.]+agent[-_.].+\\.dist-info", candidate.name, re.IGNORECASE):
            candidates.append(candidate)
    if len(candidates) != 1:
        raise RuntimeError("invalid managed runtime")
    candidate = candidates[0]
    if candidate.name != EXPECTED_DIST_INFO or candidate.is_symlink() or not candidate.is_dir():
        raise RuntimeError("invalid managed runtime")
    return candidate

def _reserve_read(budget, size, maximum):
    if not isinstance(size, int) or size < 0 or size > maximum:
        raise RuntimeError("invalid managed runtime")
    if budget[0] + size > MAX_TOTAL_BYTES:
        raise RuntimeError("invalid managed runtime")
    budget[0] += size

def _read_exact(source_file, expected_size, maximum, budget):
    if source_file.is_symlink() or not source_file.is_file():
        raise RuntimeError("invalid managed runtime")
    if source_file.stat().st_size != expected_size:
        raise RuntimeError("invalid managed runtime")
    _reserve_read(budget, expected_size, maximum)
    with source_file.open("rb") as stream:
        data = stream.read(expected_size + 1)
    if len(data) != expected_size:
        raise RuntimeError("invalid managed runtime")
    return data

def _record_bytes(dist_info, budget):
    record_file = dist_info / "RECORD"
    if record_file.is_symlink() or not record_file.is_file():
        raise RuntimeError("invalid managed runtime")
    record_size = record_file.stat().st_size
    record = _read_exact(record_file, record_size, MAX_RECORD_BYTES, budget)
    return record

def _safe_relative_path(relative_name):
    if not relative_name or len(relative_name) > MAX_RELATIVE_PATH_CHARS:
        raise RuntimeError("invalid managed runtime")
    if "\\\\" in relative_name or ":" in relative_name or "\\x00" in relative_name:
        raise RuntimeError("invalid managed runtime")
    components = relative_name.split("/")
    if any(not component or component in {".", ".."} for component in components):
        raise RuntimeError("invalid managed runtime")
    path = pathlib.PurePosixPath(relative_name)
    if path.is_absolute() or path.as_posix() != relative_name:
        raise RuntimeError("invalid managed runtime")
    return components

def _source_file(root, relative_name):
    current = root
    for component in _safe_relative_path(relative_name):
        current = current / component
        if current.is_symlink():
            raise RuntimeError("invalid managed runtime")
    if not current.is_file():
        raise RuntimeError("invalid managed runtime")
    return current

def _record_digest(encoded):
    if len(encoded) != 43:
        raise RuntimeError("invalid managed runtime")
    try:
        digest = base64.urlsafe_b64decode(encoded + "=")
    except Exception as error:
        raise RuntimeError("invalid managed runtime") from error
    canonical = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    if len(digest) != 32 or canonical != encoded:
        raise RuntimeError("invalid managed runtime")
    return digest

def _record_size(raw_size):
    if not raw_size or not raw_size.isascii() or not raw_size.isdecimal():
        raise RuntimeError("invalid managed runtime")
    size = int(raw_size)
    if str(size) != raw_size or size > MAX_FILE_BYTES:
        raise RuntimeError("invalid managed runtime")
    return size

def _hash_file(source_file, expected_size, budget):
    if source_file.is_symlink() or not source_file.is_file():
        raise RuntimeError("invalid managed runtime")
    if source_file.stat().st_size != expected_size:
        raise RuntimeError("invalid managed runtime")
    _reserve_read(budget, expected_size, MAX_FILE_BYTES)
    digest = hashlib.sha256()
    bytes_read = 0
    with source_file.open("rb") as stream:
        while True:
            remaining = expected_size + 1 - bytes_read
            if remaining <= 0:
                raise RuntimeError("invalid managed runtime")
            chunk = stream.read(min(64 * 1024, remaining))
            if not chunk:
                break
            bytes_read += len(chunk)
            if bytes_read > expected_size:
                raise RuntimeError("invalid managed runtime")
            digest.update(chunk)
    if bytes_read != expected_size:
        raise RuntimeError("invalid managed runtime")
    return digest.digest()

def _reject_source_bytecode(source_file):
    legacy_bytecode = source_file.with_suffix(".pyc")
    if legacy_bytecode.exists() or legacy_bytecode.is_symlink():
        raise RuntimeError("invalid managed runtime")
    cache_dir = source_file.parent / "__pycache__"
    if cache_dir.is_symlink():
        raise RuntimeError("invalid managed runtime")
    if cache_dir.is_dir():
        prefix = source_file.stem + "."
        for candidate in cache_dir.iterdir():
            if candidate.name.startswith(prefix) and candidate.name.endswith(".pyc"):
                raise RuntimeError("invalid managed runtime")

def _canonical_record_bytes(rows):
    stream = io.StringIO(newline="")
    csv.writer(stream, lineterminator="\\n").writerows(sorted(rows, key=lambda row: row[0]))
    return stream.getvalue().encode("utf-8")

def _verify_record(site_packages, venv_root, record, budget):
    try:
        rows = list(csv.reader(io.StringIO(record.decode("utf-8"), newline=""), strict=True))
    except Exception as error:
        raise RuntimeError("invalid managed runtime") from error
    seen_installed = set()
    seen_canonical = set()
    generated_seen = set()
    recorded_sizes = {}
    canonical_rows = []
    record_rows = 0
    for row in rows:
        if len(row) != 3:
            raise RuntimeError("invalid managed runtime")
        installed_name, hash_spec, raw_size = row
        installed_key = installed_name.casefold()
        if installed_key in seen_installed:
            raise RuntimeError("invalid managed runtime")
        seen_installed.add(installed_key)
        if installed_name.endswith(".pyc") or "/__pycache__/" in installed_name:
            raise RuntimeError("invalid managed runtime")
        if installed_name in GENERATED_RECORD_ROWS:
            if not hash_spec.startswith("sha256=") or not raw_size:
                raise RuntimeError("invalid managed runtime")
            expected_digest = _record_digest(hash_spec.removeprefix("sha256="))
            expected_size = _record_size(raw_size)
            if installed_name.startswith("../../../"):
                generated_name = installed_name.removeprefix("../../../")
                _safe_relative_path(generated_name)
                generated_root = venv_root
            else:
                generated_name = installed_name
                generated_root = site_packages
            generated_file = _source_file(generated_root, generated_name)
            if _hash_file(generated_file, expected_size, budget) != expected_digest:
                raise RuntimeError("invalid managed runtime")
            generated_seen.add(installed_name)
            continue
        if installed_name.startswith("../../../"):
            relocated_name = installed_name.removeprefix("../../../")
            _safe_relative_path(relocated_name)
            relative_name = DATA_PREFIX + relocated_name
            source_root = venv_root
            source_name = relocated_name
        else:
            relative_name = installed_name
            source_root = site_packages
            source_name = installed_name
        _safe_relative_path(relative_name)
        duplicate_key = relative_name.casefold()
        if duplicate_key in seen_canonical:
            raise RuntimeError("invalid managed runtime")
        seen_canonical.add(duplicate_key)
        if relative_name == EXPECTED_RECORD_PATH:
            if hash_spec or raw_size:
                raise RuntimeError("invalid managed runtime")
            record_rows += 1
            canonical_rows.append([relative_name, "", ""])
            continue
        if not hash_spec.startswith("sha256="):
            raise RuntimeError("invalid managed runtime")
        expected_digest = _record_digest(hash_spec.removeprefix("sha256="))
        expected_size = _record_size(raw_size)
        source_file = _source_file(source_root, source_name)
        if source_root == site_packages and relative_name.endswith(".py"):
            _reject_source_bytecode(source_file)
        if _hash_file(source_file, expected_size, budget) != expected_digest:
            raise RuntimeError("invalid managed runtime")
        recorded_sizes[relative_name] = expected_size
        canonical_rows.append([relative_name, hash_spec, raw_size])
    if (
        generated_seen != GENERATED_RECORD_ROWS
        or record_rows != 1
        or len(canonical_rows) != EXPECTED_RECORD_ENTRIES
    ):
        raise RuntimeError("invalid managed runtime")
    canonical_record = _canonical_record_bytes(canonical_rows)
    if hashlib.sha256(canonical_record).hexdigest() != EXPECTED_RECORD_CANONICAL_SHA256:
        raise RuntimeError("invalid managed runtime")
    return recorded_sizes

def _verify_owned_tree(site_packages, recorded_sizes):
    allowed_files = set(recorded_sizes)
    allowed_files.add(EXPECTED_RECORD_PATH)
    allowed_files.update(GENERATED_SITE_PACKAGE_ROWS)
    allowed_files = {
        value for value in allowed_files if not value.startswith(DATA_PREFIX)
    }
    allowed_directories = set()
    for relative_name in allowed_files:
        parent = pathlib.PurePosixPath(relative_name).parent
        while parent != pathlib.PurePosixPath("."):
            allowed_directories.add(parent.as_posix())
            parent = parent.parent

    owned_roots = {value.split("/", 1)[0] for value in allowed_files}
    top_level_modules = {
        pathlib.PurePosixPath(value).stem.casefold()
        for value in allowed_files
        if "/" not in value and value.endswith(".py")
    }
    root_names_by_case = {value.casefold(): value for value in owned_roots}

    for candidate in site_packages.iterdir():
        candidate_name = candidate.name
        folded_name = candidate_name.casefold()
        canonical_root = root_names_by_case.get(folded_name)
        module_stem = folded_name.split(".", 1)[0]
        if canonical_root is None:
            if module_stem in top_level_modules:
                raise RuntimeError("invalid managed runtime")
            continue
        if candidate_name != canonical_root or candidate.is_symlink():
            raise RuntimeError("invalid managed runtime")
        if candidate.is_file():
            if candidate_name not in allowed_files:
                raise RuntimeError("invalid managed runtime")
            continue
        if not candidate.is_dir():
            raise RuntimeError("invalid managed runtime")
        pending = [candidate]
        while pending:
            directory = pending.pop()
            for child in directory.iterdir():
                if child.is_symlink():
                    raise RuntimeError("invalid managed runtime")
                relative_name = child.relative_to(site_packages).as_posix()
                if child.is_dir():
                    if relative_name not in allowed_directories:
                        raise RuntimeError("invalid managed runtime")
                    pending.append(child)
                elif not child.is_file() or relative_name not in allowed_files:
                    raise RuntimeError("invalid managed runtime")

def _verify_relocated_tree(venv_root, recorded_sizes):
    allowed_files = {
        value.removeprefix(DATA_PREFIX)
        for value in recorded_sizes
        if value.startswith(DATA_PREFIX)
    }
    allowed_directories = set()
    for relative_name in allowed_files:
        parent = pathlib.PurePosixPath(relative_name).parent
        while parent != pathlib.PurePosixPath("."):
            allowed_directories.add(parent.as_posix())
            parent = parent.parent
    owned_roots = {value.split("/", 1)[0] for value in allowed_files}
    root_names_by_case = {value.casefold(): value for value in owned_roots}

    for candidate in venv_root.iterdir():
        canonical_root = root_names_by_case.get(candidate.name.casefold())
        if canonical_root is None:
            continue
        if candidate.name != canonical_root or candidate.is_symlink():
            raise RuntimeError("invalid managed runtime")
        if candidate.is_file():
            if candidate.name not in allowed_files:
                raise RuntimeError("invalid managed runtime")
            continue
        if not candidate.is_dir():
            raise RuntimeError("invalid managed runtime")
        pending = [candidate]
        while pending:
            directory = pending.pop()
            for child in directory.iterdir():
                if child.is_symlink():
                    raise RuntimeError("invalid managed runtime")
                relative_name = child.relative_to(venv_root).as_posix()
                if child.is_dir():
                    if relative_name not in allowed_directories:
                        raise RuntimeError("invalid managed runtime")
                    pending.append(child)
                elif not child.is_file() or relative_name not in allowed_files:
                    raise RuntimeError("invalid managed runtime")

def _normalized_distribution_name(value):
    return re.sub(r"[-_.]+", "-", value).lower()

def _metadata_fields(metadata, expected_size, budget):
    if expected_size > MAX_METADATA_BYTES:
        raise RuntimeError("invalid managed runtime")
    source = _read_exact(metadata, expected_size, MAX_METADATA_BYTES, budget)
    fields = {"Name": [], "Version": []}
    for line in source.decode("utf-8").splitlines():
        if not line:
            break
        if ":" not in line:
            continue
        name, value = line.split(":", 1)
        if name in fields:
            fields[name].append(value.strip())
    return fields

def _verify_metadata(site_packages, recorded_sizes, budget):
    relative_name = EXPECTED_DIST_INFO + "/METADATA"
    expected_size = recorded_sizes.get(relative_name)
    if expected_size is None:
        raise RuntimeError("invalid managed runtime")
    fields = _metadata_fields(_source_file(site_packages, relative_name), expected_size, budget)
    names = fields["Name"]
    versions = fields["Version"]
    if len(names) != 1 or _normalized_distribution_name(names[0]) != "hermes-agent":
        raise RuntimeError("invalid managed runtime")
    if versions != [EXPECTED_VERSION]:
        raise RuntimeError("invalid managed runtime")

def _verify_critical_sources(site_packages, recorded_sizes, budget):
    for relative_name, expected_digest in EXPECTED_FILES.items():
        expected_size = recorded_sizes.get(relative_name)
        if expected_size is None:
            raise RuntimeError("invalid managed runtime")
        actual = _hash_file(_source_file(site_packages, relative_name), expected_size, budget)
        if actual.hex() != expected_digest:
            raise RuntimeError("invalid managed runtime")

def _verify():
    if sys.version_info[:2] not in SUPPORTED_PYTHONS:
        raise RuntimeError("invalid managed runtime")
    site_packages, venv_root = _runtime_paths()
    if site_packages.is_symlink() or not site_packages.is_dir():
        raise RuntimeError("invalid managed runtime")
    budget = [0]
    dist_info = _dist_info(site_packages)
    record = _record_bytes(dist_info, budget)
    recorded_sizes = _verify_record(site_packages, venv_root, record, budget)
    _verify_owned_tree(site_packages, recorded_sizes)
    _verify_relocated_tree(venv_root, recorded_sizes)
    _verify_metadata(site_packages, recorded_sizes, budget)
    _verify_critical_sources(site_packages, recorded_sizes, budget)

try:
    _verify()
except Exception:
    print(json.dumps({"schema": 1, "ok": False}, separators=(",", ":"), sort_keys=True))
else:
    print(json.dumps({
        "schema": 1,
        "ok": True,
        "version": EXPECTED_VERSION,
        "releaseTag": EXPECTED_RELEASE_TAG,
    }, separators=(",", ":"), sort_keys=True))
`.trim();

export interface HermesCommandResult {
  readonly stdout: string;
}

export type HermesCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<HermesCommandResult>;

export interface VerifiedHermesInstallation {
  readonly pythonExecutable: string;
  readonly version: typeof HERMES_AGENT_VERSION;
  readonly releaseTag: typeof HERMES_RELEASE_TAG;
}

export class HermesRuntimeUnavailableError extends Error {
  readonly code = "HERMES_RUNTIME_UNAVAILABLE";

  constructor(message: string, options?: ErrorOptions) {
    super(`Managed Hermes runtime unavailable: ${message}`, options);
    this.name = "HermesRuntimeUnavailableError";
  }
}

export async function verifyHermesInstallation(
  pythonExecutable: string,
  runner: HermesCommandRunner,
): Promise<VerifiedHermesInstallation> {
  try {
    const result = await runner(pythonExecutable, [
      "-I",
      "-S",
      "-B",
      "-c",
      HERMES_INSTALLATION_QUERY,
    ]);
    if (!isVerifiedEnvelope(result.stdout)) {
      throw new Error("invalid installation result");
    }
  } catch {
    throw new HermesRuntimeUnavailableError("installation integrity check failed");
  }

  return {
    pythonExecutable,
    version: HERMES_AGENT_VERSION,
    releaseTag: HERMES_RELEASE_TAG,
  };
}

function isVerifiedEnvelope(stdout: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return false;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const envelope = value as Record<string, unknown>;
  const keys = Object.keys(envelope).sort();
  return (
    keys.length === 4 &&
    keys[0] === "ok" &&
    keys[1] === "releaseTag" &&
    keys[2] === "schema" &&
    keys[3] === "version" &&
    envelope.schema === 1 &&
    envelope.ok === true &&
    envelope.version === HERMES_AGENT_VERSION &&
    envelope.releaseTag === HERMES_RELEASE_TAG
  );
}
