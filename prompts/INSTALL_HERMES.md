# Install the Hermes Side

Use this prompt locally on the Linux host that runs Hermes. It establishes official Hermes/Telegram prerequisites before installing the bridge-owned systemd service and Hermes reply skill.

Never ask the user to paste a Telegram token or chat ID into chat. The user must configure both values directly on the Hermes host in a dedicated protected local env file. Produce only redacted JSON output or a redacted report.

## Read-only preflight

Verify prerequisites in this order before any bridge mutation:

1. Confirm the official client is available as `hermes` and record only a pass/fail code.
2. Require one normal local Hermes chat before gateway setup.
3. Confirm `hermes gateway setup` has been completed or is the next explicit onboarding action.
4. Require one normal Telegram conversation with Hermes to succeed before bridge installation; a bot token alone is not proof.
5. Confirm Syncthing reports the shared folder up to date and that `<shared-root>/v3/hermes` contains `scripts/install.sh`, `watcher.py`, and the templates published by the reviewed Windows install.
6. Confirm Linux, Python 3, systemd, `sudo`, an existing non-root account that already runs Hermes, an absolute writable Hermes home, and an absolute Queue root ending in `Queue/bridge/v3` that this account can read, write, and traverse. The bridge installer verifies these permissions; it does not create the account or grant them.

If Hermes itself is missing, plan the official installation command, but do not run it yet:

```sh
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

If onboarding is already complete and the dedicated env file already exists, inspect the bridge plan without `--apply`:

```sh
cd "<shared-root>/v3/hermes"
sudo ./scripts/install.sh --queue-root "<shared-root>/Queue/bridge/v3" --hermes-home "<hermes-home>" --env-file "<dedicated-env-file>" --service-user hermes
```

Before planning, verify the existing service identity locally with `id hermes` and `sudo -u hermes test` checks for read access to the synced payload, read/write/traverse access to the Queue and `interactions`, and read/write/traverse access to `<hermes-home>`. If another non-root account actually runs Hermes, substitute it consistently. Stop if no prepared identity exists; never make these paths world-writable.

For a fresh installation, report `PLAN_PENDING_LOCAL_SECRET_SETUP` and defer this command until after the first approval; creating an env file is a mutation. The installer must identify only stable target labels. Inspect the templates `hermes/templates/hermes-codex-bridge.service.in` and `hermes/templates/SKILL.md.in`; never render secrets into either.

Stop immediately if an onboarding attempt or normal Telegram conversation fails, Syncthing is not converged, the Queue is not writable by the intended service user, any known path is relative/symlinked/overlapping, an existing env file is shared or not mode `600`, tests fail, or authority is missing. Missing Hermes onboarding or a missing dedicated env file on a fresh host is a planned prerequisite, not permission to mutate during preflight.

## Approval gate

Prepare a redacted plan for these exact targets:

- `/opt/hermes-codex-bridge-v3`;
- `/var/lib/hermes-codex-bridge-v3`;
- `/etc/systemd/system/hermes-codex-bridge.service`;
- `<hermes-home>/skills/hermes-codex-telegram-reply-v3`;
- the dedicated `<env-file>` as protected input preserved by default;
- the shared Queue as preserved data, never an uninstall target.

Wait for explicit user approval before running the official Hermes installer, `hermes gateway setup`, creating the env file, installing the bridge, enabling a service, or changing a gateway. These are distinct authorities; do only the approved actions.

## Approved mutation

If approved and needed, install official Hermes, verify `hermes`, complete a normal local Hermes chat, complete `hermes gateway setup`, and prove the normal Telegram conversation first.

Create a dedicated env file locally without displaying values, command history expansion, process arguments, or terminal capture. It must contain exactly one local value for each required key:

```text
HERMES_TELEGRAM_TOKEN=<set-locally>
HERMES_TELEGRAM_CHAT_ID=<set-locally>
```

Set ownership for the dedicated service account and run `chmod 600 "<dedicated-env-file>"`. Do not reuse a general Hermes env file.

From the converged `<shared-root>/v3/hermes` payload, run `scripts/install.sh` without `--apply`, present its redacted target plan, and wait for renewed explicit user approval. Apply only the unchanged reviewed plan:

```sh
cd "<shared-root>/v3/hermes"
sudo ./scripts/install.sh --queue-root "<shared-root>/Queue/bridge/v3" --hermes-home "<hermes-home>" --env-file "<dedicated-env-file>" --service-user hermes --apply
```

Do not edit the rendered unit, installed runtime, ownership manifest, or skill by hand. A failed installer transaction is a failure, not permission to reproduce its steps manually.

## Verification

Run the offline, redacted doctor and the installed service checks:

```sh
cd "<shared-root>/v3/hermes"
python3 ./doctor.py --queue-root "<shared-root>/Queue/bridge/v3" --env-file "<dedicated-env-file>" --runtime-root /opt/hermes-codex-bridge-v3
sudo systemctl status hermes-codex-bridge.service --no-pager
sudo -u hermes python3 -m unittest discover -s /opt/hermes-codex-bridge-v3 -p 'test_*.py' -v
```

Require `healthy:true`, a fresh service heartbeat, a successful Queue create/delete probe, protected env mode/content checks, passing installed tests, and an active service. The doctor does not contact Telegram; retain the earlier normal conversation as the gateway proof. Return stable codes and counts only in the redacted report—never environment values, private paths, raw Queue data, token, or chat ID.

## Owned-only rollback

Preview rollback with the same Hermes home and dedicated env file:

```sh
sudo ./hermes/scripts/uninstall.sh --hermes-home "<hermes-home>" --env-file "<dedicated-env-file>"
```

After explicit user approval, apply it:

```sh
sudo ./hermes/scripts/uninstall.sh --hermes-home "<hermes-home>" --env-file "<dedicated-env-file>" --apply
```

The owned-only rollback is limited to the manifest-proven unit, runtime, state, and bridge skill. It preserves the pre-existing dedicated env file by default; remove that file only after separate explicit approval with `--remove-env`. Stop if the manifest is missing, provenance is inconsistent, a target overlaps user data, the service cannot stop, or rollback reports `UNINSTALL_ROLLBACK`. Preserve recovery evidence. Never delete the Queue, Syncthing configuration/data, Hermes home, Hermes gateway configuration, Telegram history, or any user-created Hermes skill.
