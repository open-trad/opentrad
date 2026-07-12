#!/usr/bin/env python3
"""OpenTrad-owned, fail-closed launcher for the pinned Hermes quarantine.

This module establishes the boundary that must exist before any third-party
module is loaded: private paths, a scrubbed environment, a bounded FD
capability, no core dumps, an explicitly inferred site-packages directory, and
an audit policy primitive.  It then hash-pins and directly compiles the sibling
OpenTrad runtime before that runtime imports the verified Hermes distribution.

The eventual production invocation is deliberately narrow::

    python -I -S -B -u -X utf8 /absolute/opentrad_hermes_launcher.py

Only Python's standard library may be imported above the Hermes boundary.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import faulthandler
import hashlib
import json
import math
import os
from pathlib import Path
import re
import resource
import selectors
import socket
import stat
import sys
import threading
import time
import types
from typing import BinaryIO, Callable, MutableMapping, NoReturn, Protocol


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
MAX_NDJSON_FRAME_BYTES = 4 * 1024 * 1024
MAX_RPC_ID_STRING_CHARACTERS = 128
MAX_SAFE_JSON_INTEGER = 9_007_199_254_740_991
MAX_JSON_INTEGER_DIGITS = 64
MAX_JSON_NESTING_DEPTH = 128
MAX_PROMPT_CHARACTERS = 262_144
MAX_PROMPT_UTF8_BYTES = 1024 * 1024
OWNED_RUNTIME_FILENAME = "opentrad_hermes_runtime.py"
OWNED_RUNTIME_MODULE_NAME = "_opentrad_owned_hermes_runtime_v1"
OWNED_RUNTIME_MAX_BYTES = 512 * 1024
OWNED_RUNTIME_SHA256 = (
    "6e36115f78f35a6d70362c3dd6f06c84b270974851bfdde6260d7a280cf901ad"
)
STORED_SESSION_ID_PATTERN = re.compile(r"^\d{8}_\d{6}_[0-9a-f]{6}$", re.ASCII)
LIVE_SESSION_ID_PATTERN = re.compile(r"^[0-9a-f]{8}$")
ALLOWED_RPC_METHODS = frozenset(
    {
        "session.create",
        "session.resume",
        "session.status",
        "session.close",
        "session.interrupt",
        "prompt.submit",
        "approval.respond",
    }
)
READY_ENVELOPE = {
    "jsonrpc": "2.0",
    "method": "event",
    "params": {"type": "gateway.ready", "payload": {"skin": {}}},
}
_RPC_ERROR_MESSAGES = {
    -32700: "Parse error",
    -32600: "Invalid Request",
    -32601: "Method not found",
    -32602: "Invalid params",
    -32603: "Internal error",
}
_UNKNOWN_RPC_ERROR_MESSAGE = "Server error"

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


@dataclass(frozen=True, slots=True)
class RpcRequest:
    request_id: int | str
    method: str
    params: object


@dataclass(frozen=True, slots=True)
class RpcPolicyContext:
    """Trusted immutable values injected into the pinned gateway contract."""

    cwd: Path

    def __post_init__(self) -> None:
        try:
            cwd = self.cwd
            if not isinstance(cwd, Path):
                _reject("rpc_policy_cwd")
            canonical = Path(os.path.normpath(os.fspath(cwd)))
            if (
                not cwd.is_absolute()
                or cwd != canonical
                or not _is_strict_utf8(str(cwd))
            ):
                _reject("rpc_policy_cwd")
        except LauncherRefusal:
            raise
        except (OSError, RuntimeError, TypeError, ValueError):
            _reject("rpc_policy_cwd")


class SafeJsonTransport:
    """Thread-safe bounded NDJSON output that never renders the capability token."""

    __slots__ = ("_stream", "_token", "_write_lock", "_closed")

    def __init__(self, stream: BinaryIO, capability: Capability) -> None:
        self._stream = stream
        self._token = capability.token
        self._write_lock = threading.Lock()
        self._closed = False

    @classmethod
    def capture_stdout(cls, capability: Capability) -> "SafeJsonTransport":
        stream = getattr(sys.stdout, "buffer", None)
        if stream is None or not callable(getattr(stream, "write", None)):
            _reject("stdout_transport")
        return cls(stream, capability)

    def __repr__(self) -> str:
        return f"SafeJsonTransport(max_frame_bytes={MAX_NDJSON_FRAME_BYTES})"

    def write(self, payload: object) -> bool:
        return self.write_frame(payload)

    def close(self) -> None:
        with self._write_lock:
            if self._closed:
                return
            self._closed = True
            try:
                self._stream.flush()
            except BaseException:
                pass

    def write_frame(self, payload: object) -> bool:
        try:
            safe_payload = _prepare_json_output(payload, self._token)
            encoded = json.dumps(
                safe_payload,
                ensure_ascii=False,
                separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8", errors="strict")
            wire = encoded + b"\n"
            if len(wire) > MAX_NDJSON_FRAME_BYTES:
                return False
        except BaseException:
            return False

        with self._write_lock:
            if self._closed:
                return False
            try:
                remaining = memoryview(wire)
                while remaining:
                    written = self._stream.write(remaining)
                    if (
                        type(written) is not int
                        or written <= 0
                        or written > len(remaining)
                    ):
                        return False
                    remaining = remaining[written:]
                self._stream.flush()
                return True
            except BaseException:
                return False


RpcResponse = dict[str, object] | None
RpcDispatcher = Callable[[dict[str, object]], RpcResponse]


class ServerDispatch(Protocol):
    """Pinned gateway shape; its optional transport must never fall back to stdio."""

    def dispatch(
        self,
        request: dict[str, object],
        transport: SafeJsonTransport,
        /,
    ) -> RpcResponse: ...


def bind_server_dispatch(
    server: ServerDispatch,
    transport: SafeJsonTransport,
) -> RpcDispatcher:
    """Bind the safe transport explicitly instead of passing ``server.dispatch`` raw."""

    def dispatch_with_safe_transport(request: dict[str, object]) -> RpcResponse:
        return server.dispatch(request, transport)

    return dispatch_with_safe_transport


def _prepare_json_output(payload: object, token: str) -> object:
    sanitized = _redact_json_value(payload, token, set())
    if (
        isinstance(sanitized, dict)
        and sanitized.get("jsonrpc") == "2.0"
        and "error" in sanitized
    ):
        error = sanitized.get("error")
        code, message = _normalize_rpc_error(
            error.get("code") if isinstance(error, dict) else None
        )
        normalized = dict(sanitized)
        normalized["error"] = {"code": code, "message": message}
        return normalized
    return sanitized


def _normalize_rpc_error(code: object) -> tuple[int, str]:
    if (
        type(code) is not int
        or not -MAX_SAFE_JSON_INTEGER <= code <= MAX_SAFE_JSON_INTEGER
    ):
        code = -32603
    return code, _RPC_ERROR_MESSAGES.get(code, _UNKNOWN_RPC_ERROR_MESSAGE)


def _redact_json_value(value: object, token: str, active: set[int]) -> object:
    if isinstance(value, str):
        return value.replace(token, "<redacted>")
    if value is None or type(value) in {bool, int, float}:
        return value
    if isinstance(value, dict):
        identity = id(value)
        if identity in active:
            raise ValueError("cyclic JSON value")
        active.add(identity)
        try:
            return {
                (
                    key.replace(token, "<redacted>") if isinstance(key, str) else key
                ): _redact_json_value(
                    item,
                    token,
                    active,
                )
                for key, item in value.items()
            }
        finally:
            active.remove(identity)
    if isinstance(value, (list, tuple)):
        identity = id(value)
        if identity in active:
            raise ValueError("cyclic JSON value")
        active.add(identity)
        try:
            return [_redact_json_value(item, token, active) for item in value]
        finally:
            active.remove(identity)
    return value


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


class _RpcFrameError(ValueError):
    __slots__ = ("code",)

    def __init__(self, code: int) -> None:
        super().__init__(_RPC_ERROR_MESSAGES[code])
        self.code = code


class _InvalidJsonValue(ValueError):
    pass


class _InvalidRpcParams(ValueError):
    pass


def _reject_json_constant(_value: str) -> NoReturn:
    raise _InvalidJsonValue()


def _parse_json_integer(value: str) -> int:
    digits = value[1:] if value.startswith("-") else value
    if len(digits) > MAX_JSON_INTEGER_DIGITS:
        raise _InvalidJsonValue()
    try:
        parsed = int(value)
    except (ValueError, OverflowError):
        raise _InvalidJsonValue() from None
    return parsed


def _parse_json_float(value: str) -> float:
    try:
        parsed = float(value)
    except (ValueError, OverflowError):
        raise _InvalidJsonValue() from None
    if not math.isfinite(parsed):
        raise _InvalidJsonValue()
    return parsed


def parse_rpc_request(frame: bytes) -> RpcRequest:
    """Parse one bounded frame into a normalized request without reflecting input."""

    try:
        text = frame.decode("utf-8", errors="strict")
        payload = json.loads(
            text,
            object_pairs_hook=_pairs_without_duplicates,
            parse_constant=_reject_json_constant,
            parse_int=_parse_json_integer,
            parse_float=_parse_json_float,
        )
    except (UnicodeDecodeError, ValueError, OverflowError, RecursionError):
        raise _RpcFrameError(-32700) from None

    if not isinstance(payload, dict) or set(payload) != {
        "jsonrpc",
        "id",
        "method",
        "params",
    }:
        raise _RpcFrameError(-32600)
    request_id = payload["id"]
    method = payload["method"]
    params = payload["params"]
    if payload["jsonrpc"] != "2.0" or not _is_valid_rpc_id(request_id):
        raise _RpcFrameError(-32600)
    if not isinstance(method, str) or len(method) == 0 or not _is_strict_utf8(method):
        raise _RpcFrameError(-32600)
    try:
        normalized_params = _copy_json_value(params, 0)
    except (ValueError, RecursionError):
        raise _RpcFrameError(-32700) from None
    return RpcRequest(
        request_id=request_id,
        method=method,
        params=normalized_params,
    )


def _is_valid_rpc_id(value: object) -> bool:
    if type(value) is int:
        return -MAX_SAFE_JSON_INTEGER <= value <= MAX_SAFE_JSON_INTEGER
    return (
        type(value) is str
        and len(value) <= MAX_RPC_ID_STRING_CHARACTERS
        and _is_strict_utf8(value)
    )


def _is_strict_utf8(value: str) -> bool:
    try:
        value.encode("utf-8", errors="strict")
        return True
    except UnicodeEncodeError:
        return False


def _copy_json_object(
    value: dict[str, object],
    depth: int = 0,
) -> dict[str, object]:
    if depth > MAX_JSON_NESTING_DEPTH:
        raise _InvalidJsonValue()
    copied: dict[str, object] = {}
    for key, item in value.items():
        if not isinstance(key, str):
            raise _InvalidJsonValue()
        copied[key] = _copy_json_value(item, depth + 1)
    return copied


def _copy_json_value(value: object, depth: int) -> object:
    if value is None or type(value) is bool:
        return value
    if isinstance(value, str):
        return value
    if type(value) is int:
        if not -MAX_SAFE_JSON_INTEGER <= value <= MAX_SAFE_JSON_INTEGER:
            raise _InvalidJsonValue()
        return value
    if type(value) is float:
        if not math.isfinite(value) or (
            value.is_integer() and abs(value) > MAX_SAFE_JSON_INTEGER
        ):
            raise _InvalidJsonValue()
        return value
    if isinstance(value, dict):
        return _copy_json_object(value, depth)
    if isinstance(value, list):
        if depth > MAX_JSON_NESTING_DEPTH:
            raise _InvalidJsonValue()
        return [_copy_json_value(item, depth + 1) for item in value]
    raise _InvalidJsonValue()


def _rpc_error_response(
    code: int, request_id: int | str | None = None
) -> dict[str, object]:
    normalized_code, message = _normalize_rpc_error(code)
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {
            "code": normalized_code,
            "message": message,
        },
    }


def _require_exact_rpc_keys(
    params: object,
    expected: frozenset[str],
) -> None:
    if type(params) is not dict or set(params) != expected:
        raise _InvalidRpcParams()


def _require_session_id(value: object, pattern: re.Pattern[str]) -> str:
    if type(value) is not str or pattern.fullmatch(value) is None:
        raise _InvalidRpcParams()
    return value


def _normalize_rpc_params(
    method: str,
    params: object,
    policy_context: RpcPolicyContext,
) -> dict[str, object]:
    if type(policy_context) is not RpcPolicyContext:
        raise _InvalidRpcParams()

    if method == "session.create":
        _require_exact_rpc_keys(params, frozenset())
        return {"cwd": str(policy_context.cwd), "source": "opentrad"}

    if method == "session.resume":
        _require_exact_rpc_keys(params, frozenset({"session_id"}))
        return {
            "session_id": _require_session_id(
                params["session_id"],
                STORED_SESSION_ID_PATTERN,
            )
        }

    if method in {"session.status", "session.close", "session.interrupt"}:
        _require_exact_rpc_keys(params, frozenset({"session_id"}))
        return {
            "session_id": _require_session_id(
                params["session_id"],
                LIVE_SESSION_ID_PATTERN,
            )
        }

    if method == "prompt.submit":
        _require_exact_rpc_keys(params, frozenset({"session_id", "text"}))
        session_id = _require_session_id(
            params["session_id"],
            LIVE_SESSION_ID_PATTERN,
        )
        text = params["text"]
        if type(text) is not str or len(text) > MAX_PROMPT_CHARACTERS:
            raise _InvalidRpcParams()
        try:
            encoded_text = text.encode("utf-8", errors="strict")
        except UnicodeEncodeError:
            raise _InvalidRpcParams() from None
        if not text.strip() or len(encoded_text) > MAX_PROMPT_UTF8_BYTES:
            raise _InvalidRpcParams()
        return {"session_id": session_id, "text": text}

    if method == "approval.respond":
        _require_exact_rpc_keys(params, frozenset({"session_id", "choice"}))
        session_id = _require_session_id(
            params["session_id"],
            LIVE_SESSION_ID_PATTERN,
        )
        choice = params["choice"]
        if type(choice) is not str or choice not in {"once", "deny"}:
            raise _InvalidRpcParams()
        return {"session_id": session_id, "choice": choice, "all": False}

    raise _InvalidRpcParams()


def dispatch_rpc_request(
    request: RpcRequest,
    dispatcher: RpcDispatcher,
    policy_context: RpcPolicyContext,
) -> dict[str, object] | None:
    """Apply the method and parameter policy before calling the gateway."""

    if type(request) is not RpcRequest:
        return _rpc_error_response(-32600)
    request_id = request.request_id
    method = request.method
    params = request.params
    if (
        not _is_valid_rpc_id(request_id)
        or type(method) is not str
        or not _is_strict_utf8(method)
    ):
        return _rpc_error_response(-32600)
    if method not in ALLOWED_RPC_METHODS:
        return _rpc_error_response(-32601, request_id)
    try:
        normalized_params = _normalize_rpc_params(
            method,
            params,
            policy_context,
        )
    except BaseException:
        return _rpc_error_response(-32602, request_id)
    try:
        normalized_request: dict[str, object] = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": normalized_params,
        }
        response = dispatcher(normalized_request)
    except BaseException:
        return _rpc_error_response(-32603, request_id)
    if response is None:
        return None
    if not isinstance(response, dict):
        return _rpc_error_response(-32603, request_id)
    return response


def run_ndjson_loop(
    input_stream: BinaryIO,
    transport: SafeJsonTransport,
    dispatcher: RpcDispatcher,
    shutdown: Callable[[], object],
    policy_context: RpcPolicyContext,
) -> bool:
    """Run the owned loop and close output after shutdown on every exit.

    ``dispatcher`` must already be unary and transport-bound.  Native gateway
    dispatchers require :func:`bind_server_dispatch`; the owned quarantine
    returns an equivalent guarded unary dispatcher directly.  Passing the
    pinned gateway's raw ``server.dispatch`` would select its unsafe default
    stdio transport for asynchronous responses and events.
    """

    try:
        if not transport.write_frame(READY_ENVELOPE):
            return False
        while True:
            try:
                frame = input_stream.readline(MAX_NDJSON_FRAME_BYTES + 1)
            except BaseException:
                return False
            if not isinstance(frame, bytes):
                return False
            if frame == b"":
                return True
            if len(frame) > MAX_NDJSON_FRAME_BYTES:
                transport.write_frame(_rpc_error_response(-32600))
                return False
            if frame.strip() == b"":
                continue
            try:
                request = parse_rpc_request(frame)
            except _RpcFrameError as error:
                if not transport.write_frame(_rpc_error_response(error.code)):
                    return False
                continue
            if request.method not in ALLOWED_RPC_METHODS:
                response = _rpc_error_response(-32601, request.request_id)
            else:
                response = dispatch_rpc_request(request, dispatcher, policy_context)
            if response is not None and not transport.write_frame(response):
                return False
    finally:
        try:
            shutdown()
        except BaseException:
            pass
        try:
            transport.close()
        except BaseException:
            pass


def parse_capability(raw: bytes, *, now: int | None = None) -> Capability:
    """Parse the closed FD3 capability schema without reflecting input in errors."""

    if not isinstance(raw, bytes) or len(raw) == 0 or len(raw) > CAPABILITY_MAX_BYTES:
        _reject("capability_size")
    try:
        text = raw.decode("utf-8", errors="strict")
        payload = json.loads(text, object_pairs_hook=_pairs_without_duplicates)
    except (
        UnicodeDecodeError,
        json.JSONDecodeError,
        _DuplicateCapabilityKey,
        RecursionError,
    ):
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
    if (
        expires_at <= current_time
        or expires_at > current_time + CAPABILITY_MAX_LIFETIME_SECONDS
    ):
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
        bounded_timeout = min(
            max(float(timeout_seconds), 0.001), CAPABILITY_READ_TIMEOUT_SECONDS
        )
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
            candidate = (
                runtime_root
                / "lib"
                / f"python{version[0]}.{version[1]}"
                / "site-packages"
            )
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


def activate_site_packages(
    site_packages: Path, sys_path: list[str] | None = None
) -> None:
    """Append a validated directory without processing .pth or sitecustomize.

    The isolated interpreter's standard-library paths must stay ahead of the
    managed runtime so an added site-packages module cannot shadow stdlib.
    """

    target_path = sys.path if sys_path is None else sys_path
    value = str(site_packages)
    if value not in target_path:
        target_path.append(value)


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
        writes = isinstance(mode, str) and any(
            character in mode for character in "wax+"
        )
        if type(flags) is int:
            write_flags = (
                os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND
            )
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
    policy = AuditPolicy(
        paths.hermes_home, paths.cwd, broker_port=capability.broker_port
    )
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
    if (
        not flags.isolated
        or not flags.no_site
        or not sys.dont_write_bytecode
        or not flags.utf8_mode
    ):
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


def _capture_binary_stdin() -> BinaryIO:
    """Capture the inherited binary request stream before runtime redirection."""

    stream = getattr(sys.stdin, "buffer", None)
    if stream is None or not callable(getattr(stream, "readline", None)):
        _reject("stdin_transport")
    return stream


def _read_owned_runtime_source(runtime_path: Path) -> bytes:
    """Read one immutable-looking regular file without following a symlink."""

    no_follow = getattr(os, "O_NOFOLLOW", None)
    close_on_exec = getattr(os, "O_CLOEXEC", None)
    if type(no_follow) is not int or type(close_on_exec) is not int:
        _reject("owned_runtime_platform")

    descriptor: int | None = None
    try:
        lexical = Path(os.path.normpath(os.fspath(runtime_path)))
        if not runtime_path.is_absolute() or lexical != runtime_path:
            _reject("owned_runtime_path")
        before = runtime_path.lstat()
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_mode & 0o022
            or before.st_mode & 0o400 == 0
            or before.st_size <= 0
            or before.st_size > OWNED_RUNTIME_MAX_BYTES
            or (hasattr(os, "getuid") and before.st_uid != os.getuid())
        ):
            _reject("owned_runtime_metadata")

        descriptor = os.open(runtime_path, os.O_RDONLY | no_follow | close_on_exec)
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)
            or opened.st_uid != before.st_uid
            or opened.st_mode != before.st_mode
            or opened.st_size != before.st_size
        ):
            _reject("owned_runtime_race")

        source = bytearray()
        while len(source) <= OWNED_RUNTIME_MAX_BYTES:
            chunk = os.read(
                descriptor,
                min(65_536, OWNED_RUNTIME_MAX_BYTES + 1 - len(source)),
            )
            if chunk == b"":
                break
            source.extend(chunk)
        after = os.fstat(descriptor)
        if (
            len(source) != opened.st_size
            or len(source) > OWNED_RUNTIME_MAX_BYTES
            or (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
            != (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns)
        ):
            _reject("owned_runtime_race")
        return bytes(source)
    except LauncherRefusal:
        raise
    except BaseException:
        _reject("owned_runtime_read")
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass


def _load_owned_runtime(launcher_path: Path) -> types.ModuleType:
    """Hash-pin and compile the reviewed sibling runtime without importing pyc."""

    try:
        canonical_launcher = _canonical_existing_path(
            launcher_path,
            directory=False,
        )
        launcher_mode = stat.S_IMODE(canonical_launcher.lstat().st_mode)
        if launcher_mode & 0o022 or launcher_mode & 0o400 == 0:
            _reject("owned_launcher_metadata")
        runtime_path = canonical_launcher.with_name(OWNED_RUNTIME_FILENAME)
        if OWNED_RUNTIME_MODULE_NAME in sys.modules:
            _reject("owned_runtime_collision")
        source = _read_owned_runtime_source(runtime_path)
        if hashlib.sha256(source).hexdigest() != OWNED_RUNTIME_SHA256:
            _reject("owned_runtime_digest")
        code = compile(
            source,
            str(runtime_path),
            "exec",
            flags=0,
            dont_inherit=True,
            optimize=0,
        )
        module = types.ModuleType(OWNED_RUNTIME_MODULE_NAME)
        module.__file__ = str(runtime_path)
        module.__package__ = ""
        module.__loader__ = None
        if OWNED_RUNTIME_MODULE_NAME in sys.modules:
            _reject("owned_runtime_collision")
        sys.modules[OWNED_RUNTIME_MODULE_NAME] = module
        try:
            exec(code, module.__dict__)
        except BaseException:
            if sys.modules.get(OWNED_RUNTIME_MODULE_NAME) is module:
                sys.modules.pop(OWNED_RUNTIME_MODULE_NAME, None)
            _reject("owned_runtime_execution")
        if sys.modules.get(OWNED_RUNTIME_MODULE_NAME) is not module:
            _reject("owned_runtime_registry")
        return module
    except LauncherRefusal:
        raise
    except BaseException:
        if (
            "module" in locals()
            and sys.modules.get(OWNED_RUNTIME_MODULE_NAME) is module
        ):
            sys.modules.pop(OWNED_RUNTIME_MODULE_NAME, None)
        _reject("owned_runtime_load")


def _instantiate_owned_runtime(
    runtime_module: types.ModuleType,
    site_packages: Path,
    transport: SafeJsonTransport,
) -> object:
    """Create the exact guarded runtime type exported by the pinned source."""

    try:
        if (
            type(runtime_module) is not types.ModuleType
            or runtime_module.__name__ != OWNED_RUNTIME_MODULE_NAME
            or sys.modules.get(OWNED_RUNTIME_MODULE_NAME) is not runtime_module
        ):
            _reject("owned_runtime_module")
        loader = getattr(runtime_module, "load_pinned_runtime", None)
        guarded_type = getattr(runtime_module, "GuardedHermesRuntime", None)
        if (
            type(loader) is not types.FunctionType
            or loader.__module__ != runtime_module.__name__
            or type(guarded_type) is not type
            or guarded_type.__module__ != runtime_module.__name__
        ):
            _reject("owned_runtime_contract")
        guarded = loader(site_packages, transport)
        if type(guarded) is not guarded_type:
            _reject("owned_runtime_result")
        return guarded
    except LauncherRefusal:
        raise
    except BaseException:
        _reject("owned_runtime_start")


def _write_generic_refusal() -> None:
    try:
        os.write(2, GENERIC_STDERR)
    except OSError:
        pass


def main() -> int:
    transport: SafeJsonTransport | None = None
    shutdown_callback: Callable[[], object] | None = None
    loop_started = False
    try:
        state = bootstrap_pre_import()
        input_stream = _capture_binary_stdin()
        transport = SafeJsonTransport.capture_stdout(state.capability)
        policy_context = RpcPolicyContext(state.paths.cwd)
        runtime_module = _load_owned_runtime(state.paths.launcher)
        guarded = _instantiate_owned_runtime(
            runtime_module,
            state.site_packages,
            transport,
        )
        dispatcher = getattr(guarded, "dispatch", None)
        shutdown = getattr(guarded, "shutdown", None)
        if not callable(dispatcher) or not callable(shutdown):
            _reject("owned_runtime_api")
        shutdown_callback = shutdown
        loop_started = True
        if not run_ndjson_loop(
            input_stream,
            transport,
            dispatcher,
            shutdown_callback,
            policy_context,
        ):
            _reject("owned_runtime_loop")
        return 0
    except BaseException:
        _write_generic_refusal()
        return EX_CONFIG
    finally:
        if not loop_started:
            if shutdown_callback is not None:
                try:
                    shutdown_callback()
                except BaseException:
                    pass
            if transport is not None:
                try:
                    transport.close()
                except BaseException:
                    pass


if __name__ == "__main__":
    raise SystemExit(main())
