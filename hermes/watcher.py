"""Durable outbound Hermes watcher for bridge protocol v3."""
from __future__ import annotations

import argparse
import json
import os
import re
import stat
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    from .contracts import ContractError, EVENT_ID_RE, load_event
    from .telegram import TelegramClient, TelegramError
except ImportError:  # direct systemd script execution
    from contracts import ContractError, EVENT_ID_RE, load_event
    from telegram import TelegramClient, TelegramError

SECRET_RE = re.compile(r"(?i)(authorization\s*:|bearer\s+\S{12,}|api[_-]?key\s*[:=]|password\s*[:=]|token\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----)")
TYPE_LABELS = {"FINAL_RESPONSE": "Финальный отчёт", "QUESTION": "Требуется ответ", "APPROVAL_REQUEST": "Требуется подтверждение", "ERROR": "Ошибка", "TASK_COMPLETED": "Задача завершена"}


def _iso(value): return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _write_json_exclusive(path, value):
    data = (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
    except Exception:
        try: path.unlink()
        except OSError: pass
        raise


def _unsafe_path_component(path):
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    for component in reversed([Path(path), *Path(path).parents]):
        try:
            info = os.lstat(component)
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & reparse:
            return True
    return False


def _atomic_heartbeat(queue_root, observed_at):
    if _unsafe_path_component(queue_root):
        raise OSError("HEARTBEAT_PATH")
    queue_info = os.lstat(queue_root)
    if not stat.S_ISDIR(queue_info.st_mode):
        raise OSError("HEARTBEAT_PATH")
    health_root = queue_root / "health"
    health_root.mkdir(mode=0o700, exist_ok=True)
    if _unsafe_path_component(health_root) or not stat.S_ISDIR(os.lstat(health_root).st_mode):
        raise OSError("HEARTBEAT_PATH")
    target = health_root / "hermes-heartbeat.json"
    temporary = health_root / f".hermes-heartbeat.{uuid.uuid4().hex}.tmp"
    data = (json.dumps({
        "schema": "hermes-codex-hermes-heartbeat/v3",
        "observed_at": _iso(observed_at),
        "status": "ok",
    }, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    descriptor = None
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        stream = os.fdopen(descriptor, "wb")
        descriptor = None
        with stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            target_info = os.lstat(target)
        except FileNotFoundError:
            target_info = None
        reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
        if target_info is not None and (not stat.S_ISREG(target_info.st_mode) or stat.S_ISLNK(target_info.st_mode) or getattr(target_info, "st_file_attributes", 0) & reparse):
            raise OSError("HEARTBEAT_PATH")
        os.replace(temporary, target)
    finally:
        if descriptor is not None:
            try: os.close(descriptor)
            except OSError: pass
        try: temporary.unlink()
        except OSError: pass


class Watcher:
    def __init__(self, queue_root, telegram, state_root=None, now=None, sleep=None):
        self.queue_root = Path(queue_root)
        self.interactions = self.queue_root / "interactions"
        self.state_root = Path(state_root) if state_root else self.queue_root / "state"
        self.telegram = telegram
        self.now = now or (lambda: datetime.now(timezone.utc))
        self.sleep = sleep or time.sleep
        self._scan_lock = threading.Lock()

    def _load_state(self, event_id):
        path = self.state_root / f"{event_id}.json"
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            return {"attempts": int(value.get("attempts", 0)), "retry_at": str(value.get("retry_at", "1970-01-01T00:00:00Z"))}
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return {"attempts": 0, "retry_at": "1970-01-01T00:00:00Z"}

    def _save_state(self, event_id, attempts, retry_at):
        self.state_root.mkdir(parents=True, exist_ok=True)
        path = self.state_root / f"{event_id}.json"
        temporary = self.state_root / f".{event_id}.{os.getpid()}.{threading.get_ident()}.tmp"
        temporary.write_text(json.dumps({"attempts": attempts, "retry_at": _iso(retry_at)}, sort_keys=True) + "\n", encoding="utf-8")
        os.replace(temporary, path)

    def _claim(self, event_id):
        self.state_root.mkdir(parents=True, exist_ok=True)
        path = self.state_root / f".{event_id}.sending"
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600); os.close(fd); return path
        except FileExistsError:
            return None

    @staticmethod
    def _message(event, text):
        if SECRET_RE.search(text): raise ContractError("EVENT_SECRET")
        def clean(value, limit):
            result = re.sub(r"[\x00-\x1f\x7f]+", " ", value).strip()
            return result[:limit]
        project = clean(event["thread"]["project_label"], 48)
        title = clean(event["thread"]["title"], 96)
        body = text if len(text) <= 3500 else text[:3200].rstrip() + "\n\n[summary truncated; full text remains in Queue]"
        instructions = ""
        if "APPROVE_ONCE" in event["allowed_actions"] or "DECLINE" in event["allowed_actions"]:
            instructions = "\n\nОтветьте на это сообщение точным текстом:\nОДОБРИТЬ ОДИН РАЗ\nили\nОТКЛОНИТЬ"
        elif "REPLY" in event["allowed_actions"]:
            instructions = "\n\nОтветьте на это сообщение обычным текстом."
        route = f"HC3:{event['event_id'][4:]}"
        return f"🤖 Codex\nПроект: {project}\nЧат: {title}\n{route}\nТип: {TYPE_LABELS[event['kind']]}\n\n{body}{instructions}\n\n{route}"

    def _process(self, directory):
        if any((directory / name).exists() for name in ("delivery.json", "reply.json", "receipt.json")): return
        try:
            event, payload = load_event(directory, self.now())
        except (ContractError, OSError):
            return
        state = self._load_state(event["event_id"])
        try:
            retry_at = datetime.fromisoformat(state["retry_at"].replace("Z", "+00:00"))
        except ValueError:
            retry_at = datetime(1970, 1, 1, tzinfo=timezone.utc)
        if self.now() < retry_at: return
        claim = self._claim(event["event_id"])
        if claim is None: return
        try:
            if (directory / "delivery.json").exists(): return
            attempts = state["attempts"] + 1
            try:
                message = self._message(event, payload)
            except ContractError:
                return
            try:
                result = self.telegram.send(message, event["event_id"], event["allowed_actions"])
            except Exception as error:
                delay = min(300, 2 ** attempts)
                if isinstance(error, TelegramError) and error.retry_after is not None: delay = max(delay, error.retry_after)
                self._save_state(event["event_id"], attempts, self.now() + timedelta(seconds=delay))
                return
            delivery = {"schema": "hermes-codex-interaction-delivery/v3", "event_id": event["event_id"], "delivery_ref": f"tgmsg_{result['message_id']}", "created_at": _iso(self.now()), "attempts": attempts}
            try: _write_json_exclusive(directory / "delivery.json", delivery)
            except FileExistsError: pass
            self._save_state(event["event_id"], attempts, self.now())
        finally:
            try: claim.unlink()
            except OSError: pass

    def scan_once(self):
        with self._scan_lock:
            try: directories = list(self.interactions.iterdir())
            except OSError: return 0
            count = 0
            for directory in directories:
                if not EVENT_ID_RE.fullmatch(directory.name) or directory.is_symlink() or not directory.is_dir(): continue
                before = (directory / "delivery.json").exists(); self._process(directory)
                count += int(not before and (directory / "delivery.json").exists())
            _atomic_heartbeat(self.queue_root, self.now())
            return count

    def run(self, interval=2.0):
        while True: self.scan_once(); self.sleep(interval)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--queue-root", required=True); parser.add_argument("--state-root"); parser.add_argument("--interval", type=float, default=2.0)
    args = parser.parse_args()
    Watcher(args.queue_root, TelegramClient(), args.state_root).run(args.interval)


if __name__ == "__main__": main()
