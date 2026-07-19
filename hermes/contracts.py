"""Strict stdlib-only validators for Hermes–Codex interaction protocol v3."""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
from datetime import datetime, timezone
from pathlib import Path

EVENT_ID_RE = re.compile(r"^evt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
RFC3339_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$")
EVENT_KINDS = frozenset(("FINAL_RESPONSE", "QUESTION", "APPROVAL_REQUEST", "ERROR", "TASK_COMPLETED"))
REPLY_ACTIONS = frozenset(("REPLY", "APPROVE_ONCE", "DECLINE"))
MAX_JSON_BYTES = 64 * 1024
MAX_MESSAGE_BYTES = 256 * 1024
SENDER_FINGERPRINT_DOMAIN = b"hermes-codex-v3:telegram-user:"
DELIVERY_REF_RE = re.compile(r"^tgmsg_[1-9]\d{0,18}$")


class ContractError(ValueError):
    """Stable validation error; never contains untrusted input."""


def _fail(code): raise ContractError(code)


def sender_fingerprint(sender_id):
    """Return the protocol v3 fingerprint for a verified Telegram from.id."""
    if isinstance(sender_id, bool) or not isinstance(sender_id, int) or sender_id <= 0 or sender_id >= 1 << 63:
        _fail("SENDER_ID")
    identity = str(sender_id).encode("ascii")
    return hashlib.sha256(SENDER_FINGERPRINT_DOMAIN + identity).hexdigest()


def parse_timestamp(value, code="EVENT_TIME"):
    if not isinstance(value, str) or not RFC3339_RE.fullmatch(value): _fail(code)
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        _fail(code)
    if result.tzinfo is None: _fail(code)
    return result.astimezone(timezone.utc)


def _regular_unlinked(path: Path):
    try:
        info = path.lstat()
    except OSError:
        _fail("EVENT_IO")
    attrs = getattr(info, "st_file_attributes", 0)
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    if stat.S_ISLNK(info.st_mode) or attrs & reparse or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        _fail("EVENT_PATH")


def _read_limited(path: Path, limit: int):
    _regular_unlinked(path)
    try:
        with path.open("rb") as stream:
            data = stream.read(limit + 1)
    except OSError:
        _fail("EVENT_IO")
    if len(data) > limit: _fail("EVENT_SIZE")
    return data


def _required_object(value, fields, code):
    if not isinstance(value, dict) or any(field not in value for field in fields): _fail(code)
    return value


def load_event(directory, now=None):
    directory = Path(directory)
    if not EVENT_ID_RE.fullmatch(directory.name) or directory.is_symlink(): _fail("EVENT_DIRECTORY")
    attrs = getattr(directory.stat(follow_symlinks=False), "st_file_attributes", 0)
    if attrs & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400): _fail("EVENT_DIRECTORY")
    raw = _read_limited(directory / "event.json", MAX_JSON_BYTES)
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        _fail("EVENT_JSON")
    required = ("schema", "event_id", "kind", "created_at", "expires_at", "thread", "message", "allowed_actions", "integrity")
    _required_object(value, required, "EVENT_SHAPE")
    if value["schema"] != "hermes-codex-interaction-event/v3": _fail("EVENT_SCHEMA")
    if value["event_id"] != directory.name or not EVENT_ID_RE.fullmatch(value["event_id"]): _fail("EVENT_ID")
    if value["kind"] not in EVENT_KINDS: _fail("EVENT_KIND")
    created = parse_timestamp(value["created_at"])
    expires = parse_timestamp(value["expires_at"])
    current = now() if callable(now) else (now or datetime.now(timezone.utc))
    if current.tzinfo is None: _fail("EVENT_TIME")
    current = current.astimezone(timezone.utc)
    if expires <= created or current >= expires: _fail("EVENT_EXPIRED")
    maximum = 43200 if value["kind"] == "APPROVAL_REQUEST" else 604800
    if (expires - created).total_seconds() > maximum: _fail("EVENT_TTL")
    thread = _required_object(value["thread"], ("id", "turn_id", "title", "project_label", "cwd_label"), "EVENT_THREAD")
    limits = {"id": 256, "turn_id": 256, "title": 256, "project_label": 128, "cwd_label": 128}
    for key, limit in limits.items():
        if not isinstance(thread[key], str) or len(thread[key]) > limit or (key != "cwd_label" and not thread[key]): _fail("EVENT_THREAD")
    message = _required_object(value["message"], ("summary", "markdown_path", "is_replyable"), "EVENT_MESSAGE")
    if not isinstance(message["summary"], str) or len(message["summary"]) > 3500 or not isinstance(message["is_replyable"], bool): _fail("EVENT_MESSAGE")
    if message["markdown_path"] not in (None, "message.md"): _fail("EVENT_PATH")
    actions = value["allowed_actions"]
    if not isinstance(actions, list) or len(actions) > 3 or len(actions) != len(set(actions)) or any(action not in REPLY_ACTIONS for action in actions): _fail("EVENT_ACTIONS")
    integrity = _required_object(value["integrity"], ("producer", "content_sha256"), "EVENT_INTEGRITY")
    if not isinstance(integrity["producer"], str) or not integrity["producer"] or len(integrity["producer"]) > 128: _fail("EVENT_INTEGRITY")
    if not isinstance(integrity["content_sha256"], str) or not SHA256_RE.fullmatch(integrity["content_sha256"]): _fail("EVENT_HASH")
    payload = message["summary"].encode("utf-8") if message["markdown_path"] is None else _read_limited(directory / "message.md", MAX_MESSAGE_BYTES)
    if len(payload) > MAX_MESSAGE_BYTES or hashlib.sha256(payload).hexdigest() != integrity["content_sha256"]: _fail("EVENT_HASH")
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError:
        _fail("EVENT_ENCODING")
    return value, text


def load_delivery(directory, event_id, expected_delivery_ref):
    raw = _read_limited(Path(directory) / "delivery.json", MAX_JSON_BYTES)
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        _fail("DELIVERY_JSON")
    _required_object(value, ("schema", "event_id", "delivery_ref", "created_at", "attempts"), "DELIVERY_SHAPE")
    if value["schema"] != "hermes-codex-interaction-delivery/v3": _fail("DELIVERY_SCHEMA")
    if value["event_id"] != event_id: _fail("DELIVERY_EVENT")
    if not isinstance(value["delivery_ref"], str) or not DELIVERY_REF_RE.fullmatch(value["delivery_ref"]): _fail("DELIVERY_REF")
    if value["delivery_ref"] != expected_delivery_ref: _fail("DELIVERY_MISMATCH")
    parse_timestamp(value["created_at"], "DELIVERY_TIME")
    if isinstance(value["attempts"], bool) or not isinstance(value["attempts"], int) or not 1 <= value["attempts"] <= 1_000_000: _fail("DELIVERY_ATTEMPTS")
    return value


def validate_reply(value):
    _required_object(value, ("schema", "event_id", "created_at", "action", "text", "telegram"), "REPLY_SHAPE")
    if value["schema"] != "hermes-codex-interaction-reply/v3" or not EVENT_ID_RE.fullmatch(value["event_id"]): _fail("REPLY_SCHEMA")
    parse_timestamp(value["created_at"], "REPLY_TIME")
    if value["action"] not in REPLY_ACTIONS: _fail("REPLY_ACTION")
    if value["action"] == "REPLY":
        if not isinstance(value["text"], str) or not 1 <= len(value["text"]) <= 3500: _fail("REPLY_TEXT")
    elif value["text"] is not None: _fail("REPLY_TEXT")
    telegram = _required_object(value["telegram"], ("delivery_ref", "sender_fingerprint"), "REPLY_TELEGRAM")
    if not isinstance(telegram["delivery_ref"], str) or not DELIVERY_REF_RE.fullmatch(telegram["delivery_ref"]): _fail("REPLY_DELIVERY")
    if not isinstance(telegram["sender_fingerprint"], str) or not SHA256_RE.fullmatch(telegram["sender_fingerprint"]): _fail("REPLY_SENDER")
    return value
