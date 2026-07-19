# Verify the Complete Installation

Use this prompt only after both installers report success. Verification must prove a real notification-and-reply loop, not merely that processes exist.

Never ask the user to paste a Telegram token or chat ID into this prompt. Secrets remain in the protected local env file on Hermes. All evidence returned to chat must be redacted output or a redacted report.

## Read-only preflight

Verify in this order:

1. **Syncthing convergence** — confirm both peers are connected and up to date; compare safe protocol file names, sizes, and hashes across hosts without reading payloads.
2. **Windows health** — run `node ./bridge/src/cli.mjs doctor --config "<target-root>/config.json"` and require a healthy service and native-router heartbeat.
3. **Hermes health** — run `python3 ./hermes/doctor.py --queue-root "<shared-root>/Queue/bridge/v3" --env-file "<dedicated-env-file>" --runtime-root /opt/hermes-codex-bridge-v3` and require healthy paths, env, runtime, Queue write probe, and service heartbeat.
4. **originating Codex task/thread** — resolve its exact ID from authoritative Codex metadata and verify that it is open/active. Never infer it from title, project, time, or position.
5. Plan one **real E2E** notification and Telegram Reply round trip tied to that exact task/thread.

Run the repository regression suite before creating live evidence:

```powershell
pwsh -NoProfile -File ./tests/Run-V3Tests.ps1
```

Stop immediately if Syncthing is not converged, either doctor is unhealthy, unit/E2E tests fail, the originating Codex identity is ambiguous, an unrelated interaction is pending, the user has not authorized a live Telegram message, or any evidence would expose private content.

## Approval gate

Present a redacted plan containing the exact originating task/thread identity only as a shortened fingerprint, the notification kind, the expected `HC3:<uuid>` routing footer, the expected Reply behavior, timeout, and stop conditions.

Wait for explicit user approval before creating the live Codex event or sending anything to Telegram. Approval to test is not approval to inspect or delete existing Queue data.

## Approved mutation

From the exact originating Codex task/thread, use Codex's supported question mechanism to create a harmless, clearly labelled `QUESTION/LIVE_REQUEST` notification with a one-time nonce. Let the installed bridge, Syncthing, Hermes watcher, and existing Telegram gateway carry it naturally. Do not create or edit `event.json`, `delivery.json`, or `reply.json` by hand.

After the message appears in Telegram, have the user use Telegram Reply on that exact bridge message with a harmless nonce. Do not accept an unthreaded message. Wait for the Reply to return through the bridge to the exact originating task/thread and confirm the nonce there.

Do not copy raw Queue records into the report, do not paste Telegram updates, and do not use a second task/thread as a substitute when routing fails.

## Verification

Verify your own work with these independent facts:

- both Syncthing peers remained converged after the round trip;
- Windows and Hermes health remained redacted and healthy;
- the bridge produced one genuine notification in Telegram;
- the Telegram Reply carried the matching route and appeared in the exact originating Codex task/thread;
- no other Codex task/thread received the Reply;
- all `tests/Run-V3Tests.ps1` checks passed before the live test.

Report only pass/fail, stable codes, timestamps rounded to minutes, shortened event identifiers, and test counts. Do not report absolute paths, task/thread IDs, message IDs, chat IDs, tokens, payload text, Queue records, automation IDs, or claim JSON.

## Owned-only rollback

Live bridge records are write-once evidence and are not rollback targets. If verification started components that were stopped beforehand, the owned-only rollback may restore only their prior state: scheduled task `HermesCodexBridgeV3`, systemd unit `hermes-codex-bridge.service`, and the exact native router automation created solely for this verification.

Require explicit user approval before stopping/removing any of those targets. Stop if prior state or ownership is unknown, if a target pre-dates this verification, or if either service is processing a live interaction. Never delete Queue records, Syncthing data/configuration, Telegram messages/history, user Hermes data, Codex sessions, or user tasks to make the test appear clean.
