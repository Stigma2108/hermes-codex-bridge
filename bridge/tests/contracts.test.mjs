import assert from "node:assert/strict";
import test from "node:test";
import { validateEvent, validateReply } from "../src/contracts.mjs";

const event = {
  schema: "hermes-codex-interaction-event/v3",
  event_id: "evt_019f74b5-c168-7381-9629-d395da0255f7",
  kind: "FINAL_RESPONSE",
  created_at: "2026-07-18T12:00:00.000Z",
  expires_at: "2026-07-25T12:00:00.000Z",
  thread: { id: "019f74b5-c168-7381-9629-d395da0255f7", turn_id: "turn-1", title: "Чат", project_label: "Knots", cwd_label: "Knots" },
  message: { summary: "Готово", markdown_path: null, is_replyable: true },
  allowed_actions: ["REPLY"],
  integrity: { producer: "codex-windows-local", content_sha256: "a".repeat(64) }
};

const reply = {
  schema: "hermes-codex-interaction-reply/v3",
  event_id: event.event_id,
  created_at: event.created_at,
  action: "APPROVE_ONCE",
  text: null,
  telegram: { delivery_ref: "opaque", sender_fingerprint: "f".repeat(64) }
};

function expectCode(callback, code) {
  assert.throws(callback, (error) => {
    assert.equal(error?.message, code);
    return true;
  });
}

function withoutOwn(object, field) {
  const copy = { ...object };
  delete copy[field];
  return copy;
}

function withInheritedField(object, field) {
  const copy = Object.assign(Object.create({ [field]: object[field] }), object);
  delete copy[field];
  return copy;
}

test("accepts a complete v3 event by identity", () => assert.strictEqual(validateEvent(event), event));
test("accepts a complete v3 reply by identity", () => assert.strictEqual(validateReply(reply), reply));

test("measures event summaries in Unicode code points", () => {
  for (const summary of ["🧵".repeat(2000), "🧵".repeat(3500)]) {
    const value = { ...event, message: { ...event.message, summary } };
    assert.strictEqual(validateEvent(value), value);
  }
  expectCode(
    () => validateEvent({ ...event, message: { ...event.message, summary: "🧵".repeat(3501) } }),
    "EVENT_MESSAGE",
  );
});

test("accepts forward-compatible optional additions", () => {
  const extendedEvent = { ...event, optional_future_field: true };
  const extendedReply = { ...reply, optional_future_field: true };
  assert.strictEqual(validateEvent(extendedEvent), extendedEvent);
  assert.strictEqual(validateReply(extendedReply), extendedReply);
});

test("accepts only the closed optional message reply_mode values", () => {
  for (const reply_mode of ["LIVE_REQUEST", "NEXT_TURN", "NONE"]) {
    const value = { ...event, message: { ...event.message, reply_mode } };
    assert.strictEqual(validateEvent(value), value);
  }
  expectCode(() => validateEvent({ ...event, message: { ...event.message, reply_mode: "FUTURE" } }), "EVENT_MESSAGE");
});

for (const [label, callback, code] of [
  ["event schema", () => validateEvent({ ...event, schema: "hermes-codex-interaction-event/v2" }), "EVENT_SCHEMA"],
  ["reply schema", () => validateReply({ ...reply, schema: "hermes-codex-interaction-reply/v2" }), "REPLY_SCHEMA"],
  ["event kind", () => validateEvent({ ...event, kind: "PROGRESS" }), "EVENT_KIND"],
  ["reply action", () => validateReply({ ...reply, action: "APPROVE_FOR_SESSION" }), "REPLY_ACTION"]
]) {
  test(`rejects an unknown ${label}`, () => expectCode(callback, code));
}

for (const [label, callback, code] of [
  ["null event root", () => validateEvent(null), "EVENT_SHAPE"],
  ["array event root", () => validateEvent([]), "EVENT_SHAPE"],
  ["inherited event root", () => validateEvent(Object.create(event)), "EVENT_SHAPE"],
  ["null reply root", () => validateReply(null), "REPLY_SHAPE"],
  ["array reply root", () => validateReply([]), "REPLY_SHAPE"],
  ["inherited reply root", () => validateReply(Object.create(reply)), "REPLY_SHAPE"]
]) {
  test(`rejects ${label}`, () => expectCode(callback, code));
}

for (const field of Object.keys(event)) {
  test(`rejects an event without own root field ${field}`, () => {
    expectCode(() => validateEvent(withoutOwn(event, field)), "EVENT_SHAPE");
  });
}

for (const field of Object.keys(reply)) {
  test(`rejects a reply without own root field ${field}`, () => {
    expectCode(() => validateReply(withoutOwn(reply, field)), "REPLY_SHAPE");
  });
}

for (const { label, value, apply, code } of [
  { label: "thread", value: event.thread, apply: (nested) => validateEvent({ ...event, thread: nested }), code: "EVENT_THREAD" },
  { label: "message", value: event.message, apply: (nested) => validateEvent({ ...event, message: nested }), code: "EVENT_MESSAGE" },
  { label: "integrity", value: event.integrity, apply: (nested) => validateEvent({ ...event, integrity: nested }), code: "EVENT_INTEGRITY" },
  { label: "telegram", value: reply.telegram, apply: (nested) => validateReply({ ...reply, telegram: nested }), code: "REPLY_TELEGRAM" }
]) {
  test(`rejects an array ${label} object`, () => expectCode(() => apply([]), code));
  for (const field of Object.keys(value)) {
    test(`rejects ${label} without own field ${field}`, () => expectCode(() => apply(withoutOwn(value, field)), code));
    test(`rejects inherited ${label} field ${field}`, () => expectCode(() => apply(withInheritedField(value, field)), code));
  }
}

const validRfc3339Timestamps = [
  "2026-07-18T12:00:00Z",
  "2026-07-18T12:00:00.000Z",
  "2026-07-18T12:00:00.123456Z",
  "2026-07-18T15:00:00+03:00",
  "2026-07-18T07:30:00.250-04:30"
];

for (const timestamp of validRfc3339Timestamps) {
  test(`accepts RFC3339 event created_at ${timestamp}`, () => {
    const value = { ...event, created_at: timestamp };
    assert.strictEqual(validateEvent(value), value);
  });
  test(`accepts RFC3339 event expires_at ${timestamp}`, () => {
    const value = { ...event, expires_at: timestamp };
    assert.strictEqual(validateEvent(value), value);
  });
  test(`accepts RFC3339 reply created_at ${timestamp}`, () => {
    const value = { ...reply, created_at: timestamp };
    assert.strictEqual(validateReply(value), value);
  });
}

const invalidRfc3339Timestamps = [
  ["locale date", "07/18/2026 12:00:00"],
  ["date only", "2026-07-18"],
  ["space separator", "2026-07-18 12:00:00Z"],
  ["timezone name", "2026-07-18T12:00:00UTC"],
  ["missing offset", "2026-07-18T12:00:00"],
  ["rollover day", "2026-02-30T12:00:00Z"],
  ["non-leap February 29", "2025-02-29T12:00:00Z"],
  ["month 13", "2026-13-18T12:00:00Z"],
  ["day zero", "2026-07-00T12:00:00Z"],
  ["hour 24", "2026-07-18T24:00:00Z"],
  ["minute 60", "2026-07-18T12:60:00Z"],
  ["second 60", "2026-07-18T12:00:60Z"],
  ["offset hour 24", "2026-07-18T12:00:00+24:00"],
  ["offset minute 60", "2026-07-18T12:00:00+03:60"],
  ["malformed offset", "2026-07-18T12:00:00+0300"],
  ["null", null],
  ["array", ["2026-07-18T12:00:00Z"]]
];

for (const [label, timestamp] of invalidRfc3339Timestamps) {
  test(`rejects invalid RFC3339 event created_at: ${label}`, () => {
    expectCode(() => validateEvent({ ...event, created_at: timestamp }), "EVENT_TIME");
  });
  test(`rejects invalid RFC3339 event expires_at: ${label}`, () => {
    expectCode(() => validateEvent({ ...event, expires_at: timestamp }), "EVENT_TIME");
  });
  test(`rejects invalid RFC3339 reply created_at: ${label}`, () => {
    expectCode(() => validateReply({ ...reply, created_at: timestamp }), "REPLY_TIME");
  });
}

for (const [label, callback, code] of [
  ["array-coerced event id", () => validateEvent({ ...event, event_id: [event.event_id] }), "EVENT_ID"],
  ["empty thread title", () => validateEvent({ ...event, thread: { ...event.thread, title: "" } }), "EVENT_THREAD"],
  ["empty project label", () => validateEvent({ ...event, thread: { ...event.thread, project_label: "" } }), "EVENT_THREAD"],
  ["non-string cwd label", () => validateEvent({ ...event, thread: { ...event.thread, cwd_label: 42 } }), "EVENT_THREAD"],
  ["non-string message summary", () => validateEvent({ ...event, message: { ...event.message, summary: 42 } }), "EVENT_MESSAGE"],
  ["invalid markdown path", () => validateEvent({ ...event, message: { ...event.message, markdown_path: "notes.md" } }), "EVENT_MESSAGE"],
  ["non-boolean replyable flag", () => validateEvent({ ...event, message: { ...event.message, is_replyable: 1 } }), "EVENT_MESSAGE"],
  ["non-array allowed actions", () => validateEvent({ ...event, allowed_actions: "REPLY" }), "EVENT_ACTIONS"],
  ["sparse allowed actions", () => validateEvent({ ...event, allowed_actions: Array(1) }), "EVENT_ACTIONS"],
  ["empty integrity producer", () => validateEvent({ ...event, integrity: { ...event.integrity, producer: "" } }), "EVENT_INTEGRITY"],
  ["uppercase event hash", () => validateEvent({ ...event, integrity: { ...event.integrity, content_sha256: "A".repeat(64) } }), "EVENT_HASH"],
  ["short event hash", () => validateEvent({ ...event, integrity: { ...event.integrity, content_sha256: "a".repeat(63) } }), "EVENT_HASH"],
  ["array-coerced event hash", () => validateEvent({ ...event, integrity: { ...event.integrity, content_sha256: [event.integrity.content_sha256] } }), "EVENT_HASH"],
  ["array-coerced reply event id", () => validateReply({ ...reply, event_id: [reply.event_id] }), "REPLY_EVENT_ID"],
  ["arbitrary approval reply text", () => validateReply({ ...reply, text: { unsafe: true } }), "REPLY_TEXT"],
  ["blank REPLY text", () => validateReply({ ...reply, action: "REPLY", text: "   " }), "REPLY_TEXT"],
  ["empty Telegram delivery reference", () => validateReply({ ...reply, telegram: { ...reply.telegram, delivery_ref: "" } }), "REPLY_DELIVERY"],
  ["uppercase sender fingerprint", () => validateReply({ ...reply, telegram: { ...reply.telegram, sender_fingerprint: "F".repeat(64) } }), "REPLY_SENDER"],
  ["short sender fingerprint", () => validateReply({ ...reply, telegram: { ...reply.telegram, sender_fingerprint: "f".repeat(63) } }), "REPLY_SENDER"],
  ["array-coerced sender fingerprint", () => validateReply({ ...reply, telegram: { ...reply.telegram, sender_fingerprint: [reply.telegram.sender_fingerprint] } }), "REPLY_SENDER"]
]) {
  test(`rejects ${label}`, () => expectCode(callback, code));
}
