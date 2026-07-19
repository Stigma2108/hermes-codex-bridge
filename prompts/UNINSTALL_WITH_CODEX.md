# Uninstall Hermes–Codex Bridge with Codex

Use this prompt to remove only components that the bridge can prove it owns. Uninstall is a two-host operation with separate authority and preservation boundaries.

Never ask the user to paste a Telegram token or chat ID into this prompt. If the dedicated credential file must be identified, inspect its path locally; never read or display it. Secrets remain in a protected local env file until an explicitly approved, ownership-verified removal. Produce only redacted output or a redacted report.

## Read-only preflight

Discover the Windows and Hermes installations without mutation. Inspect ownership metadata and run plan modes:

```powershell
pwsh -NoProfile -File ./bridge/scripts/Uninstall-Bridge.ps1 -TargetRoot "<target-root>" -CodexHome "<codex-home>" -WhatIf
```

```sh
sudo ./hermes/scripts/uninstall.sh --hermes-home "<hermes-home>" --env-file "<dedicated-env-file>"
```

Confirm the bridge is idle, record current service states, and identify the exact native router automation if the bridge created one. Treat `Queue/bridge/v3`, `Queue/protocol/v3`, all Syncthing configuration/data, Codex sessions, user workspaces, the Hermes home, Hermes gateway state, and user-created skills as preserved.

Stop immediately if ownership/provenance is absent or ambiguous, a target is symlinked or overlaps preserved data, a live interaction is in progress, a service cannot be quiesced, an env file is shared, plan output differs from the documented targets, or either host authority is missing.

## Approval gate

Show two redacted plans, one per host, with exact target labels and preservation boundaries. Obtain separate explicit approval for each authority: Windows approval does not authorize Hermes/SSH, and Hermes approval does not authorize Windows. The normal Hermes uninstall preserves the dedicated env file. Never claim that the installer owns a pre-existing env file.

Wait for explicit user approval before mutation. If only one host is approved, uninstall only that host, report the other as pending, and do not claim complete removal.

## Approved mutation

On an approved Windows host, run:

```powershell
pwsh -NoProfile -File ./bridge/scripts/Uninstall-Bridge.ps1 -TargetRoot "<target-root>" -CodexHome "<codex-home>" -Confirm:$false
```

This may remove only scheduled task `HermesCodexBridgeV3`, bridge-owned hook commands, and the configured bridge runtime/state root. Remove the native router automation only when its exact recorded ID proves this installation created it.

On an independently approved Hermes host, run:

```sh
sudo ./hermes/scripts/uninstall.sh --hermes-home "<hermes-home>" --env-file "<dedicated-env-file>" --apply
```

This may remove only manifest-proven `/etc/systemd/system/hermes-codex-bridge.service`, `/opt/hermes-codex-bridge-v3`, `/var/lib/hermes-codex-bridge-v3`, and `<hermes-home>/skills/hermes-codex-telegram-reply-v3`. It preserves the dedicated env file.

Before applying the normal command above, stop and ask separately whether the user wants that local credential file removed. Only if the user gives separate explicit approval, use this opt-in plan and apply instead while the ownership manifest is still present:

```sh
sudo ./hermes/scripts/uninstall.sh --hermes-home "<hermes-home>" --env-file "<dedicated-env-file>" --remove-env
sudo ./hermes/scripts/uninstall.sh --hermes-home "<hermes-home>" --env-file "<dedicated-env-file>" --remove-env --apply
```

The `--remove-env` operation requires the same matching manifest/path provenance and its own approval; it does not retroactively make a pre-existing env file installer-owned.

Do not delete the Queue, Syncthing data, or user-owned Hermes data unless separately authorized for a distinct operation outside this uninstall. Syncthing configuration is preserved as well. Do not modify the Telegram gateway or uninstall Hermes itself.

## Verification

Verify each approved side independently:

- rerun the matching uninstaller in plan mode and require no owned live targets;
- confirm the Windows scheduled task and bridge hook commands are absent without exposing other hooks;
- confirm the systemd bridge unit, runtime, state, and bridge skill are absent;
- confirm preserved Queue, Syncthing, Codex, Hermes, Telegram, and workspace data still exist;
- report partial/rollback stable codes exactly, without private paths.

The redacted report must distinguish `removed`, `not authorized`, `not installed`, and `manual recovery required`. Never include credentials, env values, chat IDs, raw manifests, absolute paths, Queue payloads, or unrelated service/configuration details.

## Owned-only rollback

Hermes uninstall transactionally rolls back its manifest-proven owned mutations. If it reports failure, stop immediately, preserve its recovery evidence, report the stable code, and do not manually delete, move, or recreate targets.

Windows uninstall fails closed before mutation when provenance or the scheduled task identity/action does not match. After mutation begins it is sequential, not transactional. An `UNINSTALL_PARTIAL` after mutation is non-transactional: stop, preserve the evidence, do not retry destructive steps blindly, report the exact redacted failed stage, and require a recovery plan plus explicit approval before further action.

For Hermes, the owned-only rollback targets are exactly the bridge targets named in the approved plan. Restore prior service state only when the Hermes uninstaller proves it captured that state. For Windows recovery, plan only the remaining manifest-proven owned targets; never promise or improvise rollback of a step that already succeeded. Never roll back or recover by deleting the Queue, Syncthing data/configuration, Codex home/sessions, user workspaces, Hermes home/gateway data, Telegram data, or unrelated automations. If Hermes rollback itself fails, stop and require host-owner recovery before any retry.
