# Hermes–Codex Queue Protocol v3

Protocol v3 is an additive bridge namespace. It does not modify or reinterpret v1/v2 task directories. Only the bridge scheduler/service may operate under `Queue/bridge/v3`; it has no ownership elsewhere in Queue.

## Layout and ownership

Each interaction is a direct child `interactions/evt_<uuid>/`. Windows exclusively creates `event.json`, optional `message.md`, `receipt.json`, and `windows-failure.json`. Hermes exclusively creates `delivery.json`, `reply.json`, and `hermes-failure.json`. Writers use create-if-absent atomic rename and never edit a committed file. Symlinks, reparse-like paths, nested event directories, and filename conflicts fail closed.

Commit order is `message.md` (when present), then `event.json`; Hermes commits `delivery.json` only after confirmed Telegram success and `reply.json` only after validating the matching delivery; Windows commits a terminal receipt last. A reader treats a missing owner record as an incomplete state, never as permission to reconstruct it.

## Lifetime, replay, and conflicts

`expires_at` is authoritative: approvals expire after at most 12 hours and replies after at most 7 days. Expired or terminal interactions are not delivered or applied. `event_id`, `delivery_ref`, and the exact thread identity bind all later records; Telegram replies route only to the event's exact thread—never to a current, guessed, or similarly titled thread. Restart scans are idempotent: existing delivery/reply/receipt files prevent replay. Concurrent equal creates are duplicates; unequal content is an integrity conflict and must produce only a redacted owner failure.

`integrity.content_sha256` is lowercase SHA-256 of the exact UTF-8 message bytes selected by the producer (inline summary, or `message.md` when declared). Consumers verify hashes and byte limits before delivery. Malformed JSON, wrong schema/version, timestamp, enum, size, path, ownership, or hash is rejected without copying its raw payload into errors.

## Safety and evolution

Core fields are required and closed by their value constraints; unknown optional fields are allowed for additive v3 evolution and must not change core meaning. New enum values or required fields require a new protocol version. Receipts expose only terminal status, offered action, and bounded redacted error code/message—never raw event/reply content.

Queue records, logs, failures, docs, and protocol examples must contain no Telegram token, raw chat ID, password, private endpoint, or other credential. `delivery_ref` is opaque. Hermes obtains credentials only from its runtime environment, and Windows never receives them.

`telegram.sender_fingerprint` is lowercase SHA-256 over the exact ASCII bytes `hermes-codex-v3:telegram-user:` followed by the verified sender's canonical positive base-10 Telegram `from.id` (no sign, whitespace, or leading zeroes). The raw ID is held only in memory and is never written to Queue or logs.

Protocol v3 requires only ordinary Telegram Reply routing; it does not require callback support, slash-command registration, or changes to an existing Telegram adapter. For an approval event, an exact trimmed Reply `ОДОБРИТЬ ОДИН РАЗ` maps to `APPROVE_ONCE` and `ОТКЛОНИТЬ` maps to `DECLINE`. Permanent/session approval is outside v3. Other reply text is rejected when `REPLY` was not offered.

`message.reply_mode` is an optional additive routing hint with the closed values `LIVE_REQUEST`, `NEXT_TURN`, and `NONE`. An absent value preserves the v3 behavior: a `QUESTION` targets its live app-server request, while other replyable events use normal exact-thread continuation. `NEXT_TURN` means that the original turn has already ended; Windows must verify that the event is still current before starting one new turn in `thread.id`.

The installed Hermes skill does not construct Queue records itself. It passes the footer event id, replied-to Telegram message id, verified sender `from.id`, and Reply text as bounded JSON on stdin to `/opt/hermes-codex-bridge-v3/inbound.py`. That runtime validates the event, exact `delivery.json`, owner identity from the private env file, terminal state, TTL, action, secret patterns, and reply schema before a mode-0600 create-if-absent publication of `reply.json`.
