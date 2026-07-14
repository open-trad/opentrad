#!/usr/bin/env python3
"""Contract tests for OpenTrad's thin native Hermes bootstrap."""

from __future__ import annotations

import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
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
    name = "opentrad_hermes_native_launcher_tested"
    spec = importlib.util.spec_from_file_location(name, LAUNCHER)
    if spec is None or spec.loader is None:
        raise AssertionError("launcher module could not be loaded")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def valid_payload(**overrides: object) -> bytes:
    payload: dict[str, object] = {
        "v": 1,
        "profileId": "profile-deepseek",
        "providerSlug": "deepseek",
        "authMode": "api_key",
        "apiMode": "chat_completions",
        "executionBackend": "local",
        "model": "deepseek-chat",
        "apiKey": CANARY,
        "baseUrl": "https://api.deepseek.com/v1",
    }
    payload.update(overrides)
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")


def valid_skills_sync_result(**overrides: object) -> dict[str, object]:
    result: dict[str, object] = {
        "copied": [f"skill-{index}" for index in range(72)],
        "updated": [],
        "skipped": 0,
        "user_modified": [],
        "suppressed": [],
        "total_bundled": 72,
    }
    result.update(overrides)
    return result


class PayloadContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.launcher = load_launcher()

    def assert_refused(self, raw: bytes) -> None:
        with self.assertRaises(self.launcher.LauncherRefusal) as caught:
            self.launcher.parse_bootstrap_payload(raw)
        rendered = f"{caught.exception!s} {caught.exception!r}"
        self.assertEqual(str(caught.exception), self.launcher.GENERIC_REFUSAL)
        self.assertNotIn(CANARY, rendered)

    def test_accepts_api_key_profile_without_exposing_secret_in_repr(self) -> None:
        payload = self.launcher.parse_bootstrap_payload(valid_payload())

        self.assertEqual(payload.profile_id, "profile-deepseek")
        self.assertEqual(payload.provider_slug, "deepseek")
        self.assertEqual(payload.auth_mode, "api_key")
        self.assertEqual(payload.api_mode, "chat_completions")
        self.assertEqual(payload.execution_backend, "local")
        self.assertEqual(payload.model, "deepseek-chat")
        self.assertEqual(payload.api_key, CANARY)
        self.assertEqual(payload.base_url, "https://api.deepseek.com/v1")
        self.assertNotIn(CANARY, repr(payload))

    def test_accepts_oauth_profile_only_without_api_key_or_base_url(self) -> None:
        payload = self.launcher.parse_bootstrap_payload(
            valid_payload(
                profileId="profile-chatgpt",
                providerSlug="openai-codex",
                authMode="oauth",
                apiMode="codex_responses",
                model="gpt-5.2-codex",
                apiKey=None,
                baseUrl=None,
            )
        )

        self.assertEqual(payload.auth_mode, "oauth")
        self.assertIsNone(payload.api_key)
        self.assertIsNone(payload.base_url)

    def test_rejects_duplicate_unknown_and_missing_fields(self) -> None:
        duplicate = valid_payload().decode("utf-8").replace(
            '"profileId":"profile-deepseek"',
            '"profileId":"profile-deepseek","profileId":"shadow"',
        )
        self.assert_refused(duplicate.encode("utf-8"))
        self.assert_refused(valid_payload(extra="not-allowed"))
        missing = json.loads(valid_payload())
        del missing["providerSlug"]
        self.assert_refused(json.dumps(missing).encode("utf-8"))

    def test_rejects_invalid_scalar_fields(self) -> None:
        invalid_cases = (
            {"v": 2},
            {"v": True},
            {"profileId": ""},
            {"profileId": "bad/profile"},
            {"providerSlug": ""},
            {"providerSlug": "bad provider"},
            {"authMode": "token"},
            {"apiMode": "responses"},
            {"executionBackend": "remote"},
            {"model": ""},
            {"model": "bad model"},
        )
        for overrides in invalid_cases:
            with self.subTest(overrides=overrides):
                self.assert_refused(valid_payload(**overrides))

    def test_requires_exactly_one_auth_shape(self) -> None:
        self.assert_refused(valid_payload(apiKey=None))
        self.assert_refused(valid_payload(apiKey=""))
        self.assert_refused(valid_payload(apiKey=f"prefix\n{CANARY}"))
        self.assert_refused(valid_payload(apiKey=f"prefix\x00{CANARY}"))
        self.assert_refused(valid_payload(authMode="oauth"))
        self.assert_refused(valid_payload(authMode="oauth", apiKey=None, baseUrl="https://x.test/v1"))

    def test_accepts_https_and_loopback_http_base_urls_only(self) -> None:
        for value in (
            "https://example.test/v1",
            "http://localhost:11434/v1",
            "http://127.0.0.1:8000/v1",
            "http://[::1]:9000/v1",
        ):
            with self.subTest(value=value):
                parsed = self.launcher.parse_bootstrap_payload(valid_payload(baseUrl=value))
                self.assertEqual(parsed.base_url, value)

        for value in (
            "http://example.test/v1",
            "https://user:pass@example.test/v1",
            "https://example.test/v1?token=secret",
            "file:///tmp/socket",
            "not-a-url",
        ):
            with self.subTest(value=value):
                self.assert_refused(valid_payload(baseUrl=value))

    def test_rejects_oversized_or_non_utf8_payloads_without_reflection(self) -> None:
        self.assert_refused(b"x" * (self.launcher.BOOTSTRAP_MAX_BYTES + 1))
        self.assert_refused(b"\xff\xfe" + CANARY.encode("ascii"))


class PayloadFdTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.launcher = load_launcher()

    def test_reads_exactly_one_bounded_payload_and_closes_fd(self) -> None:
        read_fd, write_fd = os.pipe()
        os.write(write_fd, valid_payload())
        os.close(write_fd)

        payload = self.launcher.read_bootstrap_fd(read_fd, timeout_seconds=0.2)

        self.assertEqual(payload.provider_slug, "deepseek")
        with self.assertRaises(OSError):
            os.fstat(read_fd)

    def test_closes_fd_on_parse_failure(self) -> None:
        read_fd, write_fd = os.pipe()
        os.write(write_fd, b"not-json")
        os.close(write_fd)

        with self.assertRaises(self.launcher.LauncherRefusal):
            self.launcher.read_bootstrap_fd(read_fd, timeout_seconds=0.2)

        with self.assertRaises(OSError):
            os.fstat(read_fd)

    def test_refuses_timeout_missing_eof_and_oversized_payload(self) -> None:
        read_fd, write_fd = os.pipe()
        try:
            with self.assertRaises(self.launcher.LauncherRefusal):
                self.launcher.read_bootstrap_fd(read_fd, timeout_seconds=0.01)
        finally:
            os.close(write_fd)

        read_fd, write_fd = os.pipe()
        try:
            os.write(write_fd, valid_payload())
            with self.assertRaises(self.launcher.LauncherRefusal):
                self.launcher.read_bootstrap_fd(read_fd, timeout_seconds=0.01)
        finally:
            os.close(write_fd)

        read_fd, write_fd = os.pipe()
        os.write(write_fd, b"x" * (self.launcher.BOOTSTRAP_MAX_BYTES + 1))
        os.close(write_fd)
        with self.assertRaises(self.launcher.LauncherRefusal):
            self.launcher.read_bootstrap_fd(read_fd, timeout_seconds=0.2)


class EnvironmentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.launcher = load_launcher()

    def base_environment(self, home: Path) -> dict[str, str]:
        (home / "gh-config").mkdir(mode=0o700, exist_ok=True)
        (home / "xdg-config").mkdir(mode=0o700, exist_ok=True)
        (home / "codex-home").mkdir(mode=0o700, exist_ok=True)
        return {
            "HERMES_HOME": str(home),
            "HERMES_BUNDLED_SKILLS": str(home.resolve()),
            "OPENTRAD_WORKSPACE_ROOT": str(home.resolve()),
            "HOME": "/Users/example",
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "TMPDIR": "/private/tmp/",
            "LANG": "en_US.UTF-8",
            "LC_CTYPE": "UTF-8",
            "PYTHONPATH": "/attacker",
            "PYTHONHOME": "/attacker",
            "DYLD_INSERT_LIBRARIES": "/attacker.dylib",
            "NODE_OPTIONS": "--require=/attacker.js",
            "HTTPS_PROXY": "http://attacker.invalid:8080",
            "OPENAI_API_KEY": "inherited-openai-secret",
            "DEEPSEEK_API_KEY": "inherited-deepseek-secret",
            "ANTHROPIC_API_KEY": "inherited-anthropic-secret",
            "GH_CONFIG_DIR": "/Users/example/.config/gh",
            "XDG_CONFIG_HOME": "/Users/example/.config",
            "COPILOT_GH_HOST": "github.com",
            "CODEX_HOME": "/Users/example/.codex",
        }

    def test_scrubs_inherited_control_and_provider_environment(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            home = Path(raw)
            target = self.base_environment(home)
            payload = self.launcher.parse_bootstrap_payload(valid_payload())

            self.launcher.configure_environment(payload, target)

            self.assertEqual(target["HERMES_HOME"], str(home))
            self.assertEqual(target["HERMES_BUNDLED_SKILLS"], str(home.resolve()))
            self.assertEqual(target["GH_CONFIG_DIR"], str(home / "gh-config"))
            self.assertEqual(target["XDG_CONFIG_HOME"], str(home / "xdg-config"))
            self.assertRegex(target["COPILOT_GH_HOST"], r"^[a-f0-9]{24}\.opentrad\.invalid$")
            self.assertEqual(target["CODEX_HOME"], str(home / "codex-home"))
            self.assertEqual(target["HOME"], "/Users/example")
            self.assertEqual(target["PATH"], "/usr/local/bin:/usr/bin:/bin")
            self.assertEqual(target["DEEPSEEK_API_KEY"], CANARY)
            self.assertEqual(target["DEEPSEEK_BASE_URL"], "https://api.deepseek.com/v1")
            for key in (
                "PYTHONPATH",
                "PYTHONHOME",
                "DYLD_INSERT_LIBRARIES",
                "NODE_OPTIONS",
                "HTTPS_PROXY",
                "OPENAI_API_KEY",
                "ANTHROPIC_API_KEY",
                "OPENTRAD_WORKSPACE_ROOT",
            ):
                self.assertNotIn(key, target)

    def test_maps_only_private_trusted_proxy_inputs_to_upstream_environment(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            home = Path(raw)
            target = self.base_environment(home)
            target.update(
                {
                    "OPENTRAD_NETWORK_HTTP_PROXY": "http://127.0.0.1:7897",
                    "OPENTRAD_NETWORK_HTTPS_PROXY": "http://127.0.0.1:7897",
                    "OPENTRAD_NETWORK_NO_PROXY": "localhost,127.0.0.1,::1",
                    "http_proxy": "http://attacker.invalid:4444",
                    "https_proxy": "http://attacker.invalid:5555",
                }
            )
            payload = self.launcher.parse_bootstrap_payload(valid_payload())

            self.launcher.configure_environment(payload, target)

            self.assertEqual(target["HTTP_PROXY"], "http://127.0.0.1:7897")
            self.assertEqual(target["HTTPS_PROXY"], "http://127.0.0.1:7897")
            self.assertEqual(target["NO_PROXY"], "localhost,127.0.0.1,::1")
            self.assertNotIn("OPENTRAD_NETWORK_HTTP_PROXY", target)
            self.assertNotIn("OPENTRAD_NETWORK_HTTPS_PROXY", target)
            self.assertNotIn("OPENTRAD_NETWORK_NO_PROXY", target)
            self.assertNotIn("http_proxy", target)
            self.assertNotIn("https_proxy", target)

    def test_rejects_malformed_private_trusted_proxy_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            home = Path(raw)
            payload = self.launcher.parse_bootstrap_payload(valid_payload())
            for value in (
                "https://127.0.0.1:7897",
                "http://user:password@127.0.0.1:7897",
                "http://127.0.0.1:7897/escape",
                "http://127.0.0.1:0",
            ):
                with self.subTest(value=value):
                    target = self.base_environment(home)
                    target["OPENTRAD_NETWORK_HTTPS_PROXY"] = value
                    with self.assertRaises(self.launcher.LauncherRefusal):
                        self.launcher.configure_environment(payload, target)

    def test_local_backend_fixes_workspace_and_disables_docker_controls(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            target = self.base_environment(Path(raw))
            payload = self.launcher.parse_bootstrap_payload(valid_payload())

            workspace = self.launcher.configure_environment(payload, target)

            self.assertEqual(workspace, Path(raw).resolve())
            self.assertEqual(target["TERMINAL_ENV"], "local")
            self.assertEqual(target["TERMINAL_CWD"], str(workspace))
            self.assertEqual(target["TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE"], "false")
            self.assertEqual(target["TERMINAL_CONTAINER_PERSISTENT"], "false")
            self.assertEqual(target["TERMINAL_DOCKER_PERSIST_ACROSS_PROCESSES"], "false")
            self.assertEqual(target["TERMINAL_DOCKER_VOLUMES"], "[]")
            self.assertEqual(target["TERMINAL_DOCKER_EXTRA_ARGS"], "[]")
            self.assertEqual(target["TERMINAL_DOCKER_FORWARD_ENV"], "[]")
            self.assertEqual(target["TERMINAL_DOCKER_ENV"], "{}")

    def test_docker_backend_uses_only_the_canonical_workspace_mount_contract(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            workspace = Path(raw).resolve()
            target = self.base_environment(workspace)
            target.update(
                {
                    "TERMINAL_ENV": "ssh",
                    "TERMINAL_CWD": "/attacker",
                    "TERMINAL_DOCKER_VOLUMES": '["/attacker:/host"]',
                    "TERMINAL_DOCKER_EXTRA_ARGS": '["--mount", "attacker"]',
                    "TERMINAL_DOCKER_FORWARD_ENV": '["DEEPSEEK_API_KEY"]',
                    "TERMINAL_DOCKER_ENV": '{"LEAK":"secret"}',
                    "TERMINAL_CONTAINER_PERSISTENT": "true",
                    "TERMINAL_DOCKER_PERSIST_ACROSS_PROCESSES": "true",
                }
            )
            payload = self.launcher.parse_bootstrap_payload(
                valid_payload(executionBackend="docker")
            )

            selected = self.launcher.configure_environment(payload, target)

            self.assertEqual(selected, workspace)
            self.assertEqual(target["TERMINAL_ENV"], "docker")
            self.assertEqual(target["TERMINAL_CWD"], str(workspace))
            self.assertEqual(target["TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE"], "true")
            self.assertEqual(target["TERMINAL_DOCKER_RUN_AS_HOST_USER"], "true")
            self.assertEqual(target["TERMINAL_CONTAINER_PERSISTENT"], "false")
            self.assertEqual(target["TERMINAL_DOCKER_VOLUMES"], "[]")
            self.assertEqual(target["TERMINAL_DOCKER_EXTRA_ARGS"], "[]")
            self.assertEqual(target["TERMINAL_DOCKER_FORWARD_ENV"], "[]")
            self.assertEqual(target["TERMINAL_DOCKER_ENV"], "{}")
            self.assertEqual(target["TERMINAL_DOCKER_PERSIST_ACROSS_PROCESSES"], "false")
            self.assertNotIn("OPENTRAD_WORKSPACE_ROOT", target)

    def test_rejects_missing_relative_nonexistent_or_symlinked_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw).resolve()
            real = root / "real"
            real.mkdir()
            linked = root / "linked"
            linked.symlink_to(real, target_is_directory=True)
            candidates: tuple[str | None, ...] = (
                None,
                "relative/workspace",
                str(root / "missing"),
                str(linked),
            )
            payload = self.launcher.parse_bootstrap_payload(valid_payload())
            for value in candidates:
                with self.subTest(value=value):
                    target = self.base_environment(root)
                    if value is None:
                        target.pop("OPENTRAD_WORKSPACE_ROOT")
                    else:
                        target["OPENTRAD_WORKSPACE_ROOT"] = value
                    with self.assertRaises(self.launcher.LauncherRefusal) as caught:
                        self.launcher.configure_environment(payload, target)
                    self.assertEqual(str(caught.exception), self.launcher.GENERIC_REFUSAL)
                    self.assertNotIn(CANARY, repr(caught.exception))

    def test_docker_contract_is_restored_after_profile_config_bridge(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            workspace = Path(raw).resolve()
            target = self.base_environment(workspace)
            payload = self.launcher.parse_bootstrap_payload(
                valid_payload(executionBackend="docker")
            )
            self.launcher.configure_environment(payload, target)

            def upstream_bridge(**_kwargs: object) -> dict[str, str]:
                target.update(
                    {
                        "TERMINAL_ENV": "local",
                        "TERMINAL_CWD": "/attacker",
                        "TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE": "false",
                        "TERMINAL_DOCKER_RUN_AS_HOST_USER": "false",
                        "TERMINAL_DOCKER_VOLUMES": '["/attacker:/host"]',
                        "TERMINAL_DOCKER_FORWARD_ENV": '["DEEPSEEK_API_KEY"]',
                        "TERMINAL_DOCKER_ENV": '{"LEAK":"secret"}',
                        "TERMINAL_CONTAINER_PERSISTENT": "true",
                        "TERMINAL_DOCKER_PERSIST_ACROSS_PROCESSES": "true",
                    }
                )
                return target

            module = types.SimpleNamespace(apply_terminal_config_to_env=upstream_bridge)
            self.launcher.install_execution_environment_guard(
                payload, workspace, module, target
            )

            result = module.apply_terminal_config_to_env(config={"terminal": {}})

            self.assertIs(result, target)
            self.assertEqual(target["TERMINAL_ENV"], "docker")
            self.assertEqual(target["TERMINAL_CWD"], str(workspace))
            self.assertEqual(target["TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE"], "true")
            self.assertEqual(target["TERMINAL_DOCKER_RUN_AS_HOST_USER"], "true")
            self.assertEqual(target["TERMINAL_CONTAINER_PERSISTENT"], "false")
            self.assertEqual(target["TERMINAL_DOCKER_VOLUMES"], "[]")
            self.assertEqual(target["TERMINAL_DOCKER_EXTRA_ARGS"], "[]")
            self.assertEqual(target["TERMINAL_DOCKER_FORWARD_ENV"], "[]")
            self.assertEqual(target["TERMINAL_DOCKER_ENV"], "{}")
            self.assertEqual(target["TERMINAL_DOCKER_PERSIST_ACROSS_PROCESSES"], "false")

    def test_maps_api_keys_to_the_pinned_hermes_provider_environment(self) -> None:
        cases = (
            ("openai-api", "codex_responses", "OPENAI_API_KEY", "OPENAI_BASE_URL"),
            ("anthropic", "chat_completions", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"),
            ("deepseek", "chat_completions", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"),
            (
                "custom:profile-compatible",
                "chat_completions",
                "OPENTRAD_PROVIDER_API_KEY",
                "OPENTRAD_PROVIDER_BASE_URL",
            ),
        )
        with tempfile.TemporaryDirectory() as raw:
            for slug, api_mode, key_name, base_name in cases:
                with self.subTest(slug=slug):
                    target = self.base_environment(Path(raw))
                    payload = self.launcher.parse_bootstrap_payload(
                        valid_payload(providerSlug=slug, apiMode=api_mode)
                    )
                    self.launcher.configure_environment(payload, target)
                    self.assertEqual(target[key_name], CANARY)
                    self.assertEqual(target[base_name], "https://api.deepseek.com/v1")

    def test_oauth_profile_never_injects_an_api_key(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            target = self.base_environment(Path(raw))
            payload = self.launcher.parse_bootstrap_payload(
                valid_payload(
                    providerSlug="openai-codex",
                    authMode="oauth",
                    apiMode="codex_responses",
                    apiKey=None,
                    baseUrl=None,
                )
            )

            self.launcher.configure_environment(payload, target)

            self.assertFalse(any(key.endswith("API_KEY") for key in target))
            self.assertNotIn(CANARY, repr(target))

    def test_fd_key_is_restored_after_every_upstream_dotenv_reload(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            target = self.base_environment(Path(raw))
            target.update(
                {
                    "OPENTRAD_NETWORK_HTTPS_PROXY": "http://127.0.0.1:7897",
                    "OPENTRAD_NETWORK_NO_PROXY": "localhost,127.0.0.1,::1",
                }
            )
            payload = self.launcher.parse_bootstrap_payload(valid_payload())
            self.launcher.configure_environment(payload, target)
            env_file = Path(raw) / ".env"
            env_file.write_text("DEEPSEEK_API_KEY=stale-profile-key\n", encoding="utf-8")

            def upstream_loader(*_args: object, **_kwargs: object) -> list[Path]:
                target["DEEPSEEK_API_KEY"] = "stale-profile-key"
                target["HERMES_BUNDLED_SKILLS"] = "/attacker/skills"
                target["HERMES_HOME"] = "/attacker/home"
                target["HOME"] = "/attacker/home-alias"
                target["PATH"] = "/attacker/bin"
                target["GH_CONFIG_DIR"] = "/attacker/gh"
                target["XDG_CONFIG_HOME"] = "/attacker/xdg"
                target["COPILOT_GH_HOST"] = "github.com"
                target["CODEX_HOME"] = "/attacker/codex"
                target["HERMES_PROFILE"] = "shared-host-profile"
                target["HERMES_CONFIG"] = "/attacker/config.yaml"
                target["HERMES_ENV"] = "/attacker/.env"
                target["PYTHONPATH"] = "/attacker/python"
                target["DYLD_INSERT_LIBRARIES"] = "/attacker/inject.dylib"
                target["NODE_OPTIONS"] = "--require=/attacker.js"
                target["HTTPS_PROXY"] = "http://attacker.invalid:4444"
                target["https_proxy"] = "http://attacker.invalid:5555"
                target["NO_PROXY"] = "attacker.invalid"
                target["SSL_CERT_FILE"] = "/attacker/ca.pem"
                target["SSL_CERT_DIR"] = "/attacker/ca-dir"
                target["REQUESTS_CA_BUNDLE"] = "/attacker/requests-ca.pem"
                target["CURL_CA_BUNDLE"] = "/attacker/curl-ca.pem"
                target["NODE_EXTRA_CA_CERTS"] = "/attacker/node-ca.pem"
                target["OPENSSL_CONF"] = "/attacker/openssl.cnf"
                target["SSLKEYLOGFILE"] = "/attacker/tls-keys.log"
                target["COPILOT_API_BASE_URL"] = "https://attacker.invalid/copilot"
                target["NOUS_PORTAL_BASE_URL"] = "https://attacker.invalid/oauth"
                target["NOUS_INFERENCE_BASE_URL"] = "https://attacker.invalid/inference"
                target["TERMINAL_DOCKER_IMAGE"] = "attacker/image"
                target["DOCKER_HOST"] = "tcp://attacker.invalid:2375"
                target["HERMES_LANGFUSE_SECRET_KEY"] = "profile-observability-secret"
                target["NODE_AUTH_TOKEN"] = "profile-registry-secret"
                target["TOOL_SKILL_SECRET"] = "profile-tool-secret"
                target["TERMINAL_ENV"] = "docker"
                target["TERMINAL_CWD"] = "/attacker/workspace"
                return [env_file]

            module = types.SimpleNamespace(load_hermes_dotenv=upstream_loader)
            self.launcher.install_provider_environment_guard(
                payload,
                module,
                target,
                workspace_root=Path(raw).resolve(),
                bundled_skills_root=Path(raw).resolve(),
            )

            first = module.load_hermes_dotenv(hermes_home=raw)
            second = module.load_hermes_dotenv(hermes_home=raw)

            self.assertEqual(first, [env_file])
            self.assertEqual(second, [env_file])
            self.assertEqual(target["DEEPSEEK_API_KEY"], CANARY)
            self.assertEqual(target["HERMES_BUNDLED_SKILLS"], str(Path(raw).resolve()))
            self.assertEqual(target["HERMES_HOME"], str(Path(raw)))
            self.assertEqual(target["GH_CONFIG_DIR"], str(Path(raw) / "gh-config"))
            self.assertEqual(target["XDG_CONFIG_HOME"], str(Path(raw) / "xdg-config"))
            self.assertRegex(target["COPILOT_GH_HOST"], r"^[a-f0-9]{24}\.opentrad\.invalid$")
            self.assertEqual(target["CODEX_HOME"], str(Path(raw) / "codex-home"))
            self.assertEqual(target["HOME"], "/Users/example")
            self.assertEqual(target["PATH"], "/usr/local/bin:/usr/bin:/bin")
            self.assertEqual(target["HTTPS_PROXY"], "http://127.0.0.1:7897")
            self.assertEqual(target["NO_PROXY"], "localhost,127.0.0.1,::1")
            self.assertNotIn("https_proxy", target)
            self.assertEqual(target["TOOL_SKILL_SECRET"], "profile-tool-secret")
            self.assertEqual(
                target["HERMES_LANGFUSE_SECRET_KEY"], "profile-observability-secret"
            )
            self.assertEqual(target["NODE_AUTH_TOKEN"], "profile-registry-secret")
            for forbidden in (
                "HERMES_PROFILE",
                "HERMES_CONFIG",
                "HERMES_ENV",
                "PYTHONPATH",
                "DYLD_INSERT_LIBRARIES",
                "NODE_OPTIONS",
                "SSL_CERT_FILE",
                "SSL_CERT_DIR",
                "REQUESTS_CA_BUNDLE",
                "CURL_CA_BUNDLE",
                "NODE_EXTRA_CA_CERTS",
                "OPENSSL_CONF",
                "SSLKEYLOGFILE",
                "COPILOT_API_BASE_URL",
                "NOUS_PORTAL_BASE_URL",
                "NOUS_INFERENCE_BASE_URL",
                "TERMINAL_DOCKER_IMAGE",
                "DOCKER_HOST",
            ):
                self.assertNotIn(forbidden, target)
            self.assertEqual(target["TERMINAL_ENV"], "local")
            self.assertEqual(target["TERMINAL_CWD"], str(Path(raw).resolve()))
            self.assertEqual(
                env_file.read_text(encoding="utf-8"),
                "DEEPSEEK_API_KEY=stale-profile-key\n",
            )

    def test_docker_contract_is_restored_after_every_upstream_dotenv_reload(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            workspace = Path(raw).resolve()
            target = self.base_environment(workspace)
            payload = self.launcher.parse_bootstrap_payload(
                valid_payload(executionBackend="docker")
            )
            self.launcher.configure_environment(payload, target)

            def upstream_loader(**_kwargs: object) -> list[Path]:
                target.update(
                    {
                        "TERMINAL_ENV": "local",
                        "TERMINAL_CWD": "/attacker",
                        "TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE": "false",
                        "TERMINAL_DOCKER_RUN_AS_HOST_USER": "false",
                        "TERMINAL_DOCKER_VOLUMES": '["/attacker:/host"]',
                        "TERMINAL_DOCKER_FORWARD_ENV": '["DEEPSEEK_API_KEY"]',
                        "TERMINAL_DOCKER_ENV": '{"LEAK":"secret"}',
                        "TERMINAL_CONTAINER_PERSISTENT": "true",
                        "TERMINAL_DOCKER_PERSIST_ACROSS_PROCESSES": "true",
                    }
                )
                return []

            module = types.SimpleNamespace(load_hermes_dotenv=upstream_loader)
            self.launcher.install_provider_environment_guard(
                payload, module, target, workspace_root=workspace
            )

            module.load_hermes_dotenv(hermes_home=raw)

            self.assertEqual(target["TERMINAL_ENV"], "docker")
            self.assertEqual(target["TERMINAL_CWD"], str(workspace))
            self.assertEqual(target["TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE"], "true")
            self.assertEqual(target["TERMINAL_DOCKER_RUN_AS_HOST_USER"], "true")
            self.assertEqual(target["TERMINAL_CONTAINER_PERSISTENT"], "false")
            self.assertEqual(target["TERMINAL_DOCKER_VOLUMES"], "[]")
            self.assertEqual(target["TERMINAL_DOCKER_EXTRA_ARGS"], "[]")
            self.assertEqual(target["TERMINAL_DOCKER_FORWARD_ENV"], "[]")
            self.assertEqual(target["TERMINAL_DOCKER_ENV"], "{}")
            self.assertEqual(target["TERMINAL_DOCKER_PERSIST_ACROSS_PROCESSES"], "false")

    def test_anthropic_dotenv_cannot_cross_the_profile_auth_mode(self) -> None:
        cases = (
            ("api_key", CANARY, "ANTHROPIC_TOKEN", "sk-ant-oat01-stale-profile"),
            ("oauth", None, "ANTHROPIC_API_KEY", "stale-profile-api-key"),
        )
        for auth_mode, api_key, forbidden, forbidden_value in cases:
            with self.subTest(auth_mode=auth_mode), tempfile.TemporaryDirectory() as raw:
                target = self.base_environment(Path(raw))
                payload = self.launcher.parse_bootstrap_payload(
                    valid_payload(
                        providerSlug="anthropic",
                        authMode=auth_mode,
                        apiMode="chat_completions",
                        apiKey=api_key,
                        baseUrl=None,
                    )
                )
                self.launcher.configure_environment(payload, target)

                def upstream_loader(**_kwargs: object) -> list[Path]:
                    target[forbidden] = forbidden_value
                    target["ANTHROPIC_BASE_URL"] = "https://attacker.invalid/anthropic"
                    if auth_mode == "oauth":
                        target["ANTHROPIC_TOKEN"] = "sk-ant-oat01-profile-oauth"
                    else:
                        target["CLAUDE_CODE_OAUTH_TOKEN"] = "sk-ant-oat01-stale-claude"
                    return []

                module = types.SimpleNamespace(load_hermes_dotenv=upstream_loader)
                self.launcher.install_provider_environment_guard(
                    payload,
                    module,
                    target,
                    workspace_root=Path(raw).resolve(),
                    bundled_skills_root=Path(raw).resolve(),
                )

                module.load_hermes_dotenv(hermes_home=raw)

                self.assertNotIn(forbidden, target)
                self.assertNotIn("ANTHROPIC_BASE_URL", target)
                if auth_mode == "api_key":
                    self.assertEqual(target["ANTHROPIC_API_KEY"], CANARY)
                    self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", target)
                else:
                    self.assertEqual(target["ANTHROPIC_TOKEN"], "sk-ant-oat01-profile-oauth")


class BootstrapBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.launcher = load_launcher()

    @staticmethod
    def make_private_tree(root: Path) -> tuple[Path, Path, Path, Path]:
        runtime = root / "runtime"
        python = runtime / "python" / "bin" / "python3"
        site_packages = runtime / "python" / "lib" / "python3.12" / "site-packages"
        launcher = root / "app" / "opentrad_hermes_launcher.py"
        home = root / "profile"
        cwd = home / "gateway-cwd"
        python.parent.mkdir(parents=True)
        site_packages.mkdir(parents=True)
        launcher.parent.mkdir(parents=True)
        home.mkdir(mode=0o700)
        cwd.mkdir(mode=0o700)
        python.write_bytes(b"python")
        launcher.write_bytes(b"launcher")
        python.chmod(0o700)
        launcher.chmod(0o600)
        return python, launcher, home, cwd

    def test_requires_exact_managed_cpython_version(self) -> None:
        self.launcher.verify_interpreter_contract((3, 12, 11))
        for version in ((3, 12, 10), (3, 12, 12), (3, 11, 9), (3, 13, 0), (3, 14, 0)):
            with self.subTest(version=version):
                with self.assertRaises(self.launcher.LauncherRefusal):
                    self.launcher.verify_interpreter_contract(version)

    def test_validates_private_profile_and_infers_only_managed_site_packages(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw).resolve()
            python, launcher, home, cwd = self.make_private_tree(root)

            paths = self.launcher.validate_bootstrap_paths(launcher, home, cwd)
            site_packages = self.launcher.infer_site_packages(python, (3, 12, 11))
            sys_path = [str(launcher.parent), "/stdlib", "/attacker"]
            self.launcher.activate_site_packages(site_packages, sys_path)

            self.assertEqual(paths.hermes_home, home)
            self.assertEqual(paths.cwd, cwd)
            self.assertEqual(site_packages, root / "runtime/python/lib/python3.12/site-packages")
            self.assertEqual(
                sys_path,
                [str(launcher.parent), "/stdlib", "/attacker", str(site_packages)],
            )

    def test_rejects_symlink_or_group_writable_profile_paths(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw).resolve()
            _python, launcher, home, cwd = self.make_private_tree(root)
            home_link = root / "profile-link"
            home_link.symlink_to(home, target_is_directory=True)
            with self.assertRaises(self.launcher.LauncherRefusal):
                self.launcher.validate_bootstrap_paths(launcher, home_link, cwd)
            home.chmod(0o770)
            with self.assertRaises(self.launcher.LauncherRefusal):
                self.launcher.validate_bootstrap_paths(launcher, home, cwd)

    def test_validates_only_the_pinned_private_read_only_bundled_skills_tree(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw).resolve()
            runtime_root = root / "runtimes" / "hermes" / "0.18.2"
            python = runtime_root / "venv" / "bin" / "python3"
            skills = runtime_root / "share" / "hermes" / "skills"
            python.parent.mkdir(parents=True)
            python.write_bytes(b"python")
            skills.mkdir(parents=True)
            (runtime_root / "share").chmod(0o700)
            (runtime_root / "share" / "hermes").chmod(0o700)
            skills.chmod(0o500)

            self.assertEqual(
                self.launcher.validate_bundled_skills_root(str(skills), python),
                skills,
            )

            skills.chmod(0o700)
            with self.assertRaises(self.launcher.LauncherRefusal):
                self.launcher.validate_bundled_skills_root(str(skills), python)
            skills.chmod(0o500)

            linked = root / "skills-link"
            linked.symlink_to(skills, target_is_directory=True)
            with self.assertRaises(self.launcher.LauncherRefusal):
                self.launcher.validate_bundled_skills_root(str(linked), python)

    def test_disables_core_dumps(self) -> None:
        with mock.patch.object(self.launcher.resource, "setrlimit") as setrlimit:
            self.launcher.disable_core_dumps()
        setrlimit.assert_called_once_with(self.launcher.resource.RLIMIT_CORE, (0, 0))

    def test_anthropic_resolver_is_limited_to_the_profile_auth_mode(self) -> None:
        def adapter(token: str) -> object:
            return types.SimpleNamespace(
                read_claude_code_credentials=lambda: {"accessToken": CANARY},
                _read_claude_code_credentials_from_keychain=lambda: {"accessToken": CANARY},
                _read_claude_code_credentials_from_file=lambda: {"accessToken": CANARY},
                resolve_anthropic_token=lambda: token,
                _is_oauth_token=lambda value: value.startswith("sk-ant-oat"),
            )

        api_adapter = adapter("sk-ant-oat01-stale-profile")
        api_payload = self.launcher.parse_bootstrap_payload(
            valid_payload(
                providerSlug="anthropic",
                authMode="api_key",
                apiMode="chat_completions",
            )
        )
        self.launcher.install_anthropic_auth_guard(api_adapter, api_payload)
        self.assertEqual(api_adapter.resolve_anthropic_token(), CANARY)
        self.assertIsNone(api_adapter.read_claude_code_credentials())

        rejected_oauth_adapter = adapter("sk-ant-api03-stale-key")
        oauth_payload = self.launcher.parse_bootstrap_payload(
            valid_payload(
                providerSlug="anthropic",
                authMode="oauth",
                apiMode="chat_completions",
                apiKey=None,
                baseUrl=None,
            )
        )
        self.launcher.install_anthropic_auth_guard(rejected_oauth_adapter, oauth_payload)
        self.assertIsNone(rejected_oauth_adapter.resolve_anthropic_token())

        accepted_oauth_adapter = adapter("sk-ant-oat01-profile")
        self.launcher.install_anthropic_auth_guard(accepted_oauth_adapter, oauth_payload)
        self.assertEqual(
            accepted_oauth_adapter.resolve_anthropic_token(), "sk-ant-oat01-profile"
        )

    def test_anthropic_runtime_pool_cannot_bypass_the_guarded_resolver(self) -> None:
        calls: list[str] = []
        api_entry = types.SimpleNamespace(auth_type="api_key")
        oauth_entry = types.SimpleNamespace(auth_type="oauth", base_url="https://api.anthropic.com")
        attacker_oauth_entry = types.SimpleNamespace(
            auth_type="oauth", base_url="https://attacker.invalid/anthropic"
        )
        pool = types.SimpleNamespace(_entries=[api_entry, oauth_entry])
        module = types.SimpleNamespace(load_pool=lambda provider: calls.append(provider) or pool)
        api_payload = self.launcher.parse_bootstrap_payload(
            valid_payload(
                providerSlug="anthropic",
                authMode="api_key",
                apiMode="chat_completions",
            )
        )

        self.launcher.install_provider_pool_guard(module, api_payload)

        self.assertIsNone(module.load_pool("anthropic"))
        self.assertIs(module.load_pool("deepseek"), pool)
        self.assertEqual(pool._entries, [api_entry, oauth_entry])
        self.assertEqual(calls, ["deepseek"])

        oauth_pool = types.SimpleNamespace(
            _entries=[api_entry, attacker_oauth_entry, oauth_entry]
        )
        oauth_module = types.SimpleNamespace(load_pool=lambda _provider: oauth_pool)
        oauth_payload = self.launcher.parse_bootstrap_payload(
            valid_payload(
                providerSlug="anthropic",
                authMode="oauth",
                apiMode="chat_completions",
                apiKey=None,
                baseUrl=None,
            )
        )

        self.launcher.install_provider_pool_guard(oauth_module, oauth_payload)

        self.assertIs(oauth_module.load_pool("anthropic"), oauth_pool)
        self.assertEqual(oauth_pool._entries, [oauth_entry])

        copilot_calls: list[str] = []
        copilot_module = types.SimpleNamespace(
            load_pool=lambda provider: copilot_calls.append(provider) or pool
        )
        copilot_payload = self.launcher.parse_bootstrap_payload(
            valid_payload(
                providerSlug="copilot",
                authMode="oauth",
                apiMode="codex_responses",
                apiKey=None,
                baseUrl=None,
            )
        )
        self.launcher.install_provider_pool_guard(copilot_module, copilot_payload)
        self.assertIsNone(copilot_module.load_pool("copilot"))
        self.assertEqual(copilot_calls, [])

    def test_loads_exact_wheel_and_returns_upstream_main_directly(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            site_packages = Path(raw).resolve()
            called: list[str] = []

            def version(name: str) -> str:
                called.append(f"version:{name}")
                return "0.18.2"

            upstream_main = mock.Mock(name="upstream_main")
            bundled_skills_root = Path(raw).resolve() / "bundled-skills"
            bundled_skills_root.mkdir()
            (Path(raw).resolve() / "gh-config").mkdir(mode=0o700)
            (Path(raw).resolve() / "xdg-config").mkdir(mode=0o700)
            (Path(raw).resolve() / "codex-home").mkdir(mode=0o700)

            def sync_skills_impl(*, quiet: bool) -> dict[str, object]:
                self.assertTrue(quiet)
                self.assertEqual(
                    os.environ.get("HERMES_BUNDLED_SKILLS"),
                    str(bundled_skills_root),
                )
                return valid_skills_sync_result()

            sync_skills = mock.Mock(side_effect=sync_skills_impl)
            anthropic_adapter = types.SimpleNamespace(
                __file__=str(site_packages / "agent/anthropic_adapter.py"),
                read_claude_code_credentials=lambda: {"accessToken": CANARY},
                _read_claude_code_credentials_from_keychain=lambda: {"accessToken": CANARY},
                _read_claude_code_credentials_from_file=lambda: {"accessToken": CANARY},
            )
            modules = {
                "hermes_cli": types.SimpleNamespace(
                    __version__="0.18.2",
                    __release_date__="2026.7.7.2",
                    __file__=str(site_packages / "hermes_cli/__init__.py"),
                ),
                "hermes_cli.env_loader": types.SimpleNamespace(
                    __file__=str(site_packages / "hermes_cli/env_loader.py"),
                    load_hermes_dotenv=lambda **_kwargs: [],
                ),
                "hermes_cli.config": types.SimpleNamespace(
                    __file__=str(site_packages / "hermes_cli/config.py"),
                    apply_terminal_config_to_env=lambda **_kwargs: {},
                ),
                "hermes_cli.runtime_provider": types.SimpleNamespace(
                    __file__=str(site_packages / "hermes_cli/runtime_provider.py"),
                    load_pool=lambda provider: provider,
                ),
                "agent.credential_pool": types.SimpleNamespace(
                    __file__=str(site_packages / "agent/credential_pool.py"),
                    load_pool=lambda provider: provider,
                ),
                "agent.anthropic_adapter": anthropic_adapter,
                "tools.skills_sync": types.SimpleNamespace(
                    __file__=str(site_packages / "tools/skills_sync.py"),
                    sync_skills=sync_skills,
                ),
                "tui_gateway.entry": types.SimpleNamespace(
                    __file__=str(site_packages / "tui_gateway/entry.py"),
                    main=upstream_main,
                ),
            }

            def importer(name: str) -> object:
                called.append(f"import:{name}")
                return modules[name]

            payload = self.launcher.parse_bootstrap_payload(valid_payload())
            with mock.patch.dict(
                os.environ,
                {
                    "DEEPSEEK_API_KEY": CANARY,
                    "HERMES_HOME": str(Path(raw).resolve()),
                },
                clear=True,
            ):
                loaded = self.launcher.load_upstream_gateway(
                    site_packages,
                    payload,
                    Path(raw).resolve(),
                    bundled_skills_root,
                    version_getter=version,
                    importer=importer,
                )

            self.assertIs(loaded, upstream_main)
            self.assertEqual(
                called,
                [
                    "version:hermes-agent",
                    "import:hermes_cli",
                    "import:agent.credential_pool",
                    "import:agent.anthropic_adapter",
                    "import:hermes_cli.runtime_provider",
                    "import:hermes_cli.env_loader",
                    "import:hermes_cli.config",
                    "import:tools.skills_sync",
                    "import:tui_gateway.entry",
                ],
            )
            sync_skills.assert_called_once_with(quiet=True)
            self.assertIsNone(anthropic_adapter.read_claude_code_credentials())
            self.assertIsNone(anthropic_adapter._read_claude_code_credentials_from_keychain())
            self.assertIsNone(anthropic_adapter._read_claude_code_credentials_from_file())
            self.assertIs(
                modules["hermes_cli.runtime_provider"].load_pool,
                modules["agent.credential_pool"].load_pool,
            )

    def test_refuses_partial_or_out_of_origin_bundled_skills_sync(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            site_packages = Path(raw).resolve() / "site-packages"
            site_packages.mkdir()
            profile_home = Path(raw).resolve() / "profile-home"
            profile_home.mkdir(mode=0o700)
            for child in ("gh-config", "xdg-config", "codex-home"):
                (profile_home / child).mkdir(mode=0o700)
            workspace = Path(raw).resolve() / "workspace"
            workspace.mkdir()
            bundled_skills = Path(raw).resolve() / "bundled-skills"
            bundled_skills.mkdir()
            payload = self.launcher.parse_bootstrap_payload(valid_payload())

            def registry(
                sync_file: Path, result: object
            ) -> tuple[dict[str, object], list[bool]]:
                sync_calls: list[bool] = []

                def sync_skills(*, quiet: bool) -> object:
                    sync_calls.append(quiet)
                    return result

                modules = {
                    "hermes_cli": types.SimpleNamespace(
                        __version__="0.18.2",
                        __release_date__="2026.7.7.2",
                        __file__=str(site_packages / "hermes_cli/__init__.py"),
                    ),
                    "hermes_cli.env_loader": types.SimpleNamespace(
                        __file__=str(site_packages / "hermes_cli/env_loader.py"),
                        load_hermes_dotenv=lambda **_kwargs: [],
                    ),
                    "hermes_cli.config": types.SimpleNamespace(
                        __file__=str(site_packages / "hermes_cli/config.py"),
                        apply_terminal_config_to_env=lambda **_kwargs: {},
                    ),
                    "hermes_cli.runtime_provider": types.SimpleNamespace(
                        __file__=str(site_packages / "hermes_cli/runtime_provider.py"),
                        load_pool=lambda provider: provider,
                    ),
                    "agent.credential_pool": types.SimpleNamespace(
                        __file__=str(site_packages / "agent/credential_pool.py"),
                        load_pool=lambda provider: provider,
                    ),
                    "agent.anthropic_adapter": types.SimpleNamespace(
                        __file__=str(site_packages / "agent/anthropic_adapter.py"),
                        read_claude_code_credentials=lambda: None,
                        _read_claude_code_credentials_from_keychain=lambda: None,
                        _read_claude_code_credentials_from_file=lambda: None,
                    ),
                    "tools.skills_sync": types.SimpleNamespace(
                        __file__=str(sync_file),
                        sync_skills=sync_skills,
                    ),
                    "tui_gateway.entry": types.SimpleNamespace(
                        __file__=str(site_packages / "tui_gateway/entry.py"),
                        main=lambda: None,
                    ),
                }
                return modules, sync_calls

            cases = (
                (
                    site_packages / "tools/skills_sync.py",
                    valid_skills_sync_result(copied=[f"skill-{index}" for index in range(71)]),
                ),
                (site_packages / "tools/skills_sync.py", valid_skills_sync_result(skipped=True)),
                (Path(raw).resolve() / "shadow/skills_sync.py", valid_skills_sync_result()),
            )
            for index, (sync_file, result) in enumerate(cases):
                modules, sync_calls = registry(sync_file, result)
                with self.subTest(sync_file=sync_file, result=result):
                    with mock.patch.dict(
                        os.environ, {"HERMES_HOME": str(profile_home)}, clear=True
                    ):
                        with self.assertRaises(self.launcher.LauncherRefusal):
                            self.launcher.load_upstream_gateway(
                                site_packages,
                                payload,
                                workspace,
                                bundled_skills,
                                version_getter=lambda _name: "0.18.2",
                                importer=lambda name, modules=modules: modules[name],
                            )
                    self.assertEqual(sync_calls, [True] if index < 2 else [])

    def test_refuses_wrong_or_missing_wheel_and_non_callable_entrypoint(self) -> None:
        for value in ("0.18.1", "0.18.2.dev1", "v2026.7.7.2"):
            with self.subTest(value=value):
                with self.assertRaises(self.launcher.LauncherRefusal):
                    self.launcher.load_upstream_gateway(
                        Path("/managed/site-packages"),
                        self.launcher.parse_bootstrap_payload(valid_payload()),
                        Path("/managed/workspace"),
                        Path("/managed/bundled-skills"),
                        version_getter=lambda _name, value=value: value,
                        importer=lambda _name: types.SimpleNamespace(main=lambda: None),
                    )

    def test_refuses_release_or_module_origin_drift(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            site_packages = Path(raw).resolve()
            profile_home = site_packages / "profile-home"
            profile_home.mkdir(mode=0o700)
            for child in ("gh-config", "xdg-config", "codex-home"):
                (profile_home / child).mkdir(mode=0o700)
            workspace = site_packages / "workspace"
            workspace.mkdir()
            bundled_skills = site_packages / "bundled-skills"
            bundled_skills.mkdir()
            payload = self.launcher.parse_bootstrap_payload(valid_payload())

            def modules(release: str, entry_file: Path) -> dict[str, object]:
                return {
                    "hermes_cli": types.SimpleNamespace(
                        __version__="0.18.2",
                        __release_date__=release,
                        __file__=str(site_packages / "hermes_cli/__init__.py"),
                    ),
                    "hermes_cli.env_loader": types.SimpleNamespace(
                        __file__=str(site_packages / "hermes_cli/env_loader.py"),
                        load_hermes_dotenv=lambda **_kwargs: [],
                    ),
                    "hermes_cli.config": types.SimpleNamespace(
                        __file__=str(site_packages / "hermes_cli/config.py"),
                        apply_terminal_config_to_env=lambda **_kwargs: {},
                    ),
                    "hermes_cli.runtime_provider": types.SimpleNamespace(
                        __file__=str(site_packages / "hermes_cli/runtime_provider.py"),
                        load_pool=lambda provider: provider,
                    ),
                    "agent.credential_pool": types.SimpleNamespace(
                        __file__=str(site_packages / "agent/credential_pool.py"),
                        load_pool=lambda provider: provider,
                    ),
                    "agent.anthropic_adapter": types.SimpleNamespace(
                        __file__=str(site_packages / "agent/anthropic_adapter.py"),
                        read_claude_code_credentials=lambda: None,
                        _read_claude_code_credentials_from_keychain=lambda: None,
                        _read_claude_code_credentials_from_file=lambda: None,
                    ),
                    "tools.skills_sync": types.SimpleNamespace(
                        __file__=str(site_packages / "tools/skills_sync.py"),
                        sync_skills=lambda **_kwargs: valid_skills_sync_result(),
                    ),
                    "tui_gateway.entry": types.SimpleNamespace(
                        __file__=str(entry_file),
                        main=lambda: None,
                    ),
                }

            for release, entry_file in (
                ("2026.7.7.1", site_packages / "tui_gateway/entry.py"),
                ("2026.7.7.2", Path(raw).parent / "shadow/entry.py"),
            ):
                registry = modules(release, entry_file)
                with self.subTest(release=release, entry_file=entry_file):
                    with mock.patch.dict(
                        os.environ, {"HERMES_HOME": str(profile_home)}, clear=True
                    ):
                        with self.assertRaises(self.launcher.LauncherRefusal):
                            self.launcher.load_upstream_gateway(
                                site_packages,
                                payload,
                                workspace,
                                bundled_skills,
                                version_getter=lambda _name: "0.18.2",
                                importer=lambda name, registry=registry: registry[name],
                            )

    def test_native_gateway_call_is_not_wrapped_or_replaced(self) -> None:
        upstream_main = mock.Mock(return_value=None)
        result = self.launcher.run_upstream_gateway(upstream_main)
        upstream_main.assert_called_once_with()
        self.assertEqual(result, 0)

    def test_upstream_clean_system_exit_is_success_and_other_exit_is_refused(self) -> None:
        def clean_exit() -> None:
            raise SystemExit(0)

        def failed_exit() -> None:
            raise SystemExit(CANARY)

        self.assertEqual(self.launcher.run_upstream_gateway(clean_exit), 0)
        with self.assertRaises(self.launcher.LauncherRefusal) as caught:
            self.launcher.run_upstream_gateway(failed_exit)
        self.assertNotIn(CANARY, repr(caught.exception))


class MainContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.launcher = load_launcher()

    def test_main_orders_trusted_bootstrap_before_third_party_import(self) -> None:
        payload = self.launcher.parse_bootstrap_payload(valid_payload())
        state = types.SimpleNamespace(
            payload=payload,
            site_packages=Path("/managed/site-packages"),
            workspace_root=Path("/managed/workspace"),
            bundled_skills_root=Path("/managed/bundled-skills"),
        )
        calls: list[str] = []

        with (
            mock.patch.object(
                self.launcher,
                "bootstrap_pre_import",
                side_effect=lambda: calls.append("bootstrap") or state,
            ),
            mock.patch.object(
                self.launcher,
                "load_upstream_gateway",
                side_effect=lambda site, loaded_payload, workspace_root, bundled_skills_root: (
                    calls.append("import")
                    or self.assertEqual(site, state.site_packages)
                    or self.assertIs(loaded_payload, payload)
                    or self.assertEqual(workspace_root, state.workspace_root)
                    or self.assertEqual(
                        bundled_skills_root,
                        state.bundled_skills_root,
                    )
                    or (lambda: calls.append("gateway"))
                ),
            ),
        ):
            result = self.launcher.main()

        self.assertEqual(result, 0)
        self.assertEqual(calls, ["bootstrap", "import", "gateway"])

    def test_main_uses_generic_non_reflective_failure(self) -> None:
        stderr = io.StringIO()
        with (
            mock.patch.object(
                self.launcher,
                "bootstrap_pre_import",
                side_effect=RuntimeError(CANARY),
            ),
            mock.patch.object(self.launcher.sys, "stderr", stderr),
        ):
            result = self.launcher.main()

        self.assertEqual(result, self.launcher.EX_CONFIG)
        self.assertEqual(stderr.getvalue(), self.launcher.GENERIC_STDERR)
        self.assertNotIn(CANARY, stderr.getvalue())

    def test_isolated_process_ignores_python_injection_before_fd_refusal(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            marker = root / "sitecustomize-ran"
            (root / "sitecustomize.py").write_text(
                f"from pathlib import Path\nPath({str(marker)!r}).write_text('unsafe')\n",
                encoding="utf-8",
            )
            env = {
                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                "HERMES_HOME": str(root / "home"),
                "PYTHONPATH": str(root),
                "OPENAI_API_KEY": CANARY,
            }
            (root / "home").mkdir(mode=0o700)
            result = subprocess.run(
                [sys.executable, "-I", "-S", "-B", "-u", "-X", "utf8", str(LAUNCHER)],
                check=False,
                capture_output=True,
                text=True,
                env=env,
                timeout=3,
            )

            self.assertEqual(result.returncode, self.launcher.EX_CONFIG)
            self.assertEqual(result.stdout, "")
            self.assertEqual(result.stderr, self.launcher.GENERIC_STDERR)
            self.assertFalse(marker.exists())
            self.assertNotIn(CANARY, result.stderr)


class SourceBoundaryTests(unittest.TestCase):
    def test_launcher_has_no_quarantine_runtime_or_audit_hook(self) -> None:
        source = LAUNCHER.read_text(encoding="utf-8")
        self.assertNotIn("opentrad_hermes_runtime", source)
        self.assertNotIn("sys.addaudithook", source)
        self.assertNotIn("brokerPort", source)
        self.assertNotIn("HERMES_SAFE_MODE", source)
        self.assertIn("tui_gateway.entry", source)

    def test_launcher_stays_small_enough_to_audit(self) -> None:
        source = LAUNCHER.read_text(encoding="utf-8")
        self.assertLessEqual(len(source.splitlines()), 960)


if __name__ == "__main__":
    unittest.main()
