# Troubleshooting

Start with redacted doctors and stable codes. They are designed to locate the failing boundary without disclosing configuration values. Keep Queue records, credentials, manifests, identifiers, and absolute paths local to the authorized host.

## Prerequisites

- Stop forward installation or live verification when any doctor is unhealthy.
- Confirm which host produced the code; similarly named Windows and Hermes heartbeat codes refer to different files.
- Preserve the current service state and write-once Queue evidence until the failure is understood.
- Use an authorized local shell on each host. Network reachability alone is not authority.

Define these environment-specific placeholders locally immediately before the first command:

- `<WINDOWS_SHARED_ROOT>` — Windows dedicated Syncthing root.
- `<WINDOWS_TARGET_ROOT>` — installed Windows runtime root.
- `<CODEX_HOME>` — Windows Codex home.
- `<LINUX_SHARED_ROOT>` — Linux dedicated Syncthing root.
- `<HERMES_ENV_FILE>` — protected local bridge env file.

Run the narrow diagnostics first:

```powershell
pwsh -NoProfile -File ./bridge/scripts/Test-Prerequisites.ps1 -SharedRoot "<WINDOWS_SHARED_ROOT>" -CodexHome "<CODEX_HOME>" -Json
node ./bridge/src/cli.mjs doctor --config "<WINDOWS_TARGET_ROOT>\config.json"
```

```sh
python3 ./hermes/doctor.py --queue-root "<LINUX_SHARED_ROOT>/Queue/bridge/v3" --env-file "<HERMES_ENV_FILE>" --runtime-root /opt/hermes-codex-bridge-v3
sudo systemctl status hermes-codex-bridge.service --no-pager
```

## Prerequisite Codes

| Code | Meaning | Safe local check |
|---|---|---|
| `PREREQ_POWERSHELL_VERSION` | PowerShell major version is below 7. | Run `$PSVersionTable.PSVersion` and install a supported PowerShell release. |
| `PREREQ_NODE_MISSING` | The selected Node command cannot be resolved. | Run `Get-Command node` in the same user context. |
| `PREREQ_NODE_VERSION` | Node is present but below major 24 or unreadable. | Run `node --version`; upgrade before installation. |
| `PREREQ_CODEX_MISSING` | `codex.exe` cannot be resolved. | Verify the normal Codex installation for this Windows user. |
| `PREREQ_CODEX_HOME_INVALID` | Codex home is absent, relative, or not a directory. | Select the existing absolute Codex home; do not create a substitute inside Queue. |
| `PREREQ_SHARED_ROOT_INVALID` | Shared root is absent, relative, or not a directory. | Recheck the dedicated Syncthing folder mapping. |
| `PREREQ_SYNCTHING_MISSING` | Neither Syncthing command nor process is visible. | Start the approved local Syncthing instance and rerun the checker. |
| `PREREQ_WRITE_FAILED` | The create/delete probe failed. | Check local ACLs and free space for the dedicated root without changing ownership broadly. |

`PREREQ_SYNCTHING_COMMAND_OK` or `PREREQ_SYNCTHING_PROCESS_OK` proves availability only. Always run the two-way sentinel in [Syncthing](SYNCTHING.md).

## Windows Install and Safety Codes

| Code | Meaning | Safe local check |
|---|---|---|
| `SAFETY_REPARSE_POINT` | A target or ancestor is a symlink, junction, mount-like reparse point, or unsafe tree entry. | Inspect the selected path chain locally and choose a physical dedicated root; do not bypass the guard. |
| `SAFETY_PATH_INSPECTION` | The installer could not prove path safety. | Check local access and filesystem health, then rerun plan mode. |
| `SAFETY_QUEUE_BOUNDARY` | Queue root does not end in `Queue/bridge/v3`. | Correct only the reviewed installer argument. |
| `INSTALL_OWNERSHIP_CONFLICT` | Existing runtime does not match the Windows ownership manifest. | Stop; identify whether it predates this release or was modified. Do not replace its manifest. |
| `INSTALL_TASK_OWNERSHIP_CONFLICT` | Scheduled task name exists with a different action. | Keep the existing task untouched and choose a recovery plan with the host owner. |
| `INSTALL_TASK_STOP_TIMEOUT` | An owned scheduled task did not stop within the bounded wait. | Check Task Scheduler state and active work; retry only after it is safely idle. |
| `INSTALL_HEALTH_TIMEOUT` | The task started but no fresh service heartbeat appeared within 15 seconds. | Run the Windows doctor and inspect local task history; installation rollback should restore prior owned state. |
| `INSTALL_ROLLBACK` | Automatic install restoration failed. | Stop all mutation and retain local recovery evidence. |

## Windows Doctor Codes

| Code | Meaning | Safe local check |
|---|---|---|
| `DOCTOR_CONFIG_INVALID` | Configuration could not pass the closed schema and physical boundary checks. | Run `validate-config` locally and compare fields with [Configuration](CONFIGURATION.md). |
| `DOCTOR_CODEX_HOME_MISSING` | Configured Codex home is not an existing directory. | Restore the reviewed Codex home mapping. |
| `DOCTOR_QUEUE_MISSING` | Configured Queue directory is absent. | Restore Syncthing/folder availability; do not create a different Queue silently. |
| `DOCTOR_SERVICE_HEARTBEAT_MISSING` | Service has not written heartbeat evidence. | Check scheduled task state under the installing user. |
| `DOCTOR_SERVICE_HEARTBEAT_INVALID` | Heartbeat schema, timestamp, or status is invalid. | Treat the service state as untrusted; restart only after local investigation. |
| `DOCTOR_SERVICE_HEARTBEAT_STALE` | Last valid service heartbeat is older than its bound. | Verify the scheduled task process is making progress, not merely present. |
| `DOCTOR_UI_ROUTER_HEARTBEAT_MISSING` | Native router has never reported a cycle. | Confirm the single registered automation exists and run it once manually. |
| `DOCTOR_UI_ROUTER_HEARTBEAT_INVALID` | Router heartbeat shape or timestamp is invalid. | Pause the automation, verify installed router files, and rerun setup. |
| `DOCTOR_UI_ROUTER_HEARTBEAT_STALE` | Native router has not completed a recent cycle. | Restore the same automation; do not create a duplicate. |
| `DOCTOR_UI_ROUTER_EXTERNAL` | Router check was intentionally skipped in external mode. | Expected during base installation; not sufficient for final native verification. |

## Hermes Doctor and Install Codes

| Code | Meaning | Safe local check |
|---|---|---|
| `DOCTOR_PATH_ABSOLUTE` | A doctor argument is not absolute. | Correct the local invocation. |
| `DOCTOR_PATH_SYMLINK` | Queue, env, runtime, or an ancestor is symlinked. | Select the physical manifest-approved target; do not follow indirection. |
| `DOCTOR_QUEUE_BOUNDARY` | Linux Queue does not end in `Queue/bridge/v3`. | Correct the Syncthing mapping or argument. |
| `DOCTOR_ENV_MISSING` | Dedicated env file is absent. | Recreate or restore it locally through the approved credential process. |
| `DOCTOR_ENV_MODE` | Env file mode is not exactly `600`. | Correct owner/mode locally and rerun plan mode. |
| `DOCTOR_ENV_FORMAT` | Env file is oversized, duplicated, malformed, or chat ID shape is invalid. | Edit it locally without echoing values. |
| `DOCTOR_ENV_REQUIRED` | A required local key has no value. | Complete the approved local credential setup. |
| `DOCTOR_RUNTIME_MISSING` | A required installed Python module is absent. | Rerun the installer plan; do not copy one file by hand. |
| `DOCTOR_RUNTIME_UNSAFE` | A runtime file is not a regular physical file. | Stop the service and restore from a trusted release. |
| `DOCTOR_QUEUE_WRITE` | Hermes could not create and remove its health probe. | Check service-user access only on Queue/state and free space. |
| `DOCTOR_SERVICE_HEARTBEAT_STALE` | Hermes watcher heartbeat is older than 30 seconds. | Check the systemd unit and watcher progress. |
| `INSTALL_ENV_MODE` | Installer found an unprotected env file. | Set local ownership and mode before plan/apply. |
| `INSTALL_OWNERSHIP_CONFLICT` | Live Hermes targets do not match protected provenance. | Stop; do not overwrite the runtime or manifest. |
| `INSTALL_SYSTEMD` | Enable/start/state verification failed. | Inspect the unit locally and preserve the transaction result. |
| `INSTALL_TRANSACTION` | A staged mutation failed and rollback completed. | Fix the named prerequisite, rerun plan mode, and request approval again. |

## Reply and Delivery Symptoms

| Symptom | Likely boundary | Safe response |
|---|---|---|
| Codex event never appears in Telegram | Windows heartbeat, Syncthing convergence, Hermes heartbeat, or Telegram gateway | Check in that order; process existence is not convergence. |
| Telegram Reply waits | Windows/Syncthing offline or target task busy | Restore the component and allow the same record to retry within TTL. |
| Reply is rejected as stale | Local task advanced after notification | Start a new interaction from the current Codex task; do not reuse the old route. |
| Wrong or unthreaded message does nothing | No exact `HC3` Reply route | Use Telegram Reply on the original valid bridge message. |
| Internal agent chatter is absent | Expected subagent/reviewer suppression | Confirm primary-task reports still deliver; no recovery is needed. |

## Uninstall Codes

| Code | Meaning | Safe response |
|---|---|---|
| `UNINSTALL_OWNERSHIP_UNVERIFIED` | Manifest/provenance is absent, malformed, or inconsistent. | Stop; no target is authorized for removal. |
| `UNINSTALL_TASK_OWNERSHIP_UNVERIFIED` | Windows task action no longer matches the manifest. | Leave it untouched and create a host-owner recovery plan. |
| `UNINSTALL_PARTIAL` | Windows sequential uninstall removed some owned targets but a later step failed. | Stop and plan only remaining manifest-proven targets; no automatic rollback is promised. |
| `UNINSTALL_ROLLBACK` | Hermes transactional rollback failed. | Stop, retain the private recovery directory/evidence, and require host-owner recovery. |
| `UNINSTALL_ALREADY_ABSENT` | No manifest-proven live installation remains. | Treat as successful idempotent absence; preserved data remains. |

## Expected Redacted Output

A diagnostic result should be limited to its schema, `healthy`, check status, and stable code:

```json
{"schema":"hermes-codex-doctor/v3","healthy":false,"checks":{"serviceHeartbeat":{"status":"error","code":"DOCTOR_SERVICE_HEARTBEAT_STALE"}}}
```

The actual doctor includes its fixed check set, with unrun checks marked `DOCTOR_NOT_RUN`. Remove configured values from any local notes derived from service-manager output.

## Failure Behavior

Do not continue past a safety, ownership, convergence, health, or rollback failure. Repeating a destructive command is not diagnosis. First establish whether the failure occurred before mutation, during a transaction that rolled back, or during Windows sequential uninstall.

Escalate with the host, command family, stable code, software versions, and whether the failure was preflight/apply/verification. Keep all sensitive evidence local.

## Rollback and Recovery

Installer transaction failures normally restore prior owned state. Verify that state with plan mode and doctors before another attempt. `INSTALL_ROLLBACK` and `UNINSTALL_ROLLBACK` require host-owner recovery; do not manually reconstruct provenance.

`UNINSTALL_PARTIAL` is Windows-only and non-transactional. Follow [Uninstall](UNINSTALL.md) to inventory the remaining manifest-proven owned targets without touching Queue, Syncthing, Codex sessions, user workspaces, Hermes home/gateway data, Telegram data, or unrelated automations.
