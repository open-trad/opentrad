#!/usr/bin/env python3
"""Contract tests for the OpenTrad-owned Hermes launcher pre-import boundary."""

from __future__ import annotations

import ast
import io
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest import mock


LAUNCHER = (
    Path(__file__).resolve().parents[1]
    / "resources"
    / "hermes"
    / "opentrad_hermes_launcher.py"
)
CANARY = "canary-secret-never-print-0123456789"


def load_launcher() -> types.ModuleType:
    spec = importlib.util.spec_from_file_location("opentrad_hermes_launcher", LAUNCHER)
    if spec is None or spec.loader is None:
        raise AssertionError("launcher module could not be loaded")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def valid_capability(**overrides: object) -> bytes:
    payload: dict[str, object] = {
        "v": 1,
        "expiresAt": int(time.time()) + 30,
        "token": CANARY,
        "model": "openai/gpt-5.2",
        "apiMode": "chat_completions",
        "brokerPort": 43117,
    }
    payload.update(overrides)
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")


def find_supported_test_python() -> str | None:
    override = os.environ.get("OPENTRAD_TEST_PYTHON")
    candidates = [override] if override else [
        shutil.which("python3.13"),
        shutil.which("python3.12"),
        shutil.which("python3.11"),
    ]
    for candidate in candidates:
        if not candidate:
            continue
        result = subprocess.run(
            [candidate, "-I", "-S", "-c", "import sys; print(sys.version_info[:2])"],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode == 0 and result.stdout.strip() in {
            "(3, 11)",
            "(3, 12)",
            "(3, 13)",
        }:
            return candidate
    return None


def rpc_line(
    method: str,
    *,
    request_id: object = 1,
    params: dict[str, object] | None = None,
) -> bytes:
    return (
        json.dumps(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": {} if params is None else params,
            },
            separators=(",", ":"),
        ).encode("utf-8")
        + b"\n"
    )


class CapabilityParsingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.launcher = load_launcher()

    def assert_refused(self, raw: bytes, *, now: int | None = None) -> None:
        with self.assertRaises(self.launcher.LauncherRefusal) as caught:
            self.launcher.parse_capability(raw, now=now or int(time.time()))
        rendered = " ".join((str(caught.exception), repr(caught.exception)))
        self.assertNotIn(CANARY, rendered)

    def test_accepts_the_closed_capability_schema(self) -> None:
        now = int(time.time())
        capability = self.launcher.parse_capability(valid_capability(expiresAt=now + 30), now=now)

        self.assertEqual(capability.model, "openai/gpt-5.2")
        self.assertEqual(capability.api_mode, "chat_completions")
        self.assertEqual(capability.broker_port, 43117)
        self.assertEqual(capability.expires_at, now + 30)
        self.assertEqual(capability.token, CANARY)
        self.assertEqual(capability.broker_url, "http://127.0.0.1:43117/v1")
        self.assertNotIn(CANARY, repr(capability))

    def test_accepts_only_the_two_broker_protocol_modes(self) -> None:
        now = int(time.time())
        for mode in ("chat_completions", "codex_responses"):
            with self.subTest(mode=mode):
                capability = self.launcher.parse_capability(
                    valid_capability(apiMode=mode, expiresAt=now + 30),
                    now=now,
                )
                self.assertEqual(capability.api_mode, mode)

    def test_rejects_duplicate_keys(self) -> None:
        now = int(time.time())
        raw = (
            '{"v":1,"expiresAt":%d,"token":"%s","token":"%s",'
            '"model":"gpt-5.2","apiMode":"chat_completions","brokerPort":43117}'
            % (now + 30, CANARY, CANARY)
        ).encode()
        self.assert_refused(raw, now=now)

    def test_rejects_unknown_and_missing_fields(self) -> None:
        now = int(time.time())
        self.assert_refused(valid_capability(extra="not-allowed", expiresAt=now + 30), now=now)
        payload = json.loads(valid_capability(expiresAt=now + 30))
        del payload["model"]
        self.assert_refused(json.dumps(payload).encode(), now=now)

    def test_requires_integer_version_one(self) -> None:
        now = int(time.time())
        for version in (0, 2, True, "1"):
            with self.subTest(version=version):
                self.assert_refused(valid_capability(v=version, expiresAt=now + 30), now=now)

    def test_rejects_expired_or_long_lived_capabilities(self) -> None:
        now = int(time.time())
        for expiry in (now, now - 1, now + 301, True, float(now + 30)):
            with self.subTest(expiry=expiry):
                self.assert_refused(valid_capability(expiresAt=expiry), now=now)

    def test_rejects_invalid_ports(self) -> None:
        now = int(time.time())
        for port in (0, 65536, -1, True, "43117"):
            with self.subTest(port=port):
                self.assert_refused(
                    valid_capability(brokerPort=port, expiresAt=now + 30),
                    now=now,
                )

    def test_rejects_invalid_tokens_without_rendering_them(self) -> None:
        now = int(time.time())
        for token in (
            "",
            "a" * 31,
            "a" * 513,
            f" {CANARY}",
            f"{CANARY}\n",
            f"{CANARY}.dot",
            f"{CANARY}/slash",
            f"{CANARY}=padding",
            1234,
            "雪" * 32,
        ):
            with self.subTest(token_type=type(token).__name__):
                self.assert_refused(valid_capability(token=token, expiresAt=now + 30), now=now)

    def test_rejects_invalid_models(self) -> None:
        now = int(time.time())
        for model in ("", "bad model", "/starts-with-slash", "a" * 129, 1234):
            with self.subTest(model=model):
                self.assert_refused(valid_capability(model=model, expiresAt=now + 30), now=now)

    def test_rejects_invalid_api_modes(self) -> None:
        now = int(time.time())
        for api_mode in ("", "anthropic_messages", "CHAT_COMPLETIONS", 1234):
            with self.subTest(api_mode=api_mode):
                self.assert_refused(
                    valid_capability(apiMode=api_mode, expiresAt=now + 30),
                    now=now,
                )

    def test_rejects_malformed_or_non_utf8_input_without_echoing_it(self) -> None:
        self.assert_refused(b"\xff\xfe" + CANARY.encode())
        self.assert_refused(b"{" + CANARY.encode())


class CapabilityFdTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.launcher = load_launcher()

    def test_reads_to_eof_then_closes_and_makes_fd_non_inheritable(self) -> None:
        read_fd, write_fd = os.pipe()
        os.set_inheritable(read_fd, True)
        os.write(write_fd, valid_capability())
        os.close(write_fd)

        capability = self.launcher.read_capability_fd(read_fd, timeout_seconds=0.2)

        self.assertEqual(capability.token, CANARY)
        with self.assertRaises(OSError):
            os.fstat(read_fd)

    def test_rejects_a_missing_fd(self) -> None:
        read_fd, write_fd = os.pipe()
        os.close(read_fd)
        os.close(write_fd)
        with self.assertRaises(self.launcher.LauncherRefusal):
            self.launcher.read_capability_fd(read_fd, timeout_seconds=0.02)

    def test_rejects_more_than_4096_bytes(self) -> None:
        read_fd, write_fd = os.pipe()
        os.write(write_fd, b"x" * 4097)
        os.close(write_fd)
        with self.assertRaises(self.launcher.LauncherRefusal):
            self.launcher.read_capability_fd(read_fd, timeout_seconds=0.2)

    def test_rejects_a_writer_that_does_not_send_eof(self) -> None:
        read_fd, write_fd = os.pipe()
        os.write(write_fd, valid_capability())
        started = time.monotonic()
        try:
            with self.assertRaises(self.launcher.LauncherRefusal):
                self.launcher.read_capability_fd(read_fd, timeout_seconds=0.03)
        finally:
            os.close(write_fd)
        self.assertLess(time.monotonic() - started, 0.5)

    def test_fd_errors_never_render_the_capability_token(self) -> None:
        read_fd, write_fd = os.pipe()
        os.write(write_fd, valid_capability() + b"x" * 4097)
        os.close(write_fd)
        with self.assertRaises(self.launcher.LauncherRefusal) as caught:
            self.launcher.read_capability_fd(read_fd, timeout_seconds=0.2)
        self.assertNotIn(CANARY, str(caught.exception))
        self.assertNotIn(CANARY, repr(caught.exception))


class EnvironmentAndDiagnosticsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.launcher = load_launcher()

    def test_private_environment_redirects_home_and_tmp_and_scrubs_inherited_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root).resolve()
            hermes_home = root / "hermes"
            hermes_home.mkdir(mode=0o700)
            environment = {
                "PATH": "/usr/bin:/bin",
                "LANG": "en_US.UTF-8",
                "HTTP_PROXY": "http://attacker.invalid",
                "https_proxy": "http://attacker.invalid",
                "NO_PROXY": "*",
                "OPENAI_API_KEY": CANARY,
                "ANTHROPIC_AUTH_TOKEN": CANARY,
                "SSL_CERT_FILE": "/tmp/attacker.pem",
                "REQUESTS_CA_BUNDLE": "/tmp/attacker.pem",
                "PYTHONPATH": "/tmp/attacker",
                "PYTHONSTARTUP": "/tmp/attacker.py",
                "DYLD_INSERT_LIBRARIES": "/tmp/attacker.dylib",
                "HERMES_CONFIG": "/tmp/attacker.yaml",
                "HERMES_TUI_TOOLSETS": "all",
                "HERMES_SAFE_MODE": "0",
            }
            original_umask = os.umask(0o022)
            try:
                directories = self.launcher.prepare_private_environment(
                    hermes_home,
                    environment,
                )
                current_umask = os.umask(original_umask)
            finally:
                os.umask(original_umask)

            self.assertEqual(current_umask, 0o077)
            self.assertNotIn("PATH", environment)
            self.assertEqual(environment["LANG"], "en_US.UTF-8")
            self.assertEqual(environment["HERMES_HOME"], str(hermes_home))
            self.assertEqual(environment["HOME"], str(directories.home))
            self.assertEqual(environment["TMPDIR"], str(directories.tmp))
            self.assertEqual(environment["HERMES_SAFE_MODE"], "1")
            self.assertEqual(environment["HERMES_IGNORE_USER_CONFIG"], "1")
            self.assertEqual(environment["HERMES_IGNORE_RULES"], "1")
            for forbidden in (
                "HTTP_PROXY",
                "https_proxy",
                "NO_PROXY",
                "OPENAI_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "SSL_CERT_FILE",
                "REQUESTS_CA_BUNDLE",
                "PYTHONPATH",
                "PYTHONSTARTUP",
                "DYLD_INSERT_LIBRARIES",
                "HERMES_CONFIG",
                "HERMES_TUI_TOOLSETS",
            ):
                self.assertNotIn(forbidden, environment)
            self.assertEqual(directories.home.stat().st_mode & 0o777, 0o700)
            self.assertEqual(directories.tmp.stat().st_mode & 0o777, 0o700)

    def test_diagnostics_disable_core_dumps_and_faulthandler_in_a_child(self) -> None:
        module_path = json.dumps(str(LAUNCHER))
        code = f"""
import faulthandler, importlib.util, json, resource, sys
spec = importlib.util.spec_from_file_location('launcher_diagnostics_child', {module_path})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
faulthandler.enable()
module.disable_process_diagnostics()
print(json.dumps({{'core': resource.getrlimit(resource.RLIMIT_CORE), 'fault': faulthandler.is_enabled()}}))
"""
        result = subprocess.run(
            [sys.executable, "-I", "-S", "-B", "-u", "-X", "utf8", "-c", code],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        observed = json.loads(result.stdout)
        self.assertEqual(observed["core"], [0, 0])
        self.assertFalse(observed["fault"])

    def test_private_directory_resolution_runtime_error_is_generic(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root).resolve()
            hermes_home = root / "hermes"
            hermes_home.mkdir(mode=0o700)
            original_umask = os.umask(0o022)
            try:
                with mock.patch.object(
                    Path,
                    "resolve",
                    side_effect=[hermes_home, RuntimeError(CANARY)],
                ):
                    with self.assertRaises(self.launcher.LauncherRefusal) as caught:
                        self.launcher.prepare_private_environment(hermes_home, {})
            finally:
                os.umask(original_umask)

            self.assertNotIn(CANARY, str(caught.exception))


class PathAndRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.launcher = load_launcher()

    def make_paths(self, root: Path) -> tuple[Path, Path, Path]:
        launcher = root / "launcher.py"
        launcher.write_text("# launcher\n", encoding="utf-8")
        launcher.chmod(0o600)
        hermes_home = root / "hermes"
        hermes_home.mkdir(mode=0o700)
        cwd = hermes_home / "gateway-cwd"
        cwd.mkdir(mode=0o700)
        return launcher, hermes_home, cwd

    def test_accepts_canonical_private_launcher_home_and_gateway_cwd(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root).resolve()
            launcher, hermes_home, cwd = self.make_paths(root)
            paths = self.launcher.validate_bootstrap_paths(launcher, hermes_home, cwd)
            self.assertEqual(paths.launcher, launcher)
            self.assertEqual(paths.hermes_home, hermes_home)
            self.assertEqual(paths.cwd, cwd)

    def test_rejects_relative_symlink_or_writable_launcher_paths(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root).resolve()
            launcher, hermes_home, cwd = self.make_paths(root)
            with self.assertRaises(self.launcher.LauncherRefusal):
                self.launcher.validate_bootstrap_paths(Path("launcher.py"), hermes_home, cwd)
            link = root / "launcher-link.py"
            link.symlink_to(launcher)
            with self.assertRaises(self.launcher.LauncherRefusal):
                self.launcher.validate_bootstrap_paths(link, hermes_home, cwd)
            launcher.chmod(0o622)
            with self.assertRaises(self.launcher.LauncherRefusal):
                self.launcher.validate_bootstrap_paths(launcher, hermes_home, cwd)

    def test_symlink_loops_are_generic_launcher_refusals(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root).resolve()
            _, hermes_home, cwd = self.make_paths(root)
            loop = root / f"loop-{CANARY}"
            loop.symlink_to(loop)

            with self.assertRaises(self.launcher.LauncherRefusal) as caught:
                self.launcher.validate_bootstrap_paths(loop, hermes_home, cwd)

            self.assertNotIn(CANARY, str(caught.exception))

    def test_runtime_error_from_path_resolution_is_generic(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root).resolve()
            launcher, hermes_home, cwd = self.make_paths(root)
            with mock.patch.object(Path, "resolve", side_effect=RuntimeError(CANARY)):
                with self.assertRaises(self.launcher.LauncherRefusal) as caught:
                    self.launcher.validate_bootstrap_paths(launcher, hermes_home, cwd)

            self.assertNotIn(CANARY, str(caught.exception))

    def test_rejects_noncanonical_or_nonprivate_home_and_wrong_cwd(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root).resolve()
            launcher, hermes_home, cwd = self.make_paths(root)
            outside = root / "outside"
            outside.mkdir(mode=0o700)
            with self.assertRaises(self.launcher.LauncherRefusal):
                self.launcher.validate_bootstrap_paths(launcher, hermes_home, outside)
            home_link = root / "home-link"
            home_link.symlink_to(hermes_home, target_is_directory=True)
            with self.assertRaises(self.launcher.LauncherRefusal):
                self.launcher.validate_bootstrap_paths(launcher, home_link, cwd)
            hermes_home.chmod(0o755)
            with self.assertRaises(self.launcher.LauncherRefusal):
                self.launcher.validate_bootstrap_paths(launcher, hermes_home, cwd)

    def test_infers_posix_and_windows_venv_site_packages_without_importing_site(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root).resolve()
            posix_python = root / "posix" / "bin" / "python3"
            posix_python.parent.mkdir(parents=True)
            posix_python.write_bytes(b"")
            posix_site = root / "posix" / "lib" / "python3.14" / "site-packages"
            posix_site.mkdir(parents=True)
            windows_python = root / "windows" / "Scripts" / "python.exe"
            windows_python.parent.mkdir(parents=True)
            windows_python.write_bytes(b"")
            windows_site = root / "windows" / "Lib" / "site-packages"
            windows_site.mkdir(parents=True)

            self.assertEqual(
                self.launcher.infer_site_packages(posix_python, (3, 14), platform="posix"),
                posix_site,
            )
            self.assertEqual(
                self.launcher.infer_site_packages(windows_python, (3, 14), platform="nt"),
                windows_site,
            )

            marker = root / "pth-ran"
            (posix_site / "attacker.pth").write_text(
                f"import pathlib; pathlib.Path({str(marker)!r}).write_text('bad')\n",
                encoding="utf-8",
            )
            sys_path: list[str] = []
            self.launcher.activate_site_packages(posix_site, sys_path)
            self.assertEqual(sys_path, [str(posix_site)])
            self.assertFalse(marker.exists())

    def test_rejects_site_packages_outside_the_interpreter_venv(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root).resolve()
            python = root / "venv" / "python3"
            python.parent.mkdir()
            python.write_bytes(b"")
            with self.assertRaises(self.launcher.LauncherRefusal):
                self.launcher.infer_site_packages(python, (3, 14), platform="posix")

    def test_site_packages_symlink_loops_are_generic_refusals(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root).resolve()
            python = root / "venv" / "bin" / "python3"
            python.parent.mkdir(parents=True)
            python.write_bytes(b"")
            site_packages = root / "venv" / "lib" / "python3.13" / "site-packages"
            site_packages.parent.mkdir(parents=True)
            site_packages.symlink_to(site_packages, target_is_directory=True)

            with self.assertRaises(self.launcher.LauncherRefusal) as caught:
                self.launcher.infer_site_packages(python, (3, 13), platform="posix")

            self.assertNotIn(CANARY, str(caught.exception))


class InterpreterContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.launcher = load_launcher()

    def test_accepts_only_python_versions_supported_by_pinned_hermes(self) -> None:
        for major, minor in ((3, 11), (3, 12), (3, 13)):
            with self.subTest(major=major, minor=minor):
                self.assertTrue(
                    self.launcher.is_supported_hermes_python_version(major, minor)
                )

        for major, minor in ((3, 10), (3, 14), (4, 0), (True, 11), (3, "13")):
            with self.subTest(major=major, minor=minor):
                self.assertFalse(
                    self.launcher.is_supported_hermes_python_version(major, minor)
                )

    def test_current_unsupported_interpreter_is_rejected_before_bootstrap(self) -> None:
        if self.launcher.is_supported_hermes_python_version(
            sys.version_info.major,
            sys.version_info.minor,
        ):
            self.skipTest("test host already uses a pinned-Hermes-compatible Python")

        with self.assertRaises(self.launcher.LauncherRefusal) as caught:
            self.launcher.verify_interpreter_contract()

        self.assertEqual(caught.exception.code, "interpreter_version")


class AuditPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.launcher = load_launcher()

    def make_policy(self, root: Path):
        home = root / "hermes"
        home.mkdir(mode=0o700)
        cwd = home / "gateway-cwd"
        cwd.mkdir(mode=0o700)
        return self.launcher.AuditPolicy(home, cwd, broker_port=43117), home, cwd

    def test_allows_only_the_exact_ipv4_loopback_broker_endpoint(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            policy, _, _ = self.make_policy(Path(raw_root).resolve())
            policy("socket.__new__", (None, socket.AF_INET, socket.SOCK_STREAM, 0))
            policy("socket.connect", (None, ("127.0.0.1", 43117)))
            policy("socket.getaddrinfo", ("127.0.0.1", 43117, 0, 0, 0))
            for address in (
                ("localhost", 43117),
                ("127.0.0.1", 43118),
                ("::1", 43117),
                ("8.8.8.8", 443),
                "/tmp/broker.sock",
            ):
                with self.subTest(address=address):
                    with self.assertRaises(self.launcher.LauncherRefusal):
                        policy("socket.connect", (None, address))

    def test_rejects_non_ipv4_stream_socket_creation(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            policy, _, _ = self.make_policy(Path(raw_root).resolve())
            for family, kind, protocol in (
                (socket.AF_INET6, socket.SOCK_STREAM, 0),
                (socket.AF_UNIX, socket.SOCK_STREAM, 0),
                (socket.AF_INET, socket.SOCK_DGRAM, 0),
                (socket.AF_INET, socket.SOCK_RAW, 0),
                (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_UDP),
            ):
                with self.subTest(family=family, kind=kind, protocol=protocol):
                    with self.assertRaises(self.launcher.LauncherRefusal):
                        policy("socket.__new__", (None, family, kind, protocol))

    def test_blocks_all_alternate_dns_resolution_events(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            policy, _, _ = self.make_policy(Path(raw_root).resolve())
            for event, args in (
                ("socket.gethostbyname", ("attacker.invalid",)),
                ("socket.gethostbyaddr", ("8.8.8.8",)),
                ("socket.getnameinfo", (("8.8.8.8", 53), 0)),
                ("socket.gethostname", ()),
                ("socket.getservbyname", ("domain", "udp")),
                ("socket.sendmsg", (None, [b"payload"], [], 0, ("8.8.8.8", 53))),
                ("socket.sethostname", ("attacker",)),
            ):
                with self.subTest(event=event):
                    with self.assertRaises(self.launcher.LauncherRefusal):
                        policy(event, args)

    def test_blocks_process_creation_and_dynamic_library_loading(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            policy, _, _ = self.make_policy(Path(raw_root).resolve())
            for event in (
                "subprocess.Popen",
                "os.system",
                "os.posix_spawn",
                "pty.spawn",
                "ctypes.dlopen",
            ):
                with self.subTest(event=event):
                    with self.assertRaises(self.launcher.LauncherRefusal):
                        policy(event, (CANARY,))

    def test_blocks_bind_listen_and_all_datagram_sends(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            policy, _, _ = self.make_policy(Path(raw_root).resolve())
            for event, args in (
                ("socket.bind", (None, ("127.0.0.1", 43117))),
                ("socket.listen", (None,)),
                ("socket.sendto", (None, ("127.0.0.1", 43117))),
                ("socket.sendto", (None, b"payload", ("8.8.8.8", 53))),
            ):
                with self.subTest(event=event, args=args):
                    with self.assertRaises(self.launcher.LauncherRefusal):
                        policy(event, args)

    def test_blocks_writes_outside_hermes_home_without_rendering_the_path(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root).resolve()
            policy, home, _ = self.make_policy(root)
            policy("open", (str(home / "state.db"), "w", 0))
            policy("open", (str(root / "outside.txt"), "r", 0))
            with self.assertRaises(self.launcher.LauncherRefusal):
                policy("open", (str(root / "outside-os-open.txt"), None, os.O_CREAT | os.O_WRONLY))
            with self.assertRaises(self.launcher.LauncherRefusal) as caught:
                policy("open", (str(root / CANARY), "w", 0))
            self.assertNotIn(CANARY, str(caught.exception))

    def test_rejects_all_relative_writes_and_unverifiable_fd_writes(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root).resolve()
            policy, _, _ = self.make_policy(root)
            for event, args in (
                ("open", ("relative-open", None, os.O_CREAT | os.O_WRONLY)),
                ("os.rename", ("relative-source", "relative-destination", -1, -1)),
                ("os.remove", ("relative-remove", -1)),
                ("open", (9, "w", 0)),
            ):
                with self.subTest(event=event):
                    with self.assertRaises(self.launcher.LauncherRefusal):
                        policy(event, args)

            policy("open", (9, "r", 0))

    def test_symlink_loop_write_paths_are_generic_refusals(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root).resolve()
            policy, _, _ = self.make_policy(root)
            loop = root / f"audit-loop-{CANARY}"
            loop.symlink_to(loop)

            with self.assertRaises(self.launcher.LauncherRefusal) as caught:
                policy("open", (str(loop / "target"), "w", 0))

            self.assertNotIn(CANARY, str(caught.exception))

    def test_runtime_error_from_audit_path_resolution_is_generic(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root).resolve()
            policy, home, _ = self.make_policy(root)
            with mock.patch.object(Path, "resolve", side_effect=RuntimeError(CANARY)):
                with self.assertRaises(self.launcher.LauncherRefusal) as caught:
                    policy("open", (str(home / "state.db"), "w", 0))

            self.assertNotIn(CANARY, str(caught.exception))

    def test_checks_common_path_mutations_and_blocks_fd_truncate(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root).resolve()
            policy, home, _ = self.make_policy(root)
            for event, args in (
                ("os.truncate", (str(root / "outside"), 0)),
                ("os.setxattr", (str(root / "outside"), "user.key", b"value", 0)),
                ("os.removexattr", (str(root / "outside"), "user.key")),
                ("os.mknod", (str(root / "outside"), 0o600, 0)),
                ("os.mkfifo", (str(root / "outside"), 0o600)),
                ("os.ftruncate", (9, 0)),
            ):
                with self.subTest(event=event):
                    with self.assertRaises(self.launcher.LauncherRefusal):
                        policy(event, args)

            policy("os.truncate", (str(home / "state.db"), 0))
            policy("os.setxattr", (str(home / "state.db"), "user.key", b"value", 0))

    def test_rejects_permission_environment_process_signal_and_subinterpreter_controls(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root).resolve()
            policy, home, _ = self.make_policy(root)
            for event, args in (
                ("os.chmod", (str(home), 0o777, -1)),
                ("os.chown", (str(home), os.getuid(), os.getgid(), -1)),
                ("os.fchmod", (9, 0o777)),
                ("os.fchown", (9, os.getuid(), os.getgid())),
                ("os.putenv", (b"HERMES_SAFE_MODE", b"0")),
                ("os.unsetenv", (b"HERMES_IGNORE_RULES",)),
                ("os.fork", ()),
                ("os.forkpty", ()),
                ("os.kill", (os.getpid(), 0)),
                ("os.killpg", (os.getpgrp(), 0)),
            ):
                with self.subTest(event=event):
                    with self.assertRaises(self.launcher.LauncherRefusal):
                        policy(event, args)

    def test_real_hook_preserves_permissions_and_python_and_c_environments(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root).resolve()
            home = root / "hermes"
            home.mkdir(mode=0o700)
            cwd = home / "gateway-cwd"
            cwd.mkdir(mode=0o700)
            state = home / "state.db"
            state.write_text("state", encoding="utf-8")
            state.chmod(0o600)
            code = f"""
import ctypes, importlib.util, json, os, pathlib, stat, sys
spec = importlib.util.spec_from_file_location('launcher_controls_child', {str(LAUNCHER)!r})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
home = pathlib.Path({str(home)!r})
cwd = pathlib.Path({str(cwd)!r})
state = pathlib.Path({str(state)!r})
state_fd = os.open(state, os.O_RDWR)
libc = ctypes.CDLL(None)
c_getenv = libc.getenv
c_getenv.argtypes = [ctypes.c_char_p]
c_getenv.restype = ctypes.c_char_p
os.environ['HERMES_SAFE_MODE'] = '1'
os.environ['HERMES_IGNORE_USER_CONFIG'] = '1'
os.environ['HERMES_IGNORE_RULES'] = '1'
os.environ.pop('OPENAI_API_KEY', None)
os.unsetenv('OPENAI_API_KEY')
policy = module.AuditPolicy(home, cwd, broker_port=43117)
sys.addaudithook(policy)
outcomes = {{}}
def attempt(name, operation):
    try:
        operation()
    except module.LauncherRefusal as error:
        outcomes[name] = str(error)
    except BaseException as error:
        outcomes[name] = type(error).__name__
    else:
        outcomes[name] = 'allowed'
attempt('chmod', lambda: os.chmod(home, 0o777))
attempt('chown', lambda: os.chown(state, os.getuid(), os.getgid()))
attempt('fchmod', lambda: os.fchmod(state_fd, 0o666))
attempt('fchown', lambda: os.fchown(state_fd, os.getuid(), os.getgid()))
attempt('mapping_set', lambda: os.environ.__setitem__('HERMES_SAFE_MODE', '0'))
attempt('putenv', lambda: os.putenv('OPENAI_API_KEY', {CANARY!r}))
attempt('mapping_delete', lambda: os.environ.__delitem__('HERMES_IGNORE_RULES'))
attempt('unsetenv', lambda: os.unsetenv('HERMES_IGNORE_USER_CONFIG'))
def c_value(name):
    value = c_getenv(name.encode('ascii'))
    return None if value is None else value.decode('ascii')
observed = {{
    'outcomes': outcomes,
    'homeMode': stat.S_IMODE(os.stat(home).st_mode),
    'stateMode': stat.S_IMODE(os.stat(state).st_mode),
    'mappingSafe': os.environ.get('HERMES_SAFE_MODE'),
    'cSafe': c_value('HERMES_SAFE_MODE'),
    'mappingIgnoreConfig': os.environ.get('HERMES_IGNORE_USER_CONFIG'),
    'cIgnoreConfig': c_value('HERMES_IGNORE_USER_CONFIG'),
    'mappingIgnoreRules': os.environ.get('HERMES_IGNORE_RULES'),
    'cIgnoreRules': c_value('HERMES_IGNORE_RULES'),
    'mappingApiAbsent': 'OPENAI_API_KEY' not in os.environ,
    'cApiAbsent': c_value('OPENAI_API_KEY') is None,
}}
print(json.dumps(observed, sort_keys=True))
os.close(state_fd)
"""
            result = subprocess.run(
                [sys.executable, "-I", "-S", "-B", "-u", "-X", "utf8", "-c", code],
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            observed = json.loads(result.stdout)
            self.assertEqual(
                set(observed["outcomes"].values()),
                {"OpenTrad Hermes launcher refused startup"},
            )
            self.assertEqual(observed["homeMode"], 0o700)
            self.assertEqual(observed["stateMode"], 0o600)
            self.assertEqual(observed["mappingSafe"], "1")
            self.assertEqual(observed["cSafe"], "1")
            self.assertEqual(observed["mappingIgnoreConfig"], "1")
            self.assertEqual(observed["cIgnoreConfig"], "1")
            self.assertEqual(observed["mappingIgnoreRules"], "1")
            self.assertEqual(observed["cIgnoreRules"], "1")
            self.assertTrue(observed["mappingApiAbsent"])
            self.assertTrue(observed["cApiAbsent"])
            self.assertNotIn(CANARY, result.stdout)
            self.assertNotIn(CANARY, result.stderr)

    def test_real_hook_blocks_fork_side_effect_and_zero_signal_operations(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root).resolve()
            home = root / "hermes"
            home.mkdir(mode=0o700)
            cwd = home / "gateway-cwd"
            cwd.mkdir(mode=0o700)
            marker = root / "fork-child-side-effect"
            marker.write_bytes(b"")
            code = f"""
import importlib.util, json, os, pathlib, sys
spec = importlib.util.spec_from_file_location('launcher_process_child', {str(LAUNCHER)!r})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
home = pathlib.Path({str(home)!r})
cwd = pathlib.Path({str(cwd)!r})
marker_fd = os.open({str(marker)!r}, os.O_WRONLY | os.O_TRUNC)
policy = module.AuditPolicy(home, cwd, broker_port=43117)
sys.addaudithook(policy)
outcomes = {{}}
try:
    child_pid = os.fork()
except module.LauncherRefusal as error:
    outcomes['fork'] = str(error)
else:
    if child_pid == 0:
        os.write(marker_fd, b'child-ran')
        os._exit(0)
    os.waitpid(child_pid, 0)
    outcomes['fork'] = 'allowed'
def attempt(name, operation):
    try:
        operation()
    except module.LauncherRefusal as error:
        outcomes[name] = str(error)
    except BaseException as error:
        outcomes[name] = type(error).__name__
    else:
        outcomes[name] = 'allowed'
attempt('kill', lambda: os.kill(os.getpid(), 0))
attempt('killpg', lambda: os.killpg(os.getpgrp(), 0))
print(json.dumps(outcomes, sort_keys=True))
os.close(marker_fd)
"""
            result = subprocess.run(
                [sys.executable, "-I", "-S", "-B", "-u", "-X", "utf8", "-c", code],
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            outcomes = json.loads(result.stdout)
            self.assertEqual(
                set(outcomes.values()),
                {"OpenTrad Hermes launcher refused startup"},
            )
            self.assertEqual(marker.read_bytes(), b"")

    def test_real_subinterpreter_creation_is_blocked_when_supported(self) -> None:
        python = find_supported_test_python()
        if python is None:
            self.skipTest("no Python 3.11-3.13 interpreter available")
        availability = subprocess.run(
            [
                python,
                "-I",
                "-S",
                "-c",
                "import importlib.util; raise SystemExit(0 if importlib.util.find_spec('_xxsubinterpreters') else 1)",
            ],
            check=False,
        )
        if availability.returncode != 0:
            self.skipTest("_xxsubinterpreters is unavailable on the supported interpreter")

        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root).resolve()
            home = root / "hermes"
            home.mkdir(mode=0o700)
            cwd = home / "gateway-cwd"
            cwd.mkdir(mode=0o700)
            marker = root / "subinterpreter-side-effect"
            code = f"""
import _xxsubinterpreters as subinterpreters
import importlib.util, json, pathlib, sys
spec = importlib.util.spec_from_file_location('launcher_subinterpreter_child', {str(LAUNCHER)!r})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
home = pathlib.Path({str(home)!r})
cwd = home / 'gateway-cwd'
policy = module.AuditPolicy(home, cwd, broker_port=43117)
sys.addaudithook(policy)
try:
    interpreter = subinterpreters.create()
except module.LauncherRefusal as error:
    outcome = str(error)
else:
    subinterpreters.run_string(interpreter, "import pathlib; pathlib.Path({str(marker)!r}).write_text('created', encoding='utf-8')")
    subinterpreters.destroy(interpreter)
    outcome = 'allowed'
print(json.dumps({{'outcome': outcome}}))
"""
            result = subprocess.run(
                [python, "-I", "-S", "-B", "-u", "-X", "utf8", "-c", code],
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
            )

            self.assertEqual(result.returncode, 78, result.stderr)
            self.assertEqual(result.stdout, "")
            self.assertEqual(result.stderr, "OpenTrad Hermes launcher refused startup\n")
            self.assertFalse(marker.exists())

    def test_real_audit_hook_blocks_openat_renameat_and_unlinkat_without_side_effects(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root).resolve()
            home = root / "hermes"
            home.mkdir(mode=0o700)
            cwd = home / "gateway-cwd"
            cwd.mkdir(mode=0o700)
            outside = root / "outside"
            outside.mkdir(mode=0o700)
            rename_source = home / "rename-source"
            rename_source.write_text("source", encoding="utf-8")
            open_target = outside / "dirfd-open-canary"
            rename_target = outside / "dirfd-rename-canary"
            unlink_target = outside / "dirfd-unlink-canary"
            unlink_target.write_text("keep", encoding="utf-8")
            code = f"""
import importlib.util, json, os, pathlib, sys
spec = importlib.util.spec_from_file_location('launcher_audit_child', {str(LAUNCHER)!r})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
home = pathlib.Path({str(home)!r})
cwd = pathlib.Path({str(cwd)!r})
outside = pathlib.Path({str(outside)!r})
home_fd = os.open(home, os.O_RDONLY | os.O_DIRECTORY)
outside_fd = os.open(outside, os.O_RDONLY | os.O_DIRECTORY)
policy = module.AuditPolicy(home, cwd, broker_port=43117)
sys.addaudithook(policy)
outcomes = {{}}
def attempt(name, operation):
    try:
        operation()
    except module.LauncherRefusal as error:
        outcomes[name] = str(error)
    else:
        outcomes[name] = 'allowed'
attempt('openat', lambda: os.open('dirfd-open-canary', os.O_CREAT | os.O_WRONLY, 0o600, dir_fd=outside_fd))
attempt('renameat', lambda: os.rename('rename-source', 'dirfd-rename-canary', src_dir_fd=home_fd, dst_dir_fd=outside_fd))
attempt('unlinkat', lambda: os.unlink('dirfd-unlink-canary', dir_fd=outside_fd))
print(json.dumps(outcomes, sort_keys=True))
os.close(home_fd)
os.close(outside_fd)
"""

            result = subprocess.run(
                [sys.executable, "-I", "-S", "-B", "-u", "-X", "utf8", "-c", code],
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            outcomes = json.loads(result.stdout)
            self.assertEqual(
                set(outcomes.values()),
                {"OpenTrad Hermes launcher refused startup"},
            )
            self.assertNotIn("dirfd", result.stdout)
            self.assertNotIn("dirfd", result.stderr)
            self.assertFalse(open_target.exists())
            self.assertFalse(rename_target.exists())
            self.assertTrue(rename_source.exists())
            self.assertEqual(unlink_target.read_text(encoding="utf-8"), "keep")


class SafeJsonTransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.launcher = load_launcher()

    def capability(self):
        now = int(time.time())
        return self.launcher.parse_capability(
            valid_capability(expiresAt=now + 30),
            now=now,
        )

    def test_compacts_redacts_and_canonicalizes_error_responses(self) -> None:
        output = io.BytesIO()
        capability = self.capability()
        transport = self.launcher.SafeJsonTransport(output, capability)

        written = transport.write_frame(
            {
                "jsonrpc": "2.0",
                "id": f"prefix-{CANARY}-suffix",
                "error": {
                    "code": -32603,
                    "message": f"server exploded with {CANARY}",
                    "data": {"secret": CANARY},
                },
                "nested": [f"value-{CANARY}"],
            }
        )

        self.assertTrue(written)
        wire = output.getvalue()
        self.assertTrue(wire.endswith(b"\n"))
        self.assertNotIn(CANARY.encode(), wire)
        self.assertNotIn(b"server exploded", wire)
        self.assertNotIn(b'": ', wire)
        self.assertNotIn(b", ", wire)
        decoded = json.loads(wire)
        self.assertEqual(decoded["id"], "prefix-<redacted>-suffix")
        self.assertEqual(
            decoded["error"],
            {"code": -32603, "message": "Internal error"},
        )
        self.assertEqual(decoded["nested"], ["value-<redacted>"])
        self.assertNotIn(CANARY, repr(capability))
        self.assertNotIn(CANARY, repr(transport))

    def test_preserves_safe_application_error_codes_with_fixed_messages(self) -> None:
        output = io.BytesIO()
        transport = self.launcher.SafeJsonTransport(output, self.capability())

        self.assertTrue(
            transport.write(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "error": {"code": 5032, "message": f"private {CANARY}"},
                }
            )
        )
        self.assertTrue(
            transport.write(
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "error": {"code": -32602, "message": f"private {CANARY}"},
                }
            )
        )
        self.assertTrue(
            transport.write(
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "error": {
                        "code": self.launcher.MAX_SAFE_JSON_INTEGER + 1,
                        "message": f"private {CANARY}",
                    },
                }
            )
        )

        frames = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(frames[0]["error"], {"code": 5032, "message": "Server error"})
        self.assertEqual(
            frames[1]["error"],
            {"code": -32602, "message": "Invalid params"},
        )
        self.assertEqual(
            frames[2]["error"],
            {"code": -32603, "message": "Internal error"},
        )
        self.assertNotIn(CANARY.encode(), output.getvalue())

    def test_returns_false_for_oversize_unserializable_and_write_failures(self) -> None:
        capability = self.capability()
        oversized_output = io.BytesIO()
        oversized = self.launcher.SafeJsonTransport(oversized_output, capability)
        self.assertFalse(
            oversized.write_frame(
                {"payload": "x" * self.launcher.MAX_NDJSON_FRAME_BYTES}
            )
        )
        self.assertEqual(oversized_output.getvalue(), b"")

        cyclic: dict[str, object] = {}
        cyclic["self"] = cyclic
        self.assertFalse(oversized.write_frame(cyclic))
        self.assertEqual(oversized_output.getvalue(), b"")

        class FailingBinaryOutput:
            def write(self, _data: bytes) -> int:
                raise OSError(CANARY)

            def flush(self) -> None:
                raise AssertionError("flush must not follow a failed write")

        failing = self.launcher.SafeJsonTransport(FailingBinaryOutput(), capability)
        self.assertFalse(failing.write_frame({"ok": True}))

    def test_concurrent_writers_never_interleave_frames(self) -> None:
        class SlowPartialBinaryOutput:
            def __init__(self) -> None:
                self.data = bytearray()

            def write(self, data: bytes) -> int:
                chunk = bytes(data[:3])
                time.sleep(0)
                self.data.extend(chunk)
                return len(chunk)

            def flush(self) -> None:
                time.sleep(0)

        output = SlowPartialBinaryOutput()
        transport = self.launcher.SafeJsonTransport(output, self.capability())
        outcomes: list[bool] = []
        outcomes_lock = threading.Lock()

        def write(index: int) -> None:
            result = transport.write_frame(
                {"jsonrpc": "2.0", "id": index, "result": {"value": index}}
            )
            with outcomes_lock:
                outcomes.append(result)

        threads = [threading.Thread(target=write, args=(index,)) for index in range(24)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=2)

        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(outcomes, [True] * 24)
        frames = bytes(output.data).splitlines()
        self.assertEqual(len(frames), 24)
        observed = {json.loads(frame)["id"] for frame in frames}
        self.assertEqual(observed, set(range(24)))

    def test_capture_stdout_uses_the_binary_buffer(self) -> None:
        binary = io.BytesIO()

        class TextStdout:
            buffer = binary

        with mock.patch.object(self.launcher.sys, "stdout", TextStdout()):
            transport = self.launcher.SafeJsonTransport.capture_stdout(self.capability())
            self.assertTrue(transport.write_frame({"captured": True}))

        self.assertEqual(json.loads(binary.getvalue()), {"captured": True})

    def test_official_write_and_idempotent_logical_close_are_thread_safe(self) -> None:
        output = io.BytesIO()
        transport = self.launcher.SafeJsonTransport(output, self.capability())

        self.assertTrue(transport.write({"before": True}))
        before_close = output.getvalue()
        transport.close()
        transport.close()

        self.assertFalse(transport.write({"after": True}))
        self.assertFalse(transport.write_frame({"afterFrame": True}))
        self.assertEqual(output.getvalue(), before_close)
        self.assertFalse(output.closed)


class NdjsonLoopTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.launcher = load_launcher()

    def capability(self):
        now = int(time.time())
        return self.launcher.parse_capability(
            valid_capability(expiresAt=now + 30),
            now=now,
        )

    def run_loop(
        self,
        input_bytes: bytes,
        dispatcher,
        *,
        output=None,
        shutdown=None,
    ):
        binary_output = io.BytesIO() if output is None else output
        transport = self.launcher.SafeJsonTransport(binary_output, self.capability())
        shutdown_calls: list[str] = []

        def default_shutdown() -> None:
            shutdown_calls.append("shutdown")

        result = self.launcher.run_ndjson_loop(
            io.BytesIO(input_bytes),
            transport,
            dispatcher,
            default_shutdown if shutdown is None else shutdown,
        )
        frames = [json.loads(line) for line in binary_output.getvalue().splitlines()]
        return result, frames, shutdown_calls

    def test_uses_bounded_binary_readline_skips_blanks_and_shuts_down_once_at_eof(self) -> None:
        class RecordingInput(io.BytesIO):
            def __init__(self, initial: bytes) -> None:
                super().__init__(initial)
                self.sizes: list[int] = []

            def readline(self, size: int = -1) -> bytes:
                self.sizes.append(size)
                return super().readline(size)

        input_stream = RecordingInput(
            b"\n  \r\n"
            + rpc_line("session.create", request_id=7, params={"cwd": "/workspace"})
        )
        output = io.BytesIO()
        transport = self.launcher.SafeJsonTransport(output, self.capability())
        calls: list[dict[str, object]] = []
        shutdown_calls: list[str] = []

        def dispatcher(request: dict[str, object]):
            calls.append(request)
            return {
                "jsonrpc": "2.0",
                "id": request["id"],
                "result": {"created": True},
            }

        result = self.launcher.run_ndjson_loop(
            input_stream,
            transport,
            dispatcher,
            lambda: shutdown_calls.append("shutdown"),
        )

        self.assertTrue(result)
        self.assertEqual(
            input_stream.sizes,
            [self.launcher.MAX_NDJSON_FRAME_BYTES + 1] * 4,
        )
        self.assertEqual(
            calls,
            [
                {
                    "jsonrpc": "2.0",
                    "id": 7,
                    "method": "session.create",
                    "params": {"cwd": "/workspace"},
                }
            ],
        )
        self.assertEqual(shutdown_calls, ["shutdown"])
        frames = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(
            frames[0],
            {
                "jsonrpc": "2.0",
                "method": "event",
                "params": {"type": "gateway.ready", "payload": {"skin": {}}},
            },
        )
        self.assertEqual(
            frames[1],
            {"jsonrpc": "2.0", "id": 7, "result": {"created": True}},
        )

    def test_whitelist_is_exact_and_unknown_methods_never_reach_dispatcher(self) -> None:
        expected = {
            "session.create",
            "session.resume",
            "session.status",
            "session.close",
            "session.interrupt",
            "prompt.submit",
            "approval.respond",
        }
        self.assertEqual(set(self.launcher.ALLOWED_RPC_METHODS), expected)
        calls: list[dict[str, object]] = []

        def dispatcher(request: dict[str, object]):
            calls.append(request)
            return {"jsonrpc": "2.0", "id": request["id"], "result": None}

        result, frames, shutdown_calls = self.run_loop(
            rpc_line("terminal.execute", request_id="unknown")
            + rpc_line("session.status", request_id="known"),
            dispatcher,
        )

        self.assertTrue(result)
        self.assertEqual(
            calls,
            [
                {
                    "jsonrpc": "2.0",
                    "id": "known",
                    "method": "session.status",
                    "params": {},
                }
            ],
        )
        self.assertEqual(shutdown_calls, ["shutdown"])
        self.assertEqual(frames[1]["id"], "unknown")
        self.assertEqual(
            frames[1]["error"],
            {"code": -32601, "message": "Method not found"},
        )
        self.assertEqual(frames[2], {"jsonrpc": "2.0", "id": "known", "result": None})

        crafted = self.launcher.RpcRequest(
            request_id=9,
            method="terminal.execute",
            params={},
        )
        direct = self.launcher.dispatch_rpc_request(crafted, dispatcher)
        self.assertEqual(
            direct["error"],
            {"code": -32601, "message": "Method not found"},
        )
        self.assertEqual(len(calls), 1)

        original = self.launcher.RpcRequest(
            request_id=10,
            method="session.status",
            params={"nested": {"value": 1}},
        )

        def mutating_dispatcher(request: dict[str, object]):
            request["method"] = "terminal.execute"
            request_params = request["params"]
            assert isinstance(request_params, dict)
            nested = request_params["nested"]
            assert isinstance(nested, dict)
            nested["value"] = 2
            return {"jsonrpc": "2.0", "id": request["id"], "result": {}}

        self.launcher.dispatch_rpc_request(original, mutating_dispatcher)
        self.assertEqual(original.method, "session.status")
        self.assertEqual(original.params, {"nested": {"value": 1}})

    def test_parse_duplicate_and_invalid_requests_use_fixed_errors(self) -> None:
        duplicate = (
            b'{"jsonrpc":"2.0","id":1,"id":2,'
            b'"method":"session.status","params":{}}\n'
        )
        invalid_requests = [
            b"[]\n",
            b'{"jsonrpc":"1.0","id":1,"method":"session.status","params":{}}\n',
            rpc_line("session.status", request_id=True),
            rpc_line("session.status", request_id=9_007_199_254_740_992),
            rpc_line("session.status", request_id="x" * 129),
            b'{"jsonrpc":"2.0","id":1,"method":"","params":{}}\n',
            b'{"jsonrpc":"2.0","id":1,"method":"session.status","params":[]}\n',
        ]
        calls: list[str] = []
        result, frames, _ = self.run_loop(
            b"\xff\n" + b"{not-json}\n" + duplicate + b"".join(invalid_requests),
            lambda request: calls.append(str(request["method"])),
        )

        self.assertTrue(result)
        self.assertEqual(calls, [])
        errors = [frame["error"] for frame in frames[1:]]
        self.assertEqual(
            errors[:3],
            [{"code": -32700, "message": "Parse error"}] * 3,
        )
        self.assertEqual(
            errors[3:],
            [{"code": -32600, "message": "Invalid Request"}] * len(invalid_requests),
        )
        self.assertTrue(all(frame["id"] is None for frame in frames[1:]))

    def test_rejects_unsafe_and_nonfinite_json_numbers_without_crashing(self) -> None:
        huge_integer = b"9" * 5_000
        requests = (
            b'{"jsonrpc":"2.0","id":1,"method":"session.status","params":{"n":'
            + huge_integer
            + b"}}\n"
            + b'{"jsonrpc":"2.0","id":2,"method":"session.status","params":{"n":9007199254740992}}\n'
            + b'{"jsonrpc":"2.0","id":3,"method":"session.status","params":{"n":1e309}}\n'
            + b'{"jsonrpc":"2.0","id":4,"method":"session.status","params":{"n":9007199254740992.0}}\n'
            + b'{"jsonrpc":"2.0","id":5,"method":"session.status","params":{"n":1.25}}\n'
        )
        calls: list[dict[str, object]] = []

        def dispatcher(request: dict[str, object]):
            calls.append(request)
            return {"jsonrpc": "2.0", "id": request["id"], "result": {}}

        result, frames, shutdown_calls = self.run_loop(requests, dispatcher)

        self.assertTrue(result)
        self.assertEqual(shutdown_calls, ["shutdown"])
        self.assertEqual(
            [frame["error"] for frame in frames[1:5]],
            [{"code": -32700, "message": "Parse error"}] * 4,
        )
        self.assertEqual(
            calls,
            [
                {
                    "jsonrpc": "2.0",
                    "id": 5,
                    "method": "session.status",
                    "params": {"n": 1.25},
                }
            ],
        )
        self.assertEqual(frames[5], {"jsonrpc": "2.0", "id": 5, "result": {}})

    def test_rejects_lone_surrogates_in_nested_keys_and_values(self) -> None:
        requests = (
            b'{"jsonrpc":"2.0","id":1,"method":"session.status","params":{"value":"\\ud800"}}\n'
            b'{"jsonrpc":"2.0","id":2,"method":"session.status","params":{"\\udfff":true}}\n'
            + rpc_line("session.status", request_id=3, params={"value": "正常"})
        )
        calls: list[dict[str, object]] = []

        def dispatcher(request: dict[str, object]):
            calls.append(request)
            return {"jsonrpc": "2.0", "id": request["id"], "result": {}}

        result, frames, shutdown_calls = self.run_loop(requests, dispatcher)

        self.assertTrue(result)
        self.assertEqual(shutdown_calls, ["shutdown"])
        self.assertEqual(
            [frame["error"] for frame in frames[1:3]],
            [{"code": -32700, "message": "Parse error"}] * 2,
        )
        self.assertEqual(
            calls,
            [
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "session.status",
                    "params": {"value": "正常"},
                }
            ],
        )

    def test_enforces_exact_nesting_limit_and_handles_parser_recursion(self) -> None:
        def deep_request(request_id: int, depth: int) -> bytes:
            nested = b"[" * depth + b"0" + b"]" * depth
            return (
                b'{"jsonrpc":"2.0","id":'
                + str(request_id).encode("ascii")
                + b',"method":"session.status","params":{"deep":'
                + nested
                + b"}}\n"
            )

        calls: list[int] = []
        result, frames, shutdown_calls = self.run_loop(
            deep_request(1, self.launcher.MAX_JSON_NESTING_DEPTH)
            + deep_request(2, self.launcher.MAX_JSON_NESTING_DEPTH + 1)
            + deep_request(3, 600)
            + rpc_line("session.status", request_id=4),
            lambda request: calls.append(int(request["id"])),
        )

        self.assertTrue(result)
        self.assertEqual(calls, [1, 4])
        self.assertEqual(shutdown_calls, ["shutdown"])
        self.assertEqual(
            frames[1:],
            [
                {
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {"code": -32700, "message": "Parse error"},
                }
            ]
            * 2,
        )

    def test_server_dispatch_is_bound_through_a_two_argument_closure(self) -> None:
        emitted = threading.Event()
        allow_late_write = threading.Event()
        request_line = rpc_line("session.status", request_id=8)

        class CoordinatedInput:
            def __init__(self) -> None:
                self.reads = 0

            def readline(self, _size: int) -> bytes:
                self.reads += 1
                if self.reads == 1:
                    return request_line
                self.assert_async_emission_completed()
                return b""

            @staticmethod
            def assert_async_emission_completed() -> None:
                if not emitted.wait(timeout=2):
                    raise AssertionError("async server emission did not complete")

        input_stream = CoordinatedInput()
        output = io.BytesIO()
        transport = self.launcher.SafeJsonTransport(output, self.capability())
        calls: list[tuple[dict[str, object], object]] = []
        async_outcomes: list[bool] = []
        late_outcomes: list[bool] = []
        workers: list[threading.Thread] = []

        class FakeServer:
            def dispatch(
                self,
                request: dict[str, object],
                bound_transport=None,
            ):
                calls.append((request, bound_transport))

                def emit_async_response() -> None:
                    async_outcomes.append(
                        bound_transport.write(
                            {"jsonrpc": "2.0", "id": request["id"], "result": {}}
                        )
                    )
                    emitted.set()

                def try_late_event() -> None:
                    allow_late_write.wait(timeout=2)
                    late_outcomes.append(
                        bound_transport.write(
                            {
                                "jsonrpc": "2.0",
                                "method": "event",
                                "params": {"type": "late"},
                            }
                        )
                    )

                workers.extend(
                    [
                        threading.Thread(target=emit_async_response),
                        threading.Thread(target=try_late_event),
                    ]
                )
                for worker in workers:
                    worker.start()
                return None

        dispatcher = self.launcher.bind_server_dispatch(FakeServer(), transport)
        result = self.launcher.run_ndjson_loop(
            input_stream,
            transport,
            dispatcher,
            lambda: None,
        )
        allow_late_write.set()
        for worker in workers:
            worker.join(timeout=2)

        self.assertTrue(result)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0]["method"], "session.status")
        self.assertIs(calls[0][1], transport)
        self.assertEqual(async_outcomes, [True])
        self.assertEqual(late_outcomes, [False])
        frames = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(frames[1], {"jsonrpc": "2.0", "id": 8, "result": {}})

    def test_loop_closes_owned_transport_after_shutdown_on_every_exit(self) -> None:
        class TrackingTransport:
            def __init__(self, *, ready_succeeds: bool = True) -> None:
                self.ready_succeeds = ready_succeeds
                self.write_calls = 0
                self.close_calls = 0
                self.order: list[str] = []

            def write_frame(self, _frame: object) -> bool:
                self.write_calls += 1
                return self.ready_succeeds or self.write_calls > 1

            def close(self) -> None:
                self.close_calls += 1
                self.order.append("close")

        class ReadFailure:
            def readline(self, _size: int) -> bytes:
                raise OSError("read failed")

        cases = [
            (io.BytesIO(b""), TrackingTransport()),
            (io.BytesIO(b""), TrackingTransport(ready_succeeds=False)),
            (ReadFailure(), TrackingTransport()),
            (
                io.BytesIO(b"x" * (self.launcher.MAX_NDJSON_FRAME_BYTES + 1)),
                TrackingTransport(),
            ),
        ]

        for input_stream, transport in cases:
            with self.subTest(input_type=type(input_stream).__name__, writes=transport.write_calls):
                def shutdown() -> None:
                    transport.order.append("shutdown")

                self.launcher.run_ndjson_loop(
                    input_stream,
                    transport,
                    lambda _request: None,
                    shutdown,
                )
                self.assertEqual(transport.close_calls, 1)
                self.assertEqual(transport.order, ["shutdown", "close"])

    def test_dispatcher_none_dict_exception_and_token_output_are_safe(self) -> None:
        calls = 0

        def dispatcher(request: dict[str, object]):
            nonlocal calls
            calls += 1
            if calls == 1:
                return None
            if calls == 2:
                return {
                    "jsonrpc": "2.0",
                    "id": request["id"],
                    "result": {"secret": f"before-{CANARY}-after"},
                }
            raise RuntimeError(f"dispatcher exploded {CANARY}")

        result, frames, _ = self.run_loop(
            rpc_line("session.status", request_id=1)
            + rpc_line("session.status", request_id=2)
            + rpc_line("session.status", request_id=3),
            dispatcher,
        )

        self.assertTrue(result)
        self.assertEqual(
            frames[1],
            {
                "jsonrpc": "2.0",
                "id": 2,
                "result": {"secret": "before-<redacted>-after"},
            },
        )
        self.assertEqual(
            frames[2],
            {
                "jsonrpc": "2.0",
                "id": 3,
                "error": {"code": -32603, "message": "Internal error"},
            },
        )
        rendered = json.dumps(frames)
        self.assertNotIn(CANARY, rendered)
        self.assertNotIn("dispatcher exploded", rendered)

    def test_oversize_input_emits_fixed_failure_terminates_and_never_dispatches(self) -> None:
        oversized = b"x" * (self.launcher.MAX_NDJSON_FRAME_BYTES + 1)
        calls: list[str] = []
        result, frames, shutdown_calls = self.run_loop(
            oversized + rpc_line("session.status", request_id=2),
            lambda request: calls.append(str(request["method"])),
        )

        self.assertFalse(result)
        self.assertEqual(calls, [])
        self.assertEqual(shutdown_calls, ["shutdown"])
        self.assertEqual(len(frames), 2)
        self.assertEqual(
            frames[1],
            {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32600, "message": "Invalid Request"},
            },
        )

    def test_ready_write_failure_terminates_without_reading_and_shutdown_runs_once(self) -> None:
        class ExplodingInput:
            def readline(self, _size: int) -> bytes:
                raise AssertionError("input must not be read when ready cannot be written")

        class RejectingTransport:
            def __init__(self) -> None:
                self.frames: list[object] = []

            def write_frame(self, frame: object) -> bool:
                self.frames.append(frame)
                return False

        transport = RejectingTransport()
        shutdown_calls: list[str] = []
        result = self.launcher.run_ndjson_loop(
            ExplodingInput(),
            transport,
            lambda _request: (_ for _ in ()).throw(AssertionError("dispatch")),
            lambda: shutdown_calls.append("shutdown"),
        )

        self.assertFalse(result)
        self.assertEqual(transport.frames, [self.launcher.READY_ENVELOPE])
        self.assertEqual(shutdown_calls, ["shutdown"])


class SourceBoundaryTests(unittest.TestCase):
    def test_preimport_source_contains_only_standard_library_imports(self) -> None:
        tree = ast.parse(LAUNCHER.read_text(encoding="utf-8"), filename=str(LAUNCHER))
        imported_roots: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported_roots.update(alias.name.partition(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported_roots.add(node.module.partition(".")[0])

        allowed = set(sys.stdlib_module_names) | {"__future__"}
        self.assertEqual(imported_roots - allowed, set())

    def test_source_does_not_import_hermes_or_offer_a_test_mode_escape_hatch(self) -> None:
        source = LAUNCHER.read_text(encoding="utf-8")
        self.assertNotIn("import tui_gateway", source)
        self.assertNotIn("import hermes", source)
        self.assertNotIn("OPENTRAD_TEST", source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
