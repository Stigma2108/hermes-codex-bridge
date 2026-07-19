import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from datetime import datetime, timezone

import doctor
from watcher import Watcher


class NoNetworkTelegram:
    def send(self, *_args, **_kwargs):
        raise AssertionError("network used")


class DoctorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hc3-doctor-")
        self.root = Path(self.temp.name)
        self.queue = self.root / "Queue" / "bridge" / "v3"
        self.runtime = self.root / "runtime"
        self.env_file = self.root / "bridge.env"
        self.queue.mkdir(parents=True)
        (self.queue / "interactions").mkdir()
        self.runtime.mkdir()
        for name in doctor.REQUIRED_RUNTIME_FILES:
            (self.runtime / name).write_text("# installed runtime\n", encoding="utf-8")
        Watcher(self.queue, NoNetworkTelegram()).scan_once()
        self.heartbeat = self.queue / "health" / "hermes-heartbeat.json"
        self.env_file.write_text(
            "HERMES_TELEGRAM_TOKEN=private-token\nHERMES_TELEGRAM_CHAT_ID=123456789\n",
            encoding="ascii",
        )
        os.chmod(self.env_file, 0o600)

    def tearDown(self):
        self.temp.cleanup()

    def run_cli(self, *extra):
        return subprocess.run(
            [
                sys.executable,
                str(Path(__file__).with_name("doctor.py")),
                "--queue-root",
                str(self.queue),
                "--env-file",
                str(self.env_file),
                "--runtime-root",
                str(self.runtime),
                *extra,
            ],
            text=True,
            capture_output=True,
            check=False,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )

    def test_healthy_report_is_redacted_and_probe_is_cleaned_up(self):
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["schema"], "hermes-codex-doctor/v3")
        self.assertTrue(report["healthy"])
        self.assertEqual(
            list(report["checks"]),
            ["paths", "environment", "runtime", "queueWrite", "serviceHeartbeat"],
        )
        self.assertNotIn(str(self.root), result.stdout + result.stderr)
        self.assertNotIn("private-token", result.stdout + result.stderr)
        health = self.queue / "health"
        self.assertTrue(health.is_dir())
        self.assertEqual(list(health.iterdir()), [self.heartbeat])

    def test_missing_and_relative_inputs_have_stable_codes(self):
        missing = self.root / "missing"
        report = doctor.run_checks(missing, self.env_file, self.runtime)
        self.assertFalse(report["healthy"])
        self.assertEqual(report["checks"]["paths"]["code"], "DOCTOR_QUEUE_MISSING")
        report = doctor.run_checks(Path("relative"), self.env_file, self.runtime)
        self.assertEqual(report["checks"]["paths"]["code"], "DOCTOR_PATH_ABSOLUTE")

    def test_symlinked_input_is_rejected_without_following_it(self):
        link = self.root / "queue-link"
        try:
            link.symlink_to(self.queue, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"symlink unavailable: {error}")
        report = doctor.run_checks(link, self.env_file, self.runtime)
        self.assertFalse(report["healthy"])
        self.assertEqual(report["checks"]["paths"]["code"], "DOCTOR_PATH_SYMLINK")

    @unittest.skipIf(os.name == "nt", "Windows filesystems do not expose reliable Unix mode bits")
    def test_environment_requires_private_mode(self):
        os.chmod(self.env_file, 0o640)
        report = doctor.run_checks(self.queue, self.env_file, self.runtime)
        self.assertEqual(report["checks"]["environment"]["code"], "DOCTOR_ENV_MODE")

    def test_environment_accepts_installer_comments_blank_lines_and_additional_unique_entries(self):
        self.env_file.write_text(
            "# installed values\n\nHERMES_TELEGRAM_TOKEN=present\n"
            "HERMES_TELEGRAM_CHAT_ID=123456789\nHERMES_LOG_LEVEL=info\n",
            encoding="utf-8",
        )
        report = doctor.run_checks(self.queue, self.env_file, self.runtime)
        self.assertEqual(report["checks"]["environment"]["code"], "DOCTOR_ENV_OK")

    def test_environment_rejects_malformed_duplicates_and_invalid_required_values(self):
        for content, code in (
            ("HERMES_TELEGRAM_TOKEN=present\n", "DOCTOR_ENV_REQUIRED"),
            ("HERMES_TELEGRAM_TOKEN=x\nHERMES_TELEGRAM_CHAT_ID=\n", "DOCTOR_ENV_REQUIRED"),
            ("HERMES_TELEGRAM_TOKEN=x\nmalformed\nHERMES_TELEGRAM_CHAT_ID=1\n", "DOCTOR_ENV_FORMAT"),
            ("HERMES_TELEGRAM_TOKEN=x\nHERMES_TELEGRAM_CHAT_ID=1\nHERMES_TELEGRAM_TOKEN=y\n", "DOCTOR_ENV_FORMAT"),
            ("HERMES_TELEGRAM_TOKEN=x\nHERMES_TELEGRAM_CHAT_ID=01\n", "DOCTOR_ENV_FORMAT"),
            ("HERMES_TELEGRAM_TOKEN=x\nHERMES_TELEGRAM_CHAT_ID=12345678901234567890\n", "DOCTOR_ENV_FORMAT"),
        ):
            with self.subTest(code=code, content=content):
                self.env_file.write_text(content, encoding="ascii")
                report = doctor.run_checks(self.queue, self.env_file, self.runtime)
                self.assertEqual(report["checks"]["environment"]["code"], code)

    def test_missing_runtime_file_has_stable_code(self):
        (self.runtime / doctor.REQUIRED_RUNTIME_FILES[0]).unlink()
        report = doctor.run_checks(self.queue, self.env_file, self.runtime)
        self.assertEqual(report["checks"]["runtime"]["code"], "DOCTOR_RUNTIME_MISSING")

    def test_write_probe_failure_is_redacted_and_leaves_no_partial_file(self):
        secret = "must-never-appear"
        with mock.patch("doctor.os.open", side_effect=OSError(secret)):
            report = doctor.run_checks(self.queue, self.env_file, self.runtime)
        encoded = json.dumps(report)
        self.assertEqual(report["checks"]["queueWrite"]["code"], "DOCTOR_QUEUE_WRITE")
        self.assertNotIn(secret, encoded)
        self.assertEqual(list((self.queue / "health").glob("*.probe")), [])

    def test_default_diagnostics_never_open_a_network_connection(self):
        with mock.patch.object(socket, "create_connection", side_effect=AssertionError("network used")):
            report = doctor.run_checks(self.queue, self.env_file, self.runtime)
        self.assertTrue(report["healthy"])

    def test_service_health_uses_bounded_freshness_not_an_instantaneous_process_sample(self):
        self.heartbeat.write_text(json.dumps({
            "schema": "hermes-codex-hermes-heartbeat/v3",
            "observed_at": "2026-07-19T12:00:00Z",
            "status": "ok",
        }), encoding="utf-8")
        report = doctor.run_checks(
            self.queue,
            self.env_file,
            self.runtime,
            now=lambda: doctor.datetime.fromisoformat("2026-07-19T12:00:10+00:00"),
        )
        self.assertEqual(report["checks"]["serviceHeartbeat"]["code"], "DOCTOR_SERVICE_HEARTBEAT_OK")

    def test_missing_service_heartbeat_is_unhealthy(self):
        self.heartbeat.unlink()
        report = doctor.run_checks(self.queue, self.env_file, self.runtime)
        self.assertFalse(report["healthy"])
        self.assertEqual(report["checks"]["serviceHeartbeat"]["code"], "DOCTOR_SERVICE_HEARTBEAT_MISSING")

    def test_stale_service_heartbeat_is_unhealthy(self):
        self.heartbeat.write_text(json.dumps({
            "schema": "hermes-codex-hermes-heartbeat/v3",
            "observed_at": "2026-07-19T11:00:00Z",
            "status": "ok",
        }), encoding="utf-8")
        report = doctor.run_checks(
            self.queue,
            self.env_file,
            self.runtime,
            now=lambda: doctor.datetime.fromisoformat("2026-07-19T12:00:00+00:00"),
        )
        self.assertFalse(report["healthy"])
        self.assertEqual(report["checks"]["serviceHeartbeat"]["code"], "DOCTOR_SERVICE_HEARTBEAT_STALE")

    def test_unstable_service_heartbeat_is_unhealthy(self):
        self.heartbeat.write_text(json.dumps({
            "schema": "hermes-codex-hermes-heartbeat/v3",
            "observed_at": datetime.now(timezone.utc).isoformat(),
            "status": "starting",
        }), encoding="utf-8")
        report = doctor.run_checks(self.queue, self.env_file, self.runtime)
        self.assertFalse(report["healthy"])
        self.assertEqual(report["checks"]["serviceHeartbeat"]["code"], "DOCTOR_SERVICE_HEARTBEAT_INVALID")


if __name__ == "__main__":
    unittest.main()
