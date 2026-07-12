#!/usr/bin/env python3
"""Contract tests for the OpenTrad-owned Hermes post-bootstrap firewall."""

from __future__ import annotations

import importlib.util
import io
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import traceback
import types
import unittest


RUNTIME = (
    Path(__file__).resolve().parents[1]
    / "resources"
    / "hermes"
    / "opentrad_hermes_runtime.py"
)
LAUNCHER = RUNTIME.with_name("opentrad_hermes_launcher.py")
CANARY = "runtime-canary-secret-never-render-0123456789"
ALLOWED_METHODS = frozenset(
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
FAKE_MODULE_PREFIXES = ("agent", "hermes_cli", "tui_gateway")
REAL_SMOKE_PYTHON = os.environ.get("OPENTRAD_TEST_HERMES_PYTHON")
REAL_SMOKE_SITE_PACKAGES = os.environ.get("OPENTRAD_TEST_HERMES_SITE_PACKAGES")


def load_runtime() -> types.ModuleType:
    name = "opentrad_hermes_runtime_tested"
    sys.modules.pop(name, None)
    spec = importlib.util.spec_from_file_location(name, RUNTIME)
    if spec is None or spec.loader is None:
        raise AssertionError("runtime module could not be loaded")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def load_launcher() -> types.ModuleType:
    name = "opentrad_hermes_launcher_for_runtime_test"
    sys.modules.pop(name, None)
    spec = importlib.util.spec_from_file_location(name, LAUNCHER)
    if spec is None or spec.loader is None:
        raise AssertionError("launcher module could not be loaded")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _write_module(root: Path, relative: str, source: str) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source, encoding="utf-8")


def make_fake_hermes_tree(root: Path) -> None:
    _write_module(
        root,
        "hermes_cli/__init__.py",
        '__version__ = "0.18.2"\n__release_date__ = "2026.7.7.2"\n',
    )
    _write_module(
        root,
        "hermes_cli/env_loader.py",
        """import os
def load_hermes_dotenv(*args, **kwargs):
    os.environ["OPENTRAD_FAKE_DOTENV_CALLED"] = "1"
""",
    )
    _write_module(
        root,
        "hermes_cli/banner.py",
        """import os
def prefetch_update_check():
    os.environ["OPENTRAD_FAKE_UPDATE_CALLED"] = "1"
""",
    )
    _write_module(root, "tui_gateway/__init__.py", "")
    _write_module(
        root,
        "tui_gateway/transport.py",
        """class StdioTransport:
    pass
def bind_transport(value):
    return value
def reset_transport(value):
    return None
""",
    )
    _write_module(
        root,
        "tui_gateway/entry.py",
        'import os\nos.environ["OPENTRAD_REAL_ENTRY_IMPORTED"] = "1"\n',
    )
    _write_module(
        root,
        "tui_gateway/server.py",
        """import concurrent.futures
import sys
import threading
from hermes_cli.env_loader import load_hermes_dotenv
from hermes_cli.banner import prefetch_update_check

print("unsafe stdout runtime-canary-secret-never-render-0123456789")
print("unsafe stderr runtime-canary-secret-never-render-0123456789", file=sys.stderr)
load_hermes_dotenv()
prefetch_update_check()

_CRASH_LOG = "/private/runtime-canary-secret-never-render-0123456789/crash.log"
def _panic_hook(*args, **kwargs):
    raise AssertionError("unsafe panic hook called")
def _thread_panic_hook(*args, **kwargs):
    raise AssertionError("unsafe thread hook called")
sys.excepthook = _panic_hook
threading.excepthook = _thread_panic_hook

_real_stdout = sys.stdout
sys.stdout = sys.stderr
_stdout_lock = threading.Lock()
from tui_gateway.transport import StdioTransport
_stdio_transport = StdioTransport()
class _DropTransport:
    def write(self, value):
        return False
    def close(self):
        return None
_detached_ws_transport = _DropTransport()

_pool = concurrent.futures.ThreadPoolExecutor(max_workers=2)
_shutdown_count = 0
def _shutdown_sessions():
    global _shutdown_count
    _shutdown_count += 1

_idle_thread = None
def _start_idle_reaper():
    def _loop():
        raise AssertionError("idle reaper must not execute")
    global _idle_thread
    _idle_thread = threading.Thread(target=_loop, daemon=True)
    _idle_thread.start()
_start_idle_reaper()

_methods = {}
def method(name):
    def decorate(fn):
        _methods[name] = fn
        return fn
    return decorate

def _handler(request_id, params):
    if params.get("raise_canary"):
        raise RuntimeError("runtime-canary-secret-never-render-0123456789")
    return {"jsonrpc": "2.0", "id": request_id, "result": {"params": params}}
for _method_name in (
    "session.create", "session.resume", "session.status", "session.close",
    "session.interrupt", "prompt.submit", "approval.respond", "shell.exec",
):
    _methods[_method_name] = _handler

_last_transport = None
def dispatch(request, transport=None):
    global _last_transport
    _last_transport = transport
    handler = _methods.get(request.get("method"))
    if handler is None:
        return {"jsonrpc": "2.0", "id": request.get("id"), "error": {"code": -32601}}
    return handler(request.get("id"), request.get("params", {}))
""",
    )


def clear_fake_modules() -> None:
    for name in tuple(sys.modules):
        if name == "opentrad_hermes_launcher_for_runtime_test" or name.startswith(
            FAKE_MODULE_PREFIXES
        ):
            sys.modules.pop(name, None)


def make_transport(launcher: types.ModuleType) -> tuple[object, io.BytesIO]:
    capability = launcher.Capability(
        expires_at=2_000_000_000,
        token=CANARY,
        model="openai/gpt-5.2",
        api_mode="chat_completions",
        broker_port=43117,
    )
    output = io.BytesIO()
    return launcher.SafeJsonTransport(output, capability), output


def trusted_stdlib_paths() -> list[str]:
    roots = tuple(
        Path(value).resolve()
        for value in {sys.base_prefix, sys.base_exec_prefix}
        if value
    )
    trusted: list[str] = []
    for value in sys.path:
        if not value or "site-packages" in Path(value).parts:
            continue
        lexical = Path(os.path.normpath(value))
        if not lexical.is_absolute():
            continue
        if any(lexical == root or root in lexical.parents for root in roots):
            trusted.append(str(lexical))
    return trusted


class RuntimeModuleTests(unittest.TestCase):
    def tearDown(self) -> None:
        clear_fake_modules()
        for key in (
            "OPENTRAD_FAKE_DOTENV_CALLED",
            "OPENTRAD_FAKE_UPDATE_CALLED",
            "OPENTRAD_REAL_ENTRY_IMPORTED",
        ):
            os.environ.pop(key, None)

    def test_owned_runtime_adapter_exists(self) -> None:
        self.assertTrue(RUNTIME.is_file(), "owned Hermes runtime adapter is missing")

    def test_pins_the_reviewed_hermes_release(self) -> None:
        runtime = load_runtime()

        self.assertEqual(getattr(runtime, "PINNED_HERMES_VERSION", None), "0.18.2")
        self.assertEqual(
            getattr(runtime, "PINNED_HERMES_RELEASE_DATE", None), "2026.7.7.2"
        )

    def test_imports_through_the_firewall_and_returns_only_the_guarded_dispatcher(
        self,
    ) -> None:
        runtime = load_runtime()
        launcher = load_launcher()
        transport, output = make_transport(launcher)
        saved_stdout = sys.stdout
        saved_stderr = sys.stderr
        inherited_stdout = io.StringIO()
        inherited_stderr = io.StringIO()
        saved_sys_hook = sys.excepthook
        saved_thread_hook = threading.excepthook
        saved_thread_start = threading.Thread.start
        saved_path = list(sys.path)
        observed_signals = {
            candidate: signal.getsignal(candidate)
            for candidate in (
                getattr(signal, "SIGPIPE", None),
                getattr(signal, "SIGTERM", None),
                getattr(signal, "SIGHUP", None),
                getattr(signal, "SIGINT", None),
            )
            if candidate is not None
        }

        self.assertTrue(
            callable(getattr(runtime, "load_pinned_runtime", None)),
            "runtime import firewall entrypoint is missing",
        )

        with tempfile.TemporaryDirectory() as temporary:
            site_packages = Path(temporary).resolve()
            make_fake_hermes_tree(site_packages)
            sys.path[:] = trusted_stdlib_paths() + [str(site_packages)]
            sys.stdout = inherited_stdout
            sys.stderr = inherited_stderr
            try:
                guarded = runtime.load_pinned_runtime(site_packages, transport)
            finally:
                sys.stdout = saved_stdout
                sys.stderr = saved_stderr
                sys.path[:] = saved_path

        server = sys.modules["tui_gateway.server"]
        response = guarded.dispatch(
            {
                "jsonrpc": "2.0",
                "id": 7,
                "method": "session.status",
                "params": {"canary": "safe"},
            }
        )
        raw_request = {
            "jsonrpc": "2.0",
            "id": 8,
            "method": "session.status",
            "params": {},
        }

        self.assertEqual(response["id"], 7)
        self.assertIs(server._last_transport, transport)
        with self.assertRaises(runtime.RuntimeImportRefusal):
            server.dispatch(raw_request)
        with self.assertRaises(runtime.RuntimeImportRefusal):
            server.dispatch(raw_request, object())
        transport_gate = server.dispatch
        server.dispatch = lambda request, candidate_transport=None: {
            "jsonrpc": "2.0",
            "id": request.get("id"),
            "result": {"bypassed": True},
        }
        try:
            with self.assertRaises(runtime.RuntimeImportRefusal):
                guarded.dispatch(raw_request)
        finally:
            server.dispatch = transport_gate
        self.assertEqual(frozenset(server._methods), ALLOWED_METHODS)
        self.assertIsNone(server._idle_thread.ident)
        self.assertFalse(server._idle_thread.is_alive())
        self.assertIs(threading.Thread.start, saved_thread_start)
        self.assertNotIn("OPENTRAD_FAKE_DOTENV_CALLED", os.environ)
        self.assertNotIn("OPENTRAD_FAKE_UPDATE_CALLED", os.environ)
        self.assertNotIn("OPENTRAD_REAL_ENTRY_IMPORTED", os.environ)
        self.assertEqual(inherited_stdout.getvalue(), "")
        self.assertEqual(inherited_stderr.getvalue(), "")
        self.assertEqual(output.getvalue(), b"")
        self.assertTrue(
            getattr(sys.modules["tui_gateway.entry"], "__opentrad_stub__", False)
        )
        entry_stub = sys.modules["tui_gateway.entry"]
        self.assertIsNone(entry_stub.wait_for_mcp_discovery())
        self.assertFalse(entry_stub.mcp_discovery_in_flight())
        self.assertTrue(entry_stub.join_mcp_discovery(timeout=0.01))
        self.assertIs(sys.excepthook, server._panic_hook)
        self.assertIs(threading.excepthook, server._thread_panic_hook)
        server._panic_hook(RuntimeError, RuntimeError(CANARY), None)
        server._thread_panic_hook(types.SimpleNamespace(exc_value=RuntimeError(CANARY)))
        self.assertIsNot(sys.excepthook, saved_sys_hook)
        self.assertIsNot(threading.excepthook, saved_thread_hook)
        self.assertEqual(
            {candidate: signal.getsignal(candidate) for candidate in observed_signals},
            observed_signals,
        )
        self.assertEqual(server._CRASH_LOG, "")
        self.assertEqual(server._real_stdout.write("discarded"), 0)
        self.assertIsInstance(server._stdio_transport, server._DropTransport)

        with self.assertRaises(runtime.RuntimeImportRefusal) as dispatch_failure:
            guarded.dispatch(
                {
                    "jsonrpc": "2.0",
                    "id": 9,
                    "method": "session.status",
                    "params": {"raise_canary": True},
                }
            )
        self.assertIsNone(dispatch_failure.exception.__context__)
        self.assertIsNone(dispatch_failure.exception.__cause__)
        self.assertNotIn(
            CANARY,
            "".join(
                traceback.format_exception(
                    type(dispatch_failure.exception),
                    dispatch_failure.exception,
                    dispatch_failure.exception.__traceback__,
                )
            ),
        )

        original_status = server._methods["session.status"]
        server._methods["session.status"] = lambda *_args: {"unsafe": True}
        with self.assertRaises(runtime.RuntimeImportRefusal):
            guarded.dispatch(raw_request)
        server._methods["session.status"] = original_status
        original_drop_type = server._DropTransport
        server._DropTransport = type("ReplacementDropTransport", (), {})
        with self.assertRaises(runtime.RuntimeImportRefusal):
            guarded.dispatch(raw_request)
        server._DropTransport = original_drop_type
        guarded.shutdown()
        self.assertEqual(server._shutdown_count, 1)
        sys.excepthook = saved_sys_hook
        threading.excepthook = saved_thread_hook

    def test_refuses_a_closed_safe_transport(self) -> None:
        runtime = load_runtime()
        launcher = load_launcher()
        transport, _output = make_transport(launcher)
        transport.close()
        saved_stdout = sys.stdout
        saved_stderr = sys.stderr
        saved_sys_hook = sys.excepthook
        saved_thread_hook = threading.excepthook
        saved_path = list(sys.path)
        guarded = None

        with tempfile.TemporaryDirectory() as temporary:
            site_packages = Path(temporary).resolve()
            make_fake_hermes_tree(site_packages)
            sys.path[:] = trusted_stdlib_paths() + [str(site_packages)]
            try:
                with self.assertRaises(runtime.RuntimeImportRefusal):
                    guarded = runtime.load_pinned_runtime(site_packages, transport)
            finally:
                if guarded is not None:
                    guarded.shutdown()
                sys.stdout = saved_stdout
                sys.stderr = saved_stderr
                sys.excepthook = saved_sys_hook
                threading.excepthook = saved_thread_hook
                sys.path[:] = saved_path

    def test_refuses_a_selected_module_that_resolves_outside_site_packages(
        self,
    ) -> None:
        runtime = load_runtime()
        launcher = load_launcher()
        transport, _output = make_transport(launcher)
        saved_stdout = sys.stdout
        saved_stderr = sys.stderr
        saved_sys_hook = sys.excepthook
        saved_thread_hook = threading.excepthook
        saved_path = list(sys.path)
        guarded = None
        caught = None

        with tempfile.TemporaryDirectory() as temporary:
            sandbox = Path(temporary).resolve()
            site_packages = sandbox / "verified-site-packages"
            site_packages.mkdir()
            make_fake_hermes_tree(site_packages)
            outside = sandbox / f"outside-{CANARY}.py"
            outside.write_text(
                "def load_hermes_dotenv(*args, **kwargs):\n    return None\n",
                encoding="utf-8",
            )
            env_loader = site_packages / "hermes_cli" / "env_loader.py"
            env_loader.unlink()
            env_loader.symlink_to(outside)
            sys.path[:] = trusted_stdlib_paths() + [str(site_packages)]
            try:
                try:
                    guarded = runtime.load_pinned_runtime(site_packages, transport)
                except runtime.RuntimeImportRefusal as error:
                    caught = error
            finally:
                if guarded is not None:
                    guarded.shutdown()
                sys.stdout = saved_stdout
                sys.stderr = saved_stderr
                sys.excepthook = saved_sys_hook
                threading.excepthook = saved_thread_hook
                sys.path[:] = saved_path

        self.assertIsNotNone(caught, "out-of-root selected module was accepted")
        rendered = " ".join((str(caught), repr(caught)))
        self.assertNotIn(CANARY, rendered)
        self.assertNotIn(temporary, rendered)
        self.assertIsNone(caught.__context__)
        self.assertIsNone(caught.__cause__)
        formatted = "".join(
            traceback.format_exception(type(caught), caught, caught.__traceback__)
        )
        self.assertNotIn(CANARY, formatted)
        self.assertNotIn(temporary, formatted)

    def test_refuses_a_transitively_loaded_hermes_module_outside_site_packages(
        self,
    ) -> None:
        runtime = load_runtime()
        launcher = load_launcher()
        transport, _output = make_transport(launcher)
        saved_stdout = sys.stdout
        saved_stderr = sys.stderr
        saved_sys_hook = sys.excepthook
        saved_thread_hook = threading.excepthook
        saved_path = list(sys.path)
        guarded = None
        caught = None

        with tempfile.TemporaryDirectory() as temporary:
            sandbox = Path(temporary).resolve()
            site_packages = sandbox / "verified-site-packages"
            site_packages.mkdir()
            make_fake_hermes_tree(site_packages)
            _write_module(site_packages, "agent/__init__.py", "")
            outside = sandbox / f"transitive-{CANARY}.py"
            outside.write_text("VALUE = 'untrusted'\n", encoding="utf-8")
            (site_packages / "agent" / "transitive.py").symlink_to(outside)
            server_path = site_packages / "tui_gateway" / "server.py"
            server_path.write_text(
                server_path.read_text(encoding="utf-8") + "\nimport agent.transitive\n",
                encoding="utf-8",
            )
            sys.path[:] = trusted_stdlib_paths() + [str(site_packages)]
            try:
                try:
                    guarded = runtime.load_pinned_runtime(site_packages, transport)
                except runtime.RuntimeImportRefusal as error:
                    caught = error
            finally:
                if guarded is not None:
                    guarded.shutdown()
                sys.stdout = saved_stdout
                sys.stderr = saved_stderr
                sys.excepthook = saved_sys_hook
                threading.excepthook = saved_thread_hook
                sys.path[:] = saved_path

        self.assertIsNotNone(
            caught, "out-of-root transitive Hermes module was accepted"
        )
        rendered = " ".join((str(caught), repr(caught)))
        self.assertNotIn(CANARY, rendered)
        self.assertNotIn(temporary, rendered)

    def test_refuses_an_extra_site_packages_like_import_root(self) -> None:
        runtime = load_runtime()
        launcher = load_launcher()
        transport, _output = make_transport(launcher)
        saved_stdout = sys.stdout
        saved_stderr = sys.stderr
        saved_sys_hook = sys.excepthook
        saved_thread_hook = threading.excepthook
        saved_path = list(sys.path)
        guarded = None

        with tempfile.TemporaryDirectory() as temporary:
            sandbox = Path(temporary).resolve()
            site_packages = sandbox / "managed" / "site-packages"
            rogue_site_packages = sandbox / "rogue" / "site-packages"
            site_packages.mkdir(parents=True)
            rogue_site_packages.mkdir(parents=True)
            make_fake_hermes_tree(site_packages)
            sys.path[:] = trusted_stdlib_paths() + [
                str(rogue_site_packages),
                str(site_packages),
            ]
            try:
                with self.assertRaises(runtime.RuntimeImportRefusal):
                    guarded = runtime.load_pinned_runtime(site_packages, transport)
            finally:
                if guarded is not None:
                    guarded.shutdown()
                sys.path[:] = saved_path
                sys.stdout = saved_stdout
                sys.stderr = saved_stderr
                sys.excepthook = saved_sys_hook
                threading.excepthook = saved_thread_hook

    def test_refuses_empty_cwd_launcher_and_duplicate_import_roots(self) -> None:
        runtime = load_runtime()
        saved_path = list(sys.path)

        with tempfile.TemporaryDirectory() as temporary:
            site_packages = Path(temporary).resolve()
            base = trusted_stdlib_paths()
            invalid_prefixes = (
                base + [""],
                base + [str(Path.cwd().resolve())],
                base + [str(RUNTIME.parent.resolve())],
                base + [str(site_packages)],
            )
            try:
                for invalid in invalid_prefixes:
                    with self.subTest(extra=invalid[-1]):
                        sys.path[:] = invalid + [str(site_packages)]
                        with self.assertRaises(runtime.RuntimeImportRefusal):
                            runtime._validated_site_packages(site_packages)
            finally:
                sys.path[:] = saved_path

    def test_refuses_missing_or_wrong_transport_without_reflecting_values(self) -> None:
        runtime = load_runtime()
        saved_path = list(sys.path)
        saved_sys_hook = sys.excepthook
        saved_thread_hook = threading.excepthook

        with tempfile.TemporaryDirectory() as temporary:
            site_packages = Path(temporary).resolve()
            sys.path[:] = trusted_stdlib_paths() + [str(site_packages)]
            try:
                for candidate in (None, object(), CANARY):
                    with self.subTest(candidate=type(candidate).__name__):
                        with self.assertRaises(runtime.RuntimeImportRefusal) as caught:
                            runtime.load_pinned_runtime(site_packages, candidate)
                        rendered = " ".join(
                            (str(caught.exception), repr(caught.exception))
                        )
                        self.assertNotIn(CANARY, rendered)
                        self.assertNotIn(temporary, rendered)
            finally:
                sys.path[:] = saved_path
                sys.excepthook = saved_sys_hook
                threading.excepthook = saved_thread_hook

    def test_refuses_an_unexpected_server_import_thread_and_restores_start(
        self,
    ) -> None:
        runtime = load_runtime()
        launcher = load_launcher()
        transport, _output = make_transport(launcher)
        saved_stdout = sys.stdout
        saved_stderr = sys.stderr
        saved_sys_hook = sys.excepthook
        saved_thread_hook = threading.excepthook
        saved_thread_start = threading.Thread.start
        saved_path = list(sys.path)

        with tempfile.TemporaryDirectory() as temporary:
            site_packages = Path(temporary).resolve()
            make_fake_hermes_tree(site_packages)
            server_path = site_packages / "tui_gateway" / "server.py"
            server_path.write_text(
                server_path.read_text(encoding="utf-8")
                + "\nthreading.Thread(target=lambda: None, daemon=True).start()\n",
                encoding="utf-8",
            )
            sys.path[:] = trusted_stdlib_paths() + [str(site_packages)]
            try:
                with self.assertRaises(runtime.RuntimeImportRefusal):
                    runtime.load_pinned_runtime(site_packages, transport)
            finally:
                sys.path[:] = saved_path
                sys.stdout = saved_stdout
                sys.stderr = saved_stderr
                sys.excepthook = saved_sys_hook
                threading.excepthook = saved_thread_hook

        self.assertIs(threading.Thread.start, saved_thread_start)

    def test_refuses_a_forged_launcher_module_transport(self) -> None:
        runtime = load_runtime()
        saved_path = list(sys.path)
        saved_stdout = sys.stdout
        saved_stderr = sys.stderr
        saved_sys_hook = sys.excepthook
        saved_thread_hook = threading.excepthook
        forged = types.ModuleType("forged_launcher")

        class SafeJsonTransport:
            def __init__(self) -> None:
                self._closed = False
                self._stream = io.BytesIO()
                self._token = CANARY

        SafeJsonTransport.__module__ = forged.__name__

        def bind_server_dispatch(server: object, transport: object):
            return lambda request: server.dispatch(request, transport)

        bind_server_dispatch.__module__ = forged.__name__
        forged.SafeJsonTransport = SafeJsonTransport
        forged.bind_server_dispatch = bind_server_dispatch
        forged.ALLOWED_RPC_METHODS = ALLOWED_METHODS
        sys.modules[forged.__name__] = forged

        with tempfile.TemporaryDirectory() as temporary:
            site_packages = Path(temporary).resolve()
            make_fake_hermes_tree(site_packages)
            sys.path[:] = trusted_stdlib_paths() + [str(site_packages)]
            try:
                with self.assertRaises(runtime.RuntimeImportRefusal):
                    runtime.load_pinned_runtime(site_packages, SafeJsonTransport())
            finally:
                sys.modules.pop(forged.__name__, None)
                sys.path[:] = saved_path
                sys.stdout = saved_stdout
                sys.stderr = saved_stderr
                sys.excepthook = saved_sys_hook
                threading.excepthook = saved_thread_hook

    def test_refuses_a_server_with_the_wrong_private_lock_shape(self) -> None:
        runtime = load_runtime()
        launcher = load_launcher()
        transport, _output = make_transport(launcher)
        saved_path = list(sys.path)
        saved_stdout = sys.stdout
        saved_stderr = sys.stderr
        saved_sys_hook = sys.excepthook
        saved_thread_hook = threading.excepthook

        with tempfile.TemporaryDirectory() as temporary:
            site_packages = Path(temporary).resolve()
            make_fake_hermes_tree(site_packages)
            server_path = site_packages / "tui_gateway" / "server.py"
            server_path.write_text(
                server_path.read_text(encoding="utf-8").replace(
                    "_stdout_lock = threading.Lock()",
                    "_stdout_lock = object()",
                ),
                encoding="utf-8",
            )
            sys.path[:] = trusted_stdlib_paths() + [str(site_packages)]
            try:
                with self.assertRaises(runtime.RuntimeImportRefusal):
                    runtime.load_pinned_runtime(site_packages, transport)
            finally:
                sys.path[:] = saved_path
                sys.stdout = saved_stdout
                sys.stderr = saved_stderr
                sys.excepthook = saved_sys_hook
                threading.excepthook = saved_thread_hook

    @unittest.skipUnless(
        REAL_SMOKE_PYTHON and REAL_SMOKE_SITE_PACKAGES,
        "set OPENTRAD_TEST_HERMES_PYTHON and OPENTRAD_TEST_HERMES_SITE_PACKAGES",
    )
    def test_real_pinned_wheel_import_smoke_is_read_only(self) -> None:
        script = r"""
import importlib.util
import io
import os
from pathlib import Path
import sys
import time

owned = Path(sys.argv[1]).resolve()
site_packages = Path(sys.argv[2]).resolve()

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise SystemExit(3)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module

launcher = load("opentrad_hermes_launcher_smoke", owned / "opentrad_hermes_launcher.py")
runtime = load("opentrad_hermes_runtime_smoke", owned / "opentrad_hermes_runtime.py")
capability = launcher.Capability(
    int(time.time()) + 60,
    "smoke-canary-secret-never-render-0123456789",
    "openai/gpt-5.2",
    "chat_completions",
    43117,
)
transport = launcher.SafeJsonTransport(io.BytesIO(), capability)
sys.path.append(str(site_packages))
guarded = runtime.load_pinned_runtime(site_packages, transport)
server = sys.modules["tui_gateway.server"]
methods_ok = frozenset(server._methods) == launcher.ALLOWED_RPC_METHODS
try:
    server.dispatch({"jsonrpc": "2.0", "id": 1, "method": "session.status", "params": {}})
    raw_refused = False
except runtime.RuntimeImportRefusal:
    raw_refused = True
guarded.shutdown()
os.write(1, b"RUNTIME_SMOKE_OK\n" if methods_ok and raw_refused else b"RUNTIME_SMOKE_BAD\n")
raise SystemExit(0 if methods_ok and raw_refused else 4)
"""
        with tempfile.TemporaryDirectory() as temporary:
            hermes_home = Path(temporary).resolve()
            result = subprocess.run(
                [
                    str(Path(REAL_SMOKE_PYTHON).resolve()),
                    "-I",
                    "-S",
                    "-B",
                    "-c",
                    script,
                    str(RUNTIME.parent.resolve()),
                    str(Path(REAL_SMOKE_SITE_PACKAGES).resolve()),
                ],
                cwd=hermes_home,
                env={"HERMES_HOME": str(hermes_home), "LANG": "C.UTF-8"},
                capture_output=True,
                check=False,
                timeout=30,
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(result.stdout, b"RUNTIME_SMOKE_OK\n")
            self.assertEqual(result.stderr, b"")
            self.assertNotIn(CANARY.encode(), result.stdout + result.stderr)
            self.assertEqual(list(hermes_home.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
