# Contributing

Thanks for helping improve Hermes–Codex Bridge.

## Before opening a change

1. Open an issue for behavior or protocol changes so the compatibility and security impact can be discussed.
2. Keep changes focused and preserve the write-once Protocol v3 ownership boundaries.
3. Never add operational Queue records, credentials, private paths, logs, or exported user conversations.

## Tests

Run the focused tests for the code you changed, followed by the full project test runner documented in the repository. New behavior and bug fixes must include regression tests. Installer changes must cover plan, apply, rollback, and uninstall behavior where applicable.

All committed fixtures must be wholly synthetic fixtures written specifically for this repository. Do not sanitize or copy production records: create new data with reserved documentation identifiers, deterministic timestamps, and correctly computed hashes.

## Pull requests

Explain the user-visible outcome, security considerations, validation performed, and rollback behavior. Keep commits reviewable and update the English documentation when commands or configuration change.
