import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { openCandidateStore } from "../src/candidate-store.mjs";

const roots = [];
const eventA = "evt_00000000-0000-4000-8000-000000000001";
const eventB = "evt_00000000-0000-4000-8000-000000000002";

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "hc3-candidate-store-"));
  roots.push(root);
  return root;
}

function candidate(eventId, threadId, turnId, text, state = "PENDING_PRESENCE") {
  return { schema: 1, eventId, threadId, turnId, state, message: { text } };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("upsert and transition survive reopen without rewriting another candidate", async () => {
  const root = await temporaryRoot();
  let store = await openCandidateStore(root);
  await store.put(candidate(eventA, "T", "V", "one"));
  await store.put(candidate(eventB, "U", "W", "two"));
  await store.transition(eventA, "CANCELLED_LOCAL_REPLY", { reason: "LOCAL_REPLY" });
  await store.close();

  store = await openCandidateStore(root);
  assert.equal((await store.get(eventA)).state, "CANCELLED_LOCAL_REPLY");
  assert.equal((await store.get(eventA)).reason, "LOCAL_REPLY");
  assert.equal((await store.get(eventB)).state, "PENDING_PRESENCE");
  assert.deepEqual((await store.list()).map((item) => item.eventId), [eventA, eventB]);
  await store.close();
});

test("invalid transition fails closed without changing durable bytes", async () => {
  const root = await temporaryRoot();
  const store = await openCandidateStore(root);
  await store.put(candidate(eventA, "T", "V", "one", "PUBLISHED"));
  const path = join(root, `${eventA}.json`);
  const before = await readFile(path);
  await assert.rejects(store.transition(eventA, "PENDING_PRESENCE"), /CANDIDATE_TRANSITION/u);
  assert.deepEqual(await readFile(path), before);
  await store.close();
});

test("idempotent put requires the same immutable identity and leaves no partials", async () => {
  const root = await temporaryRoot();
  const store = await openCandidateStore(root);
  const first = await store.put(candidate(eventA, "T", "V", "one"));
  const repeated = await store.put(candidate(eventA, "T", "V", "one"));
  assert.deepEqual(repeated, first);
  await assert.rejects(store.put(candidate(eventA, "T", "V", "changed")), /CANDIDATE_CONFLICT/u);
  assert.equal((await store.get(eventA)).message.text, "one");
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".partial")), []);
  await store.close();
});

test("filters list by state and rejects malformed identifiers before filesystem access", async () => {
  const root = await temporaryRoot();
  const store = await openCandidateStore(root);
  await store.put(candidate(eventA, "T", "V", "one"));
  await store.put(candidate(eventB, "U", "W", "two", "PUBLISHED"));
  assert.deepEqual((await store.list(["PUBLISHED"])).map((item) => item.eventId), [eventB]);
  await assert.rejects(store.get("../outside"), /CANDIDATE_EVENT_ID/u);
  await assert.rejects(store.list(["UNKNOWN"]), /CANDIDATE_STATE/u);
  await store.close();
});
