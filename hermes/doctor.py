import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import stat
import uuid


REQUIRED_RUNTIME_FILES = ("contracts.py", "inbound.py", "telegram.py", "watcher.py")
REQUIRED_ENV_KEYS = ("HERMES_TELEGRAM_TOKEN", "HERMES_TELEGRAM_CHAT_ID")


def _check(status, code):
    return {"status": status, "code": code}


def _has_symlink_component(path):
    current = Path(path)
    components = [current, *current.parents]
    for component in reversed(components):
        try:
            info = os.lstat(component)
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            return True
    return False


def _path_check(queue_root, env_file, runtime_root):
    paths = (queue_root, env_file, runtime_root)
    if any(not path.is_absolute() for path in paths):
        return _check("error", "DOCTOR_PATH_ABSOLUTE")
    if any(_has_symlink_component(path) for path in paths):
        return _check("error", "DOCTOR_PATH_SYMLINK")
    if not queue_root.is_dir():
        return _check("error", "DOCTOR_QUEUE_MISSING")
    if tuple(part.casefold() for part in queue_root.parts[-3:]) != ("queue", "bridge", "v3"):
        return _check("error", "DOCTOR_QUEUE_BOUNDARY")
    if not runtime_root.is_dir():
        return _check("error", "DOCTOR_RUNTIME_ROOT_MISSING")
    if not env_file.is_file():
        return _check("error", "DOCTOR_ENV_MISSING")
    return _check("ok", "DOCTOR_PATHS_OK")


def _environment_check(env_file):
    try:
        info = os.lstat(env_file)
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            return _check("error", "DOCTOR_ENV_TYPE")
        if os.name != "nt" and stat.S_IMODE(info.st_mode) != 0o600:
            return _check("error", "DOCTOR_ENV_MODE")
        if info.st_size > 16 * 1024:
            return _check("error", "DOCTOR_ENV_FORMAT")
        text = env_file.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return _check("error", "DOCTOR_ENV_READ")
    values = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            return _check("error", "DOCTOR_ENV_FORMAT")
        key, value = line.split("=", 1)
        if key in values:
            return _check("error", "DOCTOR_ENV_FORMAT")
        values[key] = value
    if any(not values.get(key) for key in REQUIRED_ENV_KEYS):
        return _check("error", "DOCTOR_ENV_REQUIRED")
    if re.fullmatch(r"[1-9][0-9]{0,18}", values["HERMES_TELEGRAM_CHAT_ID"]) is None:
        return _check("error", "DOCTOR_ENV_FORMAT")
    return _check("ok", "DOCTOR_ENV_OK")


def _runtime_check(runtime_root):
    for name in REQUIRED_RUNTIME_FILES:
        path = runtime_root / name
        try:
            info = os.lstat(path)
        except OSError:
            return _check("error", "DOCTOR_RUNTIME_MISSING")
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            return _check("error", "DOCTOR_RUNTIME_UNSAFE")
    return _check("ok", "DOCTOR_RUNTIME_OK")


def _queue_write_check(queue_root):
    health_root = queue_root / "health"
    probe = health_root / f".{uuid.uuid4().hex}.probe"
    descriptor = None
    try:
        health_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if _has_symlink_component(health_root):
            return _check("error", "DOCTOR_QUEUE_UNSAFE")
        descriptor = os.open(probe, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.write(descriptor, b"health\n")
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        probe.unlink()
        return _check("ok", "DOCTOR_QUEUE_WRITE_OK")
    except OSError:
        return _check("error", "DOCTOR_QUEUE_WRITE")
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        try:
            probe.unlink()
        except OSError:
            pass


def _heartbeat_check(queue_root, now):
    path = queue_root / "health" / "hermes-heartbeat.json"
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return _check("error", "DOCTOR_SERVICE_HEARTBEAT_MISSING")
    except OSError:
        return _check("error", "DOCTOR_SERVICE_HEARTBEAT_INVALID")
    try:
        if _has_symlink_component(path) or not stat.S_ISREG(info.st_mode) or info.st_size > 64 * 1024:
            return _check("error", "DOCTOR_SERVICE_HEARTBEAT_INVALID")
        value = json.loads(path.read_text(encoding="utf-8"))
        observed = datetime.fromisoformat(value["observed_at"].replace("Z", "+00:00"))
        if observed.tzinfo is None:
            return _check("error", "DOCTOR_SERVICE_HEARTBEAT_INVALID")
        age = (now().astimezone(timezone.utc) - observed.astimezone(timezone.utc)).total_seconds()
    except (OSError, UnicodeError, ValueError, KeyError, TypeError, json.JSONDecodeError):
        return _check("error", "DOCTOR_SERVICE_HEARTBEAT_INVALID")
    if value.get("schema") != "hermes-codex-hermes-heartbeat/v3" or value.get("status") != "ok" or age < -60:
        return _check("error", "DOCTOR_SERVICE_HEARTBEAT_INVALID")
    if age > 30:
        return _check("error", "DOCTOR_SERVICE_HEARTBEAT_STALE")
    return _check("ok", "DOCTOR_SERVICE_HEARTBEAT_OK")


def run_checks(queue_root, env_file, runtime_root, now=None):
    queue_root = Path(queue_root)
    env_file = Path(env_file)
    runtime_root = Path(runtime_root)
    current_time = now or (lambda: datetime.now(timezone.utc))
    paths = _path_check(queue_root, env_file, runtime_root)
    checks = {
        "paths": paths,
        "environment": _environment_check(env_file) if paths["status"] != "error" else _check("skipped", "DOCTOR_NOT_RUN"),
        "runtime": _runtime_check(runtime_root) if paths["status"] != "error" else _check("skipped", "DOCTOR_NOT_RUN"),
        "queueWrite": _queue_write_check(queue_root) if paths["status"] != "error" else _check("skipped", "DOCTOR_NOT_RUN"),
        "serviceHeartbeat": _heartbeat_check(queue_root, current_time) if paths["status"] != "error" else _check("skipped", "DOCTOR_NOT_RUN"),
    }
    return {
        "schema": "hermes-codex-doctor/v3",
        "healthy": all(check["status"] != "error" for check in checks.values()),
        "checks": checks,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run offline Hermes Codex bridge diagnostics.")
    parser.add_argument("--queue-root", required=True)
    parser.add_argument("--env-file", required=True)
    parser.add_argument("--runtime-root", required=True)
    args = parser.parse_args(argv)
    report = run_checks(args.queue_root, args.env_file, args.runtime_root)
    print(json.dumps(report, ensure_ascii=True, separators=(",", ":")))
    return 0 if report["healthy"] else 3


if __name__ == "__main__":
    raise SystemExit(main())
