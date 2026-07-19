import hashlib
import json
import os
import tempfile
import threading
import unittest
from unittest import mock
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    from hermes.telegram import TelegramClient, TelegramError
    from hermes.watcher import Watcher
    from hermes.test_contracts import EVENT_ID, event
except ImportError:
    from telegram import TelegramClient, TelegramError
    from watcher import Watcher
    from test_contracts import EVENT_ID, event


class Clock:
    def __init__(self): self.value = datetime(2026, 7, 18, 13, tzinfo=timezone.utc)
    def __call__(self): return self.value
    def advance(self, seconds): self.value += timedelta(seconds=seconds)


class FakeTelegram:
    def __init__(self, outcomes): self.outcomes, self.calls = list(outcomes), []
    def send(self, text, event_id, allowed_actions):
        self.calls.append((text, event_id, allowed_actions))
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception): raise outcome
        return outcome


class WatcherTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.queue = Path(self.temp.name) / "bridge" / "v3"
        self.interaction = self.queue / "interactions" / EVENT_ID
        self.interaction.mkdir(parents=True)
        (self.interaction / "event.json").write_text(json.dumps(event()), encoding="utf-8")
        self.clock = Clock()

    def tearDown(self): self.temp.cleanup()

    def read(self, name): return json.loads((self.interaction / name).read_text(encoding="utf-8"))

    def test_delivery_only_after_success_and_restart_persists_attempts(self):
        first = FakeTelegram([RuntimeError("offline")])
        Watcher(self.queue, first, now=self.clock).scan_once()
        self.assertFalse((self.interaction / "delivery.json").exists())
        self.clock.advance(2)
        second = FakeTelegram([{"message_id": 77}])
        Watcher(self.queue, second, now=self.clock).scan_once()
        self.assertEqual(self.read("delivery.json")["delivery_ref"], "tgmsg_77")
        self.assertEqual(self.read("delivery.json")["attempts"], 2)
        self.assertNotIn("safe response", (Path(self.temp.name) / "bridge" / "v3" / "state" / f"{EVENT_ID}.json").read_text())

    def test_duplicate_and_concurrent_scans_deliver_once(self):
        telegram = FakeTelegram([{"message_id": 1}])
        watcher = Watcher(self.queue, telegram, now=self.clock)
        threads = [threading.Thread(target=watcher.scan_once) for _ in range(4)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        watcher.scan_once()
        self.assertEqual(len(telegram.calls), 1)

    def test_expired_terminal_invalid_and_symlink_are_skipped(self):
        telegram = FakeTelegram([])
        (self.interaction / "receipt.json").write_text("{}")
        Watcher(self.queue, telegram, now=self.clock).scan_once()
        self.assertEqual(telegram.calls, [])
        (self.interaction / "receipt.json").unlink()
        bad = json.loads((self.interaction / "event.json").read_text())
        bad["schema"] = "wrong"
        (self.interaction / "event.json").write_text(json.dumps(bad))
        Watcher(self.queue, telegram, now=self.clock).scan_once()
        link = self.queue / "interactions" / "evt_11111111-1111-1111-1111-111111111111"
        try:
            os.symlink(self.interaction, link, target_is_directory=True)
        except OSError:
            return
        Watcher(self.queue, telegram, now=self.clock).scan_once()
        self.assertEqual(telegram.calls, [])

    def test_secret_like_payload_is_rejected_before_send(self):
        secretish = "Authorization: Bearer sample_value_that_must_never_leave"
        value = event(secretish)
        (self.interaction / "event.json").write_text(json.dumps(value))
        telegram = FakeTelegram([])
        Watcher(self.queue, telegram, now=self.clock).scan_once()
        self.assertEqual(telegram.calls, [])

    def test_429_retry_after_controls_retry_and_message_has_safe_routing(self):
        telegram = FakeTelegram([TelegramError("TELEGRAM_RATE_LIMIT", retry_after=9), {"message_id": 5}])
        watcher = Watcher(self.queue, telegram, now=self.clock)
        watcher.scan_once(); self.clock.advance(8); watcher.scan_once()
        self.assertEqual(len(telegram.calls), 1)
        self.clock.advance(1); watcher.scan_once()
        text, event_id, _ = telegram.calls[-1]
        self.assertTrue(text.startswith("🤖 Codex\nПроект: Project\nЧат: Chat\nHC3:019f74b5-c168-7381-9629-d395da0255f7\nТип: Финальный отчёт\n\n"))
        self.assertIn("HC3:019f74b5-c168-7381-9629-d395da0255f7", text.splitlines()[:4])
        self.assertIn("Тип: Финальный отчёт", text)
        self.assertTrue(text.endswith("HC3:019f74b5-c168-7381-9629-d395da0255f7"))
        self.assertEqual(event_id, EVENT_ID)

    def test_long_message_keeps_reply_route_inside_short_gateway_preview(self):
        value = event("x" * 3000)
        value["thread"]["project_label"] = "P" * 80
        value["thread"]["title"] = "T" * 120
        text = Watcher._message(value, value["message"]["summary"])
        route = "HC3:019f74b5-c168-7381-9629-d395da0255f7"
        self.assertIn(route, text[:256])
        self.assertTrue(text.endswith(route))

    def test_approval_message_uses_reply_commands_without_adapter_callbacks(self):
        approval = event(kind="APPROVAL_REQUEST", expires_at="2026-07-18T20:00:00Z", allowed_actions=["APPROVE_ONCE", "DECLINE"])
        (self.interaction / "event.json").write_text(json.dumps(approval), encoding="utf-8")
        telegram = FakeTelegram([{"message_id": 9}])
        Watcher(self.queue, telegram, now=self.clock).scan_once()
        text = telegram.calls[0][0]
        self.assertIn("ОДОБРИТЬ ОДИН РАЗ", text)
        self.assertIn("ОТКЛОНИТЬ", text)
        self.assertNotIn("/approve_once", text)
        self.assertNotIn("/decline", text)

    def test_telegram_request_has_no_callback_markup_or_parse_mode(self):
        captured = {}
        def opener(request, timeout):
            captured["url"] = request.full_url; captured["body"] = request.data.decode(); captured["timeout"] = timeout
            class Response:
                def __enter__(self): return self
                def __exit__(self, *_): pass
                def read(self, *_): return b'{"ok":true,"result":{"message_id":8}}'
            return Response()
        with mock.patch.dict(os.environ, {"HERMES_TELEGRAM_TOKEN": "example-token", "HERMES_TELEGRAM_CHAT_ID": "example-owner"}, clear=False):
            result = TelegramClient(opener=opener).send("safe", EVENT_ID, ["REPLY", "APPROVE_ONCE", "DECLINE"])
        self.assertEqual(result["message_id"], 8)
        self.assertEqual(captured["timeout"], 15)
        self.assertNotIn("parse_mode", captured["body"])
        self.assertNotIn("reply_markup", captured["body"])
        self.assertNotIn("callback_data", captured["body"])
        self.assertNotIn("example-owner", captured["url"])

    def test_scan_writes_a_redacted_heartbeat_and_atomically_replaces_regular_state(self):
        health = self.queue / "health"
        health.mkdir()
        heartbeat = health / "hermes-heartbeat.json"
        heartbeat.write_text('{"status":"old"}\n', encoding="utf-8")
        watcher = Watcher(self.queue, FakeTelegram([{"message_id": 10}]), now=self.clock)

        watcher.scan_once()

        value = json.loads(heartbeat.read_text(encoding="utf-8"))
        self.assertEqual(value, {
            "observed_at": "2026-07-18T13:00:00.000Z",
            "schema": "hermes-codex-hermes-heartbeat/v3",
            "status": "ok",
        })
        self.assertEqual(list(health.glob(".hermes-heartbeat.*.tmp")), [])
        self.assertNotIn("message_id", heartbeat.read_text(encoding="utf-8"))

    def test_heartbeat_refuses_a_symlink_destination(self):
        health = self.queue / "health"
        health.mkdir()
        outside = Path(self.temp.name) / "outside.json"
        outside.write_text("outside\n", encoding="utf-8")
        try:
            (health / "hermes-heartbeat.json").symlink_to(outside)
        except OSError as error:
            self.skipTest(f"symlink unavailable: {error}")
        (self.interaction / "receipt.json").write_text("{}", encoding="utf-8")

        with self.assertRaises(OSError):
            Watcher(self.queue, FakeTelegram([]), now=self.clock).scan_once()
        self.assertEqual(outside.read_text(encoding="utf-8"), "outside\n")

    def test_heartbeat_write_failure_propagates_and_cleans_partial_file(self):
        (self.interaction / "receipt.json").write_text("{}", encoding="utf-8")
        with mock.patch("watcher.os.replace", side_effect=OSError("write failed")):
            with self.assertRaises(OSError):
                Watcher(self.queue, FakeTelegram([]), now=self.clock).scan_once()
        health = self.queue / "health"
        self.assertEqual(list(health.glob(".hermes-heartbeat.*.tmp")), [])
        self.assertFalse((health / "hermes-heartbeat.json").exists())


if __name__ == "__main__": unittest.main()
