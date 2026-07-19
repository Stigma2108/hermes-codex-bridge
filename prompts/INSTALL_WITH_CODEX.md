# Install Hermes–Codex Bridge with Codex

Give this entire file to Codex from the root of a trusted clone. Its job is to guide and verify the installation, while keeping every host and credential inside its proper authority boundary.

Use this prerequisite order: prepare Hermes, complete its Telegram onboarding, establish Syncthing convergence, install the Windows side, and finish with a real E2E round trip.

Use exactly this state machine and report every transition:

`DISCOVER → PREFLIGHT → PLAN → WAIT_FOR_APPROVAL → WINDOWS_INSTALL → SYNCTHING_VERIFY → HERMES_HANDOFF → HERMES_VERIFY → NATIVE_ROUTER_SETUP → REAL_E2E → REDACTED_REPORT`

Never skip, merge, reorder, or silently retry a state. Never ask the user to paste a Telegram token or chat ID into Codex. Secrets belong only in a protected local env file on the Hermes host. Display only a redacted report with stable health/error codes and repository-relative paths.

## Read-only preflight

In `DISCOVER`, establish facts without writing anything:

1. Confirm the current working directory is the trusted repository root and inspect `README.md`, `prompts/INSTALL_CODEX.md`, `prompts/INSTALL_HERMES.md`, and `prompts/VERIFY_INSTALLATION.md`.
2. Identify which host is Windows, which host runs Hermes, who controls each host, the absolute Syncthing shared root on each host, the Codex home, the Hermes home, and the allowed Windows workspace roots. Keep absolute paths out of the final report.
3. Determine whether this Codex session has explicit authority to mutate Windows and whether it has separately authorized SSH access to the Hermes host. Mere network reachability is not authority.
4. Confirm the originating Codex task/thread ID from authoritative Codex metadata. Do not infer it from a title, folder, most-recent task, or user-visible label.
5. Discover, without changing either host, whether Syncthing is installed, running, and configured; record only stable status codes. Inspect the local folder/device configuration without printing device IDs, addresses, private paths, or unrelated folder names. If the Hermes host is not under explicit authority, ask its owner to run the equivalent read-only checks and return only the redacted result.

In `PREFLIGHT`, run only read-only or reversible probe checks:

```powershell
pwsh -NoProfile -File ./bridge/scripts/Test-Prerequisites.ps1 -SharedRoot "<absolute-windows-shared-root>" -Json
pwsh -NoProfile -File ./bridge/scripts/Install-Bridge.ps1 -IntegrationRoot "<absolute-windows-shared-root>" -QueueRoot "<absolute-windows-shared-root>/Queue/bridge/v3" -AllowedWorkspaceRoots "<absolute-workspace-root>" -UiRouterMode external -WhatIf
```

On an authorized Hermes shell, run the installer without `--apply` only if the dedicated protected env file already exists. For a fresh installation, report `PLAN_PENDING_LOCAL_SECRET_SETUP`; do not create the file during preflight and defer this command to the approved Hermes handoff:

```sh
cd "<absolute-hermes-shared-root>/v3/hermes"
sudo ./scripts/install.sh --queue-root "<absolute-hermes-shared-root>/Queue/bridge/v3" --hermes-home "<absolute-hermes-home>" --env-file "<absolute-dedicated-env-file>" --service-user hermes
```

Also run the repository unit suites appropriate to each reachable host. Summarize results as stable codes and counts; never echo command environments, credentials, private paths, raw Queue content, or configuration values.

Stop immediately if there is missing authority, failed sync, failed unit tests, an unhealthy service, or an ambiguous Codex thread identity. Also stop for unsafe/symlinked paths, a shared secret file, unclear ownership, or any request to weaken a safety check.

## Approval gate

In `PLAN`, present one redacted plan containing:

- the planned state transitions;
- each host and the authority available for it;
- repository-relative scripts and named owned targets;
- tests and doctors that will prove success;
- preservation boundaries and rollback actions.
- a **Syncthing bootstrap** subflow when either host is not ready: official/manual installation, device pairing, a dedicated folder, ignore rules, autostart, and a convergence sentinel, each scoped to the separately authorized host.

Enter `WAIT_FOR_APPROVAL` and wait for explicit user approval before any mutation. Obtain explicit user approval for the Syncthing bootstrap separately from the Windows bridge install. Approval for Windows does not authorize Hermes, SSH, Telegram, Syncthing reconfiguration, or deletion. If the plan changes, return to `PLAN` and request approval again.

## Approved mutation

If the approved plan includes a clean Syncthing bootstrap, complete this approval-gated prerequisite subflow before entering `WINDOWS_INSTALL`:

1. Offer the official/manual installation procedure for each missing local Syncthing installation. Mutate only a host covered by explicit authority; otherwise give its owner the instructions and wait for a redacted result. Do not automate remote Hermes without authority.
2. Exchange and approve each Syncthing device ID through the user's trusted channel. Device IDs are identifiers, not credentials. Never put tokens or chat IDs in chat, and never request Telegram secrets.
3. On both hosts, configure one dedicated **Send & Receive** folder rooted at the user-selected absolute shared root. Never select a home directory, an entire Obsidian vault, a Hermes home, a Codex home, or another broad user-data tree.
4. Create matching `.stignore` policy on both sides before the first sync. Keep the bridge source, `Queue/bridge/v3`, `Queue/protocol/v3`, and `v3/windows|hermes`; exclude operational/private non-bridge content including `.git`, `.planning`, `.env*`, `**/__pycache__`, `**/*.pyc`, `.syncthing.*.tmp`, `sync-conflict-*`, and every unrelated subtree present under the selected root. Stop if the include/exclude boundary is ambiguous.
5. Configure Syncthing autostart on both hosts using the platform's documented user-service mechanism. Do not weaken authentication, expose the GUI publicly, or open firewall access beyond the approved peer path.
6. Prove a two-sided sentinel convergence: create a harmless nonce file on Windows, observe the same name/hash on Hermes, create a different harmless nonce on Hermes, observe it on Windows, then remove both and prove their deletion converges. Report only nonce prefixes and status codes.

If any installation, pairing, folder, ignore, autostart, or sentinel check fails or is ambiguous, stop in the prerequisite subflow, report a redacted stable code, and do not enter `WINDOWS_INSTALL`.

In `WINDOWS_INSTALL`, follow `prompts/INSTALL_CODEX.md`. Use the dedicated Windows Syncthing root as `-IntegrationRoot` and use `bridge/scripts/Install-Bridge.ps1` only with the approved absolute roots and `-UiRouterMode external` so the base service can be proved healthy before a router exists. Do not substitute private machine defaults or install outside the displayed targets.

In `SYNCTHING_VERIFY`, wait until protocol/runtime handoff files have converged on both hosts, including the reviewed payload at `<absolute-hermes-shared-root>/v3/hermes`. Compare safe file names, sizes, and cryptographic hashes; do not copy Queue payloads into chat. A running Syncthing process alone is not proof of convergence.

In `HERMES_HANDOFF`, proceed according to authority. The Hermes prompt uses its own gates: approve prerequisite onboarding and local secret-file creation first, run the redacted bridge plan, then obtain renewed approval for `--apply`:

- With explicitly authorized SSH access, execute `prompts/INSTALL_HERMES.md` on the Hermes host and obey its separate approval boundary.
- Without explicitly authorized SSH access, give the user `prompts/INSTALL_HERMES.md` for transfer, explain how to return its redacted result, and wait for the redacted Hermes result. Do not claim that the remote installation succeeded.

In `HERMES_VERIFY`, accept success only from the redacted `hermes/doctor.py` JSON plus service and unit-test status. Never request the environment file or Queue records.

In `NATIVE_ROUTER_SETUP`, follow the native-router section of `prompts/INSTALL_CODEX.md`: create one dedicated service task and paused automation from `bridge/assets/UI_ROUTER_PROMPT.md`, register only that service task/thread's authoritative ID with the installed `bridge/src/ui-router-cli.mjs` equivalent, verify two cycles, and only then switch the bridge to native mode. This router identity is separate from the originating user task/thread used by the E2E test.

In `REAL_E2E`, follow `prompts/VERIFY_INSTALLATION.md`. Require a genuine Codex notification delivered through Hermes to Telegram and a Telegram Reply routed back to the exact originating Codex task/thread.

## Verification

Verify your own work at every state boundary. Do not enter `REDACTED_REPORT` unless:

- Windows and Hermes unit tests pass;
- Syncthing convergence is proved on both sides;
- Windows and Hermes doctors report healthy without secrets or private paths;
- the native router heartbeat is healthy;
- the real E2E notification and Reply round trip reached the exact originating Codex task/thread.

The final redacted report may contain state names, pass/fail, stable codes, repository-relative files, test counts, and shortened event identifiers. It must not contain absolute private paths, tokens, chat IDs, environment values, raw Queue records, Telegram payloads, or router claim JSON.

## Owned-only rollback

If an approved mutation fails, stop forward progress and roll back only targets owned by this bridge:

- Windows: scheduled task `HermesCodexBridgeV3`, bridge-owned hook entries, and the bridge runtime/state recorded by `bridge/scripts/Uninstall-Bridge.ps1`;
- Hermes: `hermes-codex-bridge.service`, `/opt/hermes-codex-bridge-v3`, `/var/lib/hermes-codex-bridge-v3`, and the bridge skill under the approved Hermes home; preserve the dedicated bridge env file unless its separate explicit removal is approved;
- native router: only the bridge router automation created by this installation.

Use `bridge/scripts/Uninstall-Bridge.ps1` and `hermes/scripts/uninstall.sh` in plan mode first, then apply only under the matching explicit authority. Stop if ownership is missing or ambiguous. Never delete the Queue, Syncthing configuration/data, the Codex home, user workspaces, the Hermes home, Telegram configuration, or unrelated automations.
