#!/usr/bin/env python3
"""OpenTrad's stdlib-only bootstrap for the pinned native Hermes gateway.

Production invocation is intentionally narrow::

    python -I -S -B -u -X utf8 /absolute/opentrad_hermes_launcher.py

The bootstrap consumes one Profile capability from FD3, validates the managed
runtime, scrubs inherited process state, and then calls the unmodified upstream
``tui_gateway.entry.main``. Hermes owns the JSON-RPC server and native tools.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import faulthandler
import functools
import hashlib
import importlib
import importlib.metadata
import ipaddress
import json
import os
from pathlib import Path
import re
import resource
import selectors
import stat
import sys
import time
from typing import Callable, MutableMapping, NoReturn
from urllib.parse import urlsplit


BOOTSTRAP_FD = 3
BOOTSTRAP_MAX_BYTES = 4096
BOOTSTRAP_READ_TIMEOUT_SECONDS = 2.0
PINNED_PYTHON = (3, 12, 11)
PINNED_HERMES_VERSION = "0.18.2"
PINNED_HERMES_RELEASE = "2026.7.7.2"
GENERIC_REFUSAL = "OpenTrad Hermes launcher refused startup"
GENERIC_STDERR = GENERIC_REFUSAL + "\n"
EX_CONFIG = 78

_PAYLOAD_FIELDS = frozenset(
    {
        "v",
        "profileId",
        "providerSlug",
        "authMode",
        "apiMode",
        "executionBackend",
        "model",
        "apiKey",
        "baseUrl",
    }
)
_AUTH_MODES = frozenset({"api_key", "oauth"})
_API_MODES = frozenset({"chat_completions", "codex_responses"})
_EXECUTION_BACKENDS = frozenset({"local", "docker"})
_IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", re.ASCII)
_MODEL_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$", re.ASCII)
_ENVIRONMENT_ALLOWLIST = frozenset(
    {
        "HOME",
        "PATH",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TERM",
        "COLORTERM",
        "SSH_AUTH_SOCK",
    }
)
_PROVIDER_ENVIRONMENT = {
    "openai-api": ("OPENAI_API_KEY", "OPENAI_BASE_URL"),
    "anthropic": ("ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"),
    "deepseek": ("DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"),
}
_WORKSPACE_INPUT_ENV = "OPENTRAD_WORKSPACE_ROOT"
_BUNDLED_SKILLS_INPUT_ENV = "HERMES_BUNDLED_SKILLS"
_NETWORK_INPUT_ENVIRONMENT = {
    "OPENTRAD_NETWORK_HTTP_PROXY": "HTTP_PROXY",
    "OPENTRAD_NETWORK_HTTPS_PROXY": "HTTPS_PROXY",
}
_NETWORK_NO_PROXY_INPUT_ENV = "OPENTRAD_NETWORK_NO_PROXY"
_NETWORK_NO_PROXY_VALUE = "localhost,127.0.0.1,::1"
_PROXY_URL_PATTERN = re.compile(
    r"^http://(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+):([0-9]{1,5})$",
    re.ASCII,
)
_PROXY_HOST_LABEL_PATTERN = re.compile(
    r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$",
    re.ASCII,
)
_COMMON_EXECUTION_ENVIRONMENT = {
    "TERMINAL_CONTAINER_PERSISTENT": "false",
    "TERMINAL_DOCKER_PERSIST_ACROSS_PROCESSES": "false",
    "TERMINAL_DOCKER_VOLUMES": "[]",
    "TERMINAL_DOCKER_EXTRA_ARGS": "[]",
    "TERMINAL_DOCKER_FORWARD_ENV": "[]",
    "TERMINAL_DOCKER_ENV": "{}",
}
_DOCKER_EXECUTION_ENVIRONMENT = {
    "TERMINAL_ENV": "docker",
    "TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE": "true",
    "TERMINAL_DOCKER_RUN_AS_HOST_USER": "true",
}
_DOTENV_CONTROL_ENVIRONMENT = frozenset(
    """BASH_ENV BASHOPTS CDPATH ENV GLOBIGNORE IFS SHELL SHELLOPTS ZDOTDIR
    COPILOT_API_BASE_URL DOCKER_CERT_PATH DOCKER_CONFIG DOCKER_CONTEXT DOCKER_HOST DOCKER_TLS_VERIFY
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_ALLOW_PROTOCOL GIT_ASKPASS GIT_CEILING_DIRECTORIES
    GIT_DIR GIT_EXEC_PATH GIT_EXTERNAL_DIFF GIT_INDEX_FILE GIT_OBJECT_DIRECTORY
    GIT_PROTOCOL_FROM_USER GIT_PROXY_COMMAND GIT_SSH GIT_SSH_COMMAND GIT_WORK_TREE
    HERMES_ACCEPT_HOOKS HERMES_BUNDLED_SKILLS HERMES_CA_BUNDLE HERMES_CODEX_BASE_URL
    HERMES_CONFIG HERMES_CONTAINER HERMES_DEV HERMES_ENV HERMES_EPHEMERAL_SYSTEM_PROMPT
    HERMES_HOME HERMES_MANAGED HERMES_MAX_ITERATIONS HERMES_MEDIA_ALLOW_DIRS
    HERMES_MEDIA_TRUST_RECENT_FILES HERMES_PORTAL_BASE_URL HERMES_PREFILL_MESSAGES_FILE
    HERMES_PROFILE HERMES_QWEN_BASE_URL HERMES_RESOURCE_PATH
    HERMES_SHARED_AUTH_DIR HERMES_SKILL_DIR HERMES_TUI_NO_CONFIRM HERMES_XAI_BASE_URL
    HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy
    SSL_CERT_FILE SSL_CERT_DIR REQUESTS_CA_BUNDLE CURL_CA_BUNDLE NODE_EXTRA_CA_CERTS
    OPENSSL_CONF SSLKEYLOGFILE
    NODE_OPTIONS NODE_PATH NOUS_INFERENCE_BASE_URL NOUS_PORTAL_BASE_URL
    PYTHONBREAKPOINT PYTHONEXECUTABLE PYTHONHOME PYTHONINSPECT
    PYTHONNOUSERSITE PYTHONPATH PYTHONSAFEPATH PYTHONSTARTUP PYTHONUSERBASE SSH_ASKPASS""".split()
)
_DOTENV_CONTROL_PREFIXES = (
    "DYLD_", "GIT_CONFIG_", "LD_", "OPENTRAD_", "TERMINAL_",
)


class LauncherRefusal(RuntimeError):
    """A fixed, non-reflective failure at the trusted bootstrap boundary."""

    def __init__(self) -> None:
        super().__init__(GENERIC_REFUSAL)


class _DuplicateKey(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class BootstrapPayload:
    profile_id: str
    provider_slug: str
    auth_mode: str
    api_mode: str
    execution_backend: str
    model: str
    api_key: str | None = field(repr=False)
    base_url: str | None


@dataclass(frozen=True, slots=True)
class BootstrapPaths:
    launcher: Path
    hermes_home: Path
    cwd: Path


@dataclass(frozen=True, slots=True)
class BootstrapState:
    paths: BootstrapPaths
    payload: BootstrapPayload = field(repr=False)
    site_packages: Path
    workspace_root: Path
    bundled_skills_root: Path


def _refuse() -> NoReturn:
    raise LauncherRefusal()


def _pairs_without_duplicates(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateKey()
        result[key] = value
    return result


def _valid_base_url(value: object) -> str | None:
    if value is None:
        return None
    if type(value) is not str or not value or len(value) > 2048:
        _refuse()
    try:
        parsed = urlsplit(value)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            _refuse()
        _ = parsed.port
        if parsed.scheme == "http":
            hostname = parsed.hostname.casefold()
            loopback = hostname == "localhost"
            if not loopback:
                try:
                    loopback = ipaddress.ip_address(hostname).is_loopback
                except ValueError:
                    loopback = False
            if not loopback:
                _refuse()
    except LauncherRefusal:
        raise
    except (TypeError, ValueError):
        _refuse()
    return value


def parse_bootstrap_payload(raw: bytes) -> BootstrapPayload:
    """Parse the exact FD3 schema without reflecting rejected values."""

    if type(raw) is not bytes or not raw or len(raw) > BOOTSTRAP_MAX_BYTES:
        _refuse()
    try:
        decoded = raw.decode("utf-8", errors="strict")
        value = json.loads(
            decoded,
            object_pairs_hook=_pairs_without_duplicates,
            parse_constant=lambda _value: (_ for _ in ()).throw(ValueError()),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
        _refuse()
    if type(value) is not dict or frozenset(value) != _PAYLOAD_FIELDS:
        _refuse()
    if type(value["v"]) is not int or value["v"] != 1:
        _refuse()

    profile_id = value["profileId"]
    provider_slug = value["providerSlug"]
    model = value["model"]
    if (
        type(profile_id) is not str
        or _IDENTIFIER_PATTERN.fullmatch(profile_id) is None
        or type(provider_slug) is not str
        or _IDENTIFIER_PATTERN.fullmatch(provider_slug) is None
        or type(model) is not str
        or _MODEL_PATTERN.fullmatch(model) is None
    ):
        _refuse()
    auth_mode = value["authMode"]
    api_mode = value["apiMode"]
    execution_backend = value["executionBackend"]
    if (
        type(auth_mode) is not str
        or auth_mode not in _AUTH_MODES
        or type(api_mode) is not str
        or api_mode not in _API_MODES
        or type(execution_backend) is not str
        or execution_backend not in _EXECUTION_BACKENDS
    ):
        _refuse()

    api_key = value["apiKey"]
    base_url = _valid_base_url(value["baseUrl"])
    if auth_mode == "api_key":
        if (
            type(api_key) is not str
            or not api_key
            or api_key.strip() != api_key
            or any(ord(character) < 0x21 or ord(character) > 0x7E for character in api_key)
            or len(api_key) > 2048
        ):
            _refuse()
        if provider_slug not in _PROVIDER_ENVIRONMENT and not provider_slug.startswith(
            "custom:"
        ):
            _refuse()
    elif api_key is not None or base_url is not None:
        _refuse()

    return BootstrapPayload(
        profile_id=profile_id,
        provider_slug=provider_slug,
        auth_mode=auth_mode,
        api_mode=api_mode,
        execution_backend=execution_backend,
        model=model,
        api_key=api_key,
        base_url=base_url,
    )


def read_bootstrap_fd(
    fd: int = BOOTSTRAP_FD,
    *,
    timeout_seconds: float = BOOTSTRAP_READ_TIMEOUT_SECONDS,
) -> BootstrapPayload:
    """Read one bounded payload through EOF, then always close the descriptor."""

    selector = selectors.DefaultSelector()
    try:
        if type(fd) is not int or fd < 0 or timeout_seconds <= 0:
            _refuse()
        os.set_inheritable(fd, False)
        selector.register(fd, selectors.EVENT_READ)
        deadline = time.monotonic() + timeout_seconds
        chunks = bytearray()
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                _refuse()
            chunk = os.read(fd, min(1024, BOOTSTRAP_MAX_BYTES + 1 - len(chunks)))
            if not chunk:
                return parse_bootstrap_payload(bytes(chunks))
            chunks.extend(chunk)
            if len(chunks) > BOOTSTRAP_MAX_BYTES:
                _refuse()
    except LauncherRefusal:
        raise
    except (OSError, TypeError, ValueError):
        _refuse()
    finally:
        selector.close()
        try:
            os.close(fd)
        except OSError:
            pass


def _canonical_existing_path(value: os.PathLike[str] | str, *, directory: bool) -> Path:
    try:
        path = Path(value)
        lexical = Path(os.path.normpath(os.fspath(path)))
        metadata = path.lstat()
        resolved = path.resolve(strict=True)
        expected_type = stat.S_ISDIR(metadata.st_mode) if directory else stat.S_ISREG(metadata.st_mode)
        if not path.is_absolute() or lexical != path or resolved != path or not expected_type:
            _refuse()
        if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
            _refuse()
        return path
    except LauncherRefusal:
        raise
    except (OSError, RuntimeError, TypeError, ValueError):
        _refuse()


def _validate_private_directory(path: Path) -> None:
    metadata = path.lstat()
    if stat.S_IMODE(metadata.st_mode) & 0o077:
        _refuse()


def _profile_config_environment(hermes_home: object) -> dict[str, str]:
    """Derive CLI config roots from the already validated Profile Home only."""
    if type(hermes_home) is not str or not hermes_home:
        _refuse()
    home_path = Path(hermes_home)
    values = {
        "HERMES_HOME": str(home_path),
        "GH_CONFIG_DIR": str(home_path / "gh-config"),
        "XDG_CONFIG_HOME": str(home_path / "xdg-config"),
        "COPILOT_GH_HOST": hashlib.sha256(str(home_path).encode("utf-8")).hexdigest()[:24]
        + ".opentrad.invalid",
        "CODEX_HOME": str(home_path / "codex-home"),
    }
    for directory in (
        home_path,
        home_path / "gh-config",
        home_path / "xdg-config",
        home_path / "codex-home",
    ):
        try:
            metadata = directory.lstat()
        except (OSError, TypeError, ValueError):
            _refuse()
        if (
            not directory.is_absolute()
            or Path(os.path.normpath(os.fspath(directory))) != directory
            or not stat.S_ISDIR(metadata.st_mode)
            or (hasattr(os, "getuid") and metadata.st_uid != os.getuid())
        ):
            _refuse()
        _validate_private_directory(directory)
    return values


def validate_bootstrap_paths(
    launcher: os.PathLike[str] | str,
    hermes_home: os.PathLike[str] | str,
    cwd: os.PathLike[str] | str,
) -> BootstrapPaths:
    launcher_path = _canonical_existing_path(launcher, directory=False)
    home_path = _canonical_existing_path(hermes_home, directory=True)
    cwd_path = _canonical_existing_path(cwd, directory=True)
    if stat.S_IMODE(launcher_path.lstat().st_mode) & 0o022:
        _refuse()
    _validate_private_directory(home_path)
    _validate_private_directory(cwd_path)
    if cwd_path != home_path / "gateway-cwd":
        _refuse()
    return BootstrapPaths(launcher_path, home_path, cwd_path)


def validate_workspace_root(value: object) -> Path:
    if type(value) is not str or not value or len(value) > 4096:
        _refuse()
    return _canonical_existing_path(value, directory=True)


def validate_bundled_skills_root(
    value: object,
    python_executable: os.PathLike[str] | str,
) -> Path:
    """Accept only the immutable skills tree beside this exact managed venv."""

    try:
        if type(value) is not str or not value or len(value) > 4096:
            _refuse()
        executable = Path(python_executable)
        if (
            not executable.is_absolute()
            or executable.parent.name != "bin"
            or executable.parent.parent.name != "venv"
        ):
            _refuse()
        runtime_root = executable.parent.parent.parent.resolve(strict=True)
        selected = _canonical_existing_path(value, directory=True)
        expected = runtime_root / "share" / "hermes" / "skills"
        if selected != expected:
            _refuse()
        for directory in (
            runtime_root / "share",
            runtime_root / "share" / "hermes",
            selected,
        ):
            metadata = directory.lstat()
            if (
                not stat.S_ISDIR(metadata.st_mode)
                or stat.S_IMODE(metadata.st_mode) & 0o022
                or (hasattr(os, "getuid") and metadata.st_uid != os.getuid())
            ):
                _refuse()
        if stat.S_IMODE(selected.lstat().st_mode) != 0o500:
            _refuse()
        return selected
    except LauncherRefusal:
        raise
    except (OSError, RuntimeError, TypeError, ValueError):
        _refuse()


def disable_core_dumps() -> None:
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        faulthandler.disable()
    except (OSError, RuntimeError, ValueError):
        _refuse()


def verify_interpreter_contract(version: tuple[int, int, int] | None = None) -> None:
    selected = tuple(sys.version_info[:3]) if version is None else tuple(version)
    if selected != PINNED_PYTHON:
        _refuse()
    if version is not None:
        return
    flags = sys.flags
    if (
        sys.version_info.releaselevel != "final"
        or not flags.isolated
        or not flags.no_site
        or not sys.dont_write_bytecode
        or not flags.utf8_mode
        or not getattr(flags, "safe_path", False)
        or not getattr(sys.stdout, "write_through", False)
        or len(sys.argv) != 1
        or not Path(sys.argv[0]).is_absolute()
        or not Path(sys.executable).is_absolute()
    ):
        _refuse()


def infer_site_packages(
    python_executable: os.PathLike[str] | str,
    version: tuple[int, int, int],
) -> Path:
    try:
        executable = Path(python_executable)
        if not executable.is_absolute() or tuple(version) != PINNED_PYTHON:
            _refuse()
        if executable.parent.name != "bin":
            _refuse()
        runtime_root = executable.parent.parent.resolve(strict=True)
        candidate = (
            runtime_root / "lib" / f"python{version[0]}.{version[1]}" / "site-packages"
        )
        site_packages = candidate.resolve(strict=True)
        site_packages.relative_to(runtime_root)
        metadata = site_packages.lstat()
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or stat.S_IMODE(metadata.st_mode) & 0o022
            or (hasattr(os, "getuid") and metadata.st_uid != os.getuid())
        ):
            _refuse()
        return site_packages
    except LauncherRefusal:
        raise
    except (OSError, RuntimeError, TypeError, ValueError):
        _refuse()


def activate_site_packages(site_packages: Path, sys_path: list[str] | None = None) -> None:
    target = sys.path if sys_path is None else sys_path
    value = str(site_packages)
    if value in target or any(
        entry and entry != value and Path(entry).name in {"site-packages", "dist-packages"}
        for entry in target
    ):
        _refuse()
    target.append(value)


def _provider_values(payload: BootstrapPayload) -> dict[str, str]:
    if payload.auth_mode != "api_key" or payload.api_key is None:
        return {}
    names = _PROVIDER_ENVIRONMENT.get(
        payload.provider_slug,
        ("OPENTRAD_PROVIDER_API_KEY", "OPENTRAD_PROVIDER_BASE_URL"),
    )
    values = {names[0]: payload.api_key}
    if payload.base_url is not None:
        values[names[1]] = payload.base_url
    return values


def _execution_values(payload: BootstrapPayload, workspace_root: Path) -> dict[str, str]:
    common = {
        **_COMMON_EXECUTION_ENVIRONMENT,
        "TERMINAL_CWD": str(workspace_root),
    }
    if payload.execution_backend == "docker":
        return {**common, **_DOCKER_EXECUTION_ENVIRONMENT}
    return {
        **common,
        "TERMINAL_ENV": "local",
        "TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE": "false",
        "TERMINAL_DOCKER_RUN_AS_HOST_USER": "true",
    }


def _valid_proxy_url(value: object) -> str:
    if type(value) is not str or len(value) > 2048:
        _refuse()
    match = _PROXY_URL_PATTERN.fullmatch(value)
    if match is None:
        _refuse()
    raw_host, raw_port = match.groups()
    host = raw_host[1:-1] if raw_host.startswith("[") else raw_host
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        labels = host.split(".")
        if not labels or any(_PROXY_HOST_LABEL_PATTERN.fullmatch(label) is None for label in labels):
            _refuse()
        if host.casefold() != raw_host:
            _refuse()
    else:
        canonical_host = f"[{host}]" if address.version == 6 else host
        if canonical_host != raw_host:
            _refuse()
    port = int(raw_port)
    if port < 1 or port > 65535 or str(port) != raw_port:
        _refuse()
    return value


def _trusted_proxy_environment(environment: MutableMapping[str, str]) -> dict[str, str]:
    trusted: dict[str, str] = {}
    supplied_proxy = False
    for private_name, public_name in _NETWORK_INPUT_ENVIRONMENT.items():
        value = environment.get(private_name)
        if value is None:
            continue
        trusted[public_name] = _valid_proxy_url(value)
        supplied_proxy = True
    no_proxy = environment.get(_NETWORK_NO_PROXY_INPUT_ENV)
    if supplied_proxy:
        if no_proxy != _NETWORK_NO_PROXY_VALUE:
            _refuse()
        trusted["NO_PROXY"] = _NETWORK_NO_PROXY_VALUE
    elif no_proxy is not None:
        _refuse()
    return trusted


def configure_environment(
    payload: BootstrapPayload,
    environment: MutableMapping[str, str] | None = None,
    *,
    workspace_root: Path | None = None,
    bundled_skills_root: Path | None = None,
) -> Path:
    target = os.environ if environment is None else environment
    selected_workspace = (
        validate_workspace_root(target.get(_WORKSPACE_INPUT_ENV))
        if workspace_root is None
        else _canonical_existing_path(workspace_root, directory=True)
    )
    selected_bundled_skills = (
        _canonical_existing_path(target.get(_BUNDLED_SKILLS_INPUT_ENV), directory=True)
        if bundled_skills_root is None
        else _canonical_existing_path(bundled_skills_root, directory=True)
    )
    inherited = {
        key: value
        for key, value in target.items()
        if key in _ENVIRONMENT_ALLOWLIST and type(value) is str
    }
    trusted_proxy = _trusted_proxy_environment(target)
    profile_config = _profile_config_environment(target.get("HERMES_HOME"))
    target.clear()
    target.update(inherited)
    target.update(profile_config)
    target.update(trusted_proxy)
    target[_BUNDLED_SKILLS_INPUT_ENV] = str(selected_bundled_skills)
    target["PYTHONNOUSERSITE"] = "1"
    target["PYTHONDONTWRITEBYTECODE"] = "1"
    target["PYTHONUTF8"] = "1"
    target.update(_provider_values(payload))
    target.update(_execution_values(payload, selected_workspace))
    return selected_workspace


def install_provider_environment_guard(
    payload: BootstrapPayload,
    env_loader_module: object,
    environment: MutableMapping[str, str] | None = None,
    *,
    workspace_root: Path | None = None,
    bundled_skills_root: Path | None = None,
) -> None:
    """Restore trusted controls while retaining ordinary Profile tool secrets."""

    target = os.environ if environment is None else environment
    protected = dict(target)
    protected.update(_profile_config_environment(target.get("HERMES_HOME")))
    protected.update(_provider_values(payload))
    authority_controls: set[str] = set()
    if payload.provider_slug == "anthropic":
        authority_controls.add("ANTHROPIC_BASE_URL")
        authority_controls.update(
            ("ANTHROPIC_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN")
            if payload.auth_mode == "api_key"
            else ("ANTHROPIC_API_KEY",)
        )
    if bundled_skills_root is not None:
        protected[_BUNDLED_SKILLS_INPUT_ENV] = str(
            _canonical_existing_path(bundled_skills_root, directory=True)
        )
    if workspace_root is not None:
        protected.update(_execution_values(payload, workspace_root))
    original = getattr(env_loader_module, "load_hermes_dotenv", None)
    if not callable(original) or getattr(original, "__opentrad_guarded__", False):
        _refuse()

    @functools.wraps(original)
    def guarded(*args: object, **kwargs: object) -> object:
        try:
            return original(*args, **kwargs)
        finally:
            for name in tuple(target):
                if name in protected:
                    continue
                if name in authority_controls or name in _DOTENV_CONTROL_ENVIRONMENT or name.startswith(
                    _DOTENV_CONTROL_PREFIXES
                ):
                    target.pop(name, None)
            target.update(protected)

    guarded.__opentrad_guarded__ = True  # type: ignore[attr-defined]
    setattr(env_loader_module, "load_hermes_dotenv", guarded)


def install_execution_environment_guard(
    payload: BootstrapPayload,
    workspace_root: Path,
    config_module: object,
    environment: MutableMapping[str, str] | None = None,
) -> None:
    protected = _execution_values(payload, workspace_root)
    if not protected:
        return
    target = os.environ if environment is None else environment
    original = getattr(config_module, "apply_terminal_config_to_env", None)
    if not callable(original) or getattr(original, "__opentrad_guarded__", False):
        _refuse()

    @functools.wraps(original)
    def guarded(*args: object, **kwargs: object) -> object:
        try:
            return original(*args, **kwargs)
        finally:
            target.update(protected)
            supplied = kwargs.get("env")
            if supplied is not None and hasattr(supplied, "update"):
                supplied.update(protected)

    guarded.__opentrad_guarded__ = True  # type: ignore[attr-defined]
    setattr(config_module, "apply_terminal_config_to_env", guarded)


def _require_module_origin(module: object, site_packages: Path) -> None:
    try:
        origin = Path(getattr(module, "__file__")).resolve(strict=False)
        origin.relative_to(site_packages.resolve(strict=True))
    except (AttributeError, OSError, RuntimeError, TypeError, ValueError):
        _refuse()


def install_anthropic_auth_guard(module: object, payload: BootstrapPayload) -> None:
    """Keep Anthropic credentials inside the selected Profile authority."""

    names = (
        "read_claude_code_credentials",
        "_read_claude_code_credentials_from_keychain",
        "_read_claude_code_credentials_from_file",
    )

    def no_external_credentials() -> None:
        return None

    for name in names:
        if not callable(getattr(module, name, None)):
            _refuse()
        setattr(module, name, no_external_credentials)
    if payload.provider_slug != "anthropic":
        return
    original_resolve = getattr(module, "resolve_anthropic_token", None)
    is_oauth_token = getattr(module, "_is_oauth_token", None)
    if not callable(original_resolve) or not callable(is_oauth_token):
        _refuse()
    if payload.auth_mode == "api_key":
        credential = payload.api_key
        setattr(module, "resolve_anthropic_token", lambda: credential)
        return

    def resolve_oauth_only() -> str | None:
        token = original_resolve()
        return token if type(token) is str and is_oauth_token(token) else None

    setattr(module, "resolve_anthropic_token", resolve_oauth_only)


def install_provider_pool_guard(module: object, payload: BootstrapPayload) -> None:
    """Enforce Profile auth and endpoint authority before pool selection."""

    original = getattr(module, "load_pool", None)
    if not callable(original) or getattr(original, "__opentrad_guarded__", False):
        _refuse()

    @functools.wraps(original)
    def guarded(provider: object, *args: object, **kwargs: object) -> object:
        if (
            (
                provider == "anthropic"
                and payload.provider_slug == "anthropic"
                and payload.auth_mode == "api_key"
            )
            or (
                provider == "copilot"
                and payload.provider_slug == "copilot"
                and payload.auth_mode == "oauth"
            )
        ):
            return None
        pool = original(provider, *args, **kwargs)
        if provider != "anthropic" or payload.provider_slug != "anthropic":
            return pool
        entries = getattr(pool, "_entries", None)
        if type(entries) is not list:
            _refuse()
        # The original pool object keeps refresh/rotation intact. Its next
        # upstream persist deliberately retires API-key entries from this
        # OAuth-authority Profile Home instead of letting them revive later.
        official_base_url = "https://api.anthropic.com"
        pool._entries = [  # type: ignore[attr-defined]
            entry
            for entry in entries
            if getattr(entry, "auth_type", None) == "oauth"
            and getattr(entry, "base_url", None) in (None, "", official_base_url)
        ]
        return pool

    guarded.__opentrad_guarded__ = True  # type: ignore[attr-defined]
    setattr(module, "load_pool", guarded)


def validate_skills_sync_result(value: object) -> None:
    if type(value) is not dict or type(value.get("total_bundled")) is not int:
        _refuse()
    if value["total_bundled"] != 72 or type(value.get("skipped")) is not int:
        _refuse()
    skipped = value["skipped"]
    if skipped < 0 or skipped > 72:
        _refuse()
    names: list[str] = []
    for key in ("copied", "updated", "user_modified", "suppressed"):
        entries = value.get(key)
        if type(entries) is not list:
            _refuse()
        for entry in entries:
            if type(entry) is not str or not entry or len(entry) > 256 or "\0" in entry:
                _refuse()
            names.append(entry)
    if len(names) + skipped != 72 or len(set(names)) != len(names):
        _refuse()


def load_upstream_gateway(
    site_packages: Path,
    payload: BootstrapPayload,
    workspace_root: Path,
    bundled_skills_root: Path,
    *,
    version_getter: Callable[[str], str] = importlib.metadata.version,
    importer: Callable[[str], object] = importlib.import_module,
) -> Callable[[], object]:
    try:
        if version_getter("hermes-agent") != PINNED_HERMES_VERSION:
            _refuse()
        hermes_cli = importer("hermes_cli")
        _require_module_origin(hermes_cli, site_packages)
        if (
            getattr(hermes_cli, "__version__", None) != PINNED_HERMES_VERSION
            or getattr(hermes_cli, "__release_date__", None) != PINNED_HERMES_RELEASE
        ):
            _refuse()
        credential_pool = importer("agent.credential_pool")
        _require_module_origin(credential_pool, site_packages)
        install_provider_pool_guard(credential_pool, payload)
        anthropic_adapter = importer("agent.anthropic_adapter")
        _require_module_origin(anthropic_adapter, site_packages)
        install_anthropic_auth_guard(anthropic_adapter, payload)
        runtime_provider = importer("hermes_cli.runtime_provider")
        _require_module_origin(runtime_provider, site_packages)
        setattr(runtime_provider, "load_pool", getattr(credential_pool, "load_pool"))
        env_loader = importer("hermes_cli.env_loader")
        _require_module_origin(env_loader, site_packages)
        install_provider_environment_guard(
            payload,
            env_loader,
            workspace_root=workspace_root,
            bundled_skills_root=bundled_skills_root,
        )
        config_module = importer("hermes_cli.config")
        _require_module_origin(config_module, site_packages)
        install_execution_environment_guard(payload, workspace_root, config_module)
        os.environ[_BUNDLED_SKILLS_INPUT_ENV] = str(bundled_skills_root)
        skills_sync = importer("tools.skills_sync")
        _require_module_origin(skills_sync, site_packages)
        sync_skills = getattr(skills_sync, "sync_skills", None)
        if not callable(sync_skills):
            _refuse()
        validate_skills_sync_result(sync_skills(quiet=True))
        entry = importer("tui_gateway.entry")
        _require_module_origin(entry, site_packages)
        gateway_main = getattr(entry, "main", None)
        if not callable(gateway_main):
            _refuse()
        return gateway_main
    except LauncherRefusal:
        raise
    except BaseException:
        _refuse()


def run_upstream_gateway(gateway_main: Callable[[], object]) -> int:
    try:
        gateway_main()
    except SystemExit as exc:
        if exc.code not in (None, 0):
            _refuse()
    return 0


def bootstrap_pre_import(fd: int = BOOTSTRAP_FD) -> BootstrapState:
    verify_interpreter_contract()
    hermes_home = os.environ.get("HERMES_HOME")
    if not hermes_home:
        _refuse()
    try:
        cwd = Path.cwd()
    except OSError:
        _refuse()
    paths = validate_bootstrap_paths(Path(sys.argv[0]), hermes_home, cwd)
    workspace_root = validate_workspace_root(os.environ.get(_WORKSPACE_INPUT_ENV))
    bundled_skills_root = validate_bundled_skills_root(
        os.environ.get(_BUNDLED_SKILLS_INPUT_ENV),
        Path(sys.executable),
    )
    os.umask(0o077)
    disable_core_dumps()
    payload = read_bootstrap_fd(fd)
    configure_environment(
        payload,
        workspace_root=workspace_root,
        bundled_skills_root=bundled_skills_root,
    )
    private_tmp = paths.hermes_home / "tmp"
    private_tmp.mkdir(mode=0o700, exist_ok=True)
    _validate_private_directory(_canonical_existing_path(private_tmp, directory=True))
    os.environ["TMPDIR"] = str(private_tmp)
    site_packages = infer_site_packages(Path(sys.executable), PINNED_PYTHON)
    activate_site_packages(site_packages)
    return BootstrapState(
        paths,
        payload,
        site_packages,
        workspace_root,
        bundled_skills_root,
    )


def _write_generic_refusal() -> None:
    try:
        sys.stderr.write(GENERIC_STDERR)
        sys.stderr.flush()
    except BaseException:
        pass


def main() -> int:
    try:
        state = bootstrap_pre_import()
        gateway_main = load_upstream_gateway(
            state.site_packages,
            state.payload,
            state.workspace_root,
            state.bundled_skills_root,
        )
        return run_upstream_gateway(gateway_main)
    except BaseException:
        _write_generic_refusal()
        return EX_CONFIG


if __name__ == "__main__":
    raise SystemExit(main())
