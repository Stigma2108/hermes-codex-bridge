# Install the Windows/Codex Side

Use this prompt from the root of a trusted clone on the Windows host. The intent is a portable, least-privilege installation with a native Codex UI router and evidence that the local half is healthy.

Never ask the user to paste a Telegram token or chat ID into this prompt. Those secrets are not needed on Windows and belong only in a protected local env file on the Hermes host. Return only redacted JSON output or a redacted report.

## Read-only preflight

Collect absolute values locally for `<shared-root>`, `<integration-root>`, `<codex-home>`, and one or more `<allowed-workspace-root>` values. Do not print them back to chat.

Run the repository-relative prerequisite check:

```powershell
pwsh -NoProfile -File ./bridge/scripts/Test-Prerequisites.ps1 -SharedRoot "<shared-root>" -CodexHome "<codex-home>" -Json
```

Require PowerShell 7, Node.js 24 or newer, `codex.exe`, a valid Codex home, Syncthing availability, an absolute shared root, and a successful create/delete probe. Then preview the exact mutation:

```powershell
pwsh -NoProfile -File ./bridge/scripts/Install-Bridge.ps1 -CodexHome "<codex-home>" -IntegrationRoot "<integration-root>" -QueueRoot "<shared-root>/Queue/bridge/v3" -AllowedWorkspaceRoots "<allowed-workspace-root>" -UiRouterMode external -WhatIf
```

Inspect these repository-relative targets before proceeding: `bridge/scripts/Test-Prerequisites.ps1`, `bridge/scripts/Install-Bridge.ps1`, `bridge/src/cli.mjs`, `bridge/assets/UI_ROUTER_PROMPT.md`, and `bridge/src/ui-router-cli.mjs`.

Stop immediately if a prerequisite fails, a path is relative or symlinked, the Queue does not end in `Queue/bridge/v3`, the allowed workspace boundary is unclear, unit tests fail, Syncthing is not ready, or the originating Codex task/thread ID is ambiguous.

## Approval gate

Show a redacted plan naming these exact owned targets:

- `%LOCALAPPDATA%/HermesCodexBridge` unless an explicit `TargetRoot` is approved;
- scheduled task `HermesCodexBridgeV3`;
- bridge-owned entries in `<codex-home>/hooks.json`;
- `<integration-root>/v3/windows`;
- `<shared-root>/Queue/protocol/v3` and `<shared-root>/Queue/bridge/v3` as shared preservation boundaries.

Wait for explicit user approval before mutation. If any path, router mode, workspace root, or target changes, show a new plan and wait again.

## Approved mutation

Run the installer with the same reviewed arguments and no additional targets:

```powershell
pwsh -NoProfile -File ./bridge/scripts/Install-Bridge.ps1 -CodexHome "<codex-home>" -IntegrationRoot "<integration-root>" -QueueRoot "<shared-root>/Queue/bridge/v3" -AllowedWorkspaceRoots "<allowed-workspace-root>" -UiRouterMode external -Confirm:$false
```

First verify the external-mode service. Then create one dedicated Codex service task and one paused one-minute automation. Its prompt must be `bridge/assets/UI_ROUTER_PROMPT.md` with only `${UI_ROUTER_CLI}` and `${QUEUE_ROOT}` replaced by reviewed absolute paths. Resolve the dedicated service task/thread ID from authoritative Codex metadata; it must not be the originating user task. Use the installed copy corresponding to `bridge/src/ui-router-cli.mjs`:

```powershell
node "<integration-root>/v3/windows/ui-router-cli.mjs" register "<exact-router-thread-id>" pending --queue "<shared-root>/Queue/bridge/v3"
```

Register the returned automation ID in place of `pending`. Run it manually, verify a heartbeat and one applied test action, activate the same automation, and verify two consecutive cycles. Only then rerun `bridge/scripts/Install-Bridge.ps1` with the same roots and `-UiRouterMode native -Confirm:$false`. Do not guess a thread ID or create multiple router automations.

## Verification

Run the Windows unit suite and local diagnostics:

```powershell
Push-Location ./bridge; npm test; Pop-Location
node ./bridge/src/cli.mjs doctor --config "<target-root>/config.json"
node "<integration-root>/v3/windows/ui-router-cli.mjs" heartbeat "<exact-router-thread-id>" --queue "<shared-root>/Queue/bridge/v3"
node ./bridge/src/cli.mjs doctor --config "<target-root>/config.json"
```

Require passing tests, `healthy:true`, a fresh service heartbeat, and a fresh native-router heartbeat. Summarize stable codes and counts only. Never reveal absolute paths, config values, task/thread IDs, automation IDs, or Queue contents in the redacted report.

## Owned-only rollback

Preview and then, only after explicit approval, invoke the repository-relative uninstaller:

```powershell
pwsh -NoProfile -File ./bridge/scripts/Uninstall-Bridge.ps1 -TargetRoot "<target-root>" -CodexHome "<codex-home>" -WhatIf
pwsh -NoProfile -File ./bridge/scripts/Uninstall-Bridge.ps1 -TargetRoot "<target-root>" -CodexHome "<codex-home>" -Confirm:$false
```

The owned-only rollback targets are scheduled task `HermesCodexBridgeV3`, bridge-owned hook commands, and the approved bridge runtime/state root. Remove the native router automation only if this install created it and its exact ID is recorded. Stop if ownership evidence is absent, another hook shares an entry, or an uninstall step reports partial failure. Never delete the Queue, Syncthing data/configuration, Codex sessions, Codex home, integration root, or user workspaces.
