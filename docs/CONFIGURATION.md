# Configuration Reference

Windows uses one closed JSON configuration. Hermes uses one protected local env file plus paths rendered into installer-owned templates. This split keeps Telegram credentials out of Windows, Syncthing, the repository, and Queue.

## Prerequisites

- Installers have created their ownership manifests and generated configuration.
- All configured roots are absolute, physical, existing, and free of symlink/junction/reparse components.
- Changes are reviewed through installer plan mode; do not hand-edit rendered systemd units, installed runtime, or ownership manifests.

Define these environment-specific placeholders locally immediately before the first command:

- `<WINDOWS_CONFIG_PATH>` — absolute path to the installed Windows `config.json`.
- `<LINUX_SHARED_ROOT>` — absolute Syncthing root on Linux.
- `<HERMES_ENV_FILE>` — absolute protected bridge env file.

Validate Windows configuration without starting the service:

```powershell
node ./bridge/src/cli.mjs validate-config --config "<WINDOWS_CONFIG_PATH>"
```

Success is exactly `CONFIG_OK`. Validation resolves the Codex executable and physical roots; a syntactically valid JSON document can still be unsafe.

## Windows Configuration Fields

The schema is `hermes-codex-bridge-config/v3` and permits exactly these keys:

| Field | Required value and reason |
|---|---|
| `schema` | Exact value `hermes-codex-bridge-config/v3`; prevents accidental use of another contract. |
| `queueRoot` | Absolute existing directory ending in `Queue/bridge/v3`; it is the only v3 interaction boundary. |
| `codexHome` | Absolute existing Codex home containing sessions/hooks used by this user. |
| `codexCommand` | Absolute Codex executable path; the loader resolves and verifies the file. |
| `stateRoot` | Absolute existing bridge-owned local state; it must not overlap Queue or Codex home. |
| `allowedWorkspaceRoots` | Non-empty array of unique absolute existing workspace roots. Keep each narrow; a root inside Queue, state, or Codex home is rejected. |
| `pollMinMs` | Integer at least `100`; lower values are refused to prevent an unsafe busy loop. |
| `pollMaxMs` | Integer from `pollMinMs` through `60000`; used for bounded polling and service-heartbeat freshness. |
| `replyTtlSeconds` | Exact v3 value `604800` (seven days). |
| `approvalTtlSeconds` | Exact v3 value `43200` (12 hours). |
| `uiRouterMode` | `external` during base installation or `native` after the dedicated router passes its checks. |

Define these environment-specific placeholders locally immediately before the illustrative configuration:

- `<ABSOLUTE_QUEUE_ROOT>` — absolute Windows path to the dedicated `Queue/bridge/v3` directory.
- `<ABSOLUTE_CODEX_HOME>` — absolute Windows path to this user's Codex home.
- `<ABSOLUTE_CODEX_COMMAND>` — absolute Windows path to the installed Codex executable.
- `<ABSOLUTE_STATE_ROOT>` — absolute Windows path to bridge-owned local state.
- `<ABSOLUTE_WORKSPACE_ROOT>` — absolute Windows path to one allowed workspace root.

Illustrative shape only; replace placeholders locally through the installer:

```json
{
  "schema": "hermes-codex-bridge-config/v3",
  "queueRoot": "<ABSOLUTE_QUEUE_ROOT>",
  "codexHome": "<ABSOLUTE_CODEX_HOME>",
  "codexCommand": "<ABSOLUTE_CODEX_COMMAND>",
  "stateRoot": "<ABSOLUTE_STATE_ROOT>",
  "allowedWorkspaceRoots": ["<ABSOLUTE_WORKSPACE_ROOT>"],
  "pollMinMs": 1000,
  "pollMaxMs": 1500,
  "replyTtlSeconds": 604800,
  "approvalTtlSeconds": 43200,
  "uiRouterMode": "native"
}
```

Any key whose name resembles a token, password, chat ID, secret, credential, or API key is rejected recursively with `CONFIG_SECRET_KEY`. Windows configuration is not a secret store.

## Hermes Protected Environment

`<HERMES_ENV_FILE>` is a dedicated protected local env file on Linux. Operational policy is exactly one non-empty local value for each key:

```text
HERMES_TELEGRAM_TOKEN=<set-locally>
HERMES_TELEGRAM_CHAT_ID=<set-locally>
```

The file must be a regular, non-symlink file, no larger than 16 KiB, mode `600`, readable by the non-root service user, and outside Queue, runtime, state, system-unit, and Hermes skill targets. Chat ID is validated as a canonical positive decimal identifier. Values are read locally and never printed by the doctor.

Do not reuse the general Hermes gateway environment, place the file under Syncthing, embed values in a service unit, or pass them as command arguments. Rotate credentials through a separately approved local procedure, restart the bridge unit, and rerun the doctor.

## Generated Hermes Configuration

`hermes/scripts/install.sh` renders:

- `/etc/systemd/system/hermes-codex-bridge.service` from `hermes/templates/hermes-codex-bridge.service.in`;
- `<HERMES_HOME>/skills/hermes-codex-telegram-reply-v3/SKILL.md` from `hermes/templates/SKILL.md.in`;
- `/opt/hermes-codex-bridge-v3/install-manifest.json` as protected provenance.

The unit runs the watcher as the non-root `hermes` user, reads the env file through systemd, enables `NoNewPrivileges`, protects the system/home, and grants write access only to Queue and bridge state. The skill invokes `inbound.py` with bounded JSON on standard input so raw sender/message data is not placed in process arguments.

## Verification

After any approved change, run both validators:

```powershell
node ./bridge/src/cli.mjs doctor --config "<WINDOWS_CONFIG_PATH>"
```

```sh
python3 ./hermes/doctor.py --queue-root "<LINUX_SHARED_ROOT>/Queue/bridge/v3" --env-file "<HERMES_ENV_FILE>" --runtime-root /opt/hermes-codex-bridge-v3
```

Require healthy redacted JSON and fresh service/router heartbeats. A configuration change is incomplete until the installed service starts and produces the expected bounded heartbeat.

## Expected Redacted Output

Configuration validation returns:

```text
CONFIG_OK
```

Doctor checks report only fields such as:

```json
{"healthy":true,"checks":{"config":{"status":"ok","code":"DOCTOR_CONFIG_OK"},"environment":{"status":"ok","code":"DOCTOR_ENV_OK"}}}
```

Windows and Hermes doctor schemas differ, so compare stable check codes rather than merging their JSON objects.

## Failure Behavior

- Invalid JSON, wrong key set, schema, TTL, polling bounds, secret-like keys, or physical paths produces `CONFIG_INVALID` for CLI commands and `DOCTOR_CONFIG_INVALID` for the Windows doctor.
- Missing, shared, malformed, wrong-mode, or symlinked Hermes env files produce a `DOCTOR_ENV_*` or installer refusal. Do not loosen the file mode or move it into Queue.
- Missing or stale heartbeats mean the running configuration has not been proven; restore the last reviewed installer inputs before live use.
- Never troubleshoot by printing config values, environment contents, ownership manifests, Queue payloads, or absolute paths.

## Rollback and Recovery

Rerun the appropriate installer first in plan mode with the last known reviewed arguments, then explicitly approve the unchanged apply. Both installers stage prior owned files and attempt rollback if a reconfiguration fails.

If Windows reports `INSTALL_ROLLBACK` or Hermes reports `INSTALL_ROLLBACK`, stop and preserve private recovery evidence. Do not hand-edit the manifest to force ownership. Uninstall preserves the protected Hermes env file by default; `--remove-env` is an independent, opt-in credential-removal decision described in [Uninstall](UNINSTALL.md).
