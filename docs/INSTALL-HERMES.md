# Install the Linux/Hermes Side

Hermes must already work with Telegram before the bridge is added. This ordering separates gateway onboarding problems from bridge problems and keeps the bridge installer from becoming a credential bootstrapper.

For a guided host-local run, use [the Hermes installation prompt](../prompts/INSTALL_HERMES.md). Give it only to an authorized agent or operator on the Linux host.

## Prerequisites

Use the official [Hermes Agent repository](https://github.com/NousResearch/hermes-agent). In this order: install Hermes, verify `hermes`, complete a normal local Hermes chat, run `hermes gateway setup`, configure and verify one normal Telegram conversation, verify Syncthing convergence, and only then begin bridge preflight with `install.sh`.

Also require Linux, Python 3, systemd, `sudo`, an existing non-root account that already runs Hermes, its existing Hermes home, and a dedicated Queue ending in `Queue/bridge/v3`. The installer verifies access; it does not create the account or grant access to the Queue or Hermes home.

Define these environment-specific placeholders locally immediately before the first command:

- `<LINUX_SHARED_ROOT>` — absolute root of the dedicated Syncthing folder on Linux.
- `<HERMES_PAYLOAD_ROOT>` — the synced installer payload at `<LINUX_SHARED_ROOT>/v3/hermes`.
- `<HERMES_HOME>` — absolute home used by Hermes; the bridge skill is installed beneath it.
- `<HERMES_ENV_FILE>` — absolute path to one dedicated protected bridge env file outside the Queue and owned runtime/state roots.

If Hermes is not installed, use its official installer:

```sh
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

Verify the command:

```sh
hermes --help
```

Before gateway setup, use Hermes locally to complete a normal local Hermes chat. Then configure the gateway:

```sh
hermes gateway setup
```

Configure and verify one harmless normal Telegram conversation through the gateway. Do not continue merely because a bot token exists. Confirm the dedicated Syncthing folder is up to date on this host using [the Syncthing guide](SYNCTHING.md), then proceed to the bridge preflight. Never request the token or chat ID in chat.

## Prepare the Service Identity and Synced Payload

The documented service identity is the existing non-root `hermes` account. If Hermes runs as a different non-root account, substitute that account consistently in the checks and `--service-user`; do not create or switch identities implicitly. If no suitable account exists, stop and prepare one according to the host's account policy, install and verify Hermes under it, and repeat the local and Telegram conversation checks.

Wait until Syncthing has delivered the Windows-published payload, then verify the account can traverse its Hermes home, read the payload, and read/write the Queue and interactions directory:

```sh
id hermes
test -d "<HERMES_PAYLOAD_ROOT>"
sudo -u hermes test -r "<HERMES_PAYLOAD_ROOT>/scripts/install.sh"
sudo -u hermes test -r "<HERMES_PAYLOAD_ROOT>/watcher.py"
sudo -u hermes test -d "<HERMES_HOME>"
sudo -u hermes test -r "<HERMES_HOME>"
sudo -u hermes test -w "<HERMES_HOME>"
sudo -u hermes test -x "<HERMES_HOME>"
sudo -u hermes test -d "<LINUX_SHARED_ROOT>/Queue/bridge/v3/interactions"
sudo -u hermes test -r "<LINUX_SHARED_ROOT>/Queue/bridge/v3"
sudo -u hermes test -w "<LINUX_SHARED_ROOT>/Queue/bridge/v3"
sudo -u hermes test -x "<LINUX_SHARED_ROOT>/Queue/bridge/v3"
sudo -u hermes test -r "<LINUX_SHARED_ROOT>/Queue/bridge/v3/interactions"
sudo -u hermes test -w "<LINUX_SHARED_ROOT>/Queue/bridge/v3/interactions"
sudo -u hermes test -x "<LINUX_SHARED_ROOT>/Queue/bridge/v3/interactions"
```

Any failure is a local ownership or Syncthing-layout prerequisite. Correct it under host-owner authority and repeat the checks; do not make the Queue world-writable.

## Create the Protected Environment

After separate approval, create `<HERMES_ENV_FILE>` in a local editor that does not echo or record values. It contains exactly one locally entered value for each key:

```text
HERMES_TELEGRAM_TOKEN=<set-locally>
HERMES_TELEGRAM_CHAT_ID=<set-locally>
```

Never request either value in chat, paste it into an agent prompt, place it in Queue, or put it in a command argument. Protect it for the dedicated service account:

```sh
sudo chown hermes:hermes "<HERMES_ENV_FILE>"
sudo chmod 600 "<HERMES_ENV_FILE>"
```

Do not reuse a general Hermes environment file. A dedicated file makes ownership, rotation, and optional removal explicit.

## Review the Plan

Run the installer without `--apply`:

```sh
cd "<HERMES_PAYLOAD_ROOT>"
sudo ./scripts/install.sh --queue-root "<LINUX_SHARED_ROOT>/Queue/bridge/v3" --hermes-home "<HERMES_HOME>" --env-file "<HERMES_ENV_FILE>" --service-user hermes
```

The plan names runtime, state, system unit, Hermes skill, staged tests, installed tests, and systemd enablement without printing configured paths. Inspect [the systemd template](../hermes/templates/hermes-codex-bridge.service.in) and [reply skill template](../hermes/templates/SKILL.md.in). The rendered files must be created by the installer, not edited by hand.

Wait for renewed explicit approval for the unchanged plan. Official Hermes installation, gateway setup, local secret-file creation, Syncthing changes, and bridge `--apply` are separate mutations and may require separate authorities.

## Approved Installation

Apply only the reviewed arguments:

```sh
cd "<HERMES_PAYLOAD_ROOT>"
sudo ./scripts/install.sh --queue-root "<LINUX_SHARED_ROOT>/Queue/bridge/v3" --hermes-home "<HERMES_HOME>" --env-file "<HERMES_ENV_FILE>" --service-user hermes --apply
```

The installer validates every path component, environment mode and shape, service user, source ownership, the service user's existing Queue/Hermes-home access, and existing provenance before mutation. It stages source through a private root-owned directory, runs staged tests, writes a protected ownership manifest, renders the templates, creates its owned state with restricted access, runs installed tests as that user, enables the unit, and verifies its systemd state. Success ends with `INSTALL_OK`.

## Verification

Run the offline doctor, service status, and installed test suite:

```sh
cd "<HERMES_PAYLOAD_ROOT>"
python3 ./doctor.py --queue-root "<LINUX_SHARED_ROOT>/Queue/bridge/v3" --env-file "<HERMES_ENV_FILE>" --runtime-root /opt/hermes-codex-bridge-v3
sudo systemctl status hermes-codex-bridge.service --no-pager
sudo -u hermes python3 -m unittest discover -s /opt/hermes-codex-bridge-v3 -p 'test_*.py' -v
```

Require `healthy:true`, `active (running)`, passing installed tests, a successful Queue create/delete probe, and a fresh watcher heartbeat. The doctor is intentionally offline and does not contact Telegram; retain the earlier normal conversation as the gateway proof.

## Expected Redacted Output

Plan output is label-only:

```text
PLAN install hermes-codex-bridge-v3
TARGET runtime
TARGET state
TARGET system-unit
TARGET hermes-skill
CONFIG queue-root [redacted]
CONFIG env-file [redacted]
RUN staged-tests
RUN installed-tests
RUN systemd-enable [production:yes]
```

A healthy doctor resembles:

```json
{"schema":"hermes-codex-doctor/v3","healthy":true,"checks":{"paths":{"status":"ok","code":"DOCTOR_PATHS_OK"},"environment":{"status":"ok","code":"DOCTOR_ENV_OK"},"runtime":{"status":"ok","code":"DOCTOR_RUNTIME_OK"},"queueWrite":{"status":"ok","code":"DOCTOR_QUEUE_WRITE_OK"},"serviceHeartbeat":{"status":"ok","code":"DOCTOR_SERVICE_HEARTBEAT_OK"}}}
```

Output contains no token, chat ID, environment value, Queue payload, or configured path.

## Failure Behavior

- `INSTALL_ENV_MODE`, `INSTALL_ENV_CONTENT`, or `INSTALL_USER` stops before installation; correct the local prerequisite and rerun plan mode.
- `INSTALL_UNSAFE`, `INSTALL_OVERLAP`, and `INSTALL_OWNERSHIP_CONFLICT` are fail-closed path or provenance refusals. Do not bypass them with manual copying.
- An apply failure triggers transactional restore of prior targets and service state. `INSTALL_ROLLBACK` means restoration itself failed; stop and preserve the private recovery evidence for the host owner.
- An unhealthy doctor exits `3` and reports stable codes only. A fresh service heartbeat is required even when systemd reports the process active.

See [Troubleshooting](TROUBLESHOOTING.md) for safe checks. Never publish the env file, ownership manifest, Queue records, service environment, or absolute paths.

## Rollback and Recovery

Preview owned-only removal while preserving the environment file:

```sh
sudo ./hermes/scripts/uninstall.sh --hermes-home "<HERMES_HOME>" --env-file "<HERMES_ENV_FILE>"
```

After explicit approval, add `--apply`. The Hermes uninstaller is transactional and restores manifest-proven targets plus prior service state when a later step fails. It preserves Queue, Syncthing, Hermes home/gateway data, user skills, and the protected env file by default. Optional `--remove-env` requires separate approval before the ownership manifest is removed; see [Uninstall](UNINSTALL.md).
