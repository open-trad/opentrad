#!/usr/bin/env python3
"""OpenTrad-owned post-bootstrap import firewall for pinned Hermes Agent.

Only Python's standard library is imported before :func:`load_pinned_runtime`
crosses the already-verified managed ``site-packages`` boundary.
"""

from __future__ import annotations

import concurrent.futures
import importlib
import importlib.machinery
import inspect
import io
import os
from pathlib import Path
import sys
import threading
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
    "hermes_cli": "hermes_cli/__init__.py",
    "hermes_cli.env_loader": "hermes_cli/env_loader.py",
    "hermes_cli.banner": "hermes_cli/banner.py",
    "tui_gateway": "tui_gateway/__init__.py",
    "tui_gateway.transport": "tui_gateway/transport.py",
    "tui_gateway.server": "tui_gateway/server.py",
}
_IDLE_REAPER_QUALNAME = "_start_idle_reaper.<locals>._loop"
_LOCK_TYPE = type(threading.Lock())
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

    __slots__ = ("_dispatcher", "_shutdown", "_closed")

    def __init__(
        self,
        dispatcher: Callable[[dict[str, object]], dict[str, object] | None],
        shutdown: Callable[[], None],
    ) -> None:
        self._dispatcher = dispatcher
        self._shutdown = shutdown
        self._closed = False

    def __repr__(self) -> str:
        return "GuardedHermesRuntime(pinned='0.18.2', methods=7)"

    def dispatch(self, request: dict[str, object]) -> dict[str, object] | None:
        if self._closed:
            raise RuntimeImportRefusal()
        try:
            return self._dispatcher(request)
        except BaseException:
            pass
        raise RuntimeImportRefusal()

    def shutdown(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._shutdown()
        except BaseException:
            return


def _refuse() -> NoReturn:
    raise RuntimeImportRefusal() from None


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


def _launcher_contract(
    transport: object,
) -> tuple[type, Callable[[object, object], Callable[[dict[str, object]], object]]]:
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
        if getattr(transport, "_closed", None) is not False:
            _refuse()
        if not callable(getattr(getattr(transport, "_stream", None), "write", None)):
            _refuse()
        if not isinstance(getattr(transport, "_token", None), str):
            _refuse()
        binder = getattr(launcher, "bind_server_dispatch", None)
        if (
            not callable(binder)
            or getattr(binder, "__module__", None) != launcher.__name__
        ):
            _refuse()
        allowed = getattr(launcher, "ALLOWED_RPC_METHODS", None)
        if type(allowed) is not frozenset or allowed != EXPECTED_RPC_METHODS:
            _refuse()
        return transport_type, binder
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


def _install_entry_stub() -> types.ModuleType:
    if "tui_gateway.entry" in sys.modules:
        _refuse()
    stub = types.ModuleType("tui_gateway.entry")
    stub.__package__ = "tui_gateway"
    stub.__opentrad_stub__ = True
    stub.__spec__ = importlib.machinery.ModuleSpec(
        "tui_gateway.entry",
        loader=None,
        origin="<opentrad-owned-stub>",
    )

    def wait_for_mcp_discovery() -> None:
        return None

    def mcp_discovery_in_flight() -> bool:
        return False

    def join_mcp_discovery(*, timeout: float | None = None) -> bool:
        del timeout
        return True

    stub.wait_for_mcp_discovery = wait_for_mcp_discovery
    stub.mcp_discovery_in_flight = mcp_discovery_in_flight
    stub.join_mcp_discovery = join_mcp_discovery
    sys.modules[stub.__name__] = stub
    return stub


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


def _validate_loaded_owned_modules(root: Path, entry_stub: types.ModuleType) -> None:
    for name, module in tuple(sys.modules.items()):
        if not _is_owned_module_name(name):
            continue
        if name == "tui_gateway.entry":
            if (
                module is not entry_stub
                or not getattr(module, "__opentrad_stub__", False)
                or getattr(getattr(module, "__spec__", None), "origin", None)
                != "<opentrad-owned-stub>"
                or getattr(module, "__file__", None) is not None
            ):
                _refuse()
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
    original_start = threading.Thread.start
    idle_attempts: list[threading.Thread] = []
    unexpected_attempts: list[threading.Thread] = []

    def guarded_start(
        thread: threading.Thread, *args: object, **kwargs: object
    ) -> None:
        target = getattr(thread, "_target", None)
        recognized = (
            callable(target)
            and getattr(target, "__module__", None) == "tui_gateway.server"
            and getattr(target, "__qualname__", None) == _IDLE_REAPER_QUALNAME
            and thread.daemon is True
            and not args
            and not kwargs
        )
        if recognized and not idle_attempts:
            idle_attempts.append(thread)
            return None
        unexpected_attempts.append(thread)
        raise RuntimeImportRefusal()

    threading.Thread.start = guarded_start
    try:
        server = _import_selected(root, "tui_gateway.server")
    finally:
        threading.Thread.start = original_start
    if unexpected_attempts or len(idle_attempts) != 1:
        _refuse()
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
    dict[str, Callable[..., object]],
    type,
    object,
    object,
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
        retained_methods,
        drop_transport_type,
        safe_stdio_transport,
        safe_detached_transport,
    )


def _build_shutdown(server: types.ModuleType) -> Callable[[], None]:
    shutdown_sessions = getattr(server, "_shutdown_sessions")
    pool = getattr(server, "_pool")

    def shutdown() -> None:
        try:
            shutdown_sessions()
        except BaseException:
            pass
        try:
            pool.shutdown(wait=False, cancel_futures=True)
        except BaseException:
            pass

    return shutdown


def _install_transport_gate(
    server: types.ModuleType,
    transport: object,
) -> Callable[[dict[str, object], object], dict[str, object] | None]:
    original_dispatch = getattr(server, "dispatch")

    def guarded_server_dispatch(
        request: dict[str, object],
        candidate_transport: object = None,
    ) -> dict[str, object] | None:
        if candidate_transport is not transport:
            _refuse()
        try:
            return original_dispatch(request, transport)
        except BaseException:
            pass
        raise RuntimeImportRefusal()

    server.dispatch = guarded_server_dispatch
    return guarded_server_dispatch


def load_pinned_runtime(
    site_packages: Path,
    transport: object,
) -> GuardedHermesRuntime:
    """Import pinned Hermes behind owned sinks and return a transport-bound API."""

    drop_stream = _DropTextStream()
    try:
        root = _validated_site_packages(site_packages)
        _transport_type, bind_dispatch = _launcher_contract(transport)

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

        env_loader = _import_selected(root, "hermes_cli.env_loader")
        _require_callable(env_loader, "load_hermes_dotenv")
        env_loader.load_hermes_dotenv = lambda *_args, **_kwargs: None

        banner = _import_selected(root, "hermes_cli.banner")
        _require_callable(banner, "prefetch_update_check")
        banner.prefetch_update_check = lambda *_args, **_kwargs: None

        _import_selected(root, "tui_gateway")
        _import_selected(root, "tui_gateway.transport")
        entry_stub = _install_entry_stub()
        server = _import_server_without_threads(root)
        _validate_loaded_owned_modules(root, entry_stub)
        (
            methods,
            retained_methods,
            drop_transport_type,
            safe_stdio_transport,
            safe_detached_transport,
        ) = _sanitize_server(server, drop_stream)
        transport_gate = _install_transport_gate(server, transport)

        bound = bind_dispatch(server, transport)
        if not callable(bound):
            _refuse()

        def guarded_dispatch(request: dict[str, object]) -> dict[str, object] | None:
            current_methods = getattr(server, "_methods", None)
            if (
                current_methods is not methods
                or frozenset(current_methods) != EXPECTED_RPC_METHODS
                or any(
                    current_methods.get(name) is not handler
                    for name, handler in retained_methods.items()
                )
            ):
                _refuse()
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
            return bound(request)

        return GuardedHermesRuntime(guarded_dispatch, _build_shutdown(server))
    except BaseException:
        sys.excepthook = _drop_exception_hook
        threading.excepthook = _drop_exception_hook
    raise RuntimeImportRefusal()
