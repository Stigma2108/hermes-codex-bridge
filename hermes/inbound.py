"""Fail-closed Telegram Reply publisher for Hermes–Codex protocol v3."""
from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

try:
    from .contracts import ContractError, EVENT_ID_RE, load_delivery, load_event, sender_fingerprint, validate_reply
except ImportError:
    from contracts import ContractError, EVENT_ID_RE, load_delivery, load_event, sender_fingerprint, validate_reply


APPROVE_TEXT = "ОДОБРИТЬ ОДИН РАЗ"
DECLINE_TEXT = "ОТКЛОНИТЬ"
SECRET_RE = re.compile(r"(?i)(authorization\s*:|bearer\s+\S{12,}|api[_-]?key\s*[:=]|password\s*[:=]|token\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----)")
TERMINAL_NAMES = ("reply.json", "receipt.json", "windows-failure.json", "hermes-failure.json")


class InboundError(RuntimeError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _fail(code): raise InboundError(code)


def _iso(value): return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _canonical_positive_decimal(value, maximum, code):
    if isinstance(value, bool): _fail(code)
    if isinstance(value, int): result = value
    elif isinstance(value, str) and re.fullmatch(r"[1-9]\d{0,18}", value): result = int(value)
    else: _fail(code)
    if not 1 <= result < maximum: _fail(code)
    return result


def _owner_from_env_file(path):
    path = Path(path)
    if not path.is_absolute(): _fail("INBOUND_CONFIG")
    try:
        info = path.lstat()
        reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or getattr(info, "st_file_attributes", 0) & reparse: _fail("INBOUND_CONFIG")
        if os.name != "nt" and info.st_mode & 0o077: _fail("INBOUND_CONFIG")
        raw = path.read_bytes()
    except InboundError:
        raise
    except OSError:
        _fail("INBOUND_CONFIG")
    if len(raw) > 16 * 1024: _fail("INBOUND_CONFIG")
    try: lines = raw.decode("utf-8").splitlines()
    except UnicodeDecodeError: _fail("INBOUND_CONFIG")
    values = [line.split("=", 1)[1] for line in lines if line.startswith("HERMES_TELEGRAM_CHAT_ID=")]
    if len(values) != 1 or not re.fullmatch(r"[1-9]\d{0,18}", values[0]): _fail("INBOUND_CONFIG")
    return int(values[0])


def _verified_directory(root, event_id):
    root = Path(root)
    if not root.is_absolute() or not isinstance(event_id, str) or not EVENT_ID_RE.fullmatch(event_id): _fail("INBOUND_PATH")
    try:
        root_info = root.lstat()
        directory = root / event_id
        info = directory.lstat()
    except OSError:
        _fail("INBOUND_PATH")
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    if stat.S_ISLNK(root_info.st_mode) or not stat.S_ISDIR(root_info.st_mode) or getattr(root_info, "st_file_attributes", 0) & reparse: _fail("INBOUND_PATH")
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or getattr(info, "st_file_attributes", 0) & reparse: _fail("INBOUND_PATH")
    return directory


def _ensure_nonterminal(directory):
    for name in TERMINAL_NAMES:
        try:
            (directory / name).lstat()
        except FileNotFoundError:
            continue
        except OSError:
            _fail("INBOUND_PATH")
        _fail("INBOUND_TERMINAL")


def _atomic_reply(path, value):
    payload = (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
    temporary = path.parent / f".reply.{os.getpid()}.{threading.get_ident()}.tmp"
    fd = None
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as stream:
            fd = None
            stream.write(payload); stream.flush(); os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        try:
            os.link(temporary, path)
        except FileExistsError:
            _fail("INBOUND_DUPLICATE")
        if os.name != "nt":
            try:
                directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
                try: os.fsync(directory_fd)
                finally: os.close(directory_fd)
            except OSError:
                try: path.unlink()
                except OSError: pass
                _fail("INBOUND_SYNC")
    except InboundError:
        raise
    except Exception:
        _fail("INBOUND_WRITE")
    finally:
        if fd is not None:
            try: os.close(fd)
            except OSError: pass
        try: temporary.unlink()
        except OSError: pass


def publish_reply(*, interaction_root, event_id, reply_to_message_id, sender_id, owner_id, text, now=None):
    reply_to_message_id = _canonical_positive_decimal(reply_to_message_id, 10**19, "INBOUND_DELIVERY")
    sender_id = _canonical_positive_decimal(sender_id, 1 << 63, "INBOUND_OWNER")
    if isinstance(owner_id, bool) or not isinstance(owner_id, int) or sender_id != owner_id: _fail("INBOUND_OWNER")
    try: fingerprint = sender_fingerprint(sender_id)
    except ContractError: _fail("INBOUND_OWNER")
    if not isinstance(text, str): _fail("INBOUND_TEXT")
    text = text.strip()
    if not 1 <= len(text) <= 3500 or SECRET_RE.search(text): _fail("INBOUND_TEXT")
    try: text.encode("utf-8")
    except UnicodeEncodeError: _fail("INBOUND_TEXT")

    directory = _verified_directory(interaction_root, event_id)
    _ensure_nonterminal(directory)
    current = now or datetime.now(timezone.utc)
    try:
        event, _ = load_event(directory, current)
        delivery_ref = f"tgmsg_{reply_to_message_id}"
        load_delivery(directory, event_id, delivery_ref)
    except ContractError as error:
        _fail(str(error))
    if not event["message"]["is_replyable"]: _fail("INBOUND_ACTION")

    if "REPLY" in event["allowed_actions"]:
        action, reply_text = "REPLY", text
    elif text == APPROVE_TEXT and "APPROVE_ONCE" in event["allowed_actions"]:
        action, reply_text = "APPROVE_ONCE", None
    elif text == DECLINE_TEXT and "DECLINE" in event["allowed_actions"]:
        action, reply_text = "DECLINE", None
    else:
        _fail("INBOUND_ACTION")
    value = {
        "schema": "hermes-codex-interaction-reply/v3",
        "event_id": event_id,
        "created_at": _iso(current),
        "action": action,
        "text": reply_text,
        "telegram": {"delivery_ref": delivery_ref, "sender_fingerprint": fingerprint},
    }
    try: validate_reply(value)
    except ContractError as error: _fail(str(error))
    _atomic_reply(directory / "reply.json", value)
    return {"event_id": event_id, "action": action}


def main(argv=None):
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--interaction-root", required=True)
    parser.add_argument("--env-file", required=True)
    args = parser.parse_args(argv)
    try:
        raw = sys.stdin.buffer.read(16 * 1024 + 1)
        if len(raw) > 16 * 1024: _fail("INBOUND_SIZE")
        request = json.loads(raw.decode("utf-8"))
        if not isinstance(request, dict): _fail("INBOUND_INPUT")
        owner_id = _owner_from_env_file(args.env_file)
        result = publish_reply(
            interaction_root=args.interaction_root,
            event_id=request.get("event_id"),
            reply_to_message_id=request.get("reply_to_message_id"),
            sender_id=request.get("sender_id"),
            owner_id=owner_id,
            text=request.get("text"),
        )
        sys.stdout.write(json.dumps({"status": "PUBLISHED", "event": result["event_id"][4:12], "action": result["action"]}) + "\n")
        return 0
    except (InboundError, UnicodeDecodeError, json.JSONDecodeError):
        sys.stderr.write("INBOUND_REJECTED\n")
        return 2


if __name__ == "__main__": raise SystemExit(main())
