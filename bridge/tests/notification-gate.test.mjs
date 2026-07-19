import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { openCandidateStore } from "../src/candidate-store.mjs";
import { createNotificationGate } from "../src/notification-gate.mjs";
import { createPublicationEventId } from "../src/rollout-parser.mjs";

const roots = [];

async function gateHarness({ presence: initialPresence = "DESK", failPublishes = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "hc3-notification-gate-"));
  roots.push(root);
  const store = await openCandidateStore(root);
  const published = [];
  let nowMs = Date.parse("2026-07-18T12:00:00.000Z");
  let presenceState = initialPresence;
  let failures = failPublishes;
  const publish = async (message, { idempotencyKey }) => {
    if (failures > 0) { failures -= 1; throw new Error("offline"); }
    published.push(message);
    return { idempotencyKey };
  };
  const createGate = (candidateStore) => createNotificationGate({
    store: candidateStore,
    publish,
    presence: { sample: async () => ({ state: presenceState, idleMs: presenceState === "AWAY" ? 90_000 : 0 }) },
    now: () => new Date(nowMs),
  });
  let gate = createGate(store);

  const eventId = (turnId) => createPublicationEventId(`test:${turnId}`);
  const final = (threadId, turnId) => ({
    channel: "final", kind: "FINAL_RESPONSE", replyMode: null, threadId, turnId,
    eventId: eventId(turnId), text: `final-${turnId}`, timestamp: new Date(nowMs).toISOString(),
  });
  const question = (threadId, turnId) => ({
    ...final(threadId, turnId), kind: "QUESTION", replyMode: "NEXT_TURN", text: `question-${turnId}`,
  });
  const control = (kind, threadId, turnId) => ({
    channel: "control", kind, threadId, turnId, eventId: eventId(`${kind}-${turnId}`),
    timestamp: new Date(nowMs).toISOString(),
  });
  const observe = (observation) => gate.observe(observation, { idempotencyKey: observation.eventId });

  return {
    root, store, gate, published, final, question, control, observe, eventId,
    advance(ms) { nowMs += ms; },
    setPresence(state) { presenceState = state; },
    async reopen() {
      await store.close();
      const reopenedStore = await openCandidateStore(root);
      gate = createGate(reopenedStore);
      return { store: reopenedStore, gate, observe: (observation) => gate.observe(observation, { idempotencyKey: observation.eventId }) };
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

for (const scenario of [
  { name: "auto goal continuation inside settle window", advanceBeforeControlsMs: 6_000, controls: ["TURN_STARTED", "AUTO_GOAL_CONTINUATION"], expected: 0 },
  { name: "local reply", controls: ["USER_INPUT"], expected: 0 },
  { name: "away unclassified final before settle", presence: "AWAY", advanceMs: 14_999, expected: 0 },
  { name: "away unclassified final after settle", presence: "AWAY", advanceMs: 15_000, expected: 1 },
  { name: "desk before grace", presence: "DESK", advanceMs: 299_999, expected: 0 },
  { name: "desk after grace", presence: "DESK", advanceMs: 300_000, expected: 1 },
]) test(scenario.name, async () => {
  const harness = await gateHarness({ presence: scenario.presence ?? "DESK" });
  await harness.observe(harness.final("T", "V"));
  harness.advance(scenario.advanceBeforeControlsMs ?? 0);
  for (const kind of scenario.controls ?? []) await harness.observe(harness.control(kind, "T", "V2"));
  harness.advance(scenario.advanceMs ?? 0);
  await harness.gate.flush();
  assert.equal(harness.published.length, scenario.expected);
  await harness.store.close();
});

test("away marker question bypasses final settle window", async () => {
  const harness = await gateHarness({ presence: "AWAY" });
  await harness.observe(harness.question("T", "V"));
  await harness.gate.flush();
  assert.equal(harness.published.length, 1);
  await harness.store.close();
});

test("transition from desk to away publishes before five-minute deadline", async () => {
  const harness = await gateHarness({ presence: "DESK" });
  await harness.observe(harness.final("T", "V"));
  harness.advance(90_000);
  harness.setPresence("AWAY");
  await harness.gate.flush();
  assert.equal(harness.published.length, 1);
  await harness.store.close();
});

test("local reply cancels only its own thread", async () => {
  const harness = await gateHarness({ presence: "DESK" });
  await harness.observe(harness.final("A", "A1"));
  await harness.observe(harness.final("B", "B1"));
  await harness.observe(harness.control("USER_INPUT", "A", "A2"));
  harness.advance(300_000);
  await harness.gate.flush();
  assert.deepEqual(harness.published.map((item) => item.threadId), ["B"]);
  await harness.store.close();
});

test("restart recovers published candidate and later local input makes Telegram reply stale", async () => {
  const harness = await gateHarness({ presence: "AWAY" });
  await harness.observe(harness.final("A", "A1"));
  harness.advance(15_000);
  await harness.gate.flush();
  const reopened = await harness.reopen();
  await reopened.observe(harness.control("USER_INPUT", "A", "A2"));
  assert.equal(await reopened.gate.isReplyCurrent({ event_id: harness.eventId("A1") }), false);
  assert.equal((await reopened.store.get(harness.eventId("A1"))).state, "STALE_LOCAL_REPLY");
  await reopened.store.close();
});

test("duplicate observation has one durable candidate", async () => {
  const harness = await gateHarness({ presence: "DESK" });
  const final = harness.final("A", "A1");
  await harness.observe(final);
  await harness.observe(final);
  assert.equal((await harness.store.list()).length, 1);
  await harness.store.close();
});

test("publish failure leaves READY candidate retryable without a duplicate", async () => {
  const harness = await gateHarness({ presence: "AWAY", failPublishes: 1 });
  await harness.observe(harness.question("A", "A1"));
  await assert.rejects(harness.gate.flush(), /offline/u);
  assert.equal((await harness.store.get(harness.eventId("A1"))).state, "READY");
  await harness.gate.flush();
  await harness.gate.flush();
  assert.equal(harness.published.length, 1);
  assert.equal((await harness.store.get(harness.eventId("A1"))).state, "PUBLISHED");
  await harness.store.close();
});
