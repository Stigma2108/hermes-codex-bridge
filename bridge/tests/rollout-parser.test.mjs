import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  MAX_ROLLOUT_RECORD_BYTES,
  createRolloutRecordParser,
  parseRollout,
} from "../src/rollout-parser.mjs";

const fixtures = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures");

function hasExactError(code) {
  return (error) => error?.code === code && error?.message === code;
}

test("parseRollout(path) returns only a normalized final assistant response", async () => {
  const messages = await parseRollout(join(fixtures, "rollout-final.jsonl"));

  assert.deepEqual(messages, [{
    channel: "final",
    kind: "FINAL_RESPONSE",
    replyMode: null,
    text: "Фаза завершена.\nЗапустить следующую?",
    threadId: "11111111-1111-4111-8111-111111111111",
    cwd: "D:\\Fictional Workspace\\Demo",
    turnId: "22222222-2222-4222-8222-222222222222",
    itemId: "66666666-6666-4666-8666-666666666666",
    timestamp: "2026-01-02T03:04:11.000Z",
    dedupeKey: "codex:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:66666666-6666-4666-8666-666666666666:FINAL_RESPONSE",
    canonicalIdentity: "codex:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:66666666-6666-4666-8666-666666666666:FINAL_RESPONSE",
    eventId: "evt_048c5e68-b320-525b-bc22-f618da2df29c",
  }]);
});

test("parseRollout(readable) ignores commentary, reasoning, command, and tool records but observes user input", async () => {
  const messages = await parseRollout(createReadStream(join(fixtures, "rollout-commentary.jsonl")));
  assert.deepEqual(messages.map(({ channel, kind }) => ({ channel, kind })), [
    { channel: "control", kind: "USER_INPUT" },
  ]);
});

test("record parser accepts only explicit v2 agentMessage final wrapper variants", () => {
  const parser = createRolloutRecordParser();
  parser.parse(JSON.stringify({
    timestamp: "2026-03-04T05:06:07.000Z",
    type: "session_meta",
    payload: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  }));
  const accepted = [
    {
      timestamp: "2026-03-04T05:06:08.000Z",
      type: "turn_item",
      turn_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      payload: { item: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", type: "agentMessage", phase: "final_answer", text: "V2 final one" } },
    },
    {
      timestamp: "2026-03-04T05:06:09.000Z",
      type: "turn_item",
      payload: { turn_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", type: "agentMessage", phase: "final", text: "V2 final two" },
    },
  ].flatMap((record) => parser.parse(JSON.stringify(record)));
  const ignored = [
    { type: "turn_item", payload: { item: { type: "agentMessage", phase: "commentary", text: "no" } } },
    { type: "turn_item", payload: { item: { type: "agentMessage", phase: "analysis", text: "no" } } },
    { type: "unknown", payload: { nested: { type: "agentMessage", phase: "final", text: "no recursive search" } } },
  ].flatMap((record) => parser.parse(JSON.stringify(record)));

  assert.deepEqual(accepted.map(({ text, turnId, itemId }) => ({ text, turnId, itemId })), [
    { text: "V2 final one", turnId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", itemId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    { text: "V2 final two", turnId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", itemId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
  ]);
  assert.deepEqual(ignored, []);
});

test("historical final phase remains accepted for response_item and v2 records", () => {
  const parser = createRolloutRecordParser();
  const records = [
    { type: "response_item", payload: { id: "historical-response", type: "message", role: "assistant", phase: "final", content: [{ type: "output_text", text: "Historical response" }] } },
    { type: "turn_item", payload: { item: { id: "historical-v2", type: "agentMessage", phase: "final", text: "Historical v2" } } },
  ];
  assert.deepEqual(records.flatMap((record) => parser.parse(JSON.stringify(record))).map((message) => message.text), [
    "Historical response",
    "Historical v2",
  ]);
});

test("subagent session finals are suppressed while user sessions remain publishable", () => {
  const subagent = createRolloutRecordParser();
  subagent.parse(JSON.stringify({
    type: "session_meta",
    payload: {
      id: "subagent-thread",
      parent_thread_id: "parent-thread",
      thread_source: "subagent",
      agent_role: "worker",
      source: { subagent: { thread_spawn: { parent_thread_id: "parent-thread", depth: 1, agent_role: "worker" } } },
    },
  }));
  const final = JSON.stringify({
    type: "response_item",
    turn_id: "subagent-turn",
    payload: { id: "subagent-item", type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "internal worker result" }] },
  });
  assert.deepEqual(subagent.parse(final), []);

  const user = createRolloutRecordParser();
  user.parse(JSON.stringify({ type: "session_meta", payload: { id: "user-thread", source: "vscode", thread_source: "user" } }));
  assert.equal(user.parse(final).length, 1);
});

test("subagent suppression survives an inherited parent session_meta record", () => {
  const parser = createRolloutRecordParser();
  parser.parse(JSON.stringify({
    type: "session_meta",
    payload: {
      id: "subagent-thread",
      parent_thread_id: "parent-thread",
      source: { subagent: { thread_spawn: { parent_thread_id: "parent-thread", depth: 1 } } },
      thread_source: "subagent",
    },
  }));
  parser.parse(JSON.stringify({
    type: "session_meta",
    payload: { id: "parent-thread", source: "vscode", thread_source: "user" },
  }));

  const messages = parser.parse(JSON.stringify({
    type: "response_item",
    turn_id: "subagent-turn",
    payload: {
      id: "subagent-final",
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "internal review result" }],
    },
  }));

  assert.deepEqual(messages, []);
});

test("registered router thread is suppressed while another automation-like task remains publishable", () => {
  const parser = createRolloutRecordParser({ isSuppressedThread: (id) => id === "router-thread" });
  assert.deepEqual(parser.parse(JSON.stringify({ type: "session_meta", payload: { id: "router-thread", source: "automation" } })), []);
  const final = JSON.stringify({
    type: "response_item",
    turn_id: "router-turn",
    payload: { id: "router-item", type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "router final must not publish" }] },
  });
  assert.deepEqual(parser.parse(final), []);

  parser.parse(JSON.stringify({ type: "session_meta", payload: { id: "user-automation-thread", source: "automation" } }));
  assert.equal(parser.parse(final).length, 1);
});

test("visible delegated Codex task remains publishable despite its subagent thread_source", () => {
  const delegated = createRolloutRecordParser();
  delegated.parse(JSON.stringify({
    type: "session_meta",
    payload: {
      id: "delegated-user-thread",
      thread_source: "subagent",
      source: "vscode",
      cwd: "C:\\Users\\demo\\.codex\\worktrees\\1234\\Project",
    },
  }));
  const messages = delegated.parse(JSON.stringify({
    timestamp: "2026-07-19T00:00:00.000Z",
    type: "response_item",
    turn_id: "delegated-turn",
    payload: {
      id: "delegated-final",
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "Visible delegated task finished" }],
    },
  }));
  assert.deepEqual(messages.map(({ kind, threadId, turnId, text }) => ({ kind, threadId, turnId, text })), [{
    kind: "FINAL_RESPONSE",
    threadId: "delegated-user-thread",
    turnId: "delegated-turn",
    text: "Visible delegated task finished",
  }]);
});

test("emits root final plus automatic goal continuation controls", async () => {
  const observations = await parseRollout(join(fixtures, "rollout-goal-cycle.jsonl"));
  assert.deepEqual(observations.map(({ channel, kind, threadId, turnId }) => ({ channel, kind, threadId, turnId })), [
    { channel: "final", kind: "FINAL_RESPONSE", threadId: "root-thread", turnId: "goal-turn-1" },
    { channel: "control", kind: "TURN_STARTED", threadId: "root-thread", turnId: "goal-turn-2" },
    { channel: "control", kind: "AUTO_GOAL_CONTINUATION", threadId: "root-thread", turnId: "goal-turn-2" },
  ]);
});

test("ordinary root user message emits thread-scoped USER_INPUT control", () => {
  const parser = createRolloutRecordParser();
  parser.parse(JSON.stringify({ type: "session_meta", payload: { id: "T", thread_source: "user" } }));
  const [control] = parser.parse(JSON.stringify({
    timestamp: "2026-07-18T18:00:00.000Z",
    type: "response_item",
    turn_id: "V",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Продолжай" }] },
  }));
  assert.deepEqual({ channel: control.channel, kind: control.kind, threadId: control.threadId, turnId: control.turnId }, {
    channel: "control", kind: "USER_INPUT", threadId: "T", turnId: "V",
  });
});

test("hidden remote-input markers classify and are removed from user text", () => {
  const parser = createRolloutRecordParser();
  parser.parse(JSON.stringify({ type: "session_meta", payload: { id: "T", thread_source: "user" } }));
  parser.parse(JSON.stringify({ type: "turn_context", payload: { turn_id: "V" } }));
  const [question] = parser.parse(JSON.stringify({ type: "response_item", payload: {
    id: "I", type: "message", role: "assistant", phase: "final_answer",
    content: [{ type: "output_text", text: "Как продолжить?\n<!-- HC3:WAITING_FOR_INPUT -->" }],
  }}));
  assert.equal(question.kind, "QUESTION");
  assert.equal(question.replyMode, "NEXT_TURN");
  assert.equal(question.text, "Как продолжить?");
});

test("malformed complete records are ignored without reflecting their payload", () => {
  const secret = "DO-NOT-LEAK-MALFORMED";
  const parser = createRolloutRecordParser();
  assert.doesNotThrow(() => assert.deepEqual(parser.parse(`{${secret}`), []));
});

test("oversize and invalid API errors are stable and do not expose input", async () => {
  const secret = "DO-NOT-LEAK-OVERSIZE";
  const parser = createRolloutRecordParser();
  assert.throws(
    () => parser.parse(`{"padding":"${secret}${"x".repeat(MAX_ROLLOUT_RECORD_BYTES)}"}`),
    hasExactError("ROLLOUT_RECORD_TOO_LARGE"),
  );
  await assert.rejects(parseRollout(42), hasExactError("ROLLOUT_INPUT"));
});

test("missing item id uses session id plus exact-record hash for dedupe", () => {
  const parser = createRolloutRecordParser();
  parser.parse(JSON.stringify({ type: "session_meta", payload: { id: "session-a" } }));
  const base = { type: "response_item", timestamp: "2026-01-01T00:00:00Z", payload: { type: "message", role: "assistant", phase: "final", content: [{ type: "output_text", text: "Same" }] } };
  const first = parser.parse(JSON.stringify(base))[0];
  const identical = parser.parse(JSON.stringify(base))[0];
  const later = parser.parse(JSON.stringify({ ...base, timestamp: "2026-01-01T00:00:01Z" }))[0];

  assert.equal(first.dedupeKey, identical.dedupeKey);
  assert.notEqual(first.dedupeKey, later.dedupeKey);
  assert.equal(first.dedupeKey.includes("Same"), false);
  assert.equal(first.eventId, identical.eventId);
  assert.notEqual(first.eventId, later.eventId);
  assert.match(first.eventId, /^evt_[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(first.eventId.includes("session-a"), false);
});

test("explicit item id remains stable when a rewritten file has a new session context", () => {
  const record = JSON.stringify({
    type: "response_item",
    payload: { id: "stable-item", type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Stable item" }] },
  });
  const oldSession = createRolloutRecordParser();
  oldSession.parse(JSON.stringify({ type: "session_meta", payload: { id: "old-session" } }));
  const newSession = createRolloutRecordParser();
  newSession.parse(JSON.stringify({ type: "session_meta", payload: { id: "new-session" } }));

  const oldMessage = oldSession.parse(record)[0];
  const newMessage = newSession.parse(record)[0];
  assert.equal(oldMessage.dedupeKey, "item:stable-item");
  assert.equal(newMessage.dedupeKey, oldMessage.dedupeKey);
  assert.equal(newMessage.eventId, oldMessage.eventId);
});

test("invalid UTF-8 record bytes fail with a stable non-leaking error", () => {
  const parser = createRolloutRecordParser();
  assert.throws(() => parser.parse(Buffer.from([0xff, 0xfe])), hasExactError("ROLLOUT_UTF8"));
});

test("empty final output is ignored", () => {
  const parser = createRolloutRecordParser();
  const result = parser.parse(JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final",
      content: [{ type: "output_text", text: "" }, { type: "output_text", text: "" }],
    },
  }));
  assert.deepEqual(result, []);
});

test("parseRollout supports an iterable of complete UTF-8 records", async () => {
  const contents = await readFile(join(fixtures, "rollout-final.jsonl"), "utf8");
  const messages = await parseRollout({ records: contents.trimEnd().split("\n") });
  assert.equal(messages.length, 1);
});
