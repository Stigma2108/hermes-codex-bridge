import hashlib
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

try:
    from hermes.contracts import ContractError, load_event, sender_fingerprint
except ImportError:
    from contracts import ContractError, load_event, sender_fingerprint

EVENT_ID = "evt_019f74b5-c168-7381-9629-d395da0255f7"


def event(summary="safe response", **changes):
    value = {
        "schema": "hermes-codex-interaction-event/v3", "event_id": EVENT_ID,
        "kind": "FINAL_RESPONSE", "created_at": "2026-07-18T12:00:00Z",
        "expires_at": "2026-07-25T12:00:00Z",
        "thread": {"id": "t", "turn_id": "u", "title": "Chat", "project_label": "Project", "cwd_label": "Work"},
        "message": {"summary": summary, "markdown_path": None, "is_replyable": True},
        "allowed_actions": ["REPLY"],
        "integrity": {"producer": "codex-windows-local", "content_sha256": hashlib.sha256(summary.encode()).hexdigest()},
    }
    value.update(changes)
    return value


class ContractsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name) / EVENT_ID
        self.directory.mkdir()

    def tearDown(self): self.temp.cleanup()

    def write(self, value):
        (self.directory / "event.json").write_text(json.dumps(value), encoding="utf-8")

    def test_validates_schema_hash_ttl_and_sizes(self):
        self.write(event())
        value, payload = load_event(self.directory, datetime(2026, 7, 18, 13, tzinfo=timezone.utc))
        self.assertEqual(value["event_id"], EVENT_ID)
        self.assertEqual(payload, "safe response")
        for bad in [event(schema="v2"), event(integrity={"producer": "p", "content_sha256": "0" * 64}), event(expires_at="2026-07-18T12:00:00Z")]:
            self.write(bad)
            with self.assertRaises(ContractError): load_event(self.directory, datetime(2026, 7, 18, 13, tzinfo=timezone.utc))

    def test_reads_exact_message_bytes_and_rejects_traversal(self):
        payload = "x" * 4000
        (self.directory / "message.md").write_text(payload, encoding="utf-8", newline="")
        value = event("summary")
        value["message"]["markdown_path"] = "message.md"
        value["integrity"]["content_sha256"] = hashlib.sha256(payload.encode()).hexdigest()
        self.write(value)
        self.assertEqual(load_event(self.directory, datetime(2026, 7, 18, 13, tzinfo=timezone.utc))[1], payload)
        value["message"]["markdown_path"] = "../message.md"
        self.write(value)
        with self.assertRaises(ContractError): load_event(self.directory, datetime(2026, 7, 18, 13, tzinfo=timezone.utc))

    def test_sender_fingerprint_has_exact_domain_and_canonical_identity(self):
        self.assertEqual(sender_fingerprint(123456789), "2361d05fad5228ffc0e66045df95d865361b0c42ba1f47e1e113f2e7ba547e95")
        for invalid in (True, 0, -1, "123456789", 1 << 63):
            with self.assertRaises(ContractError): sender_fingerprint(invalid)
