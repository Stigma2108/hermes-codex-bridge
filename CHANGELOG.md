# Changelog

All notable changes to this project are documented in this file.

## [1.0.0] - 2026-07-19

### Added

- A local-first Protocol v3 bridge between Codex Desktop on Windows and Hermes Agent on Linux.
- Transactional Windows and Hermes installers with explicit ownership, rollback, and uninstall boundaries.
- Redacted prerequisite checks and offline diagnostics for both hosts.
- Guided Codex and Hermes prompts for setup, verification, recovery, and removal.
- English installation, configuration, architecture, usage, security, and troubleshooting documentation.
- Synthetic configuration and Queue examples validated against the published protocol.

### Security

- Credentials remain on the Hermes host and are excluded from Syncthing, Queue, diagnostics, and Windows configuration.
- Sticky suppression prevents internal subagent and reviewer outputs from being forwarded as user-facing Telegram messages.
