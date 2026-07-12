#!/usr/bin/env python3
"""Contract tests for the OpenTrad-owned Hermes post-bootstrap firewall."""

from __future__ import annotations

import atexit
import importlib.util
import io
import os
from pathlib import Path
import signal
import socket
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
FAKE_MODULE_PREFIXES = (
    "agent",
    "dotenv",
    "hermes_cli",
    "hermes_state",
    "jiter",
    "model_tools",
    "plugins",
    "providers",
    "run_agent",
    "tools",
    "tui_gateway",
    "utils",
    "yaml",
)
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
    for denied_name in (
        "hermes_state",
        "model_tools",
        "plugins",
        "providers",
        "run_agent",
    ):
        _write_module(
            root,
            f"{denied_name}.py",
            'import os\nos.environ["OPENTRAD_DENIED_IMPORT"] = "1"\n',
        )
    _write_module(
        root,
        "dotenv.py",
        'import os\nos.environ["OPENTRAD_DOTENV_IMPORTED"] = "1"\n',
    )
    _write_module(
        root,
        "jiter/__init__.py",
        "",
    )
    _write_module(
        root,
        "jiter/jiter.py",
        'import os\nos.environ["OPENTRAD_JITER_IMPORTED"] = "1"\n',
    )
    _write_module(
        root,
        "yaml.py",
        'import os\nos.environ["OPENTRAD_YAML_IMPORTED"] = "1"\n',
    )
    _write_module(
        root,
        "agent/__init__.py",
        "import jiter.jiter\n",
    )
    _write_module(
        root,
        "agent/replay_cleanup.py",
        "def sanitize_replay_history(value):\n    return value\n",
    )
    _write_module(
        root,
        "utils.py",
        'import os\nimport yaml\nos.environ["OPENTRAD_UTILS_IMPORTED"] = "1"\n'
        "def is_truthy_value(value, default=False):\n    return bool(value)\n",
    )
    _write_module(root, "tools/__init__.py", "")
    _write_module(
        root,
        "tools/environments/__init__.py",
        'import os\nos.environ["OPENTRAD_TOOL_ENV_IMPORTED"] = "1"\n',
    )
    _write_module(
        root,
        "tools/environments/local.py",
        "def hermes_subprocess_env(*args, **kwargs):\n    return {}\n",
    )
    _write_module(
        root,
        "hermes_cli/__init__.py",
        '__version__ = "0.18.2"\n__release_date__ = "2026.7.7.2"\n',
    )
    _write_module(
        root,
        "hermes_cli/env_loader.py",
        """import os
import dotenv
import utils
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
        "tui_gateway/git_probe.py",
        'import os\nos.environ["OPENTRAD_GIT_PROBE_IMPORTED"] = "1"\n'
        "def _empty(*args, **kwargs):\n    return ''\n"
        "run_git = branch = repo_root = common_repo_root = resolve = _empty\n",
    )
    _write_module(
        root,
        "tui_gateway/render.py",
        'import os\nos.environ["OPENTRAD_RENDER_IMPORTED"] = "1"\n'
        "def _empty(*args, **kwargs):\n    return None\n"
        "make_stream_renderer = render_diff = render_message = _empty\n",
    )
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
        """import atexit
import concurrent.futures
import sys
import threading
from agent.replay_cleanup import sanitize_replay_history
from hermes_cli.env_loader import load_hermes_dotenv
from hermes_cli.banner import prefetch_update_check
from utils import is_truthy_value
from tools.environments.local import hermes_subprocess_env
from tui_gateway import git_probe
from tui_gateway.render import make_stream_renderer, render_diff, render_message

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
_pool_atexit_callback = lambda: _pool.shutdown(wait=False, cancel_futures=True)
_native_shutdown_callback = _shutdown_sessions
atexit.register(_pool_atexit_callback)
atexit.register(_native_shutdown_callback)

_native_handler_calls = 0
_sessions = {}
_pending = {}
_pending_prompt_payloads = {}
_answers = {}
_db = None
_cfg_cache = None
_LONG_HANDLERS = frozenset({"session.resume", "prompt.submit"})
def _dangerous_helper(*args, **kwargs):
    raise AssertionError("native Hermes helper executed")
for _dangerous_name in (
    "_schedule_agent_build", "_start_agent_build", "_run_prompt_submit",
    "_load_cfg", "_save_cfg", "_enable_gateway_prompts",
    "_register_session_cwd", "_git", "_git_branch_for_cwd",
    "_resolve_cwd_git", "_profile_home", "_set_session_context",
    "_clear_session_context", "_resolve_startup_runtime",
    "_resolve_runtime_with_fallback", "_load_provider_routing",
    "_schedule_mcp_late_refresh", "_start_notification_poller",
    "_restart_slash_worker", "_mirror_slash_side_effects",
    "_allowed_image_extensions", "_emit_approval_request",
    "_finalize_session", "_get_db", "_notify_session_boundary",
    "_clear_pending", "_close_session_by_id", "_sess", "_sess_nowait",
    "_teardown_session", "_wire_callbacks", "_make_agent",
    "_schedule_session_cap_enforcement", "_SlashWorker",
    "_persist_session_git_meta", "_stored_session_runtime_overrides",
    "_resolve_model",
):
    globals()[_dangerous_name] = _dangerous_helper

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

def _emit(*args, **kwargs):
    raise AssertionError("native emit executed")
def write_json(*args, **kwargs):
    raise AssertionError("native write executed")
def _normalize_request(request):
    return request.get("id"), request.get("method"), request.get("params", {})
def handle_request(request):
    request_id, method_name, params = _normalize_request(request)
    handler = _methods.get(method_name)
    if handler is None:
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601}}
    return handler(request_id, params)

def _handler(request_id, params):
    global _native_handler_calls
    _native_handler_calls += 1
    if params.get("raise_canary"):
        raise RuntimeError("runtime-canary-secret-never-render-0123456789")
    return {"jsonrpc": "2.0", "id": request_id, "result": {"params": params}}
for _method_name in (
    "session.create", "session.resume", "session.status", "session.close",
    "session.interrupt", "prompt.submit", "approval.respond", "shell.exec",
):
    _methods[_method_name] = _handler
_ = _handler

_last_transport = None
def dispatch(request, transport=None):
    global _last_transport
    _last_transport = transport
    _normalize_request(request)
    return handle_request(request)
_native_dispatch_for_test = dispatch
""",
    )


def clear_fake_modules() -> None:
    sys.meta_path[:] = [
        finder
        for finder in sys.meta_path
        if not (
            type(finder).__name__ == "_DeniedHermesImportFinder"
            and type(finder).__module__.startswith("opentrad_hermes_runtime")
        )
    ]
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
            "OPENTRAD_DENIED_IMPORT",
            "OPENTRAD_DOTENV_IMPORTED",
            "OPENTRAD_FAKE_DOTENV_CALLED",
            "OPENTRAD_FAKE_UPDATE_CALLED",
            "OPENTRAD_REAL_ENTRY_IMPORTED",
            "OPENTRAD_GIT_PROBE_IMPORTED",
            "OPENTRAD_JITER_IMPORTED",
            "OPENTRAD_OWNED_RUNTIME_MUTATION_EXECUTED",
            "OPENTRAD_POOL_SHUTDOWN_OVERRIDE_EXECUTED",
            "OPENTRAD_RENDER_IMPORTED",
            "OPENTRAD_SERVER_CLASS_EXECUTED",
            "OPENTRAD_TOOL_ENV_IMPORTED",
            "OPENTRAD_UTILS_IMPORTED",
            "OPENTRAD_YAML_IMPORTED",
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
        self.assertEqual(response["error"]["code"], -32602)
        self.assertIsNone(server._last_transport)
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

        original_helper = server._resolve_model
        server._resolve_model = lambda: (_ for _ in ()).throw(RuntimeError(CANARY))
        try:
            with self.assertRaises(runtime.RuntimeImportRefusal) as dispatch_failure:
                guarded.dispatch(raw_request)
        finally:
            server._resolve_model = original_helper
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

        original_methods = server._methods
        server._methods = dict(original_methods)
        server._methods["session.status"] = lambda *_args: {"unsafe": True}
        try:
            with self.assertRaises(runtime.RuntimeImportRefusal):
                guarded.dispatch(raw_request)
        finally:
            server._methods = original_methods
        original_drop_type = server._DropTransport
        server._DropTransport = type("ReplacementDropTransport", (), {})
        with self.assertRaises(runtime.RuntimeImportRefusal):
            guarded.dispatch(raw_request)
        server._DropTransport = original_drop_type
        guarded.shutdown()
        self.assertEqual(server._shutdown_count, 0)
        sys.excepthook = saved_sys_hook
        threading.excepthook = saved_thread_hook

    def test_quarantines_all_native_handlers_behind_owned_lazy_state(self) -> None:
        runtime = load_runtime()
        launcher = load_launcher()
        transport, output = make_transport(launcher)
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
                guarded = runtime.load_pinned_runtime(site_packages, transport)
                server = sys.modules["tui_gateway.server"]
                environment_before = dict(os.environ)
                files_before = tuple(
                    sorted(
                        str(path.relative_to(site_packages))
                        for path in site_packages.rglob("*")
                    )
                )
                threads_before = tuple(threading.enumerate())
                dangerous_modules = {
                    "hermes_cli.config",
                    "hermes_cli.plugins",
                    "model_tools",
                    "run_agent",
                    "tools.approval",
                    "tools.mcp_tool",
                    "tools.terminal_tool",
                }
                self.assertTrue(dangerous_modules.isdisjoint(sys.modules))

                original_thread_start = threading.Thread.start
                original_timer = threading.Timer
                original_popen = subprocess.Popen
                original_run = subprocess.run
                original_socket = socket.socket

                def forbidden_side_effect(*_args: object, **_kwargs: object):
                    raise AssertionError("quarantined RPC attempted an OS side effect")

                threading.Thread.start = forbidden_side_effect
                threading.Timer = forbidden_side_effect
                subprocess.Popen = forbidden_side_effect
                subprocess.run = forbidden_side_effect
                socket.socket = forbidden_side_effect
                try:
                    invalid_create_params = (
                        {"cwd": str(site_packages), "source": "opentrad"},
                        {
                            "cwd": str(site_packages),
                            "source": "opentrad",
                            "close_on_disconnect": False,
                        },
                        {
                            "cwd": str(site_packages),
                            "source": "opentrad",
                            "close_on_disconnect": True,
                            "extra": CANARY,
                        },
                    )
                    for invalid_params in invalid_create_params:
                        invalid_create = guarded.dispatch(
                            {
                                "jsonrpc": "2.0",
                                "id": 100,
                                "method": "session.create",
                                "params": invalid_params,
                            }
                        )
                        self.assertEqual(
                            invalid_create,
                            {
                                "jsonrpc": "2.0",
                                "id": 100,
                                "error": {
                                    "code": -32602,
                                    "message": "Invalid params",
                                },
                            },
                        )
                        self.assertNotIn(CANARY, repr(invalid_create))

                    created = guarded.dispatch(
                        {
                            "jsonrpc": "2.0",
                            "id": 1,
                            "method": "session.create",
                            "params": {
                                "cwd": str(site_packages),
                                "source": "opentrad",
                                "close_on_disconnect": True,
                            },
                        }
                    )
                    self.assertEqual(set(created or {}), {"jsonrpc", "id", "result"})
                    self.assertEqual(created["id"], 1)
                    create_result = created["result"]
                    self.assertEqual(
                        set(create_result),
                        {
                            "info",
                            "message_count",
                            "messages",
                            "persisted",
                            "resumable",
                            "session_id",
                            "stored_session_id",
                        },
                    )
                    sid = create_result["session_id"]
                    self.assertRegex(sid, r"^[0-9a-f]{8}$")
                    stored_session_id = create_result["stored_session_id"]
                    self.assertRegex(stored_session_id, r"^\d{8}_\d{6}_[0-9a-f]{6}$")
                    self.assertEqual(create_result["message_count"], 0)
                    self.assertEqual(create_result["messages"], [])
                    self.assertIs(create_result["persisted"], False)
                    self.assertIs(create_result["resumable"], False)
                    self.assertEqual(
                        create_result["info"],
                        {
                            "lazy": True,
                            "persisted": False,
                            "resumable": False,
                            "runtime": "hermes-quarantined",
                            "state": "quarantined",
                        },
                    )

                    status_request = {
                        "jsonrpc": "2.0",
                        "id": 2,
                        "method": "session.status",
                        "params": {"session_id": sid},
                    }
                    status_before = guarded.dispatch(status_request)
                    self.assertEqual(
                        status_before,
                        {
                            "jsonrpc": "2.0",
                            "id": 2,
                            "result": {
                                "lazy": True,
                                "message_count": 0,
                                "output": "",
                                "persisted": False,
                                "resumable": False,
                                "running": False,
                                "session_id": sid,
                                "state": "quarantined",
                                "stored_session_id": stored_session_id,
                            },
                        },
                    )
                    self.assertNotIn("path", repr(status_before).lower())
                    self.assertNotIn("tools", repr(status_before).lower())
                    self.assertNotIn("provider", repr(status_before).lower())

                    approval = guarded.dispatch(
                        {
                            "jsonrpc": "2.0",
                            "id": 3,
                            "method": "approval.respond",
                            "params": {
                                "session_id": sid,
                                "choice": "deny",
                                "all": False,
                            },
                        }
                    )
                    self.assertEqual(
                        approval,
                        {"jsonrpc": "2.0", "id": 3, "result": {"resolved": 0}},
                    )

                    prompt = guarded.dispatch(
                        {
                            "jsonrpc": "2.0",
                            "id": 4,
                            "method": "prompt.submit",
                            "params": {"session_id": sid, "text": CANARY},
                        }
                    )
                    self.assertEqual(
                        prompt,
                        {
                            "jsonrpc": "2.0",
                            "id": 4,
                            "error": {"code": -32603, "message": "Internal error"},
                        },
                    )
                    status_after_prompt = guarded.dispatch({**status_request, "id": 5})
                    self.assertEqual(
                        status_after_prompt["result"], status_before["result"]
                    )

                    interrupted = guarded.dispatch(
                        {
                            "jsonrpc": "2.0",
                            "id": 6,
                            "method": "session.interrupt",
                            "params": {"session_id": sid},
                        }
                    )
                    self.assertEqual(
                        interrupted,
                        {
                            "jsonrpc": "2.0",
                            "id": 6,
                            "result": {"status": "interrupted"},
                        },
                    )
                    closed = guarded.dispatch(
                        {
                            "jsonrpc": "2.0",
                            "id": 7,
                            "method": "session.close",
                            "params": {"session_id": sid},
                        }
                    )
                    self.assertEqual(
                        closed,
                        {"jsonrpc": "2.0", "id": 7, "result": {"closed": True}},
                    )
                    resumed = guarded.dispatch(
                        {
                            "jsonrpc": "2.0",
                            "id": 8,
                            "method": "session.resume",
                            "params": {"session_id": "20260710_082226_abcdef"},
                        }
                    )
                    self.assertEqual(
                        resumed,
                        {
                            "jsonrpc": "2.0",
                            "id": 8,
                            "error": {"code": -32603, "message": "Internal error"},
                        },
                    )
                    non_ascii_resume = guarded.dispatch(
                        {
                            "jsonrpc": "2.0",
                            "id": 9,
                            "method": "session.resume",
                            "params": {
                                "session_id": "２０２６０７１０_０８２２２６_abcdef"
                            },
                        }
                    )
                    self.assertEqual(
                        non_ascii_resume,
                        {
                            "jsonrpc": "2.0",
                            "id": 9,
                            "error": {"code": -32602, "message": "Invalid params"},
                        },
                    )
                finally:
                    threading.Thread.start = original_thread_start
                    threading.Timer = original_timer
                    subprocess.Popen = original_popen
                    subprocess.run = original_run
                    socket.socket = original_socket

                self.assertEqual(server._native_handler_calls, 0)
                self.assertTrue(
                    all(
                        getattr(handler, "__module__", None) == runtime.__name__
                        for handler in server._methods.values()
                    )
                )
                self.assertEqual(server._sessions, {})
                self.assertEqual(server._pending, {})
                self.assertEqual(server._pending_prompt_payloads, {})
                self.assertEqual(server._answers, {})
                self.assertIsNone(server._db)
                self.assertIsNone(server._cfg_cache)
                self.assertEqual(server._LONG_HANDLERS, frozenset())
                self.assertEqual(environment_before, dict(os.environ))
                self.assertEqual(threads_before, tuple(threading.enumerate()))
                self.assertEqual(
                    files_before,
                    tuple(
                        sorted(
                            str(path.relative_to(site_packages))
                            for path in site_packages.rglob("*")
                        )
                    ),
                )
                self.assertTrue(dangerous_modules.isdisjoint(sys.modules))
                self.assertEqual(output.getvalue(), b"")
            finally:
                if guarded is not None:
                    guarded.shutdown()
                sys.path[:] = saved_path
                sys.stdout = saved_stdout
                sys.stderr = saved_stderr
                sys.excepthook = saved_sys_hook
                threading.excepthook = saved_thread_hook

    def test_stubs_unreviewed_top_level_dependencies_and_native_atexit(self) -> None:
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
            site_packages = Path(temporary).resolve()
            make_fake_hermes_tree(site_packages)
            callbacks_before = atexit._ncallbacks()
            sys.path[:] = trusted_stdlib_paths() + [str(site_packages)]
            try:
                guarded = runtime.load_pinned_runtime(site_packages, transport)
                server = sys.modules["tui_gateway.server"]
                self.assertEqual(atexit._ncallbacks(), callbacks_before)
                self.assertTrue(
                    {
                        "agent",
                        "agent.replay_cleanup",
                        "tools",
                        "tools.environments",
                        "tools.environments.local",
                        "tui_gateway.git_probe",
                        "tui_gateway.render",
                        "utils",
                    }.issubset(sys.modules)
                )
                for name in (
                    "agent",
                    "agent.replay_cleanup",
                    "tools",
                    "tools.environments",
                    "tools.environments.local",
                    "tui_gateway.git_probe",
                    "tui_gateway.render",
                    "utils",
                ):
                    module = sys.modules[name]
                    self.assertTrue(getattr(module, "__opentrad_stub__", False))
                    self.assertTrue(
                        str(getattr(module.__spec__, "origin", "")).startswith(
                            "<opentrad-owned-stub:"
                        )
                    )
                self.assertIs(
                    sys.modules["agent"].replay_cleanup,
                    sys.modules["agent.replay_cleanup"],
                )
                self.assertIs(
                    sys.modules["tools"].environments,
                    sys.modules["tools.environments"],
                )
                self.assertIs(
                    sys.modules["tools.environments"].local,
                    sys.modules["tools.environments.local"],
                )
                self.assertIs(
                    sys.modules["tui_gateway"].git_probe,
                    sys.modules["tui_gateway.git_probe"],
                )
                self.assertIs(
                    sys.modules["tui_gateway"].render,
                    sys.modules["tui_gateway.render"],
                )
                self.assertTrue(
                    {
                        "dotenv",
                        "jiter",
                        "jiter.jiter",
                        "yaml",
                    }.isdisjoint(sys.modules)
                )
                for marker in (
                    "OPENTRAD_DOTENV_IMPORTED",
                    "OPENTRAD_GIT_PROBE_IMPORTED",
                    "OPENTRAD_JITER_IMPORTED",
                    "OPENTRAD_RENDER_IMPORTED",
                    "OPENTRAD_TOOL_ENV_IMPORTED",
                    "OPENTRAD_UTILS_IMPORTED",
                    "OPENTRAD_YAML_IMPORTED",
                ):
                    self.assertNotIn(marker, os.environ)
            finally:
                if "tui_gateway.server" in sys.modules:
                    server = sys.modules["tui_gateway.server"]
                    for name in ("_pool_atexit_callback", "_native_shutdown_callback"):
                        callback = getattr(server, name, None)
                        if callable(callback):
                            atexit.unregister(callback)
                if guarded is not None:
                    guarded.shutdown()
                sys.path[:] = saved_path
                sys.stdout = saved_stdout
                sys.stderr = saved_stderr
                sys.excepthook = saved_sys_hook
                threading.excepthook = saved_thread_hook

    def test_owned_gate_rejects_empty_method_without_reflecting_input(self) -> None:
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
            site_packages = Path(temporary).resolve()
            make_fake_hermes_tree(site_packages)
            sys.path[:] = trusted_stdlib_paths() + [str(site_packages)]
            try:
                guarded = runtime.load_pinned_runtime(site_packages, transport)
                response = guarded.dispatch(
                    {
                        "jsonrpc": "2.0",
                        "id": CANARY,
                        "method": "",
                        "params": {},
                    }
                )
                self.assertEqual(
                    response,
                    {
                        "jsonrpc": "2.0",
                        "id": None,
                        "error": {"code": -32600, "message": "Invalid Request"},
                    },
                )
                self.assertNotIn(CANARY, repr(response))
            finally:
                if guarded is not None:
                    guarded.shutdown()
                sys.path[:] = saved_path
                sys.stdout = saved_stdout
                sys.stderr = saved_stderr
                sys.excepthook = saved_sys_hook
                threading.excepthook = saved_thread_hook

    def test_quarantine_tampering_and_denied_imports_fail_closed(self) -> None:
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
            site_packages = Path(temporary).resolve()
            make_fake_hermes_tree(site_packages)
            sys.path[:] = trusted_stdlib_paths() + [str(site_packages)]
            try:
                guarded = runtime.load_pinned_runtime(site_packages, transport)
                server = sys.modules["tui_gateway.server"]
                request = {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "session.create",
                    "params": {
                        "cwd": str(site_packages),
                        "source": "opentrad",
                        "close_on_disconnect": True,
                    },
                }

                self.assertIs(type(server._methods), types.MappingProxyType)
                self.assertIs(type(server._sessions), types.MappingProxyType)
                with self.assertRaises(TypeError):
                    server._methods["session.create"] = lambda *_args: None
                with self.assertRaises(TypeError):
                    server._sessions["00000000"] = {}

                with self.assertRaises(runtime.RuntimeImportRefusal):
                    server._native_dispatch_for_test(request, transport)
                self.assertEqual(server._native_handler_calls, 0)

                original_helper = server._make_agent
                server._make_agent = lambda *_args, **_kwargs: CANARY
                try:
                    with self.assertRaises(
                        runtime.RuntimeImportRefusal
                    ) as helper_failure:
                        guarded.dispatch(request)
                finally:
                    server._make_agent = original_helper
                self.assertIsNone(helper_failure.exception.__context__)
                self.assertIsNone(helper_failure.exception.__cause__)
                self.assertNotIn(
                    CANARY,
                    "".join(
                        traceback.format_exception(
                            type(helper_failure.exception),
                            helper_failure.exception,
                            helper_failure.exception.__traceback__,
                        )
                    ),
                )

                original_long_handlers = server._LONG_HANDLERS
                server._LONG_HANDLERS = frozenset({"prompt.submit"})
                try:
                    with self.assertRaises(runtime.RuntimeImportRefusal):
                        guarded.dispatch(request)
                finally:
                    server._LONG_HANDLERS = original_long_handlers

                original_state = server._pending
                server._pending = {"unsafe": CANARY}
                try:
                    with self.assertRaises(runtime.RuntimeImportRefusal):
                        guarded.dispatch(request)
                finally:
                    server._pending = original_state

                handler = server._methods["session.create"]
                original_handler_code = handler.__code__

                def unsafe_handler_factory():
                    captured = CANARY

                    def unsafe_handler(_request_id, _params):
                        return {"unsafe": captured}

                    return unsafe_handler

                handler.__code__ = unsafe_handler_factory().__code__
                try:
                    with self.assertRaises(runtime.RuntimeImportRefusal):
                        guarded.dispatch(request)
                finally:
                    handler.__code__ = original_handler_code

                session_cell = next(
                    cell
                    for cell in handler.__closure__ or ()
                    if type(cell.cell_contents).__name__ == "_LazySessionStore"
                )
                original_sessions = session_cell.cell_contents
                evil_calls = 0

                class EvilSessions:
                    def create(self):
                        nonlocal evil_calls
                        evil_calls += 1
                        return ("deadbeef", "20260711_120000_abcdef")

                session_cell.cell_contents = EvilSessions()
                try:
                    with self.assertRaises(runtime.RuntimeImportRefusal):
                        guarded.dispatch(request)
                finally:
                    session_cell.cell_contents = original_sessions
                self.assertEqual(evil_calls, 0)

                gate = server.dispatch
                verifier = next(
                    cell.cell_contents
                    for cell in gate.__closure__ or ()
                    if type(cell.cell_contents) is types.FunctionType
                    and cell.cell_contents.__name__ == "verify_quarantine"
                )
                handler_contract_cell = next(
                    cell
                    for cell in verifier.__closure__ or ()
                    if type(cell.cell_contents) is dict
                    and set(cell.cell_contents) == ALLOWED_METHODS
                    and all(
                        type(value) is tuple and len(value) == 6
                        for value in cell.cell_contents.values()
                    )
                )
                original_handler_contracts = handler_contract_cell.cell_contents
                verifier_side_effects = 0

                class EvilHandlerContracts:
                    def values(self):
                        nonlocal verifier_side_effects
                        verifier_side_effects += 1
                        return ()

                handler_contract_cell.cell_contents = EvilHandlerContracts()
                try:
                    with self.assertRaises(runtime.RuntimeImportRefusal):
                        guarded.dispatch(request)
                finally:
                    handler_contract_cell.cell_contents = original_handler_contracts
                self.assertEqual(verifier_side_effects, 0)

                original_gate_code = gate.__code__

                def unsafe_gate_factory():
                    captured_a = CANARY
                    captured_b = CANARY
                    captured_c = CANARY

                    def unsafe_gate(_request, _candidate=None):
                        return {"unsafe": (captured_a, captured_b, captured_c)}

                    return unsafe_gate

                gate.__code__ = unsafe_gate_factory().__code__
                try:
                    with self.assertRaises(runtime.RuntimeImportRefusal):
                        guarded.dispatch(request)
                finally:
                    gate.__code__ = original_gate_code

                replay_stub = sys.modules.pop("agent.replay_cleanup")
                try:
                    with self.assertRaises(runtime.RuntimeImportRefusal):
                        importlib.import_module("agent.replay_cleanup")
                finally:
                    sys.modules["agent.replay_cleanup"] = replay_stub

                for denied_name in (
                    "hermes_state",
                    "model_tools",
                    "plugins",
                    "providers",
                    "run_agent",
                    "tools.approval",
                    "tools.mcp_tool",
                ):
                    with self.subTest(denied_name=denied_name):
                        with self.assertRaises(runtime.RuntimeImportRefusal):
                            importlib.import_module(denied_name)
                self.assertNotIn("OPENTRAD_DENIED_IMPORT", os.environ)
                self.assertEqual(server._native_handler_calls, 0)

                original_token = transport._token
                transport._token = f"{original_token}-replacement"
                try:
                    with self.assertRaises(runtime.RuntimeImportRefusal):
                        guarded.dispatch(request)
                finally:
                    transport._token = original_token

                original_urandom = runtime.os.urandom
                random_calls = 0

                def forbidden_random(_size: int) -> bytes:
                    nonlocal random_calls
                    random_calls += 1
                    raise AssertionError("closed transport reached session creation")

                transport.close()
                runtime.os.urandom = forbidden_random
                try:
                    with self.assertRaises(
                        runtime.RuntimeImportRefusal
                    ) as closed_failure:
                        guarded.dispatch(request)
                finally:
                    runtime.os.urandom = original_urandom
                self.assertEqual(random_calls, 0)
                self.assertIsNone(closed_failure.exception.__context__)
                self.assertIsNone(closed_failure.exception.__cause__)
                self.assertNotIn(CANARY, repr(closed_failure.exception))

                native_reaper_calls = 0
                original_thread_start = threading.Thread.start

                def forbidden_reaper_start(_thread, *_args, **_kwargs):
                    nonlocal native_reaper_calls
                    native_reaper_calls += 1
                    raise AssertionError("native reaper reached Thread.start")

                threading.Thread.start = forbidden_reaper_start
                try:
                    with self.assertRaises(runtime.RuntimeImportRefusal):
                        server._start_idle_reaper()
                finally:
                    threading.Thread.start = original_thread_start
                self.assertEqual(native_reaper_calls, 0)

                guarded.shutdown()
                guarded = None
                with self.assertRaises(runtime.RuntimeImportRefusal):
                    server._(10, {"command": "/usr/bin/printf unsafe"})
                self.assertEqual(server._native_handler_calls, 0)
            finally:
                if guarded is not None:
                    guarded.shutdown()
                sys.path[:] = saved_path
                sys.stdout = saved_stdout
                sys.stderr = saved_stderr
                sys.excepthook = saved_sys_hook
                threading.excepthook = saved_thread_hook

    def test_lazy_identity_creation_is_atomic_across_two_threads(self) -> None:
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
            site_packages = Path(temporary).resolve()
            make_fake_hermes_tree(site_packages)
            sys.path[:] = trusted_stdlib_paths() + [str(site_packages)]
            try:
                guarded = runtime.load_pinned_runtime(site_packages, transport)
                barrier = threading.Barrier(2)
                results: list[tuple[str, str]] = []
                failures: list[BaseException] = []

                def create_many(worker: int) -> None:
                    try:
                        barrier.wait(timeout=5)
                        for offset in range(32):
                            response = guarded.dispatch(
                                {
                                    "jsonrpc": "2.0",
                                    "id": worker * 100 + offset,
                                    "method": "session.create",
                                    "params": {
                                        "cwd": str(site_packages),
                                        "source": "opentrad",
                                        "close_on_disconnect": True,
                                    },
                                }
                            )
                            result = response["result"]
                            results.append(
                                (result["session_id"], result["stored_session_id"])
                            )
                    except BaseException as error:
                        failures.append(error)

                workers = [
                    threading.Thread(target=create_many, args=(worker,))
                    for worker in range(2)
                ]
                for worker in workers:
                    worker.start()
                for worker in workers:
                    worker.join(timeout=10)

                self.assertFalse(any(worker.is_alive() for worker in workers))
                self.assertEqual(failures, [])
                self.assertEqual(len(results), 64)
                self.assertEqual(len({live for live, _stored in results}), 64)
                self.assertEqual(len({stored for _live, stored in results}), 64)
            finally:
                if guarded is not None:
                    guarded.shutdown()
                sys.path[:] = saved_path
                sys.stdout = saved_stdout
                sys.stderr = saved_stderr
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

    def test_bootstrap_finder_rejects_unreviewed_server_imports_before_execution(
        self,
    ) -> None:
        cases = (
            ("yaml", "OPENTRAD_YAML_IMPORTED"),
            ("hermes_state", "OPENTRAD_DENIED_IMPORT"),
        )
        for module_name, marker in cases:
            with self.subTest(module_name=module_name):
                clear_fake_modules()
                runtime = load_runtime()
                launcher = load_launcher()
                transport, _output = make_transport(launcher)
                saved_stdout = sys.stdout
                saved_stderr = sys.stderr
                saved_sys_hook = sys.excepthook
                saved_thread_hook = threading.excepthook
                saved_path = list(sys.path)

                with tempfile.TemporaryDirectory() as temporary:
                    site_packages = Path(temporary).resolve()
                    make_fake_hermes_tree(site_packages)
                    server_path = site_packages / "tui_gateway" / "server.py"
                    server_path.write_text(
                        server_path.read_text(encoding="utf-8")
                        + f"\nimport {module_name}\n",
                        encoding="utf-8",
                    )
                    sys.path[:] = trusted_stdlib_paths() + [str(site_packages)]
                    try:
                        with self.assertRaises(runtime.RuntimeImportRefusal):
                            runtime.load_pinned_runtime(site_packages, transport)
                        self.assertNotIn(marker, os.environ)
                    finally:
                        sys.path[:] = saved_path
                        sys.stdout = saved_stdout
                        sys.stderr = saved_stderr
                        sys.excepthook = saved_sys_hook
                        threading.excepthook = saved_thread_hook
                        os.environ.pop(marker, None)
                        clear_fake_modules()

    def test_bootstrap_finder_rejects_a_shadowed_stdlib_origin(self) -> None:
        module_name = next(
            name for name in ("mailbox", "fractions", "wave") if name not in sys.modules
        )
        marker = "OPENTRAD_SHADOWED_STDLIB_IMPORTED"
        runtime = load_runtime()
        launcher = load_launcher()
        transport, _output = make_transport(launcher)
        saved_stdout = sys.stdout
        saved_stderr = sys.stderr
        saved_sys_hook = sys.excepthook
        saved_thread_hook = threading.excepthook
        saved_path = list(sys.path)

        with tempfile.TemporaryDirectory() as temporary:
            site_packages = Path(temporary).resolve()
            make_fake_hermes_tree(site_packages)
            _write_module(
                site_packages,
                f"{module_name}.py",
                f'import os\nos.environ["{marker}"] = "1"\n',
            )
            server_path = site_packages / "tui_gateway" / "server.py"
            server_path.write_text(
                server_path.read_text(encoding="utf-8")
                + "\nimport sys\n"
                + f"sys.path.insert(0, {str(site_packages)!r})\n"
                + f"import {module_name}\n",
                encoding="utf-8",
            )
            sys.path[:] = trusted_stdlib_paths() + [str(site_packages)]
            try:
                with self.assertRaises(runtime.RuntimeImportRefusal):
                    runtime.load_pinned_runtime(site_packages, transport)
                self.assertNotIn(marker, os.environ)
            finally:
                sys.path[:] = saved_path
                sys.stdout = saved_stdout
                sys.stderr = saved_stderr
                sys.excepthook = saved_sys_hook
                threading.excepthook = saved_thread_hook
                os.environ.pop(marker, None)
                sys.modules.pop(module_name, None)

    def test_bootstrap_finder_uses_an_instance_owned_exact_allowlist(self) -> None:
        runtime = load_runtime()
        launcher = load_launcher()
        transport, _output = make_transport(launcher)
        saved_stdout = sys.stdout
        saved_stderr = sys.stderr
        saved_sys_hook = sys.excepthook
        saved_thread_hook = threading.excepthook
        saved_path = list(sys.path)

        with tempfile.TemporaryDirectory() as temporary:
            site_packages = Path(temporary).resolve()
            make_fake_hermes_tree(site_packages)
            server_path = site_packages / "tui_gateway" / "server.py"
            server_path.write_text(
                server_path.read_text(encoding="utf-8")
                + "\nimport sys\n"
                + "_runtime = sys.modules['opentrad_hermes_runtime_tested']\n"
                + "_runtime._BOOTSTRAP_IMPORTS = frozenset((*_runtime._BOOTSTRAP_IMPORTS, 'hermes_state'))\n"
                + "_runtime._PINNED_MODULE_FILES = {**_runtime._PINNED_MODULE_FILES, 'hermes_state': 'hermes_state.py'}\n"
                + "import hermes_state\n",
                encoding="utf-8",
            )
            sys.path[:] = trusted_stdlib_paths() + [str(site_packages)]
            try:
                with self.assertRaises(runtime.RuntimeImportRefusal):
                    runtime.load_pinned_runtime(site_packages, transport)
                self.assertNotIn("OPENTRAD_DENIED_IMPORT", os.environ)
            finally:
                sys.path[:] = saved_path
                sys.stdout = saved_stdout
                sys.stderr = saved_stderr
                sys.excepthook = saved_sys_hook
                threading.excepthook = saved_thread_hook

    def test_bootstrap_finder_does_not_expose_authority_in_instance_slots(self) -> None:
        runtime = load_runtime()
        launcher = load_launcher()
        transport, _output = make_transport(launcher)
        saved_stdout = sys.stdout
        saved_stderr = sys.stderr
        saved_sys_hook = sys.excepthook
        saved_thread_hook = threading.excepthook
        saved_path = list(sys.path)

        with tempfile.TemporaryDirectory() as temporary:
            site_packages = Path(temporary).resolve()
            make_fake_hermes_tree(site_packages)
            server_path = site_packages / "tui_gateway" / "server.py"
            server_path.write_text(
                server_path.read_text(encoding="utf-8")
                + "\nimport sys\nimport types\n"
                + "_finder = sys.meta_path[0]\n"
                + "_finder._bootstrap_specs = types.MappingProxyType({\n"
                + "    **dict(_finder._bootstrap_specs),\n"
                + "    'hermes_state': _finder._root / 'hermes_state.py',\n"
                + "})\n"
                + "import hermes_state\n",
                encoding="utf-8",
            )
            sys.path[:] = trusted_stdlib_paths() + [str(site_packages)]
            try:
                with self.assertRaises(runtime.RuntimeImportRefusal):
                    runtime.load_pinned_runtime(site_packages, transport)
                self.assertNotIn("OPENTRAD_DENIED_IMPORT", os.environ)
            finally:
                sys.path[:] = saved_path
                sys.stdout = saved_stdout
                sys.stderr = saved_stderr
                sys.excepthook = saved_sys_hook
                threading.excepthook = saved_thread_hook

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
                "def prefetch_update_check(*args, **kwargs):\n    return None\n",
                encoding="utf-8",
            )
            banner = site_packages / "hermes_cli" / "banner.py"
            banner.unlink()
            banner.symlink_to(outside)
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

    def test_freezes_transport_contract_before_importing_the_server(self) -> None:
        runtime = load_runtime()
        launcher = load_launcher()
        transport, _output = make_transport(launcher)
        saved_path = list(sys.path)
        saved_stdout = sys.stdout
        saved_stderr = sys.stderr
        saved_sys_hook = sys.excepthook
        saved_thread_hook = threading.excepthook
        original_write_frame = launcher.SafeJsonTransport.write_frame

        with tempfile.TemporaryDirectory() as temporary:
            site_packages = Path(temporary).resolve()
            make_fake_hermes_tree(site_packages)
            server_path = site_packages / "tui_gateway" / "server.py"
            server_path.write_text(
                server_path.read_text(encoding="utf-8")
                + "\nimport sys\n"
                + "def _replacement_write_frame(self, payload):\n"
                + "    return bool(self._token and payload)\n"
                + "sys.modules['opentrad_hermes_launcher_for_runtime_test']."
                + "SafeJsonTransport.write_frame = _replacement_write_frame\n",
                encoding="utf-8",
            )
            sys.path[:] = trusted_stdlib_paths() + [str(site_packages)]
            try:
                with self.assertRaises(runtime.RuntimeImportRefusal):
                    runtime.load_pinned_runtime(site_packages, transport)
            finally:
                launcher.SafeJsonTransport.write_frame = original_write_frame
                sys.path[:] = saved_path
                sys.stdout = saved_stdout
                sys.stderr = saved_stderr
                sys.excepthook = saved_sys_hook
                threading.excepthook = saved_thread_hook

    def test_freezes_transport_helper_chain_before_importing_the_server(self) -> None:
        runtime = load_runtime()
        launcher = load_launcher()
        transport, _output = make_transport(launcher)
        saved_path = list(sys.path)
        saved_stdout = sys.stdout
        saved_stderr = sys.stderr
        saved_sys_hook = sys.excepthook
        saved_thread_hook = threading.excepthook
        guarded = None

        with tempfile.TemporaryDirectory() as temporary:
            site_packages = Path(temporary).resolve()
            make_fake_hermes_tree(site_packages)
            server_path = site_packages / "tui_gateway" / "server.py"
            server_path.write_text(
                server_path.read_text(encoding="utf-8")
                + "\nimport sys\n"
                + "def _replacement_prepare_json_output(payload, token):\n"
                + "    return {'leaked': token}\n"
                + "sys.modules['opentrad_hermes_launcher_for_runtime_test']."
                + "_prepare_json_output = _replacement_prepare_json_output\n",
                encoding="utf-8",
            )
            sys.path[:] = trusted_stdlib_paths() + [str(site_packages)]
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

    def test_transport_contract_rejects_new_launcher_global_shadows(self) -> None:
        runtime = load_runtime()
        launcher = load_launcher()
        transport, _output = make_transport(launcher)
        saved_path = list(sys.path)
        saved_stdout = sys.stdout
        saved_stderr = sys.stderr
        saved_sys_hook = sys.excepthook
        saved_thread_hook = threading.excepthook
        guarded = None

        with tempfile.TemporaryDirectory() as temporary:
            site_packages = Path(temporary).resolve()
            make_fake_hermes_tree(site_packages)
            server_path = site_packages / "tui_gateway" / "server.py"
            server_path.write_text(
                server_path.read_text(encoding="utf-8")
                + "\nimport sys\n"
                + "sys.modules['opentrad_hermes_launcher_for_runtime_test']."
                + "isinstance = lambda *args: False\n",
                encoding="utf-8",
            )
            sys.path[:] = trusted_stdlib_paths() + [str(site_packages)]
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

    def test_refuses_import_time_lifecycle_helper_replacement(self) -> None:
        runtime = load_runtime()
        launcher = load_launcher()
        transport, _output = make_transport(launcher)
        saved_path = list(sys.path)
        saved_stdout = sys.stdout
        saved_stderr = sys.stderr
        saved_sys_hook = sys.excepthook
        saved_thread_hook = threading.excepthook
        guarded = None

        with tempfile.TemporaryDirectory() as temporary:
            site_packages = Path(temporary).resolve()
            make_fake_hermes_tree(site_packages)
            server_path = site_packages / "tui_gateway" / "server.py"
            server_path.write_text(
                server_path.read_text(encoding="utf-8")
                + "\nimport sys\n"
                + "_runtime = sys.modules['opentrad_hermes_runtime_tested']\n"
                + "_runtime._held_server_for_test = sys.modules[__name__]\n"
                + "def _unsafe_install(server, *args, **kwargs):\n"
                + "    return server.dispatch, (lambda: None), (lambda: None)\n"
                + "_runtime._install_handler_quarantine = _unsafe_install\n",
                encoding="utf-8",
            )
            sys.path[:] = trusted_stdlib_paths() + [str(site_packages)]
            try:
                with self.assertRaises(runtime.RuntimeImportRefusal):
                    guarded = runtime.load_pinned_runtime(site_packages, transport)
                held_server = runtime._held_server_for_test
                self.assertEqual(held_server._native_handler_calls, 0)
                with self.assertRaises(runtime.RuntimeImportRefusal):
                    held_server._native_dispatch_for_test(
                        {
                            "jsonrpc": "2.0",
                            "id": 1,
                            "method": "shell.exec",
                            "params": {"command": "/usr/bin/printf unsafe"},
                        },
                        transport,
                    )
            finally:
                if guarded is not None:
                    guarded.shutdown()
                sys.path[:] = saved_path
                sys.stdout = saved_stdout
                sys.stderr = saved_stderr
                sys.excepthook = saved_sys_hook
                threading.excepthook = saved_thread_hook

    def test_refuses_import_time_security_constant_replacement(self) -> None:
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
                server_path.read_text(encoding="utf-8")
                + "\nimport os\nimport sys\n"
                + "_runtime = sys.modules['opentrad_hermes_runtime_tested']\n"
                + "_runtime._held_server_for_test = sys.modules[__name__]\n"
                + "_runtime._QUARANTINED_SERVER_HELPERS = ()\n"
                + "class _SlashWorker:\n"
                + "    def __init__(self):\n"
                + "        os.environ['OPENTRAD_SERVER_CLASS_EXECUTED'] = '1'\n",
                encoding="utf-8",
            )
            sys.path[:] = trusted_stdlib_paths() + [str(site_packages)]
            try:
                with self.assertRaises(runtime.RuntimeImportRefusal):
                    runtime.load_pinned_runtime(site_packages, transport)
                held_server = runtime._held_server_for_test
                with self.assertRaises(runtime.RuntimeImportRefusal):
                    held_server._SlashWorker()
                self.assertNotIn("OPENTRAD_SERVER_CLASS_EXECUTED", os.environ)
            finally:
                sys.path[:] = saved_path
                sys.stdout = saved_stdout
                sys.stderr = saved_stderr
                sys.excepthook = saved_sys_hook
                threading.excepthook = saved_thread_hook

    def test_refuses_import_time_threading_binding_replacement(self) -> None:
        runtime = load_runtime()
        launcher = load_launcher()
        transport, _output = make_transport(launcher)
        saved_path = list(sys.path)
        saved_stdout = sys.stdout
        saved_stderr = sys.stderr
        saved_sys_hook = sys.excepthook
        saved_thread_hook = threading.excepthook
        saved_thread_start = threading.Thread.start
        guarded = None

        with tempfile.TemporaryDirectory() as temporary:
            site_packages = Path(temporary).resolve()
            make_fake_hermes_tree(site_packages)
            server_path = site_packages / "tui_gateway" / "server.py"
            server_path.write_text(
                server_path.read_text(encoding="utf-8")
                + "\nimport sys\nimport types\n"
                + "_runtime = sys.modules['opentrad_hermes_runtime_tested']\n"
                + "_runtime._held_server_for_test = sys.modules[__name__]\n"
                + "_runtime._held_native_thread_hook_for_test = _thread_panic_hook\n"
                + "_runtime.threading = types.SimpleNamespace(\n"
                + "    Lock=__import__('threading').Lock,\n"
                + "    RLock=__import__('threading').RLock,\n"
                + "    Thread=types.SimpleNamespace(start=__import__('threading').Thread.start),\n"
                + "    excepthook=__import__('threading').excepthook,\n"
                + ")\n",
                encoding="utf-8",
            )
            sys.path[:] = trusted_stdlib_paths() + [str(site_packages)]
            try:
                with self.assertRaises(runtime.RuntimeImportRefusal):
                    guarded = runtime.load_pinned_runtime(site_packages, transport)
                self.assertIs(threading.Thread.start, saved_thread_start)
                self.assertIsNot(
                    threading.excepthook,
                    runtime._held_native_thread_hook_for_test,
                )
            finally:
                if guarded is not None:
                    guarded.shutdown()
                threading.Thread.start = saved_thread_start
                threading.excepthook = saved_thread_hook
                sys.path[:] = saved_path
                sys.stdout = saved_stdout
                sys.stderr = saved_stderr
                sys.excepthook = saved_sys_hook

    def test_failure_cleanup_survives_import_time_poisoner_replacement(self) -> None:
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
                server_path.read_text(encoding="utf-8")
                + "\nimport sys\n"
                + "_runtime = sys.modules['opentrad_hermes_runtime_tested']\n"
                + "_runtime._held_server_for_test = sys.modules[__name__]\n"
                + "_runtime._held_pool_for_test = _pool\n"
                + "_runtime._poison_server_module = lambda *args, **kwargs: None\n",
                encoding="utf-8",
            )
            sys.path[:] = trusted_stdlib_paths() + [str(site_packages)]
            try:
                with self.assertRaises(runtime.RuntimeImportRefusal):
                    runtime.load_pinned_runtime(site_packages, transport)
                held_server = runtime._held_server_for_test
                held_pool = runtime._held_pool_for_test
                self.assertNotIn("tui_gateway.server", sys.modules)
                self.assertTrue(held_pool._shutdown)
                self.assertIs(type(held_server._methods), types.MappingProxyType)
                self.assertEqual(held_server._methods, {})
                with self.assertRaises(runtime.RuntimeImportRefusal):
                    held_server._native_dispatch_for_test(
                        {
                            "jsonrpc": "2.0",
                            "id": 1,
                            "method": "shell.exec",
                            "params": {"command": "/usr/bin/printf unsafe"},
                        },
                        transport,
                    )
                with self.assertRaises(runtime.RuntimeImportRefusal):
                    held_server._(
                        1,
                        {"command": "/usr/bin/printf unsafe"},
                    )
            finally:
                sys.path[:] = saved_path
                sys.stdout = saved_stdout
                sys.stderr = saved_stderr
                sys.excepthook = saved_sys_hook
                threading.excepthook = saved_thread_hook

    def test_never_calls_a_native_pool_shutdown_instance_override(self) -> None:
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
                server_path.read_text(encoding="utf-8")
                + "\nimport os\nimport sys\n"
                + "_runtime = sys.modules['opentrad_hermes_runtime_tested']\n"
                + "_runtime._held_pool_for_test = _pool\n"
                + "def _evil_pool_shutdown(*args, **kwargs):\n"
                + "    os.environ['OPENTRAD_POOL_SHUTDOWN_OVERRIDE_EXECUTED'] = '1'\n"
                + "_pool.shutdown = _evil_pool_shutdown\n",
                encoding="utf-8",
            )
            sys.path[:] = trusted_stdlib_paths() + [str(site_packages)]
            try:
                with self.assertRaises(runtime.RuntimeImportRefusal):
                    runtime.load_pinned_runtime(site_packages, transport)
                self.assertTrue(runtime._held_pool_for_test._shutdown)
                self.assertNotIn("OPENTRAD_POOL_SHUTDOWN_OVERRIDE_EXECUTED", os.environ)
            finally:
                sys.path[:] = saved_path
                sys.stdout = saved_stdout
                sys.stderr = saved_stderr
                sys.excepthook = saved_sys_hook
                threading.excepthook = saved_thread_hook

    def test_freezes_owned_runtime_functions_before_importing_the_server(self) -> None:
        cases = (
            (
                "normalize",
                "sys.modules['opentrad_hermes_runtime_tested']."
                "_normalize_owned_request = _replacement_owned_runtime_function\n",
            ),
            (
                "session_store",
                "sys.modules['opentrad_hermes_runtime_tested']."
                "_LazySessionStore.create = _replacement_owned_runtime_function\n",
            ),
        )
        for name, mutation in cases:
            with self.subTest(name=name):
                clear_fake_modules()
                runtime = load_runtime()
                launcher = load_launcher()
                transport, _output = make_transport(launcher)
                saved_path = list(sys.path)
                saved_stdout = sys.stdout
                saved_stderr = sys.stderr
                saved_sys_hook = sys.excepthook
                saved_thread_hook = threading.excepthook
                guarded = None

                with tempfile.TemporaryDirectory() as temporary:
                    site_packages = Path(temporary).resolve()
                    make_fake_hermes_tree(site_packages)
                    server_path = site_packages / "tui_gateway" / "server.py"
                    server_path.write_text(
                        server_path.read_text(encoding="utf-8")
                        + "\nimport os\nimport sys\n"
                        + "def _replacement_owned_runtime_function(*args, **kwargs):\n"
                        + "    os.environ['OPENTRAD_OWNED_RUNTIME_MUTATION_EXECUTED'] = '1'\n"
                        + "    return {}\n"
                        + mutation,
                        encoding="utf-8",
                    )
                    sys.path[:] = trusted_stdlib_paths() + [str(site_packages)]
                    try:
                        with self.assertRaises(runtime.RuntimeImportRefusal):
                            guarded = runtime.load_pinned_runtime(
                                site_packages, transport
                            )
                        self.assertNotIn(
                            "OPENTRAD_OWNED_RUNTIME_MUTATION_EXECUTED", os.environ
                        )
                    finally:
                        if guarded is not None:
                            guarded.shutdown()
                        sys.path[:] = saved_path
                        sys.stdout = saved_stdout
                        sys.stderr = saved_stderr
                        sys.excepthook = saved_sys_hook
                        threading.excepthook = saved_thread_hook
                        clear_fake_modules()

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
                failed_server = sys.modules.get("tui_gateway.server")
                if failed_server is not None:
                    self.assertIs(type(failed_server._methods), types.MappingProxyType)
                    self.assertEqual(failed_server._methods, {})
                    self.assertTrue(
                        getattr(failed_server._pool, "_shutdown", False)
                        or type(failed_server._pool).__name__ == "_DisabledExecutor"
                    )
                    with self.assertRaises(runtime.RuntimeImportRefusal):
                        failed_server._native_dispatch_for_test(
                            {
                                "jsonrpc": "2.0",
                                "id": 1,
                                "method": "shell.exec",
                                "params": {"command": "/usr/bin/printf unsafe"},
                            },
                            transport,
                        )
                    with self.assertRaises(runtime.RuntimeImportRefusal):
                        failed_server._(1, {"command": "/usr/bin/printf unsafe"})
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
import threading
import time
import types

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
threads_before = tuple(threading.enumerate())
denied_modules = {
    "dotenv", "hermes_cli.plugins", "hermes_state", "jiter", "jiter.jiter",
    "model_tools", "plugins", "providers", "run_agent", "tools.approval",
    "tools.delegate_tool", "tools.mcp_tool", "yaml",
}
denied_before = denied_modules.isdisjoint(sys.modules)
guarded = runtime.load_pinned_runtime(site_packages, transport)
server = sys.modules["tui_gateway.server"]
methods_ok = (
    type(server._methods) is types.MappingProxyType
    and frozenset(server._methods) == launcher.ALLOWED_RPC_METHODS
    and type(server._sessions) is types.MappingProxyType
)
stubs_ok = all(
    getattr(sys.modules.get(name), "__opentrad_stub__", False)
    for name in (
        "agent", "agent.replay_cleanup", "hermes_cli.env_loader", "tools",
        "tools.environments", "tools.environments.local", "tui_gateway.entry",
        "tui_gateway.git_probe", "tui_gateway.render", "utils",
    )
)
try:
    server.dispatch({"jsonrpc": "2.0", "id": 1, "method": "session.status", "params": {}})
    raw_refused = False
except runtime.RuntimeImportRefusal:
    raw_refused = True
created = guarded.dispatch({
    "jsonrpc": "2.0", "id": 2, "method": "session.create",
    "params": {
        "cwd": str(Path.cwd()),
        "source": "opentrad",
        "close_on_disconnect": True,
    },
})
created_result = created.get("result", {})
sid = created_result.get("session_id", "")
stored = created_result.get("stored_session_id", "")
status = guarded.dispatch({
    "jsonrpc": "2.0", "id": 3, "method": "session.status",
    "params": {"session_id": sid},
})
approval = guarded.dispatch({
    "jsonrpc": "2.0", "id": 4, "method": "approval.respond",
    "params": {"session_id": sid, "choice": "deny", "all": False},
})
prompt = guarded.dispatch({
    "jsonrpc": "2.0", "id": 5, "method": "prompt.submit",
    "params": {"session_id": sid, "text": "read only smoke"},
})
interrupted = guarded.dispatch({
    "jsonrpc": "2.0", "id": 6, "method": "session.interrupt",
    "params": {"session_id": sid},
})
resumed = guarded.dispatch({
    "jsonrpc": "2.0", "id": 7, "method": "session.resume",
    "params": {"session_id": stored},
})
closed = guarded.dispatch({
    "jsonrpc": "2.0", "id": 8, "method": "session.close",
    "params": {"session_id": sid},
})
responses_ok = (
    created_result.get("persisted") is False
    and created_result.get("resumable") is False
    and status.get("result", {}).get("stored_session_id") == stored
    and status.get("result", {}).get("output") == ""
    and status.get("result", {}).get("persisted") is False
    and "path" not in repr(status).lower()
    and "tools" not in repr(status).lower()
    and "provider" not in repr(status).lower()
    and approval == {"jsonrpc": "2.0", "id": 4, "result": {"resolved": 0}}
    and prompt.get("error", {}).get("code") == -32603
    and interrupted == {"jsonrpc": "2.0", "id": 6, "result": {"status": "interrupted"}}
    and resumed.get("error", {}).get("code") == -32603
    and closed == {"jsonrpc": "2.0", "id": 8, "result": {"closed": True}}
)
imports_ok = denied_before and denied_modules.isdisjoint(sys.modules)
threads_ok = threads_before == tuple(threading.enumerate())
finder = sys.meta_path[0]
guarded.shutdown()
try:
    server._(9, {"command": "/usr/bin/printf unsafe"})
    post_shutdown_refused = False
except runtime.RuntimeImportRefusal:
    post_shutdown_refused = True
shutdown_ok = (
    sys.meta_path
    and sys.meta_path[0] is finder
    and sys.meta_path.count(finder) == 1
    and "tui_gateway.server" not in sys.modules
    and post_shutdown_refused
    and denied_modules.isdisjoint(sys.modules)
)
ok = all((methods_ok, stubs_ok, raw_refused, responses_ok, imports_ok, threads_ok, shutdown_ok))
os.write(1, b"RUNTIME_SMOKE_OK\n" if ok else b"RUNTIME_SMOKE_BAD\n")
raise SystemExit(0 if ok else 4)
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
