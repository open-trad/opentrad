#!/usr/bin/env python3
"""OpenTrad-owned post-bootstrap quarantine for pinned Hermes Agent.

Only Python's standard library is imported before :func:`load_pinned_runtime`
crosses the already-verified managed ``site-packages`` boundary.

The exact wheel, RECORD, and reviewed source hashes are a prerequisite trust
boundary.  This module detects protocol drift and removes native execution
surfaces; it is not an in-process sandbox against malicious Python that rewrites
``sys.meta_path`` or interpreter objects.  The dedicated launcher audit policy
and process lifecycle remain the outer enforcement boundary.
"""

from __future__ import annotations

import atexit
import concurrent.futures
import importlib
import importlib.machinery
import inspect
import io
import os
from pathlib import Path
import re
import sys
import threading
import time
import types
from typing import Callable, NoReturn


PINNED_HERMES_VERSION = "0.18.2"
PINNED_HERMES_RELEASE_DATE = "2026.7.7.2"
GENERIC_RUNTIME_REFUSAL = "OpenTrad Hermes runtime refused startup"
EXPECTED_RPC_METHODS = frozenset(
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
_PINNED_MODULE_FILES = {
    "hermes_constants": "hermes_constants.py",
    "hermes_cli": "hermes_cli/__init__.py",
    "hermes_cli.env_loader": "hermes_cli/env_loader.py",
    "hermes_cli.banner": "hermes_cli/banner.py",
    "tui_gateway": "tui_gateway/__init__.py",
    "tui_gateway.transport": "tui_gateway/transport.py",
    "tui_gateway.server": "tui_gateway/server.py",
}
_IDLE_REAPER_QUALNAME = "_start_idle_reaper.<locals>._loop"
_LOCK_TYPE = type(threading.Lock())
_RLOCK_TYPE = type(threading.RLock())
_THREAD_POOL_SHUTDOWN = concurrent.futures.ThreadPoolExecutor.shutdown
_LIVE_SESSION_ID_PATTERN = re.compile(r"^[0-9a-f]{8}$")
_STORED_SESSION_ID_PATTERN = re.compile(r"^\d{8}_\d{6}_[0-9a-f]{6}$", re.ASCII)
_MAX_LAZY_SESSIONS = 128
_MAX_SAFE_JSON_INTEGER = 9_007_199_254_740_991
_MAX_RPC_ID_CHARACTERS = 128
_MAX_PROMPT_CHARACTERS = 262_144
_MAX_PROMPT_UTF8_BYTES = 1_048_576
_BOOTSTRAP_IMPORTS = frozenset({"hermes_constants", "tui_gateway.server"})
_TRANSPORT_METHOD_NAMES = ("close", "write", "write_frame")
_EMPTY_LONG_HANDLERS = frozenset()
_QUARANTINED_SERVER_HELPERS = (
    "_allowed_image_extensions",
    "_clear_session_context",
    "_enable_gateway_prompts",
    "_emit_approval_request",
    "_finalize_session",
    "_get_db",
    "_git",
    "_git_branch_for_cwd",
    "_load_cfg",
    "_load_provider_routing",
    "_mirror_slash_side_effects",
    "_profile_home",
    "_notify_session_boundary",
    "_clear_pending",
    "_close_session_by_id",
    "_register_session_cwd",
    "_resolve_cwd_git",
    "_resolve_runtime_with_fallback",
    "_resolve_startup_runtime",
    "_restart_slash_worker",
    "_run_prompt_submit",
    "_save_cfg",
    "_SlashWorker",
    "_schedule_session_cap_enforcement",
    "_schedule_agent_build",
    "_schedule_mcp_late_refresh",
    "_set_session_context",
    "_persist_session_git_meta",
    "_stored_session_runtime_overrides",
    "_resolve_model",
    "_start_agent_build",
    "_start_idle_reaper",
    "_start_notification_poller",
    "_sess",
    "_sess_nowait",
    "_teardown_session",
    "_wire_callbacks",
    "_make_agent",
)
_NATIVE_STATE_MAPS = (
    "_answers",
    "_pending",
    "_pending_prompt_payloads",
    "_sessions",
)
_HERMES_OWNED_TOP_LEVELS = frozenset(
    {
        "acp_adapter",
        "agent",
        "batch_runner",
        "cli",
        "cron",
        "gateway",
        "hermes_bootstrap",
        "hermes_cli",
        "hermes_constants",
        "hermes_logging",
        "hermes_state",
        "hermes_time",
        "mcp_serve",
        "model_tools",
        "plugins",
        "providers",
        "run_agent",
        "tools",
        "toolset_distributions",
        "toolsets",
        "trajectory_compressor",
        "tui_gateway",
        "utils",
    }
)


class RuntimeImportRefusal(RuntimeError):
    """Non-reflective failure at the reviewed Hermes import boundary."""

    def __init__(self) -> None:
        super().__init__(GENERIC_RUNTIME_REFUSAL)


class _LazySessionStore:
    """Bounded, non-persistent identities for the quarantined RPC surface."""

    __slots__ = ("_lock", "_sessions")

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._sessions: dict[str, str] = {}

    def verify(self) -> None:
        if type(self._lock) is not _RLOCK_TYPE:
            _refuse()
        with self._lock:
            if (
                type(self._sessions) is not dict
                or len(self._sessions) > _MAX_LAZY_SESSIONS
            ):
                _refuse()
            snapshot = tuple(self._sessions.items())
        for live_session_id, stored_session_id in snapshot:
            if (
                type(live_session_id) is not str
                or _LIVE_SESSION_ID_PATTERN.fullmatch(live_session_id) is None
                or type(stored_session_id) is not str
                or _STORED_SESSION_ID_PATTERN.fullmatch(stored_session_id) is None
            ):
                _refuse()
        if len({stored for _live, stored in snapshot}) != len(snapshot):
            _refuse()

    def create(self) -> tuple[str, str] | None:
        with self._lock:
            self.verify()
            if len(self._sessions) >= _MAX_LAZY_SESSIONS:
                return None
            for _attempt in range(_MAX_LAZY_SESSIONS * 2):
                live_session_id = os.urandom(4).hex()
                timestamp = time.strftime("%Y%m%d_%H%M%S", time.gmtime())
                stored_session_id = f"{timestamp}_{os.urandom(3).hex()}"
                if (
                    live_session_id not in self._sessions
                    and stored_session_id not in self._sessions.values()
                ):
                    self._sessions[live_session_id] = stored_session_id
                    self.verify()
                    return live_session_id, stored_session_id
        _refuse()

    def stored_session_id(self, live_session_id: str) -> str | None:
        with self._lock:
            self.verify()
            return self._sessions.get(live_session_id)

    def close(self, live_session_id: str) -> bool:
        with self._lock:
            self.verify()
            closed = self._sessions.pop(live_session_id, None) is not None
            self.verify()
            return closed

    def clear(self) -> None:
        with self._lock:
            self._sessions.clear()


class _DisabledExecutor:
    """Owned replacement for Hermes' imported-but-never-started RPC pool."""

    __slots__ = ()

    def submit(self, *_args: object, **_kwargs: object) -> NoReturn:
        _refuse()

    def shutdown(self, *_args: object, **_kwargs: object) -> None:
        return None


def _detach_server_module(server: types.ModuleType) -> None:
    """Remove the exact imported server without exposing a re-import path."""

    name = getattr(server, "__name__", None)
    if type(name) is not str:
        return
    if sys.modules.get(name) is server:
        sys.modules.pop(name, None)
    parent_name, separator, child_name = name.rpartition(".")
    parent = sys.modules.get(parent_name) if separator else None
    if type(parent) is types.ModuleType and getattr(parent, child_name, None) is server:
        try:
            delattr(parent, child_name)
        except BaseException:
            pass


def _poison_server_module(server: types.ModuleType, *, detach: bool) -> None:
    """Turn every reachable native RPC entry point into an owned refusal."""

    if type(server) is not types.ModuleType:
        return
    namespace = vars(server)
    pool = namespace.get("_pool")
    if type(pool) is concurrent.futures.ThreadPoolExecutor:
        try:
            _THREAD_POOL_SHUTDOWN(pool, wait=False, cancel_futures=True)
        except BaseException:
            pass

    methods = namespace.get("_methods")
    if type(methods) is dict:
        methods.clear()
    server._methods = types.MappingProxyType({})
    for name in _NATIVE_STATE_MAPS:
        state = namespace.get(name)
        if type(state) is dict:
            state.clear()
        setattr(server, name, types.MappingProxyType({}))

    server._LONG_HANDLERS = _EMPTY_LONG_HANDLERS
    server._db = None
    server._db_error = None
    server._cfg_cache = None
    server._cfg_mtime = None
    server._cfg_path = None
    server._pool = _DisabledExecutor()

    module_name = getattr(server, "__name__", None)
    for name, value in tuple(namespace.items()):
        if (
            type(value) is types.FunctionType
            and getattr(value, "__module__", None) == module_name
        ):
            setattr(server, name, _blocked_server_helper)
    for name in (
        "_",
        "_shutdown_sessions",
        "_start_idle_reaper",
        "dispatch",
        "handle_request",
        "method",
    ):
        setattr(server, name, _blocked_server_helper)

    if detach:
        _detach_server_module(server)


def _build_denied_import_finder(
    root: Path,
    stub_names: frozenset[str],
) -> tuple[object, Callable[[bool], None]]:
    """Build a finder whose authority lives only in import-private closures."""

    if _BOOTSTRAP_IMPORTS != frozenset({"hermes_constants", "tui_gateway.server"}):
        _refuse()
    bootstrap_specs = types.MappingProxyType(
        {name: root / _PINNED_MODULE_FILES[name] for name in _BOOTSTRAP_IMPORTS}
    )
    stdlib_names = frozenset(sys.stdlib_module_names)
    try:
        stdlib_roots = tuple(
            Path(value).resolve(strict=True)
            for value in {sys.base_prefix, sys.base_exec_prefix}
            if isinstance(value, str) and value
        )
    except BaseException:
        _refuse()
    if not stdlib_roots:
        _refuse()

    any_of = any
    base_exception = BaseException
    bool_type = bool
    function_type = types.FunctionType
    getattr_of = getattr
    isinstance_of = isinstance
    len_of = len
    module_not_found_type = ModuleNotFoundError
    path_finder = importlib.machinery.PathFinder.find_spec
    path_type = Path
    refusal_type = RuntimeImportRefusal
    str_type = str
    tuple_of = tuple
    type_of = type
    vars_of = vars
    zip_of = zip

    def seal(self: object) -> None:
        if self._bootstrap_open is not True:
            raise refusal_type() from None
        self._bootstrap_open = False

    def find_spec(
        self: object,
        fullname: str,
        path: object = None,
        target: object = None,
    ) -> importlib.machinery.ModuleSpec | None:
        if fullname in stub_names:
            raise refusal_type() from None
        expected = bootstrap_specs.get(fullname)
        if self._bootstrap_open and expected is not None:
            spec = path_finder(fullname, path, target)
            origin = getattr_of(spec, "origin", None)
            if (
                spec is None
                or not isinstance_of(origin, str_type)
                or path_type(origin) != expected
                or expected.resolve(strict=True) != expected
            ):
                raise refusal_type() from None
            return spec
        root_name = fullname.partition(".")[0]
        if root_name in stdlib_names:
            spec = path_finder(fullname, path, target)
            if spec is None:
                raise module_not_found_type(fullname) from None
            origin = getattr_of(spec, "origin", None)
            if not isinstance_of(origin, str_type):
                raise refusal_type() from None
            if origin in {"built-in", "frozen"}:
                return spec
            try:
                resolved = path_type(origin).resolve(strict=True)
                if not any_of(
                    resolved == stdlib_root or stdlib_root in resolved.parents
                    for stdlib_root in stdlib_roots
                ):
                    raise refusal_type() from None
            except refusal_type:
                raise
            except base_exception:
                raise refusal_type() from None
            return spec
        if fullname:
            raise refusal_type() from None
        return None

    class DeniedHermesImportFinder:
        __slots__ = ("_bootstrap_open",)

        def __init__(self) -> None:
            self._bootstrap_open = True

    DeniedHermesImportFinder.__name__ = "_DeniedHermesImportFinder"
    DeniedHermesImportFinder.__qualname__ = "_DeniedHermesImportFinder"
    DeniedHermesImportFinder.find_spec = find_spec
    DeniedHermesImportFinder.seal = seal
    finder = DeniedHermesImportFinder()
    finder_type = type_of(finder)
    finder_attributes = tuple_of(vars_of(finder_type).items())
    find_spec_contract = _capture_function_contract(find_spec)
    seal_contract = _capture_function_contract(seal)

    def verify(expected_open: bool) -> None:
        def verify_function(contract: tuple[object, ...]) -> None:
            function, code, closure, contents, defaults, kwdefaults = contract
            if type_of(function) is not function_type:
                raise refusal_type() from None
            try:
                current = tuple_of(
                    cell.cell_contents for cell in function.__closure__ or ()
                )
            except base_exception:
                raise refusal_type() from None
            if (
                function.__code__ is not code
                or function.__closure__ is not closure
                or function.__defaults__ is not defaults
                or function.__kwdefaults__ is not kwdefaults
                or len_of(current) != len_of(contents)
                or any_of(
                    value is not expected
                    for value, expected in zip_of(current, contents, strict=True)
                )
            ):
                raise refusal_type() from None

        if (
            type_of(expected_open) is not bool_type
            or type_of(finder) is not finder_type
            or finder._bootstrap_open is not expected_open
            or tuple_of(vars_of(finder_type).items()) != finder_attributes
            or getattr_of(finder_type, "find_spec", None) is not find_spec
            or getattr_of(finder_type, "seal", None) is not seal
        ):
            raise refusal_type() from None
        verify_function(find_spec_contract)
        verify_function(seal_contract)

    verify(True)
    return finder, verify


class _DropTextStream(io.TextIOBase):
    """UTF-8 text sink used after the owned binary transport is captured."""

    @property
    def encoding(self) -> str:
        return "utf-8"

    @property
    def errors(self) -> str:
        return "replace"

    def isatty(self) -> bool:
        return False

    def reconfigure(self, **_kwargs: object) -> None:
        return None

    def write(self, value: str) -> int:
        return 0 if isinstance(value, str) else 0

    def flush(self) -> None:
        return None

    def close(self) -> None:
        return None


def _drop_exception_hook(*_args: object, **_kwargs: object) -> None:
    return None


class GuardedHermesRuntime:
    """Narrow post-import result: one bound dispatcher and bounded shutdown."""

    __slots__ = (
        "_dispatcher",
        "_dispatcher_contract",
        "_dispatcher_graph_contract",
        "_shutdown",
        "_shutdown_contract",
        "_shutdown_graph_contract",
        "_closed",
        "_lock",
    )

    def __init__(
        self,
        dispatcher: Callable[[dict[str, object]], dict[str, object] | None],
        shutdown: Callable[[], None],
    ) -> None:
        self._dispatcher = dispatcher
        self._dispatcher_contract = _capture_function_contract(dispatcher)
        self._dispatcher_graph_contract = _capture_function_graph_contract(dispatcher)
        self._shutdown = shutdown
        self._shutdown_contract = _capture_function_contract(shutdown)
        self._shutdown_graph_contract = _capture_function_graph_contract(shutdown)
        self._closed = False
        self._lock = threading.Lock()

    def __repr__(self) -> str:
        return "GuardedHermesRuntime(pinned='0.18.2', methods=7)"

    def dispatch(self, request: dict[str, object]) -> dict[str, object] | None:
        with self._lock:
            if self._closed:
                raise RuntimeImportRefusal()
            try:
                if self._dispatcher is not self._dispatcher_contract[0]:
                    _refuse()
                _verify_function_contract(self._dispatcher_contract)
                _verify_function_graph_contract(self._dispatcher_graph_contract)
                return self._dispatcher(request)
            except BaseException:
                pass
        raise RuntimeImportRefusal()

    def shutdown(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            try:
                if self._shutdown is not self._shutdown_contract[0]:
                    _refuse()
                _verify_function_contract(self._shutdown_contract)
                _verify_function_graph_contract(self._shutdown_graph_contract)
                self._shutdown()
            except BaseException:
                return


def _refuse() -> NoReturn:
    raise RuntimeImportRefusal() from None


def _blocked_server_helper(*_args: object, **_kwargs: object) -> NoReturn:
    _refuse()


def _capture_function_contract(function: object) -> tuple[object, ...]:
    if type(function) is not types.FunctionType:
        _refuse()
    closure = function.__closure__
    try:
        closure_contents = tuple(cell.cell_contents for cell in closure or ())
    except BaseException:
        _refuse()
    return (
        function,
        function.__code__,
        closure,
        closure_contents,
        function.__defaults__,
        function.__kwdefaults__,
    )


def _verify_function_contract(contract: tuple[object, ...]) -> None:
    try:
        function, code, closure, closure_contents, defaults, kwdefaults = contract
        current_contents = tuple(
            cell.cell_contents for cell in function.__closure__ or ()
        )
        if (
            type(function) is not types.FunctionType
            or function.__code__ is not code
            or function.__closure__ is not closure
            or function.__defaults__ is not defaults
            or function.__kwdefaults__ is not kwdefaults
            or len(current_contents) != len(closure_contents)
        ):
            _refuse()
        for current, expected in zip(
            current_contents,
            closure_contents,
            strict=True,
        ):
            if current is not expected:
                _refuse()
    except RuntimeImportRefusal:
        raise
    except BaseException:
        _refuse()


def _capture_function_graph_contract(
    function: object,
) -> tuple[tuple[object, ...], ...]:
    try:
        pending = [function]
        seen: set[int] = set()
        contracts: list[tuple[object, ...]] = []
        while pending:
            candidate = pending.pop()
            if type(candidate) is not types.FunctionType:
                _refuse()
            identity = id(candidate)
            if identity in seen:
                continue
            seen.add(identity)
            contract = _capture_function_contract(candidate)
            contracts.append(contract)
            closure_contents = contract[3]
            for value in closure_contents:
                if type(value) is types.FunctionType:
                    pending.append(value)
            defaults = contract[4]
            for value in defaults or ():
                if type(value) is types.FunctionType:
                    pending.append(value)
            kwdefaults = contract[5]
            for value in (kwdefaults or {}).values():
                if type(value) is types.FunctionType:
                    pending.append(value)
        return tuple(contracts)
    except RuntimeImportRefusal:
        raise
    except BaseException:
        _refuse()


def _verify_function_graph_contract(
    contracts: tuple[tuple[object, ...], ...],
) -> None:
    try:
        if type(contracts) is not tuple or not contracts:
            _refuse()
        for contract in contracts:
            _verify_function_contract(contract)
    except RuntimeImportRefusal:
        raise
    except BaseException:
        _refuse()


def _capture_owned_runtime_contract() -> tuple[object, ...]:
    try:
        module_name = __name__
        namespace = globals()
        global_bindings = tuple(
            sorted(
                (
                    (name, value)
                    for name, value in tuple(namespace.items())
                    if not name.startswith("__")
                ),
                key=lambda item: item[0],
            )
        )
        mutable_snapshots = tuple(
            (
                name,
                (
                    ("dict", tuple(value.items()))
                    if type(value) is dict
                    else ("list", tuple(value))
                    if type(value) is list
                    else ("set", frozenset(value))
                ),
            )
            for name, value in global_bindings
            if type(value) in {dict, list, set}
        )
        function_contracts = tuple(
            sorted(
                (
                    (name, _capture_function_contract(value))
                    for name, value in tuple(globals().items())
                    if type(value) is types.FunctionType
                    and getattr(value, "__module__", None) == module_name
                ),
                key=lambda item: item[0],
            )
        )
        class_contracts = []
        for class_name, owned_type in sorted(tuple(globals().items())):
            if (
                not isinstance(owned_type, type)
                or getattr(owned_type, "__module__", None) != module_name
            ):
                continue
            attributes = tuple(vars(owned_type).items())
            function_descriptors = []
            for name, descriptor in attributes:
                functions: list[tuple[object, ...]] = []
                if type(descriptor) is types.FunctionType:
                    functions.append(_capture_function_contract(descriptor))
                elif isinstance(descriptor, (classmethod, staticmethod)):
                    functions.append(_capture_function_contract(descriptor.__func__))
                elif isinstance(descriptor, property):
                    for function in (
                        descriptor.fget,
                        descriptor.fset,
                        descriptor.fdel,
                    ):
                        if function is not None:
                            functions.append(_capture_function_contract(function))
                if functions:
                    function_descriptors.append((name, descriptor, tuple(functions)))
            class_contracts.append(
                (
                    class_name,
                    owned_type,
                    owned_type.__bases__,
                    attributes,
                    tuple(function_descriptors),
                )
            )
        return (
            RuntimeImportRefusal,
            types.FunctionType,
            _THREAD_POOL_SHUTDOWN,
            sys.modules,
            module_name,
            sys.modules.get(module_name),
            namespace,
            global_bindings,
            mutable_snapshots,
            function_contracts,
            tuple(class_contracts),
        )
    except RuntimeImportRefusal:
        raise
    except BaseException:
        _refuse()


def _verify_owned_runtime_contract(
    contract: tuple[object, ...],
    _any: Callable[..., bool] = any,
    _base_exception: type[BaseException] = BaseException,
    _dict: type[dict] = dict,
    _frozenset: Callable[..., frozenset[object]] = frozenset,
    _getattr: Callable[..., object] = getattr,
    _len: Callable[[object], int] = len,
    _list: type[list] = list,
    _set: type[set] = set,
    _sorted: Callable[..., list[object]] = sorted,
    _tuple: type[tuple] = tuple,
    _type: type = type,
    _vars: Callable[..., dict[str, object]] = vars,
    _zip: Callable[..., object] = zip,
) -> None:
    try:
        (
            refusal_type,
            function_type,
            thread_pool_shutdown,
            module_registry,
            module_name,
            module,
            namespace,
            global_bindings,
            mutable_snapshots,
            function_contracts,
            class_contracts,
        ) = contract

        def refuse_owned_contract() -> NoReturn:
            raise refusal_type() from None

        def verify_function(function_contract: tuple[object, ...]) -> None:
            (
                function,
                code,
                closure,
                closure_contents,
                defaults,
                kwdefaults,
            ) = function_contract
            if _type(function) is not function_type:
                refuse_owned_contract()
            try:
                current_contents = _tuple(
                    cell.cell_contents for cell in function.__closure__ or ()
                )
            except _base_exception:
                refuse_owned_contract()
            if (
                function.__code__ is not code
                or function.__closure__ is not closure
                or function.__defaults__ is not defaults
                or function.__kwdefaults__ is not kwdefaults
                or _len(current_contents) != _len(closure_contents)
            ):
                refuse_owned_contract()
            for current, expected in _zip(
                current_contents,
                closure_contents,
                strict=True,
            ):
                if current is not expected:
                    refuse_owned_contract()

        if (
            namespace.get("RuntimeImportRefusal") is not refusal_type
            or _getattr(namespace.get("types"), "FunctionType", None)
            is not function_type
            or namespace.get("_THREAD_POOL_SHUTDOWN") is not thread_pool_shutdown
            or module_registry.get(module_name) is not module
            or module is None
        ):
            refuse_owned_contract()
        if _tuple(
            _sorted(name for name in namespace if not name.startswith("__"))
        ) != _tuple(name for name, _value in global_bindings):
            refuse_owned_contract()
        for name, expected in global_bindings:
            if namespace.get(name) is not expected:
                refuse_owned_contract()
        for name, snapshot in mutable_snapshots:
            value = namespace.get(name)
            kind, expected = snapshot
            if kind == "dict":
                current = _tuple(value.items()) if _type(value) is _dict else None
            elif kind == "list":
                current = _tuple(value) if _type(value) is _list else None
            else:
                current = _frozenset(value) if _type(value) is _set else None
            if current != expected:
                refuse_owned_contract()
        for name, function_contract in function_contracts:
            if namespace.get(name) is not function_contract[0]:
                refuse_owned_contract()
            verify_function(function_contract)
        for (
            class_name,
            owned_type,
            bases,
            attributes,
            function_descriptors,
        ) in class_contracts:
            if namespace.get(class_name) is not owned_type:
                refuse_owned_contract()
            current_attributes = _vars(owned_type)
            if (
                _len(owned_type.__bases__) != _len(bases)
                or _any(
                    current is not expected
                    for current, expected in _zip(
                        owned_type.__bases__, bases, strict=True
                    )
                )
                or _tuple(current_attributes)
                != _tuple(name for name, _value in attributes)
            ):
                refuse_owned_contract()
            for name, expected in attributes:
                if current_attributes.get(name) is not expected:
                    refuse_owned_contract()
            for name, descriptor, descriptor_contracts in function_descriptors:
                if current_attributes.get(name) is not descriptor:
                    refuse_owned_contract()
                for function_contract in descriptor_contracts:
                    verify_function(function_contract)
    except _base_exception:
        raise refusal_type() from None


def _build_server_poisoner() -> tuple[
    Callable[[types.ModuleType, bool], None],
    Callable[..., None],
]:
    """Build an import-private cleanup closure before Hermes can mutate globals."""

    refusal_type = RuntimeImportRefusal
    module_type = types.ModuleType
    function_type = types.FunctionType
    mapping_proxy = types.MappingProxyType
    executor_type = concurrent.futures.ThreadPoolExecutor
    executor_shutdown = _THREAD_POOL_SHUTDOWN
    executor_shutdown_contract = _capture_function_contract(executor_shutdown)
    native_state_maps = _NATIVE_STATE_MAPS
    empty_long_handlers = _EMPTY_LONG_HANDLERS
    required_helpers = _QUARANTINED_SERVER_HELPERS
    module_registry = sys.modules
    all_of = all
    base_exception = BaseException
    delattr_of = delattr
    dict_type = dict
    getattr_of = getattr
    len_of = len
    setattr_of = setattr
    str_type = str
    tuple_of = tuple
    type_of = type
    vars_of = vars
    zip_of = zip

    def blocked(*_args: object, **_kwargs: object) -> NoReturn:
        raise refusal_type() from None

    def drop_hook(*_args: object, **_kwargs: object) -> None:
        return None

    class FailureDisabledExecutor:
        __slots__ = ()

        def submit(self, *_args: object, **_kwargs: object) -> NoReturn:
            raise refusal_type() from None

        def shutdown(self, *_args: object, **_kwargs: object) -> None:
            return None

    def poison(server: types.ModuleType, detach: bool) -> None:
        if type_of(server) is not module_type:
            return
        namespace = vars_of(server)
        pool = namespace.get("_pool")
        if type_of(pool) is executor_type:
            try:
                pool._shutdown = True
            except base_exception:
                pass
            try:
                (
                    shutdown_function,
                    shutdown_code,
                    shutdown_closure,
                    shutdown_closure_contents,
                    shutdown_defaults,
                    shutdown_kwdefaults,
                ) = executor_shutdown_contract
                current_contents = tuple_of(
                    cell.cell_contents for cell in shutdown_function.__closure__ or ()
                )
                if (
                    executor_shutdown is shutdown_function
                    and shutdown_function.__code__ is shutdown_code
                    and shutdown_function.__closure__ is shutdown_closure
                    and shutdown_function.__defaults__ is shutdown_defaults
                    and shutdown_function.__kwdefaults__ is shutdown_kwdefaults
                    and len_of(current_contents) == len_of(shutdown_closure_contents)
                    and all_of(
                        current is expected
                        for current, expected in zip_of(
                            current_contents,
                            shutdown_closure_contents,
                            strict=True,
                        )
                    )
                ):
                    shutdown_function(pool, wait=False, cancel_futures=True)
            except base_exception:
                pass

        methods = namespace.get("_methods")
        if type_of(methods) is dict_type:
            methods.clear()
        server._methods = mapping_proxy({})
        for name in native_state_maps:
            state = namespace.get(name)
            if type_of(state) is dict_type:
                state.clear()
            setattr_of(server, name, mapping_proxy({}))

        server._LONG_HANDLERS = empty_long_handlers
        server._db = None
        server._db_error = None
        server._cfg_cache = None
        server._cfg_mtime = None
        server._cfg_path = None
        server._pool = FailureDisabledExecutor()
        server._panic_hook = drop_hook
        server._thread_panic_hook = drop_hook

        module_name = namespace.get("__name__")
        for name, value in tuple_of(namespace.items()):
            if (
                type_of(value) in {function_type, type_of}
                and getattr_of(value, "__module__", None) == module_name
            ):
                setattr_of(server, name, blocked)
        for name in (
            *required_helpers,
            "_",
            "_emit",
            "_normalize_request",
            "_shutdown_sessions",
            "dispatch",
            "handle_request",
            "method",
            "write_json",
        ):
            setattr_of(server, name, blocked)

        if not detach or type_of(module_name) is not str_type:
            return
        if module_registry.get(module_name) is server:
            module_registry.pop(module_name, None)
        parent_name, separator, child_name = module_name.rpartition(".")
        parent = module_registry.get(parent_name) if separator else None
        if (
            type_of(parent) is module_type
            and getattr_of(parent, child_name, None) is server
        ):
            try:
                delattr_of(parent, child_name)
            except base_exception:
                pass

    return poison, drop_hook


def _capture_external_module_contract(module: types.ModuleType) -> tuple[object, ...]:
    try:
        if type(module) is not types.ModuleType or type(module.__name__) is not str:
            _refuse()
        module_name = module.__name__
        namespace_names = tuple(vars(module))
        function_contracts = tuple(
            sorted(
                (
                    (name, _capture_function_contract(value))
                    for name, value in tuple(vars(module).items())
                    if type(value) is types.FunctionType
                    and getattr(value, "__module__", None) == module_name
                ),
                key=lambda item: item[0],
            )
        )
        class_contracts = []
        for class_name, owned_type in sorted(tuple(vars(module).items())):
            if (
                not isinstance(owned_type, type)
                or getattr(owned_type, "__module__", None) != module_name
            ):
                continue
            attributes = tuple(vars(owned_type).items())
            function_descriptors = []
            for name, descriptor in attributes:
                functions: list[tuple[object, ...]] = []
                if type(descriptor) is types.FunctionType:
                    functions.append(_capture_function_contract(descriptor))
                elif isinstance(descriptor, (classmethod, staticmethod)):
                    functions.append(_capture_function_contract(descriptor.__func__))
                elif isinstance(descriptor, property):
                    for function in (
                        descriptor.fget,
                        descriptor.fset,
                        descriptor.fdel,
                    ):
                        if function is not None:
                            functions.append(_capture_function_contract(function))
                if functions:
                    function_descriptors.append((name, descriptor, tuple(functions)))
            class_contracts.append(
                (
                    class_name,
                    owned_type,
                    owned_type.__bases__,
                    attributes,
                    tuple(function_descriptors),
                )
            )
        return (
            module,
            module_name,
            namespace_names,
            function_contracts,
            tuple(class_contracts),
        )
    except RuntimeImportRefusal:
        raise
    except BaseException:
        _refuse()


def _verify_external_module_contract(contract: tuple[object, ...]) -> None:
    try:
        (
            module,
            module_name,
            namespace_names,
            function_contracts,
            class_contracts,
        ) = contract
        if (
            type(module) is not types.ModuleType
            or module.__name__ != module_name
            or sys.modules.get(module_name) is not module
        ):
            _refuse()
        namespace = vars(module)
        if tuple(namespace) != namespace_names:
            _refuse()
        for name, function_contract in function_contracts:
            if namespace.get(name) is not function_contract[0]:
                _refuse()
            _verify_function_contract(function_contract)
        for (
            class_name,
            owned_type,
            bases,
            attributes,
            function_descriptors,
        ) in class_contracts:
            if namespace.get(class_name) is not owned_type:
                _refuse()
            if len(owned_type.__bases__) != len(bases) or any(
                current is not expected
                for current, expected in zip(owned_type.__bases__, bases, strict=True)
            ):
                _refuse()
            current_attributes = vars(owned_type)
            if tuple(current_attributes) != tuple(name for name, _value in attributes):
                _refuse()
            for name, expected in attributes:
                if current_attributes.get(name) is not expected:
                    _refuse()
            for name, descriptor, descriptor_contracts in function_descriptors:
                if current_attributes.get(name) is not descriptor:
                    _refuse()
                for function_contract in descriptor_contracts:
                    _verify_function_contract(function_contract)
    except RuntimeImportRefusal:
        raise
    except BaseException:
        _refuse()


def _rpc_result(request_id: int | str, result: dict[str, object]) -> dict[str, object]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _rpc_error(request_id: object, code: int) -> dict[str, object]:
    messages = {
        -32600: "Invalid Request",
        -32601: "Method not found",
        -32602: "Invalid params",
        -32603: "Internal error",
    }
    normalized_id = request_id if _is_rpc_id(request_id) else None
    return {
        "jsonrpc": "2.0",
        "id": normalized_id,
        "error": {"code": code, "message": messages.get(code, "Internal error")},
    }


def _is_strict_utf8(value: str) -> bool:
    try:
        value.encode("utf-8", errors="strict")
        return True
    except UnicodeEncodeError:
        return False


def _is_rpc_id(value: object) -> bool:
    if type(value) is int:
        return -_MAX_SAFE_JSON_INTEGER <= value <= _MAX_SAFE_JSON_INTEGER
    return (
        type(value) is str
        and len(value) <= _MAX_RPC_ID_CHARACTERS
        and _is_strict_utf8(value)
    )


def _has_exact_keys(value: object, expected: frozenset[str]) -> bool:
    return type(value) is dict and set(value) == expected


def _normalize_owned_request(
    request: object,
) -> tuple[int | str, str, dict[str, object]] | dict[str, object]:
    if (
        type(request) is not dict
        or set(request) != {"id", "jsonrpc", "method", "params"}
        or request.get("jsonrpc") != "2.0"
        or not _is_rpc_id(request.get("id"))
        or type(request.get("method")) is not str
        or not request["method"]
        or not _is_strict_utf8(request["method"])
    ):
        return _rpc_error(None, -32600)
    request_id = request["id"]
    method = request["method"]
    params = request["params"]
    if method not in EXPECTED_RPC_METHODS:
        return _rpc_error(request_id, -32601)

    normalized_params: dict[str, object]
    if method == "session.create":
        if not _has_exact_keys(params, frozenset({"cwd", "source"})):
            return _rpc_error(request_id, -32602)
        cwd = params["cwd"]
        if (
            type(cwd) is not str
            or not cwd
            or "\x00" in cwd
            or not _is_strict_utf8(cwd)
            or not Path(cwd).is_absolute()
            or params["source"] != "opentrad"
        ):
            return _rpc_error(request_id, -32602)
        normalized_params = {"cwd": cwd, "source": "opentrad"}
    elif method == "session.resume":
        if not _has_exact_keys(params, frozenset({"session_id"})):
            return _rpc_error(request_id, -32602)
        stored_session_id = params["session_id"]
        if (
            type(stored_session_id) is not str
            or _STORED_SESSION_ID_PATTERN.fullmatch(stored_session_id) is None
        ):
            return _rpc_error(request_id, -32602)
        normalized_params = {"session_id": stored_session_id}
    elif method in {"session.status", "session.close", "session.interrupt"}:
        if not _has_exact_keys(params, frozenset({"session_id"})):
            return _rpc_error(request_id, -32602)
        live_session_id = params["session_id"]
        if (
            type(live_session_id) is not str
            or _LIVE_SESSION_ID_PATTERN.fullmatch(live_session_id) is None
        ):
            return _rpc_error(request_id, -32602)
        normalized_params = {"session_id": live_session_id}
    elif method == "prompt.submit":
        if not _has_exact_keys(params, frozenset({"session_id", "text"})):
            return _rpc_error(request_id, -32602)
        live_session_id = params["session_id"]
        text = params["text"]
        if (
            type(live_session_id) is not str
            or _LIVE_SESSION_ID_PATTERN.fullmatch(live_session_id) is None
            or type(text) is not str
            or not text.strip()
            or len(text) > _MAX_PROMPT_CHARACTERS
            or not _is_strict_utf8(text)
            or len(text.encode("utf-8")) > _MAX_PROMPT_UTF8_BYTES
        ):
            return _rpc_error(request_id, -32602)
        normalized_params = {"session_id": live_session_id, "text": text}
    elif method == "approval.respond":
        if not _has_exact_keys(params, frozenset({"all", "choice", "session_id"})):
            return _rpc_error(request_id, -32602)
        live_session_id = params["session_id"]
        if (
            type(live_session_id) is not str
            or _LIVE_SESSION_ID_PATTERN.fullmatch(live_session_id) is None
            or type(params["choice"]) is not str
            or params["choice"] not in {"deny", "once"}
            or params["all"] is not False
        ):
            return _rpc_error(request_id, -32602)
        normalized_params = {
            "session_id": live_session_id,
            "choice": params["choice"],
            "all": False,
        }
    else:
        return _rpc_error(request_id, -32602)
    return request_id, method, normalized_params


def _build_owned_handlers(
    sessions: _LazySessionStore,
) -> dict[str, Callable[[int | str, dict[str, object]], dict[str, object]]]:
    def create(request_id: int | str, _params: dict[str, object]) -> dict[str, object]:
        created = sessions.create()
        if created is None:
            return _rpc_error(request_id, -32603)
        live_session_id, stored_session_id = created
        return _rpc_result(
            request_id,
            {
                "info": {
                    "lazy": True,
                    "persisted": False,
                    "resumable": False,
                    "runtime": "hermes-quarantined",
                    "state": "quarantined",
                },
                "message_count": 0,
                "messages": [],
                "persisted": False,
                "resumable": False,
                "session_id": live_session_id,
                "stored_session_id": stored_session_id,
            },
        )

    def resume(request_id: int | str, _params: dict[str, object]) -> dict[str, object]:
        return _rpc_error(request_id, -32603)

    def status(request_id: int | str, params: dict[str, object]) -> dict[str, object]:
        live_session_id = params["session_id"]
        stored_session_id = sessions.stored_session_id(live_session_id)
        if stored_session_id is None:
            return _rpc_error(request_id, -32602)
        return _rpc_result(
            request_id,
            {
                "lazy": True,
                "message_count": 0,
                "persisted": False,
                "resumable": False,
                "running": False,
                "session_id": live_session_id,
                "state": "quarantined",
                "stored_session_id": stored_session_id,
            },
        )

    def close(request_id: int | str, params: dict[str, object]) -> dict[str, object]:
        return _rpc_result(
            request_id,
            {"closed": sessions.close(params["session_id"])},
        )

    def interrupt(
        request_id: int | str, params: dict[str, object]
    ) -> dict[str, object]:
        if sessions.stored_session_id(params["session_id"]) is None:
            return _rpc_error(request_id, -32602)
        return _rpc_result(request_id, {"interrupted": False})

    def prompt(request_id: int | str, _params: dict[str, object]) -> dict[str, object]:
        return _rpc_error(request_id, -32603)

    def approval(
        request_id: int | str, _params: dict[str, object]
    ) -> dict[str, object]:
        return _rpc_result(request_id, {"resolved": False})

    return {
        "approval.respond": approval,
        "prompt.submit": prompt,
        "session.close": close,
        "session.create": create,
        "session.interrupt": interrupt,
        "session.resume": resume,
        "session.status": status,
    }


def _validated_site_packages(site_packages: Path) -> Path:
    try:
        if not isinstance(site_packages, Path) or not site_packages.is_absolute():
            _refuse()
        root = site_packages.resolve(strict=True)
        if root != site_packages or not root.is_dir():
            _refuse()
        value = str(root)
        if not sys.path or sys.path[-1] != value or sys.path.count(value) != 1:
            _refuse()
        cwd = Path.cwd().resolve(strict=True)
        launcher_directory = Path(__file__).resolve(strict=True).parent
        stdlib_roots = tuple(
            Path(os.path.normpath(prefix))
            for prefix in {sys.base_prefix, sys.base_exec_prefix}
            if isinstance(prefix, str) and prefix
        )
        if not stdlib_roots:
            _refuse()
        seen: set[str] = set()
        for entry in sys.path[:-1]:
            if not isinstance(entry, str) or not entry:
                _refuse()
            lexical = Path(os.path.normpath(entry))
            if not lexical.is_absolute() or lexical in {cwd, launcher_directory}:
                _refuse()
            normalized = str(lexical)
            if normalized in seen:
                _refuse()
            seen.add(normalized)
            if any(
                "site-packages" in part.casefold() or "dist-packages" in part.casefold()
                for part in lexical.parts
            ):
                _refuse()
            if not any(
                lexical == stdlib_root or stdlib_root in lexical.parents
                for stdlib_root in stdlib_roots
            ):
                _refuse()
        return root
    except RuntimeImportRefusal:
        raise
    except BaseException:
        _refuse()


def _launcher_contract(transport: object) -> tuple[object, ...]:
    try:
        transport_type = type(transport)
        launcher = sys.modules.get(transport_type.__module__)
        if (
            launcher is None
            or getattr(launcher, "SafeJsonTransport", None) is not transport_type
        ):
            _refuse()
        expected_launcher = (
            Path(__file__).resolve(strict=True).with_name("opentrad_hermes_launcher.py")
        )
        launcher_file = getattr(launcher, "__file__", None)
        if (
            not isinstance(launcher_file, str)
            or Path(launcher_file) != expected_launcher
            or Path(launcher_file).resolve(strict=True) != expected_launcher
        ):
            _refuse()
        if transport_type.__name__ != "SafeJsonTransport":
            _refuse()
        transport_token = getattr(transport, "_token", None)
        transport_stream = getattr(transport, "_stream", None)
        transport_lock = getattr(transport, "_write_lock", None)
        stream_type = type(transport_stream)
        stream_write = getattr(stream_type, "write", None)
        stream_flush = getattr(stream_type, "flush", None)
        if (
            getattr(transport, "_closed", None) is not False
            or type(transport_token) is not str
            or type(transport_lock) is not _LOCK_TYPE
            or not callable(stream_write)
            or not callable(stream_flush)
        ):
            _refuse()
        binder = getattr(launcher, "bind_server_dispatch", None)
        if (
            type(binder) is not types.FunctionType
            or getattr(binder, "__module__", None) != launcher.__name__
        ):
            _refuse()
        allowed = getattr(launcher, "ALLOWED_RPC_METHODS", None)
        if type(allowed) is not frozenset or allowed != EXPECTED_RPC_METHODS:
            _refuse()
        transport_methods = tuple(
            (name, _capture_function_contract(getattr(transport_type, name, None)))
            for name in _TRANSPORT_METHOD_NAMES
        )
        launcher_code_contract = _capture_external_module_contract(launcher)
        json_module = getattr(launcher, "json", None)
        json_dumps = getattr(json_module, "dumps", None)
        if (
            type(json_module) is not types.ModuleType
            or sys.modules.get("json") is not json_module
            or type(json_dumps) is not types.FunctionType
        ):
            _refuse()
        output_messages = getattr(launcher, "_RPC_ERROR_MESSAGES", None)
        if type(output_messages) is not dict or any(
            type(code) is not int or type(message) is not str
            for code, message in output_messages.items()
        ):
            _refuse()
        output_globals = tuple(
            (name, getattr(launcher, name, None))
            for name in (
                "MAX_NDJSON_FRAME_BYTES",
                "MAX_SAFE_JSON_INTEGER",
                "_RPC_ERROR_MESSAGES",
                "_UNKNOWN_RPC_ERROR_MESSAGE",
            )
        )
        return (
            transport_type,
            launcher,
            allowed,
            _capture_function_contract(binder),
            transport_token,
            transport_stream,
            transport_lock,
            stream_type,
            stream_write,
            stream_flush,
            transport_methods,
            launcher_code_contract,
            json_module,
            _capture_function_contract(json_dumps),
            output_globals,
            tuple(sorted(output_messages.items())),
        )
    except RuntimeImportRefusal:
        raise
    except BaseException:
        _refuse()


def _verify_transport_contract(transport: object, contract: tuple[object, ...]) -> None:
    try:
        (
            transport_type,
            launcher,
            allowed,
            binder_contract,
            transport_token,
            transport_stream,
            transport_lock,
            stream_type,
            stream_write,
            stream_flush,
            transport_methods,
            launcher_code_contract,
            json_module,
            json_dumps_contract,
            output_globals,
            output_messages_snapshot,
        ) = contract
        binder = binder_contract[0]
        if (
            type(transport) is not transport_type
            or getattr(launcher, "SafeJsonTransport", None) is not transport_type
            or getattr(launcher, "ALLOWED_RPC_METHODS", None) is not allowed
            or allowed is not getattr(launcher, "ALLOWED_RPC_METHODS", None)
            or type(allowed) is not frozenset
            or allowed != EXPECTED_RPC_METHODS
            or getattr(launcher, "bind_server_dispatch", None) is not binder
            or getattr(transport, "_closed", None) is not False
            or getattr(transport, "_token", None) is not transport_token
            or getattr(transport, "_token", None) != transport_token
            or getattr(transport, "_stream", None) is not transport_stream
            or getattr(transport, "_write_lock", None) is not transport_lock
            or type(transport_lock) is not _LOCK_TYPE
            or type(transport_stream) is not stream_type
            or getattr(stream_type, "write", None) is not stream_write
            or getattr(stream_type, "flush", None) is not stream_flush
        ):
            _refuse()
        _verify_function_contract(binder_contract)
        for name, method_contract in transport_methods:
            if getattr(transport_type, name, None) is not method_contract[0]:
                _refuse()
            _verify_function_contract(method_contract)
        _verify_external_module_contract(launcher_code_contract)
        if (
            getattr(launcher, "json", None) is not json_module
            or sys.modules.get("json") is not json_module
            or getattr(json_module, "dumps", None) is not json_dumps_contract[0]
        ):
            _refuse()
        _verify_function_contract(json_dumps_contract)
        for name, value in output_globals:
            if getattr(launcher, name, None) is not value:
                _refuse()
        output_messages = getattr(launcher, "_RPC_ERROR_MESSAGES", None)
        if (
            type(output_messages) is not dict
            or tuple(sorted(output_messages.items())) != output_messages_snapshot
        ):
            _refuse()
    except RuntimeImportRefusal:
        raise
    except BaseException:
        _refuse()


def _require_module_origin(module: types.ModuleType, root: Path, name: str) -> None:
    try:
        expected = root / _PINNED_MODULE_FILES[name]
        if expected.resolve(strict=True) != expected:
            _refuse()
        spec = getattr(module, "__spec__", None)
        origin = getattr(spec, "origin", None)
        if (
            not isinstance(origin, str)
            or Path(origin) != expected
            or Path(origin).resolve(strict=True) != expected
        ):
            _refuse()
        if name in {"hermes_cli", "tui_gateway"}:
            search = tuple(getattr(spec, "submodule_search_locations", ()) or ())
            if search != (str(expected.parent),):
                _refuse()
    except RuntimeImportRefusal:
        raise
    except BaseException:
        _refuse()


def _import_selected(root: Path, name: str) -> types.ModuleType:
    try:
        module = importlib.import_module(name)
    except BaseException:
        _refuse()
    if not isinstance(module, types.ModuleType):
        _refuse()
    _require_module_origin(module, root, name)
    return module


def _stub_noop(*_args: object, **_kwargs: object) -> None:
    return None


def _stub_false(*_args: object, **_kwargs: object) -> bool:
    return False


def _stub_true(*_args: object, **_kwargs: object) -> bool:
    return True


def _stub_identity(value: object, *_args: object, **_kwargs: object) -> object:
    return value


def _install_owned_stub(
    contracts: dict[str, tuple[types.ModuleType, str, dict[str, object], bool]],
    name: str,
    *,
    package: bool = False,
    exports: dict[str, object] | None = None,
) -> types.ModuleType:
    if name in sys.modules:
        _refuse()
    parent_name, separator, child_name = name.rpartition(".")
    if separator and not isinstance(sys.modules.get(parent_name), types.ModuleType):
        _refuse()
    origin = f"<opentrad-owned-stub:{name}>"
    stub = types.ModuleType(name)
    stub.__package__ = name if package else parent_name
    stub.__opentrad_stub__ = True
    stub.__opentrad_stub_name__ = name
    spec = importlib.machinery.ModuleSpec(
        name,
        loader=None,
        origin=origin,
        is_package=package,
    )
    if package:
        spec.submodule_search_locations = ()
        stub.__path__ = ()
    stub.__spec__ = spec
    expected_exports = dict(exports or {})
    for export_name, value in expected_exports.items():
        setattr(stub, export_name, value)
    sys.modules[name] = stub
    if separator:
        setattr(sys.modules[parent_name], child_name, stub)
    contracts[name] = (stub, origin, expected_exports, package)
    return stub


def _install_preimport_stubs() -> dict[
    str, tuple[types.ModuleType, str, dict[str, object], bool]
]:
    contracts: dict[str, tuple[types.ModuleType, str, dict[str, object], bool]] = {}
    _install_owned_stub(contracts, "agent", package=True)
    _install_owned_stub(
        contracts,
        "agent.replay_cleanup",
        exports={"sanitize_replay_history": _stub_identity},
    )
    _install_owned_stub(
        contracts,
        "hermes_cli.env_loader",
        exports={"load_hermes_dotenv": _stub_noop},
    )
    _install_owned_stub(contracts, "tools", package=True)
    _install_owned_stub(contracts, "tools.environments", package=True)
    _install_owned_stub(
        contracts,
        "tools.environments.local",
        exports={"hermes_subprocess_env": _blocked_server_helper},
    )
    _install_owned_stub(
        contracts,
        "tui_gateway.git_probe",
        exports={
            "branch": _blocked_server_helper,
            "common_repo_root": _blocked_server_helper,
            "repo_root": _blocked_server_helper,
            "resolve": _blocked_server_helper,
            "run_git": _blocked_server_helper,
            "warm_roots": _blocked_server_helper,
        },
    )
    _install_owned_stub(
        contracts,
        "tui_gateway.render",
        exports={
            "make_stream_renderer": _blocked_server_helper,
            "render_diff": _blocked_server_helper,
            "render_message": _blocked_server_helper,
        },
    )
    _install_owned_stub(
        contracts,
        "utils",
        exports={"is_truthy_value": _blocked_server_helper},
    )
    return contracts


def _install_entry_stub(
    contracts: dict[str, tuple[types.ModuleType, str, dict[str, object], bool]],
) -> types.ModuleType:
    return _install_owned_stub(
        contracts,
        "tui_gateway.entry",
        exports={
            "join_mcp_discovery": _stub_true,
            "mcp_discovery_in_flight": _stub_false,
            "wait_for_mcp_discovery": _stub_noop,
        },
    )


def _is_owned_module_name(name: str) -> bool:
    return name.partition(".")[0] in _HERMES_OWNED_TOP_LEVELS


def _require_path_under_root(value: object, root: Path) -> None:
    try:
        if not isinstance(value, str):
            _refuse()
        lexical = Path(os.path.normpath(value))
        if not lexical.is_absolute():
            _refuse()
        resolved = lexical.resolve(strict=True)
        if lexical != resolved:
            _refuse()
        resolved.relative_to(root)
    except RuntimeImportRefusal:
        raise
    except BaseException:
        _refuse()


def _validate_owned_stubs(
    contracts: dict[str, tuple[types.ModuleType, str, dict[str, object], bool]],
) -> None:
    for name, (stub, origin, exports, package) in contracts.items():
        spec = getattr(stub, "__spec__", None)
        if (
            sys.modules.get(name) is not stub
            or not getattr(stub, "__opentrad_stub__", False)
            or getattr(stub, "__opentrad_stub_name__", None) != name
            or getattr(stub, "__file__", None) is not None
            or getattr(spec, "origin", None) != origin
            or getattr(spec, "loader", object()) is not None
            or (getattr(spec, "submodule_search_locations", None) is not None)
            != package
        ):
            _refuse()
        if package and (
            tuple(getattr(spec, "submodule_search_locations", ())) != ()
            or tuple(getattr(stub, "__path__", ())) != ()
        ):
            _refuse()
        for export_name, expected in exports.items():
            if getattr(stub, export_name, None) is not expected:
                _refuse()
        parent_name, separator, child_name = name.rpartition(".")
        if (
            separator
            and getattr(sys.modules.get(parent_name), child_name, None) is not stub
        ):
            _refuse()


def _remove_owned_stubs(
    contracts: dict[str, tuple[types.ModuleType, str, dict[str, object], bool]],
) -> None:
    for name in sorted(contracts, key=lambda value: value.count("."), reverse=True):
        stub = contracts[name][0]
        parent_name, separator, child_name = name.rpartition(".")
        parent = sys.modules.get(parent_name) if separator else None
        if parent is not None and getattr(parent, child_name, None) is stub:
            try:
                delattr(parent, child_name)
            except BaseException:
                pass
        if sys.modules.get(name) is stub:
            sys.modules.pop(name, None)


def _validate_loaded_owned_modules(
    root: Path,
    contracts: dict[str, tuple[types.ModuleType, str, dict[str, object], bool]],
) -> None:
    _validate_owned_stubs(contracts)
    for name, module in tuple(sys.modules.items()):
        if not _is_owned_module_name(name):
            continue
        if name in contracts:
            continue
        if not isinstance(module, types.ModuleType):
            _refuse()
        spec = getattr(module, "__spec__", None)
        origin = getattr(spec, "origin", None)
        module_file = getattr(module, "__file__", None)
        if not isinstance(origin, str) or not isinstance(module_file, str):
            _refuse()
        if Path(origin) != Path(module_file):
            _refuse()
        _require_path_under_root(origin, root)
        search_locations = getattr(spec, "submodule_search_locations", None)
        if search_locations is not None:
            locations = tuple(search_locations)
            if len(locations) != 1:
                _refuse()
            _require_path_under_root(locations[0], root)


def _import_server_without_threads(root: Path) -> types.ModuleType:
    threading_module = threading
    thread_type = threading_module.Thread
    atexit_module = atexit
    refusal_type = RuntimeImportRefusal
    idle_reaper_qualname = _IDLE_REAPER_QUALNAME
    callable_of = callable
    getattr_of = getattr
    len_of = len
    import_selected = _import_selected
    original_start = thread_type.start
    original_atexit_register = atexit_module.register
    idle_attempts: list[object] = []
    unexpected_attempts: list[object] = []
    atexit_callbacks: list[Callable[..., object]] = []

    def guarded_start(thread: object, *args: object, **kwargs: object) -> None:
        target = getattr_of(thread, "_target", None)
        recognized = (
            callable_of(target)
            and getattr_of(target, "__module__", None) == "tui_gateway.server"
            and getattr_of(target, "__qualname__", None) == idle_reaper_qualname
            and thread.daemon is True
            and not args
            and not kwargs
        )
        if recognized and not idle_attempts:
            idle_attempts.append(thread)
            return None
        unexpected_attempts.append(thread)
        raise refusal_type() from None

    def guarded_atexit_register(
        callback: Callable[..., object],
        *args: object,
        **kwargs: object,
    ) -> Callable[..., object]:
        if not callable_of(callback) or args or kwargs or len_of(atexit_callbacks) >= 2:
            raise refusal_type() from None
        atexit_callbacks.append(callback)
        return callback

    thread_type.start = guarded_start
    atexit_module.register = guarded_atexit_register
    try:
        server = import_selected(root, "tui_gateway.server")
    finally:
        thread_type.start = original_start
        atexit_module.register = original_atexit_register
    if unexpected_attempts or len_of(idle_attempts) != 1:
        raise refusal_type() from None
    if (
        len_of(atexit_callbacks) != 2
        or getattr_of(atexit_callbacks[0], "__module__", None) != "tui_gateway.server"
        or getattr_of(atexit_callbacks[0], "__name__", None) != "<lambda>"
        or getattr_of(atexit_callbacks[0], "__closure__", None) not in {None, ()}
        or atexit_callbacks[1] is not getattr_of(server, "_shutdown_sessions", None)
    ):
        raise refusal_type() from None
    return server


def _require_callable(module: types.ModuleType, name: str) -> Callable[..., object]:
    value = getattr(module, name, None)
    if not callable(value):
        _refuse()
    return value


def _sanitize_server(
    server: types.ModuleType,
    drop_stream: _DropTextStream,
) -> tuple[
    dict[str, Callable[..., object]],
    type,
    object,
    object,
    concurrent.futures.ThreadPoolExecutor,
]:
    methods = getattr(server, "_methods", None)
    if type(methods) is not dict or not EXPECTED_RPC_METHODS.issubset(methods):
        _refuse()
    if any(not callable(methods[name]) for name in EXPECTED_RPC_METHODS):
        _refuse()
    dispatch = _require_callable(server, "dispatch")
    try:
        parameters = tuple(inspect.signature(dispatch).parameters.values())
    except BaseException:
        _refuse()
    if (
        len(parameters) != 2
        or parameters[0].kind
        not in {
            inspect.Parameter.POSITIONAL_ONLY,
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
        }
        or parameters[1].kind
        not in {
            inspect.Parameter.POSITIONAL_ONLY,
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
        }
        or parameters[1].default is not None
    ):
        _refuse()

    panic_hook = _require_callable(server, "_panic_hook")
    thread_panic_hook = _require_callable(server, "_thread_panic_hook")
    if (
        sys.excepthook is not panic_hook
        or threading.excepthook is not thread_panic_hook
    ):
        _refuse()
    if not isinstance(getattr(server, "_CRASH_LOG", None), str):
        _refuse()
    if getattr(server, "_real_stdout", None) is not drop_stream:
        _refuse()
    if sys.stdout is not drop_stream or sys.stderr is not drop_stream:
        _refuse()

    drop_transport_type = getattr(server, "_DropTransport", None)
    if not isinstance(drop_transport_type, type):
        _refuse()
    transport_module = sys.modules.get("tui_gateway.transport")
    stdio_transport_type = getattr(transport_module, "StdioTransport", None)
    if (
        not isinstance(stdio_transport_type, type)
        or type(getattr(server, "_stdio_transport", None)) is not stdio_transport_type
    ):
        _refuse()
    if type(getattr(server, "_detached_ws_transport", None)) is not drop_transport_type:
        _refuse()
    if type(getattr(server, "_stdout_lock", None)) is not _LOCK_TYPE:
        _refuse()
    _require_callable(server, "_shutdown_sessions")
    _require_callable(server, "_start_idle_reaper")
    pool = getattr(server, "_pool", None)
    if type(pool) is not concurrent.futures.ThreadPoolExecutor:
        _refuse()

    retained_methods = {name: methods[name] for name in EXPECTED_RPC_METHODS}
    methods.clear()
    methods.update(retained_methods)
    if frozenset(methods) != EXPECTED_RPC_METHODS or any(
        not callable(value) for value in methods.values()
    ):
        _refuse()

    safe_stdio_transport = drop_transport_type()
    safe_detached_transport = drop_transport_type()
    server._CRASH_LOG = ""
    server._panic_hook = _drop_exception_hook
    server._thread_panic_hook = _drop_exception_hook
    server._real_stdout = drop_stream
    server._stdio_transport = safe_stdio_transport
    server._detached_ws_transport = safe_detached_transport
    sys.excepthook = _drop_exception_hook
    threading.excepthook = _drop_exception_hook
    return (
        methods,
        drop_transport_type,
        safe_stdio_transport,
        safe_detached_transport,
        pool,
    )


def _install_handler_quarantine(
    server: types.ModuleType,
    transport: object,
    transport_contract: tuple[object, ...],
    owned_runtime_contract: tuple[object, ...],
    owned_runtime_verifier: Callable[[tuple[object, ...]], None],
    server_poisoner: Callable[[types.ModuleType, bool], None],
    thread_pool_shutdown: Callable[..., None],
    thread_pool_shutdown_contract: tuple[object, ...],
    methods: dict[str, Callable[..., object]],
    native_pool: concurrent.futures.ThreadPoolExecutor,
    stub_contracts: dict[str, tuple[types.ModuleType, str, dict[str, object], bool]],
    import_finder: object,
    import_finder_verifier: Callable[[bool], None],
) -> tuple[
    Callable[[dict[str, object], object], dict[str, object] | None],
    Callable[[], None],
    Callable[[], None],
]:
    try:
        owned_runtime_verifier(owned_runtime_contract)
        _verify_transport_contract(transport, transport_contract)
        sessions = _LazySessionStore()
        owned_handler_map = _build_owned_handlers(sessions)
        if frozenset(owned_handler_map) != EXPECTED_RPC_METHODS:
            _refuse()
        methods.clear()
        owned_handlers = types.MappingProxyType(owned_handler_map)
        server._methods = owned_handlers
        handler_contracts = {
            name: _capture_function_contract(handler)
            for name, handler in owned_handler_map.items()
        }

        native_state_maps: dict[str, object] = {}
        for name in _NATIVE_STATE_MAPS:
            previous = getattr(server, name, None)
            if type(previous) is not dict:
                _refuse()
            previous.clear()
            replacement = types.MappingProxyType({})
            setattr(server, name, replacement)
            native_state_maps[name] = replacement

        server._db = None
        server._db_error = None
        server._cfg_cache = None
        server._cfg_mtime = None
        server._cfg_path = None

        required_helpers = frozenset(
            (
                *_QUARANTINED_SERVER_HELPERS,
                "_emit",
                "_normalize_request",
                "handle_request",
                "method",
                "write_json",
            )
        )
        for name in required_helpers:
            if not callable(getattr(server, name, None)):
                _refuse()

        server_function_names = {
            name
            for name, value in tuple(vars(server).items())
            if type(value) is types.FunctionType
            and getattr(value, "__module__", None) == server.__name__
        }
        server_class_names = {
            name
            for name, value in tuple(vars(server).items())
            if type(value) is type
            and getattr(value, "__module__", None) == server.__name__
            and name != "_DropTransport"
        }
        poisoned_names = (
            server_function_names | server_class_names | set(required_helpers)
        )
        for name in poisoned_names:
            setattr(server, name, _blocked_server_helper)
        helper_identities: dict[str, Callable[..., object]] = {
            name: _blocked_server_helper
            for name in poisoned_names
            if name not in {"_shutdown_sessions", "dispatch"}
        }

        if type(getattr(server, "_LONG_HANDLERS", None)) is not frozenset:
            _refuse()
        server._LONG_HANDLERS = _EMPTY_LONG_HANDLERS

        if "shutdown" in vars(native_pool):
            _refuse()
        _verify_function_contract(thread_pool_shutdown_contract)
        thread_pool_shutdown(native_pool, wait=False, cancel_futures=True)
        disabled_pool = _DisabledExecutor()
        server._pool = disabled_pool

        def shutdown_sessions() -> None:
            if (
                type(sessions) is _LazySessionStore
                and type(sessions._lock) is _RLOCK_TYPE
                and type(sessions._sessions) is dict
            ):
                with sessions._lock:
                    dict.clear(sessions._sessions)
            disabled_pool.shutdown()
            server_poisoner(server, True)
            import_finder._bootstrap_open = False
            sys.meta_path[:] = [
                candidate
                for candidate in sys.meta_path
                if candidate is not import_finder
            ]
            sys.meta_path.insert(0, import_finder)

        server._shutdown_sessions = shutdown_sessions
    except RuntimeImportRefusal:
        raise
    except BaseException:
        _refuse()

    transport_gate: Callable[[dict[str, object], object], dict[str, object] | None]
    transport_gate_code: types.CodeType
    blocked_helper_code = _blocked_server_helper.__code__
    shutdown_code = shutdown_sessions.__code__
    import_finder_verifier(False)

    def verify_quarantine() -> None:
        try:
            sessions.verify()
            _validate_owned_stubs(stub_contracts)
            if (
                getattr(server, "_methods", None) is not owned_handlers
                or type(owned_handlers) is not types.MappingProxyType
                or frozenset(owned_handlers) != EXPECTED_RPC_METHODS
                or any(
                    owned_handlers.get(name) is not handler
                    for name, handler in owned_handler_map.items()
                )
                or getattr(server, "dispatch", None) is not transport_gate
                or getattr(transport_gate, "__code__", None) is not transport_gate_code
                or getattr(server, "_LONG_HANDLERS", None) is not _EMPTY_LONG_HANDLERS
                or getattr(server, "_pool", None) is not disabled_pool
                or type(disabled_pool) is not _DisabledExecutor
                or getattr(server, "_shutdown_sessions", None) is not shutdown_sessions
                or getattr(shutdown_sessions, "__code__", None) is not shutdown_code
                or getattr(server, "_db", object()) is not None
                or getattr(server, "_db_error", object()) is not None
                or getattr(server, "_cfg_cache", object()) is not None
                or getattr(server, "_cfg_mtime", object()) is not None
                or getattr(server, "_cfg_path", object()) is not None
                or not sys.meta_path
                or sys.meta_path[0] is not import_finder
                or sys.meta_path.count(import_finder) != 1
                or import_finder._bootstrap_open is not False
                or _blocked_server_helper.__code__ is not blocked_helper_code
            ):
                _refuse()
            import_finder_verifier(False)
            for contract in handler_contracts.values():
                _verify_function_contract(contract)
            owned_runtime_verifier(owned_runtime_contract)
            _verify_transport_contract(transport, transport_contract)
            for name, state in native_state_maps.items():
                if (
                    getattr(server, name, None) is not state
                    or type(state) is not types.MappingProxyType
                    or state
                ):
                    _refuse()
            for name, helper in helper_identities.items():
                if (
                    getattr(server, name, None) is not helper
                    or getattr(helper, "__code__", None) is not blocked_helper_code
                ):
                    _refuse()
        except RuntimeImportRefusal:
            raise
        except BaseException:
            _refuse()

    def guarded_server_dispatch(
        request: dict[str, object],
        candidate_transport: object = None,
    ) -> dict[str, object] | None:
        if candidate_transport is not transport:
            _refuse()
        try:
            verify_quarantine()
            normalized = _normalize_owned_request(request)
            if isinstance(normalized, dict):
                response = normalized
            else:
                request_id, method, params = normalized
                response = owned_handlers[method](request_id, params)
            verify_quarantine()
            return response
        except BaseException:
            pass
        raise RuntimeImportRefusal()

    transport_gate = guarded_server_dispatch
    transport_gate_code = transport_gate.__code__
    server.dispatch = transport_gate
    verify_quarantine()
    return transport_gate, verify_quarantine, shutdown_sessions


def load_pinned_runtime(
    site_packages: Path,
    transport: object,
) -> GuardedHermesRuntime:
    """Import pinned Hermes behind owned sinks and return a transport-bound API."""

    drop_stream = _DropTextStream()
    import_finder: object | None = None
    import_finder_verifier: Callable[[bool], None] | None = None
    server: types.ModuleType | None = None
    server_poisoner: Callable[[types.ModuleType, bool], None] | None = None
    runtime_sys = sys
    runtime_threading = threading
    module_type = types.ModuleType
    module_registry = sys.modules
    meta_path = sys.meta_path
    runtime_namespace = globals()
    runtime_refusal_type = RuntimeImportRefusal
    safe_any = any
    safe_len = len
    safe_tuple = tuple
    safe_zip = zip
    safe_drop_hook: Callable[..., None] = _drop_exception_hook
    stub_contracts: (
        dict[str, tuple[types.ModuleType, str, dict[str, object], bool]] | None
    ) = None
    try:
        refusal_type = runtime_refusal_type
        owned_runtime_contract = _capture_owned_runtime_contract()
        owned_runtime_verifier = _verify_owned_runtime_contract
        owned_runtime_verifier_contract = _capture_function_contract(
            owned_runtime_verifier
        )
        server_poisoner, safe_drop_hook = _build_server_poisoner()
        thread_pool_shutdown = _THREAD_POOL_SHUTDOWN
        thread_pool_shutdown_contract = _capture_function_contract(thread_pool_shutdown)
        root = _validated_site_packages(site_packages)
        transport_contract = _launcher_contract(transport)

        # From this point forward third-party diagnostics cannot reach the
        # already-captured binary protocol stream or inherited stderr.
        sys.stdout = drop_stream
        sys.stderr = drop_stream

        hermes_cli = _import_selected(root, "hermes_cli")
        if (
            getattr(hermes_cli, "__version__", None) != PINNED_HERMES_VERSION
            or getattr(hermes_cli, "__release_date__", None)
            != PINNED_HERMES_RELEASE_DATE
        ):
            _refuse()

        _import_selected(root, "tui_gateway")
        _import_selected(root, "tui_gateway.transport")
        stub_contracts = _install_preimport_stubs()

        banner = _import_selected(root, "hermes_cli.banner")
        _require_callable(banner, "prefetch_update_check")
        banner.prefetch_update_check = _stub_noop

        _install_entry_stub(stub_contracts)
        import_finder, import_finder_verifier = _build_denied_import_finder(
            root,
            frozenset(stub_contracts),
        )
        meta_path.insert(0, import_finder)
        server = _import_server_without_threads(root)
        (
            expected_verifier,
            verifier_code,
            verifier_closure,
            verifier_closure_contents,
            verifier_defaults,
            verifier_kwdefaults,
        ) = owned_runtime_verifier_contract
        try:
            current_verifier_contents = safe_tuple(
                cell.cell_contents for cell in owned_runtime_verifier.__closure__ or ()
            )
        except BaseException:
            raise refusal_type() from None
        if (
            runtime_namespace.get("_verify_owned_runtime_contract")
            is not expected_verifier
            or owned_runtime_verifier is not expected_verifier
            or owned_runtime_verifier.__code__ is not verifier_code
            or owned_runtime_verifier.__closure__ is not verifier_closure
            or owned_runtime_verifier.__defaults__ is not verifier_defaults
            or owned_runtime_verifier.__kwdefaults__ is not verifier_kwdefaults
            or safe_len(current_verifier_contents)
            != safe_len(verifier_closure_contents)
            or safe_any(
                current is not expected
                for current, expected in safe_zip(
                    current_verifier_contents,
                    verifier_closure_contents,
                    strict=True,
                )
            )
        ):
            raise refusal_type() from None
        owned_runtime_verifier(owned_runtime_contract)
        import_finder_verifier(True)
        import_finder.seal()
        import_finder_verifier(False)
        _validate_loaded_owned_modules(root, stub_contracts)
        (
            methods,
            drop_transport_type,
            safe_stdio_transport,
            safe_detached_transport,
            native_pool,
        ) = _sanitize_server(server, drop_stream)
        (
            transport_gate,
            verify_quarantine,
            shutdown_sessions,
        ) = _install_handler_quarantine(
            server,
            transport,
            transport_contract,
            owned_runtime_contract,
            owned_runtime_verifier,
            server_poisoner,
            thread_pool_shutdown,
            thread_pool_shutdown_contract,
            methods,
            native_pool,
            stub_contracts,
            import_finder,
            import_finder_verifier,
        )

        def guarded_dispatch(request: dict[str, object]) -> dict[str, object] | None:
            verify_quarantine()
            if (
                getattr(server, "_real_stdout", None) is not drop_stream
                or getattr(server, "_CRASH_LOG", None) != ""
                or getattr(server, "_panic_hook", None) is not _drop_exception_hook
                or getattr(server, "_thread_panic_hook", None)
                is not _drop_exception_hook
            ):
                _refuse()
            if getattr(server, "dispatch", None) is not transport_gate:
                _refuse()
            if (
                getattr(server, "_DropTransport", None) is not drop_transport_type
                or getattr(server, "_stdio_transport", None) is not safe_stdio_transport
                or getattr(server, "_detached_ws_transport", None)
                is not safe_detached_transport
            ):
                _refuse()
            return transport_gate(request, transport)

        return GuardedHermesRuntime(
            guarded_dispatch,
            shutdown_sessions,
        )
    except BaseException:
        if import_finder is not None:
            import_finder._bootstrap_open = False
            meta_path[:] = [
                candidate for candidate in meta_path if candidate is not import_finder
            ]
            meta_path.insert(0, import_finder)
            failed_server = server
            if failed_server is None:
                candidate = module_registry.get("tui_gateway.server")
                if type(candidate) is module_type:
                    failed_server = candidate
            if failed_server is not None:
                try:
                    if server_poisoner is not None:
                        server_poisoner(failed_server, True)
                except BaseException:
                    pass
        elif stub_contracts is not None:
            _remove_owned_stubs(stub_contracts)
        runtime_sys.excepthook = safe_drop_hook
        runtime_threading.excepthook = safe_drop_hook
    raise runtime_refusal_type()
