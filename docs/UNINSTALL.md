# Uninstall and Recovery

Uninstall is two independently authorized operations. Each script removes only targets proven by its ownership manifest. Normal removal preserves Queue, Syncthing, Codex data, Hermes data, Telegram state, and the protected Hermes env file.

For a guided two-host removal, give Codex [the uninstall prompt](../prompts/UNINSTALL_WITH_CODEX.md). It keeps Windows, Linux/SSH, native-router, and optional credential-file approval separate.

## Prerequisites

- Confirm the bridge is idle and no live approval/question is pending.
- Record whether the Windows scheduled task, Hermes systemd unit, and native-router automation are running so recovery can restore only prior state.
- Locate the installed ownership manifests without displaying their contents.
- Obtain separate authority for Windows and Hermes. Approval for one host does not authorize the other.
- Treat the native-router automation as separately owned only when its exact recorded ID proves this installation created it.

Define these environment-specific placeholders locally immediately before the first command:

- `<WINDOWS_TARGET_ROOT>` — manifest-owned Windows runtime root.
- `<CODEX_HOME>` — Windows Codex home recorded by the installation.
- `<HERMES_HOME>` — Linux Hermes home recorded by the installation.
- `<HERMES_ENV_FILE>` — dedicated protected env path recorded by the installation.

Preview Windows removal:

```powershell
pwsh -NoProfile -File ./bridge/scripts/Uninstall-Bridge.ps1 -TargetRoot "<WINDOWS_TARGET_ROOT>" -CodexHome "<CODEX_HOME>" -WhatIf
```

Preview normal Hermes removal, which preserves the env file:

```sh
sudo ./hermes/scripts/uninstall.sh --hermes-home "<HERMES_HOME>" --env-file "<HERMES_ENV_FILE>"
```

Review the two redacted target lists and preservation boundaries before requesting approval.

## Windows Removal

After explicit Windows approval, apply the exact reviewed command:

```powershell
pwsh -NoProfile -File ./bridge/scripts/Uninstall-Bridge.ps1 -TargetRoot "<WINDOWS_TARGET_ROOT>" -CodexHome "<CODEX_HOME>" -Confirm:$false
```

Before reading provenance or mutating, the script rejects symlink, junction, and other reparse components. It verifies the ownership manifest and exact scheduled-task action. It may then disable/stop/remove only `HermesCodexBridgeV3`, remove only matching bridge hook commands, and remove bridge runtime/state.

The script does not remove the shared integration root, `Queue/bridge/v3`, `Queue/protocol/v3`, `v3/windows`, `v3/hermes`, Codex sessions/home, or user workspaces. Remove the native-router automation only through Codex when its exact recorded ID proves this installation created it and the user separately approved that removal.

## Hermes Removal

After independent Hermes approval, apply normal removal:

```sh
sudo ./hermes/scripts/uninstall.sh --hermes-home "<HERMES_HOME>" --env-file "<HERMES_ENV_FILE>" --apply
```

The manifest-authoritative transaction stops the service, verifies it is inactive, captures a post-stop backup, disables the unit, quarantines the manifest-proven system unit, runtime, state, and bridge skill, reloads systemd, and finalizes removal. On a later failure it restores the quarantined or backed-up targets and the prior active/enabled state.

It preserves the Queue, Syncthing configuration/data, Hermes home, gateway configuration, Telegram history, user-created skills, and dedicated env file.

## Optional Environment Removal

The manifest binds the configured env path but does not prove that the installer originally created a pre-existing credential file. Stop and ask separately whether the user wants that dedicated local file removed. If and only if the user explicitly approves credential-file removal while the manifest is still present, preview and then apply:

```sh
sudo ./hermes/scripts/uninstall.sh --hermes-home "<HERMES_HOME>" --env-file "<HERMES_ENV_FILE>" --remove-env
sudo ./hermes/scripts/uninstall.sh --hermes-home "<HERMES_HOME>" --env-file "<HERMES_ENV_FILE>" --remove-env --apply
```

`--remove-env` is opt-in and requires the same path/provenance checks plus its own approval. Never add it automatically, and never use it for a shared/general Hermes environment.

## Verification

Rerun each approved uninstaller in plan mode. Windows should report `UNINSTALL_ALREADY_ABSENT` when its runtime is gone. Hermes should report `UNINSTALL_ALREADY_ABSENT` when no manifest-proven live target remains.

Independently confirm that approved owned services/hooks/runtime/skill targets are absent and that preservation boundaries still exist. Report `removed`, `not authorized`, `not installed`, or `manual recovery required` separately for each host. Do not infer complete removal when only one host was authorized.

## Expected Redacted Output

Windows success ends with:

```text
TARGET: ScheduledTask:HermesCodexBridgeV3
TARGET: codex-hooks
TARGET: state
TARGET: runtime
UNINSTALL_OK
```

Labels for already-absent optional targets may be omitted. Normal Hermes plan/output resembles:

```text
PLAN uninstall hermes-codex-bridge-v3
TARGET system-unit
TARGET runtime
TARGET state
TARGET hermes-skill
PRESERVE queue
PRESERVE hermes-home
PRESERVE env-file [redacted]
RUN systemd-disable [production:yes]
```

Hermes apply success ends with `UNINSTALL_OK`. No output includes configured paths or environment values.

## Failure Behavior

- Missing or inconsistent provenance produces `UNINSTALL_OWNERSHIP_UNVERIFIED`; no live target is authorized for removal.
- A mismatched Windows scheduled task produces `UNINSTALL_TASK_OWNERSHIP_UNVERIFIED`; the existing task remains outside bridge authority.
- Unsafe physical paths fail before removal. Do not work around reparse checks with lower-level deletion.
- `UNINSTALL_PARTIAL` means Windows sequential mutation began and one later owned step failed. Stop immediately and do not rerun destructive steps blindly.
- `UNINSTALL_ROLLBACK` means Hermes transactional restoration failed. Stop immediately, preserve its private recovery evidence, and require the host owner to recover before retry.

See [Troubleshooting](TROUBLESHOOTING.md) for code-specific checks. A warning or partial code must not be converted into success by removing preserved data.

## Rollback and Recovery

Hermes uninstall is transactional. Its rollback restores manifest-proven targets from quarantine or the complete post-stop backup and restores the captured service state. If rollback succeeds, the original stable failure code remains; fix that cause, rerun plan mode, and request approval again. If rollback itself fails, retain the recovery directory and do not manually move or recreate targets.

Windows uninstall is non-transactional after mutation begins. `UNINSTALL_PARTIAL` may mean a task or hooks were already removed before state/runtime failed. Inventory only remaining manifest-proven owned targets, prepare a new redacted recovery plan, and obtain explicit approval. Do not promise reconstruction of a step that already completed.

Neither recovery model authorizes deletion of Queue records, Syncthing data/configuration, Codex home/sessions, integration root, user workspaces, Hermes home/gateway data, Telegram data, user-created skills, or unrelated automations.
