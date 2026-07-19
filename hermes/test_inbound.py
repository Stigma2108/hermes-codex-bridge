import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

try:
    from hermes.inbound import InboundError, publish_reply
    from hermes.test_contracts import EVENT_ID, event
except ImportError:
    from inbound import InboundError, publish_reply
    from test_contracts import EVENT_ID, event


NOW = datetime(2026, 7, 18, 13, tzinfo=timezone.utc)
OWNER_ID = 123456789


class InboundTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "interactions"
        self.directory = self.root / EVENT_ID
        self.directory.mkdir(parents=True)
        self.write_event(event())
        self.write_delivery(77)

    def tearDown(self): self.temp.cleanup()

    def write_event(self, value):
        (self.directory / "event.json").write_text(json.dumps(value), encoding="utf-8")

    def write_delivery(self, message_id):
        value = {
            "schema": "hermes-codex-interaction-delivery/v3",
            "event_id": EVENT_ID,
            "delivery_ref": f"tgmsg_{message_id}",
            "created_at": "2026-07-18T12:00:30Z",
            "attempts": 1,
        }
        (self.directory / "delivery.json").write_text(json.dumps(value), encoding="utf-8")

    def publish(self, text, **changes):
        values = {
            "interaction_root": self.root,
            "event_id": EVENT_ID,
            "reply_to_message_id": 77,
            "sender_id": OWNER_ID,
            "owner_id": OWNER_ID,
            "text": text,
            "now": NOW,
        }
        values.update(changes)
        return publish_reply(**values)

    def test_plain_text_gateway_reply_publishes_exact_reply_record(self):
        result = self.publish("Продолжай работу")
        reply = json.loads((self.directory / "reply.json").read_text(encoding="utf-8"))

        self.assertEqual(result, {"event_id": EVENT_ID, "action": "REPLY"})
        self.assertEqual(reply["action"], "REPLY")
        self.assertEqual(reply["text"], "Продолжай работу")
        self.assertEqual(reply["telegram"]["delivery_ref"], "tgmsg_77")
        self.assertEqual(reply["telegram"]["sender_fingerprint"], "2361d05fad5228ffc0e66045df95d865361b0c42ba1f47e1e113f2e7ba547e95")
        if os.name != "nt":
            self.assertEqual(os.stat(self.directory / "reply.json").st_mode & 0o777, 0o600)

    def test_plain_non_slash_approval_and_decline_map_to_exact_actions(self):
        approval = event(
            kind="APPROVAL_REQUEST",
            expires_at="2026-07-18T20:00:00Z",
            allowed_actions=["APPROVE_ONCE", "DECLINE"],
        )
        self.write_event(approval)
        self.assertEqual(self.publish("  ОДОБРИТЬ ОДИН РАЗ  ")["action"], "APPROVE_ONCE")
        self.assertIsNone(json.loads((self.directory / "reply.json").read_text(encoding="utf-8"))["text"])

        (self.directory / "reply.json").unlink()
        self.assertEqual(self.publish("ОТКЛОНИТЬ")["action"], "DECLINE")

    def test_owner_delivery_terminal_and_secret_checks_fail_before_publish(self):
        cases = [
            {"sender_id": OWNER_ID + 1},
            {"reply_to_message_id": 78},
            {"text": "Authorization: Bearer must_not_leave_the_ams"},
        ]
        for changes in cases:
            with self.subTest(changes=changes):
                with self.assertRaises(InboundError): self.publish("safe" if "text" not in changes else changes.pop("text"), **changes)
                self.assertFalse((self.directory / "reply.json").exists())

        (self.directory / "receipt.json").write_text("{}", encoding="utf-8")
        with self.assertRaises(InboundError): self.publish("safe")
        self.assertFalse((self.directory / "reply.json").exists())

    def test_duplicate_reply_is_never_overwritten(self):
        self.publish("first")
        before = (self.directory / "reply.json").read_bytes()
        with self.assertRaises(InboundError): self.publish("second")
        self.assertEqual((self.directory / "reply.json").read_bytes(), before)

    def test_installed_cli_consumes_gateway_reply_via_stdin_and_private_env_file(self):
        env_file = Path(self.temp.name) / "bridge.env"
        env_file.write_text(f"HERMES_TELEGRAM_CHAT_ID={OWNER_ID}\n", encoding="ascii")
        os.chmod(env_file, 0o600)
        request = json.dumps({
            "event_id": EVENT_ID,
            "reply_to_message_id": "77",
            "sender_id": str(OWNER_ID),
            "text": "Продолжай через CLI",
        }, ensure_ascii=False)
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("inbound.py")), "--interaction-root", str(self.root), "--env-file", str(env_file)],
            input=request,
            text=True,
            encoding="utf-8",
            capture_output=True,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["status"], "PUBLISHED")
        self.assertEqual(json.loads((self.directory / "reply.json").read_text(encoding="utf-8"))["text"], "Продолжай через CLI")

    def test_cli_rejects_malformed_gateway_input_without_traceback_or_payload(self):
        env_file = Path(self.temp.name) / "bridge.env"
        env_file.write_text(f"HERMES_TELEGRAM_CHAT_ID={OWNER_ID}\n", encoding="ascii")
        os.chmod(env_file, 0o600)
        secret = "PRIVATE_INPUT_MUST_NOT_APPEAR"
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("inbound.py")), "--interaction-root", str(self.root), "--env-file", str(env_file)],
            input=json.dumps({"reply_to_message_id": 77, "sender_id": OWNER_ID, "text": secret}),
            text=True,
            encoding="utf-8",
            capture_output=True,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stderr, "INBOUND_REJECTED\n")
        self.assertNotIn(secret, result.stdout + result.stderr)


if __name__ == "__main__": unittest.main()
