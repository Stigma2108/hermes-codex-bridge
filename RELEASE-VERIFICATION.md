# Release Verification

- Release: `v1.0.0`
- Date: 2026-07-20

## Tool Versions

- Node.js: `24.14.1`
- Python: `3.12.10`
- PowerShell: `7.6.1`
- Git: `2.51.1.windows.1`
- GitHub CLI: `2.96.0`

## Verification Results

- Repository safety audit: PASS
- Public export audit: PASS
- Node test suite: 440 total, 439 passed, 0 failed, 1 platform-permission skip
- Python test suite: 62 total, 30 passed, 0 failed, 32 Windows platform skips
- PowerShell parsing and installer sandbox: PASS
- Local bridge E2E: PASS
- Adaptive routing E2E: PASS
- Native UI router E2E: PASS
- Live Telegram Reply to the exact originating Codex task: PASS
- Staged whitespace check: PASS

## Known Limitations

- Linux-only lifecycle, permission-mode, and symbolic-link cases run in Ubuntu CI rather than the Windows release workstation.
- The bridge is self-hosted and requires separately administered Windows, Linux/Hermes, Telegram, and Syncthing components.
- It does not start arbitrary new Codex tasks from unthreaded Telegram messages.
- Syncthing transports the queue but is not a backup system.
- Telegram delivery depends on the separately configured Hermes gateway and Telegram service availability.
