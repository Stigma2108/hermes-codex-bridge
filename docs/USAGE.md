# Use the Bridge

The normal interaction starts in Codex. The bridge delivers a bounded notification to Telegram; the user acts by using Telegram Reply on that exact bridge message; Windows then applies the validated action to the same originating Codex task. No task selector or “latest task” heuristic exists.

## Prerequisites

- Both [Windows](INSTALL-CODEX.md) and [Hermes](INSTALL-HERMES.md) installations verified healthy.
- The dedicated Syncthing folder connected and up to date on both hosts.
- Native router mode enabled, with one registered router task and a fresh bounded heartbeat.
- A normal Hermes/Telegram conversation already working.

Define these environment-specific placeholders locally immediately before the first command:

- `<WINDOWS_TARGET_ROOT>` — installed Windows runtime root.
- `<LINUX_SHARED_ROOT>` — Linux path to the dedicated Syncthing root.
- `<HERMES_ENV_FILE>` — protected local Hermes bridge env file.

Before a live interaction, run both offline doctors on their respective hosts:

```powershell
node ./bridge/src/cli.mjs doctor --config "<WINDOWS_TARGET_ROOT>\config.json"
```

```sh
python3 ./hermes/doctor.py --queue-root "<LINUX_SHARED_ROOT>/Queue/bridge/v3" --env-file "<HERMES_ENV_FILE>" --runtime-root /opt/hermes-codex-bridge-v3
```

## Exact Telegram Reply Behavior

Use Telegram's Reply action on the bridge message you intend to answer. The replied-to message contains an `HC3:<uuid>` route. Hermes verifies the real replied-to message, sender, delivery record, allowed action, TTL, and exact event before writing one reply. Windows verifies the same event again before applying it.

Do not send a new unthreaded message, forward the bridge message, copy its route into another message, or reply to a screenshot. An unthreaded message cannot select or start a Codex task. If the route is absent, mismatched, expired, terminal, or already used, the action is rejected.

## Behavior Matrix

| Scenario | What the user does | Outcome |
|---|---|---|
| Final response | Use Telegram Reply with the next instruction. | If the final is still current, one continuation is routed to the same originating task. |
| Question | Use Telegram Reply with the requested answer. | A live question resolves the pending request; a completed `NEXT_TURN` question starts one exact-task continuation only while current. |
| Approve once | Reply with the exact approve-once phrase printed by the Telegram bridge message. | Only the pending local operation is allowed once; no session or permanent approval is created. |
| Decline | Reply with the exact decline phrase printed by the Telegram bridge message. | The pending operation is denied and no replacement task is started. |
| Windows offline | Reply normally to the exact message. | The authenticated reply remains in the Queue until Syncthing and Windows return, subject to TTL and stale checks. |
| Hermes offline | Continue working in Codex. | The committed event waits in the Queue; Hermes delivers it after return unless it expires or local work makes it stale. |
| Busy thread | Reply normally. | Native routing releases the claim and waits instead of interrupting active Codex work. |
| Stale reply | No retry or manual Queue edit. | A newer local response/current-state change causes terminal rejection; the old text is not injected into the newer context. |
| Wrong Telegram Reply target | Reply again only to the original bridge message if it is still valid. | The unrelated message cannot route to Codex. |

## What Is Delivered

Primary-task final reports, explicit questions, approval requests, and bounded errors are eligible. Delivery policy can delay a normal final briefly while the user is at the desk, send explicit questions promptly when away, and cancel a pending candidate when the task continues locally.

Internal child-subagent final outputs and reviewer final outputs are suppressed. That suppression is sticky even when later inherited session metadata looks like a parent task. The dedicated router task is also suppressed by its exact registered ID. These rules reduce internal chatter without hiding useful primary-task questions or final reports.

Messages show bounded task metadata and a route, not private absolute paths. Queue contents are operational records and should not be copied into chat or public support channels.

## Live Verification

Use [the verification prompt](../prompts/VERIFY_INSTALLATION.md) after installation or a routing change. It asks for separate approval before one harmless live Telegram message, resolves the originating task from authoritative metadata, and requires the Telegram Reply nonce to appear in that exact task and nowhere else.

Do not manufacture `event.json`, `delivery.json`, `reply.json`, `ui-action.json`, or receipts to make verification pass. Real evidence must travel through the installed hooks, services, Syncthing, Hermes, Telegram, and native router.

## Expected Redacted Output

Healthy doctors return `healthy:true` and only stable check codes. A live verification report should contain no more than:

```text
SYNCTHING_CONVERGED
WINDOWS_DOCTOR_OK
HERMES_DOCTOR_OK
LIVE_NOTIFICATION_OK event=<short-prefix>
EXACT_TASK_REPLY_OK event=<short-prefix>
```

The report must omit absolute paths, task/thread IDs, automation IDs, Telegram message/chat IDs, reply text, Queue payloads, and credentials.

## Failure Behavior

- `DOCTOR_SERVICE_HEARTBEAT_STALE` or a stale native-router heartbeat stops live verification even if the process exists.
- An offline component is not data loss; leave committed write-once records untouched and restore that component.
- `BUSY` is a retryable router condition. Do not interrupt the task or create a second automation.
- A stale, expired, duplicate, or declined receipt is terminal for that interaction. Do not edit records or resend its route.
- If the wrong task receives content, stop both services and preserve private evidence; exact-task routing is a security invariant.

## Rollback and Recovery

For a native-router problem, pause only the bridge-owned router automation and reinstall the Windows side in `external` mode using the same reviewed roots. External mode is a diagnostic/rollback path; a continuation may not appear correctly in the open Desktop UI, so do not claim full recovery until native verification passes.

For host or transport outages, restore the previous service state and rerun doctors plus Syncthing convergence. Never recover by deleting Queue history, changing a route footer, copying a reply to another task, or exposing credentials. Follow [Troubleshooting](TROUBLESHOOTING.md) and [Uninstall](UNINSTALL.md) when removal is required.
