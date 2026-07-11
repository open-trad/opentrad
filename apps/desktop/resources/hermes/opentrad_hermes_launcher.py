#!/usr/bin/env python3
"""OpenTrad-owned, fail-closed pre-import launcher for Hermes Agent.

This module intentionally stops before importing Hermes.  It establishes and
tests the boundary that must exist before any third-party module is loaded:
private paths, a scrubbed environment, a bounded FD capability, no core dumps,
an explicitly inferred site-packages directory, and an audit policy primitive.

The eventual production invocation is deliberately narrow::

    python -I -S -B -u -X utf8 /absolute/opentrad_hermes_launcher.py

Only Python's standard library may be imported above the Hermes boundary.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import faulthandler
import json
import os
from pathlib import Path
import re
import resource
import selectors
import socket
import stat
import sys
import time
from typing import Callable, MutableMapping, NoReturn


CAPABILITY_FD = 3
CAPABILITY_MAX_BYTES = 4096
CAPABILITY_READ_TIMEOUT_SECONDS = 1.0
CAPABILITY_MAX_LIFETIME_SECONDS = 300
CAPABILITY_FIELDS = frozenset(
    {"v", "expiresAt", "token", "model", "apiMode", "brokerPort"}
)
ALLOWED_API_MODES = frozenset({"chat_completions", "codex_responses"})
MODEL_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32,512}$")
GENERIC_REFUSAL = "OpenTrad Hermes launcher refused startup"
GENERIC_STDERR = b"OpenTrad Hermes launcher refused startup\n"
EX_CONFIG = 78

_SAFE_MODE_ENVIRONMENT = {
    "HERMES_SAFE_MODE": "1",
    "HERMES_IGNORE_USER_CONFIG": "1",
    "HERMES_IGNORE_RULES": "1",
}
_INHERITED_ENVIRONMENT_ALLOWLIST = frozenset({"LANG", "LC_ALL", "LC_CTYPE"})
_PROCESS_AUDIT_EVENTS = frozenset(
    {
        "subprocess.Popen",
        "os.system",
        "os.posix_spawn",
        "os.posix_spawnp",
        "pty.spawn",
        "ctypes.dlopen",
    }
)
_CONTROL_AUDIT_EVENTS = frozenset(
    {
        "os.chmod",
        "os.chown",
        "os.fchmod",
        "os.fchown",
        "os.putenv",
        "os.unsetenv",
        "os.fork",
        "os.forkpty",
        "os.kill",
        "os.killpg",
    }
)
_SUBINTERPRETER_AUDIT_EVENT = "cpython.PyInterpreterState_New"
_PATH_MUTATION_EVENT_INDICES: dict[str, tuple[int, ...]] = {
    "os.remove": (0,),
    "os.unlink": (0,),
    "os.rmdir": (0,),
    "os.mkdir": (0,),
    "os.rename": (0, 1),
    "os.replace": (0, 1),
    "os.utime": (0,),
    "os.link": (0, 1),
    "os.symlink": (1,),
    "os.truncate": (0,),
    "os.setxattr": (0,),
    "os.removexattr": (0,),
    "os.mknod": (0,),
    "os.mkfifo": (0,),
}
_FD_MUTATION_AUDIT_EVENTS = frozenset({"os.ftruncate"})


class LauncherRefusal(RuntimeError):
    """A deliberately non-reflective failure at the launcher boundary."""

    def __init__(self, code: str = "startup_refused") -> None:
        super().__init__(GENERIC_REFUSAL)
        self.code = code


class _DuplicateCapabilityKey(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class Capability:
    expires_at: int
    token: str = field(repr=False)
    model: str
    api_mode: str
    broker_port: int

    @property
    def broker_url(self) -> str:
        """Return the only network endpoint represented by the capability."""

        return f"http://127.0.0.1:{self.broker_port}/v1"


@dataclass(frozen=True, slots=True)
class RuntimeDirectories:
    home: Path
    tmp: Path


@dataclass(frozen=True, slots=True)
class BootstrapPaths:
    launcher: Path
    hermes_home: Path
    cwd: Path


@dataclass(frozen=True, slots=True)
class BootstrapState:
    paths: BootstrapPaths
    directories: RuntimeDirectories
    capability: Capability = field(repr=False)
    site_packages: Path
    audit_policy: "AuditPolicy"


def _reject(code: str) -> NoReturn:
    raise LauncherRefusal(code)


def _terminate_for_unsafe_audit_event() -> NoReturn:
    """Avoid CPython 3.12's crash when subinterpreter creation hooks raise."""

    try:
        os.write(2, GENERIC_STDERR)
    finally:
        os._exit(EX_CONFIG)


def _pairs_without_duplicates(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateCapabilityKey()
        result[key] = value
    return result


def parse_capability(raw: bytes, *, now: int | None = None) -> Capability:
    """Parse the closed FD3 capability schema without reflecting input in errors."""

    if not isinstance(raw, bytes) or len(raw) == 0 or len(raw) > CAPABILITY_MAX_BYTES:
        _reject("capability_size")
    try:
        text = raw.decode("utf-8", errors="strict")
        payload = json.loads(text, object_pairs_hook=_pairs_without_duplicates)
    except (UnicodeDecodeError, json.JSONDecodeError, _DuplicateCapabilityKey, RecursionError):
        _reject("capability_encoding")

    if not isinstance(payload, dict) or set(payload) != CAPABILITY_FIELDS:
        _reject("capability_schema")

    current_time = int(time.time()) if now is None else now
    version = payload["v"]
    expires_at = payload["expiresAt"]
    token = payload["token"]
    model = payload["model"]
    api_mode = payload["apiMode"]
    broker_port = payload["brokerPort"]

    if type(current_time) is not int:
        _reject("clock_invalid")
    if type(version) is not int or version != 1:
        _reject("capability_version")
    if type(expires_at) is not int:
        _reject("capability_expiry")
    if expires_at <= current_time or expires_at > current_time + CAPABILITY_MAX_LIFETIME_SECONDS:
        _reject("capability_expiry")
    if not _valid_token(token):
        _reject("capability_token")
    if not isinstance(model, str) or MODEL_PATTERN.fullmatch(model) is None:
        _reject("capability_model")
    if not isinstance(api_mode, str) or api_mode not in ALLOWED_API_MODES:
        _reject("capability_api_mode")
    if type(broker_port) is not int or not 1 <= broker_port <= 65535:
        _reject("capability_port")

    return Capability(
        expires_at=expires_at,
        token=token,
        model=model,
        api_mode=api_mode,
        broker_port=broker_port,
    )


def _valid_token(value: object) -> bool:
    return isinstance(value, str) and TOKEN_PATTERN.fullmatch(value) is not None


def read_capability_fd(
    fd: int = CAPABILITY_FD,
    *,
    timeout_seconds: float = CAPABILITY_READ_TIMEOUT_SECONDS,
    monotonic: Callable[[], float] = time.monotonic,
) -> Capability:
    """Claim, bound, read-to-EOF, and close the inherited capability pipe."""

    selector: selectors.BaseSelector | None = None
    buffer = bytearray()
    try:
        if type(fd) is not int or fd < 0:
            _reject("capability_fd")
        os.set_inheritable(fd, False)
        os.set_blocking(fd, False)
        selector = selectors.DefaultSelector()
        selector.register(fd, selectors.EVENT_READ)
        bounded_timeout = min(max(float(timeout_seconds), 0.001), CAPABILITY_READ_TIMEOUT_SECONDS)
        deadline = monotonic() + bounded_timeout

        while True:
            remaining = deadline - monotonic()
            if remaining <= 0:
                _reject("capability_eof")
            if not selector.select(remaining):
                _reject("capability_eof")
            chunk = os.read(fd, CAPABILITY_MAX_BYTES + 1 - len(buffer))
            if chunk == b"":
                break
            buffer.extend(chunk)
            if len(buffer) > CAPABILITY_MAX_BYTES:
                _reject("capability_size")

        return parse_capability(bytes(buffer))
    except LauncherRefusal:
        raise
    except (OSError, OverflowError, TypeError, ValueError):
        _reject("capability_fd")
    finally:
        if selector is not None:
            selector.close()
        try:
            os.close(fd)
        except (OSError, TypeError):
            pass


def _canonical_existing_path(value: os.PathLike[str] | str, *, directory: bool) -> Path:
    try:
        raw = Path(value)
        if not raw.is_absolute():
            _reject("path_not_absolute")
        lexical = Path(os.path.normpath(os.fspath(raw)))
        resolved = raw.resolve(strict=True)
        if lexical != resolved:
            _reject("path_not_canonical")
        metadata = raw.lstat()
    except LauncherRefusal:
        raise
    except (OSError, RuntimeError, TypeError, ValueError):
        _reject("path_invalid")

    if directory:
        if not stat.S_ISDIR(metadata.st_mode):
            _reject("path_not_directory")
    elif not stat.S_ISREG(metadata.st_mode):
        _reject("path_not_file")
    if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
        _reject("path_owner")
    return resolved


def _validate_private_directory(path: Path) -> None:
    metadata = path.lstat()
    mode = stat.S_IMODE(metadata.st_mode)
    if mode & 0o077 or mode & 0o700 != 0o700:
        _reject("path_permissions")


def validate_bootstrap_paths(
    launcher: os.PathLike[str] | str,
    hermes_home: os.PathLike[str] | str,
    cwd: os.PathLike[str] | str,
) -> BootstrapPaths:
    """Validate the exact launcher, private state root, and dedicated cwd."""

    launcher_path = _canonical_existing_path(launcher, directory=False)
    home_path = _canonical_existing_path(hermes_home, directory=True)
    cwd_path = _canonical_existing_path(cwd, directory=True)

    launcher_mode = stat.S_IMODE(launcher_path.lstat().st_mode)
    if launcher_mode & 0o022 or launcher_mode & 0o400 == 0:
        _reject("launcher_permissions")
    _validate_private_directory(home_path)
    _validate_private_directory(cwd_path)
    if cwd_path != home_path / "gateway-cwd":
        _reject("gateway_cwd")

    return BootstrapPaths(launcher=launcher_path, hermes_home=home_path, cwd=cwd_path)


def _ensure_private_directory(path: Path) -> Path:
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    except (OSError, RuntimeError):
        _reject("private_directory")

    flags = os.O_RDONLY
    flags |= getattr(os, "O_DIRECTORY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
        try:
            metadata = os.fstat(fd)
            if not stat.S_ISDIR(metadata.st_mode):
                _reject("private_directory")
            if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
                _reject("private_directory")
            os.fchmod(fd, 0o700)
        finally:
            os.close(fd)
        canonical = path.resolve(strict=True)
    except LauncherRefusal:
        raise
    except (OSError, RuntimeError):
        _reject("private_directory")
    if canonical != path:
        _reject("private_directory")
    return canonical


def prepare_private_environment(
    hermes_home: os.PathLike[str] | str,
    environ: MutableMapping[str, str] | None = None,
) -> RuntimeDirectories:
    """Apply umask 077, create private roots, and replace inherited env by allowlist."""

    environment = os.environ if environ is None else environ
    home_path = _canonical_existing_path(hermes_home, directory=True)
    _validate_private_directory(home_path)
    os.umask(0o077)
    process_home = _ensure_private_directory(home_path / "process-home")
    temporary_directory = _ensure_private_directory(home_path / "tmp")

    inherited = {
        key: value
        for key, value in environment.items()
        if key in _INHERITED_ENVIRONMENT_ALLOWLIST and isinstance(value, str)
    }
    environment.clear()
    environment.update(inherited)
    environment["HERMES_HOME"] = str(home_path)
    environment["HOME"] = str(process_home)
    environment["TMPDIR"] = str(temporary_directory)
    environment.update(_SAFE_MODE_ENVIRONMENT)
    return RuntimeDirectories(home=process_home, tmp=temporary_directory)


def disable_process_diagnostics() -> None:
    """Disable core dumps and Python faulthandler before any secret is retained."""

    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        faulthandler.disable()
    except (OSError, ValueError, RuntimeError):
        _reject("diagnostics")


def infer_site_packages(
    python_executable: os.PathLike[str] | str,
    version: tuple[int, int],
    *,
    platform: str = os.name,
) -> Path:
    """Infer one venv site-packages path without importing or executing ``site``."""

    try:
        executable = Path(python_executable)
        if not executable.is_absolute() or len(version) != 2:
            _reject("runtime_path")
        if platform == "nt":
            if executable.parent.name.casefold() != "scripts":
                _reject("runtime_path")
            runtime_root = executable.parent.parent
            candidate = runtime_root / "Lib" / "site-packages"
        elif platform == "posix":
            if executable.parent.name != "bin":
                _reject("runtime_path")
            runtime_root = executable.parent.parent
            candidate = runtime_root / "lib" / f"python{version[0]}.{version[1]}" / "site-packages"
        else:
            _reject("runtime_platform")

        root = runtime_root.resolve(strict=True)
        site_packages = candidate.resolve(strict=True)
        site_packages.relative_to(root)
        metadata = site_packages.lstat()
    except LauncherRefusal:
        raise
    except (OSError, RuntimeError, TypeError, ValueError):
        _reject("runtime_path")

    if not stat.S_ISDIR(metadata.st_mode):
        _reject("runtime_path")
    if metadata.st_mode & 0o022:
        _reject("runtime_permissions")
    if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
        _reject("runtime_owner")
    return site_packages


def activate_site_packages(site_packages: Path, sys_path: list[str] | None = None) -> None:
    """Prepend a validated directory without processing .pth or sitecustomize."""

    target_path = sys.path if sys_path is None else sys_path
    value = str(site_packages)
    if value not in target_path:
        target_path.insert(0, value)


class AuditPolicy:
    """Fail-closed process/network/write primitive.

    Relative writes are always rejected because Python audit events omit the
    ``dir_fd`` that determines their real target. Absolute write paths carried
    by audited operations must resolve under HERMES_HOME. External reads,
    native extensions, and operations without a suitable audit event remain
    outside this hook's guarantees, so this is not an OS sandbox.
    """

    __slots__ = ("_hermes_home", "_cwd", "_broker_endpoint")

    def __init__(self, hermes_home: Path, cwd: Path, *, broker_port: int) -> None:
        if type(broker_port) is not int or not 1 <= broker_port <= 65535:
            _reject("audit_port")
        self._hermes_home = hermes_home
        self._cwd = cwd
        self._broker_endpoint = ("127.0.0.1", broker_port)

    def __call__(self, event: str, args: tuple[object, ...]) -> None:
        if event == _SUBINTERPRETER_AUDIT_EVENT:
            _terminate_for_unsafe_audit_event()
        if event in _PROCESS_AUDIT_EVENTS or event.startswith(("os.exec", "os.spawn")):
            _reject("audit_process")
        if event in _CONTROL_AUDIT_EVENTS:
            _reject("audit_control")
        if event.startswith("socket."):
            self._check_socket(event, args)
            return
        if event in _FD_MUTATION_AUDIT_EVENTS:
            _reject("audit_file")
        if event == "os.chdir":
            _reject("audit_cwd")
        if event == "open":
            self._check_open(args)
        elif event in _PATH_MUTATION_EVENT_INDICES:
            for index in _PATH_MUTATION_EVENT_INDICES[event]:
                if index < len(args):
                    self._require_private_write(args[index])

    def _check_socket(self, event: str, args: tuple[object, ...]) -> None:
        if event == "socket.__new__":
            if (
                len(args) != 4
                or args[1] != socket.AF_INET
                or args[2] != socket.SOCK_STREAM
                or args[3] not in {0, socket.IPPROTO_TCP}
            ):
                _reject("audit_network")
            return
        if event == "socket.connect":
            address = args[1] if len(args) > 1 else None
            if not self._is_broker_address(address):
                _reject("audit_network")
            return
        if event == "socket.getaddrinfo":
            address = (args[0], args[1]) if len(args) > 1 else None
            if not self._is_broker_address(address):
                _reject("audit_network")
            return
        _reject("audit_network")

    def _is_broker_address(self, value: object) -> bool:
        return (
            isinstance(value, tuple)
            and len(value) == 2
            and type(value[0]) is str
            and type(value[1]) is int
            and value == self._broker_endpoint
        )

    def _check_open(self, args: tuple[object, ...]) -> None:
        if not args:
            _reject("audit_file")
        path = args[0]
        mode = args[1] if len(args) > 1 else None
        flags = args[2] if len(args) > 2 else 0
        writes = isinstance(mode, str) and any(character in mode for character in "wax+")
        if type(flags) is int:
            write_flags = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND
            writes = writes or bool(flags & write_flags)
        if writes:
            self._require_private_write(path)

    def _require_private_write(self, value: object) -> None:
        try:
            path = Path(os.fspath(value))
            if not path.is_absolute():
                _reject("audit_file")
            resolved = path.resolve(strict=False)
            resolved.relative_to(self._hermes_home)
        except LauncherRefusal:
            raise
        except (OSError, RuntimeError, TypeError, ValueError):
            _reject("audit_file")


def install_audit_policy(paths: BootstrapPaths, capability: Capability) -> AuditPolicy:
    policy = AuditPolicy(paths.hermes_home, paths.cwd, broker_port=capability.broker_port)
    sys.addaudithook(policy)
    return policy


def is_supported_hermes_python_version(major: object, minor: object) -> bool:
    """Return whether the pinned Hermes runtime supports this Python pair."""

    return type(major) is int and type(minor) is int and major == 3 and 11 <= minor < 14


def verify_interpreter_contract() -> None:
    """Require the exact isolation properties of ``-I -S -B -u -X utf8``."""

    if not is_supported_hermes_python_version(
        sys.version_info.major,
        sys.version_info.minor,
    ):
        _reject("interpreter_version")
    flags = sys.flags
    if not flags.isolated or not flags.no_site or not sys.dont_write_bytecode or not flags.utf8_mode:
        _reject("interpreter_flags")
    if not getattr(sys.stdout, "write_through", False):
        _reject("interpreter_buffering")
    if len(sys.argv) != 1 or not Path(sys.argv[0]).is_absolute():
        _reject("interpreter_arguments")
    if not Path(sys.executable).is_absolute():
        _reject("interpreter_executable")


def bootstrap_pre_import(fd: int = CAPABILITY_FD) -> BootstrapState:
    """Establish the entire trusted pre-import state, then return in-memory data."""

    verify_interpreter_contract()
    hermes_home = os.environ.get("HERMES_HOME")
    if not hermes_home:
        _reject("hermes_home")
    try:
        cwd = Path.cwd()
    except OSError:
        _reject("gateway_cwd")
    paths = validate_bootstrap_paths(Path(sys.argv[0]), hermes_home, cwd)
    directories = prepare_private_environment(paths.hermes_home)
    disable_process_diagnostics()
    capability = read_capability_fd(fd)
    site_packages = infer_site_packages(
        Path(sys.executable),
        (sys.version_info.major, sys.version_info.minor),
    )
    activate_site_packages(site_packages)
    policy = install_audit_policy(paths, capability)
    return BootstrapState(
        paths=paths,
        directories=directories,
        capability=capability,
        site_packages=site_packages,
        audit_policy=policy,
    )


def _write_generic_refusal() -> None:
    try:
        os.write(2, GENERIC_STDERR)
    except OSError:
        pass


def main() -> int:
    try:
        bootstrap_pre_import()
        # Hermes import, monkeypatching, and the owned NDJSON loop are deliberately
        # absent until they can be contract-tested against the pinned runtime.
        _reject("hermes_boundary_incomplete")
    except BaseException:
        _write_generic_refusal()
        return EX_CONFIG


if __name__ == "__main__":
    raise SystemExit(main())
