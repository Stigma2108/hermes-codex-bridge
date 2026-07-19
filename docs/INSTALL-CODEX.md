# Install the Windows/Codex Side

Install Windows first in external-router mode. This proves the base service before a Codex-native router exists and provides a clean rollback point.

For a fully guided setup, give Codex the [master installation prompt](../prompts/INSTALL_WITH_CODEX.md). It performs discovery and read-only checks, presents a redacted plan, waits for approval, and verifies the result. Do not treat the prompt as blanket authority for Linux, SSH, Telegram, or Syncthing changes.

## Prerequisites

- Windows 10/11 and PowerShell 7.
- Node.js 24 or newer and `codex.exe` available to the installing user.
- An existing absolute Codex home and at least one existing workspace root to allow.
- Syncthing installed or already running, with the dedicated shared folder present and writable.
- A trusted clone of this repository and explicit approval for the exact reviewed Windows targets.

Define these environment-specific placeholders locally immediately before the first command:

- `<WINDOWS_SHARED_ROOT>` — the absolute root of the dedicated Syncthing folder.
- `<CODEX_HOME>` — the absolute Codex home, commonly the user's `.codex` directory.
- `<WINDOWS_INTEGRATION_ROOT>` — use `<WINDOWS_SHARED_ROOT>` itself for the documented layout; the installer writes `v3/windows`, `v3/hermes`, and `Queue/protocol/v3` there so Syncthing delivers the reviewed Hermes payload to Linux.
- `<WINDOWS_WORKSPACE_ROOT>` — one absolute workspace root Codex may act within.
- `<WINDOWS_TARGET_ROOT>` — the runtime root; use the installer default under `%LOCALAPPDATA%/HermesCodexBridge` unless another root was explicitly reviewed.
- `<ROUTER_THREAD_ID>` and `<AUTOMATION_ID>` — authoritative IDs obtained from Codex after creating the dedicated router task and automation; never infer them from titles.

Run the redacted prerequisite checker:

```powershell
pwsh -NoProfile -File ./bridge/scripts/Test-Prerequisites.ps1 -SharedRoot "<WINDOWS_SHARED_ROOT>" -CodexHome "<CODEX_HOME>" -Json
```

It checks PowerShell, Node, Codex, Codex home, Syncthing availability, the absolute shared root, and a create/delete probe. It exits `3` when unhealthy. A running Syncthing process is availability evidence, not proof of folder convergence; complete the [Syncthing guide](SYNCTHING.md) separately.

## Review the Plan

Preview the exact targets without mutation:

```powershell
pwsh -NoProfile -File ./bridge/scripts/Install-Bridge.ps1 -CodexHome "<CODEX_HOME>" -IntegrationRoot "<WINDOWS_INTEGRATION_ROOT>" -QueueRoot "<WINDOWS_SHARED_ROOT>\Queue\bridge\v3" -AllowedWorkspaceRoots "<WINDOWS_WORKSPACE_ROOT>" -UiRouterMode external -WhatIf
```

The plan names only target labels, ending with `INSTALL_PLAN_OK`. Review the default runtime root, scheduled task `HermesCodexBridgeV3`, bridge-owned hook entries, shared integration copies, Queue boundary, and ownership manifest. The installer refuses relative paths, a Queue outside `Queue/bridge/v3`, missing source files, conflicting provenance, and symlink/junction/reparse components.

Wait for explicit approval after showing the reviewed plan. If any root, allowed workspace, executable, or router mode changes, generate a new plan and request approval again.

## Install External Mode

Apply the unchanged plan:

```powershell
pwsh -NoProfile -File ./bridge/scripts/Install-Bridge.ps1 -CodexHome "<CODEX_HOME>" -IntegrationRoot "<WINDOWS_INTEGRATION_ROOT>" -QueueRoot "<WINDOWS_SHARED_ROOT>\Queue\bridge\v3" -AllowedWorkspaceRoots "<WINDOWS_WORKSPACE_ROOT>" -UiRouterMode external -Confirm:$false
```

The installer copies a portable runtime, validates `config.json`, adds only bridge-owned hook commands, writes the ownership manifest, creates or verifies the limited-user scheduled task, starts that task, and waits up to 15 seconds for a fresh bounded heartbeat. Success ends with `INSTALL_OK`; a copy without a fresh heartbeat is not successful.

Verify external mode before creating the native router:

```powershell
node ./bridge/src/cli.mjs doctor --config "<WINDOWS_TARGET_ROOT>\config.json"
```

## Create the Native Router

Create exactly one dedicated Codex service task and one paused one-minute automation. Use [the router prompt template](../bridge/assets/UI_ROUTER_PROMPT.md), replacing only `${UI_ROUTER_CLI}` and `${QUEUE_ROOT}` with the reviewed installed paths. The router task must not be the user's originating task.

Register the task's authoritative ID, then replace the temporary automation value with the exact paused automation ID:

```powershell
node "<WINDOWS_INTEGRATION_ROOT>\v3\windows\ui-router-cli.mjs" register "<ROUTER_THREAD_ID>" pending --queue "<WINDOWS_SHARED_ROOT>\Queue\bridge\v3"
node "<WINDOWS_INTEGRATION_ROOT>\v3\windows\ui-router-cli.mjs" register "<ROUTER_THREAD_ID>" "<AUTOMATION_ID>" --queue "<WINDOWS_SHARED_ROOT>\Queue\bridge\v3"
```

Run the paused automation manually, require one heartbeat and one applied harmless test action, activate that same automation, and observe two consecutive cycles. Do not create a second router automation.

Switch only after those checks pass:

```powershell
pwsh -NoProfile -File ./bridge/scripts/Install-Bridge.ps1 -CodexHome "<CODEX_HOME>" -IntegrationRoot "<WINDOWS_INTEGRATION_ROOT>" -QueueRoot "<WINDOWS_SHARED_ROOT>\Queue\bridge\v3" -AllowedWorkspaceRoots "<WINDOWS_WORKSPACE_ROOT>" -UiRouterMode native -Confirm:$false
```

## Verification

Run unit tests and both redacted health checks:

```powershell
Push-Location ./bridge
npm test
Pop-Location
node "<WINDOWS_INTEGRATION_ROOT>\v3\windows\ui-router-cli.mjs" heartbeat "<ROUTER_THREAD_ID>" --queue "<WINDOWS_SHARED_ROOT>\Queue\bridge\v3"
node ./bridge/src/cli.mjs doctor --config "<WINDOWS_TARGET_ROOT>\config.json"
```

Require passing tests and `healthy:true` with fresh `serviceHeartbeat` and `uiRouterHeartbeat` checks. Then use the [complete verification prompt](../prompts/VERIFY_INSTALLATION.md); local health alone does not prove Telegram routing.

## Expected Redacted Output

A healthy prerequisite result resembles:

```json
{"schema":"hermes-codex-prerequisites/v3","healthy":true,"checks":{"powerShell":{"status":"ok","code":"PREREQ_POWERSHELL_OK"},"node":{"status":"ok","code":"PREREQ_NODE_OK"},"codex":{"status":"ok","code":"PREREQ_CODEX_OK"},"codexHome":{"status":"ok","code":"PREREQ_CODEX_HOME_OK"},"sharedRoot":{"status":"ok","code":"PREREQ_SHARED_ROOT_OK"},"syncthing":{"status":"ok","code":"PREREQ_SYNCTHING_PROCESS_OK"},"writeAccess":{"status":"ok","code":"PREREQ_WRITE_OK"}}}
```

A healthy native doctor resembles:

```json
{"schema":"hermes-codex-bridge-doctor/v3","healthy":true,"checks":{"config":{"status":"ok","code":"DOCTOR_CONFIG_OK"},"codexHome":{"status":"ok","code":"DOCTOR_CODEX_HOME_OK"},"queue":{"status":"ok","code":"DOCTOR_QUEUE_OK"},"serviceHeartbeat":{"status":"ok","code":"DOCTOR_SERVICE_HEARTBEAT_OK"},"uiRouterHeartbeat":{"status":"ok","code":"DOCTOR_UI_ROUTER_HEARTBEAT_OK"}}}
```

Neither result contains configured values or local paths.

## Failure Behavior

- Prerequisite or doctor errors return `healthy:false` and exit `3`; fix the named stable code before continuing.
- Safety and provenance errors stop before mutation. `SAFETY_REPARSE_POINT` means a symlink, junction, or other reparse component was found.
- Installation failures attempt to restore the runtime, state, hooks, integration copies, and prior task state. `INSTALL_ROLLBACK` means automatic restoration itself failed; stop and preserve evidence.
- A router heartbeat that is missing or stale means native delivery is not ready. Leave or return the bridge to external mode while recovering the dedicated router.

Use [Troubleshooting](TROUBLESHOOTING.md) for stable-code actions. Never post `config.json`, Queue payloads, task IDs, automation IDs, or absolute paths in a public issue.

## Rollback and Recovery

Preview owned-only removal before approving it:

```powershell
pwsh -NoProfile -File ./bridge/scripts/Uninstall-Bridge.ps1 -TargetRoot "<WINDOWS_TARGET_ROOT>" -CodexHome "<CODEX_HOME>" -WhatIf
```

Then follow [Uninstall](UNINSTALL.md). Windows uninstall is sequential rather than transactional: if it returns `UNINSTALL_PARTIAL`, stop, retain the stable failed-stage evidence, and plan only the remaining manifest-proven owned targets. Never delete Queue, Syncthing data/configuration, Codex home/sessions, integration root, or user workspaces as recovery.
