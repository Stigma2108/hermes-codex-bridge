import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createUiActionStore } from "../src/ui-action-store.mjs";

const EVENT_ID = "evt_019f74b5-c168-7381-9629-d395da0255f7";
const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function interaction({
  queueRoot = undefined,
  id = EVENT_ID,
  createdAt = "2026-07-19T11:59:00Z",
  expiresAt = "2026-07-26T11:59:00Z",
  text = "Продолжай видимо через UI",
} = {}) {
  queueRoot ??= await mkdtemp(join(tmpdir(), "hermes-ui-actions-"));
  const directory = join(queueRoot, "interactions", id);
  await mkdir(directory, { recursive: true });
  const event = {
    schema: "hermes-codex-interaction-event/v3",
    event_id: id,
    kind: "FINAL_RESPONSE",
    created_at: createdAt,
    expires_at: expiresAt,
    thread: { id: "thread-visible", turn_id: "turn-source", title: "Visible", project_label: "Project", cwd_label: "cwd" },
    message: { summary: "safe", markdown_path: null, is_replyable: true },
    allowed_actions: ["REPLY"],
    integrity: { producer: "test", content_sha256: hash("safe") },
  };
  const reply = {
    schema: "hermes-codex-interaction-reply/v3",
    event_id: id,
    created_at: createdAt,
    action: "REPLY",
    text,
    telegram: { delivery_ref: "tgmsg_1", sender_fingerprint: "a".repeat(64) },
  };
  await writeFile(join(directory, "event.json"), `${JSON.stringify(event)}\n`, "utf8");
  await writeFile(join(directory, "reply.json"), `${JSON.stringify(reply)}\n`, "utf8");
  return { queueRoot, directory, event, reply };
}

test("enqueue writes one immutable hash-only UI action and no terminal receipt", async () => {
  const { queueRoot, directory, event, reply } = await interaction();
  const store = createUiActionStore({ queueRoot, now: () => new Date("2026-07-19T12:00:00Z") });

  assert.deepEqual(await store.enqueue({ event, reply }), { eventId: event.event_id, state: "READY" });
  const action = JSON.parse(await readFile(join(directory, "ui-action.json"), "utf8"));
  assert.deepEqual(action, {
    schema: "hermes-codex-ui-action/v3",
    event_id: event.event_id,
    thread_id: event.thread.id,
    source_turn_id: event.thread.turn_id,
    reply_sha256: hash(reply.text),
    created_at: "2026-07-19T12:00:00.000Z",
  });
  assert.equal(await exists(join(directory, "receipt.json")), false);
  assert.doesNotMatch(JSON.stringify(action), new RegExp(reply.text, "u"));
});

test("claim release reclaim and applied are durable and idempotent", async () => {
  const fixture = await interaction();
  let instant = new Date("2026-07-19T12:00:00Z");
  let sequence = 0;
  const store = createUiActionStore({ queueRoot: fixture.queueRoot, now: () => instant, randomId: () => `lease-${++sequence}` });
  await store.enqueue(fixture);

  assert.deepEqual(await store.listReady(), [{
    eventId: fixture.event.event_id,
    threadId: "thread-visible",
    sourceTurnId: "turn-source",
    createdAt: "2026-07-19T12:00:00.000Z",
  }]);
  const first = await store.claim(fixture.event.event_id);
  assert.equal(first.text, fixture.reply.text);
  assert.equal(first.actionCreatedAt, "2026-07-19T12:00:00.000Z");
  assert.equal(first.prompt, `${first.marker}\n${fixture.reply.text}`);
  assert.match(first.marker, /^<!-- HC3_UI_EVENT:evt_[0-9a-f-]{36} -->$/u);
  assert.deepEqual(await store.listReady(), []);

  assert.deepEqual(await store.release(fixture.event.event_id, first.leaseId, "BUSY"), { state: "READY" });
  instant = new Date("2026-07-19T12:00:01Z");
  const second = await store.claim(fixture.event.event_id);
  assert.notEqual(second.leaseId, first.leaseId);
  await store.applied(fixture.event.event_id, second.leaseId, "turn-visible");

  assert.deepEqual(await store.listReady(), []);
  const receipt = JSON.parse(await readFile(join(fixture.directory, "receipt.json"), "utf8"));
  assert.equal(receipt.status, "APPLIED");
  assert.equal((await store.applied(fixture.event.event_id, second.leaseId, "turn-visible")).state, "APPLIED");
  const privateBytes = await Promise.all(["ui-action.json", "ui-claim.json", "ui-applied.json"].map((name) => readFile(join(fixture.directory, name), "utf8")));
  assert.doesNotMatch(privateBytes.join("\n"), new RegExp(fixture.reply.text, "u"));
});

test("unexpired leases exclude work, expired leases reclaim, and terminal receipts win", async () => {
  const fixture = await interaction();
  let instant = new Date("2026-07-19T12:00:00Z");
  let sequence = 0;
  const store = createUiActionStore({ queueRoot: fixture.queueRoot, now: () => instant, randomId: () => `lease-${++sequence}` });
  await store.enqueue(fixture);
  const first = await store.claim(fixture.event.event_id);
  await assert.rejects(store.claim(fixture.event.event_id), { code: "UI_CLAIMED" });
  instant = new Date("2026-07-19T12:02:01Z");
  const reclaimed = await store.claim(fixture.event.event_id);
  assert.notEqual(reclaimed.leaseId, first.leaseId);
  await store.reject(fixture.event.event_id, reclaimed.leaseId, "STALE");
  assert.equal(JSON.parse(await readFile(join(fixture.directory, "receipt.json"), "utf8")).status, "REJECTED");
  await assert.rejects(store.claim(fixture.event.event_id), { code: "UI_TERMINAL" });
});

test("a rejected receipt prevents an applied proof from being published", async () => {
  const fixture = await interaction();
  const store = createUiActionStore({ queueRoot: fixture.queueRoot, now: () => new Date("2026-07-19T12:00:00Z"), randomId: () => "lease-terminal" });
  await store.enqueue(fixture);
  const claim = await store.claim(fixture.event.event_id);
  await writeFile(join(fixture.directory, "receipt.json"), `${JSON.stringify({
    schema: "hermes-codex-interaction-receipt/v3",
    event_id: fixture.event.event_id,
    processed_at: "2026-07-19T12:00:01Z",
    status: "REJECTED",
    error: { code: "STALE" },
  })}\n`, "utf8");

  await assert.rejects(store.applied(fixture.event.event_id, claim.leaseId, "turn-visible"), { code: "UI_TERMINAL" });
  assert.equal(await exists(join(fixture.directory, "ui-applied.json")), false);
});

test("list expires seven-day actions and returns the ten oldest ready actions", async () => {
  const queueRoot = await mkdtemp(join(tmpdir(), "hermes-ui-order-"));
  const now = new Date("2026-07-19T12:00:00Z");
  const store = createUiActionStore({ queueRoot, now: () => now });
  const expired = await interaction({ queueRoot, id: "evt_f19f74b5-c168-7381-9629-d395da0255f7", createdAt: "2026-07-12T11:59:59Z", expiresAt: "2026-07-19T11:59:59Z" });
  await store.enqueue(expired);
  for (let index = 0; index < 11; index += 1) {
    const id = `evt_${index.toString(16)}19f74b5-c168-7381-9629-d395da0255f7`;
    const fixture = await interaction({ queueRoot, id });
    const actionNow = new Date(now.getTime() + index * 1000);
    await createUiActionStore({ queueRoot, now: () => actionNow }).enqueue(fixture);
  }
  const ready = await store.listReady();
  assert.equal(ready.length, 10);
  assert.deepEqual(ready.map(({ eventId }) => eventId), Array.from({ length: 10 }, (_, index) => `evt_${index.toString(16)}19f74b5-c168-7381-9629-d395da0255f7`));
  assert.equal(JSON.parse(await readFile(join(expired.directory, "receipt.json"), "utf8")).status, "EXPIRED");
});

test("store rejects mismatched hashes, malformed UTF-8, invalid IDs, and unsafe links", async (t) => {
  const fixture = await interaction();
  const store = createUiActionStore({ queueRoot: fixture.queueRoot, now: () => new Date("2026-07-19T12:00:00Z") });
  await store.enqueue(fixture);
  await writeFile(join(fixture.directory, "reply.json"), Buffer.from([0xc3, 0x28]));
  await assert.rejects(store.claim(fixture.event.event_id), { code: "UI_JSON" });

  const invalid = await interaction({ id: "evt_NOT_VALID" });
  await assert.rejects(createUiActionStore({ queueRoot: invalid.queueRoot }).enqueue(invalid), /EVENT_ID/u);

  const source = await interaction();
  const sourceStore = createUiActionStore({ queueRoot: source.queueRoot, now: () => new Date("2026-07-19T12:00:00Z") });
  await sourceStore.enqueue(source);
  const linked = await interaction();
  await rm(join(linked.directory, "ui-action.json"), { force: true });
  await link(join(source.directory, "ui-action.json"), join(linked.directory, "ui-action.json"));
  await assert.rejects(createUiActionStore({ queueRoot: linked.queueRoot, now: () => new Date("2026-07-19T12:00:00Z") }).enqueue(linked), { code: "UI_PATH" });

  const queueRoot = await mkdtemp(join(tmpdir(), "hermes-ui-junction-"));
  const outside = await mkdtemp(join(tmpdir(), "hermes-ui-outside-"));
  try {
    await symlink(outside, join(queueRoot, "interactions"), "junction");
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error?.code)) {
      t.diagnostic("junction creation is unavailable");
      return;
    }
    throw error;
  }
  const unsafe = await interaction({ queueRoot: outside });
  await assert.rejects(createUiActionStore({ queueRoot }).enqueue(unsafe), { code: "UI_PATH" });
});

test("router registry is immutable except pending automation binding and heartbeat is scoped", async () => {
  const queueRoot = await mkdtemp(join(tmpdir(), "hermes-ui-registry-"));
  let instant = new Date("2026-07-19T12:00:00Z");
  const store = createUiActionStore({ queueRoot, now: () => instant });
  assert.deepEqual(await store.registerRouter({ threadId: "router-thread", automationId: "pending" }), { threadId: "router-thread", automationId: "pending" });
  assert.deepEqual(await store.registerRouter({ threadId: "router-thread", automationId: "automation-1" }), { threadId: "router-thread", automationId: "automation-1" });
  await assert.rejects(store.registerRouter({ threadId: "other-thread", automationId: "automation-1" }), { code: "UI_REGISTRY" });
  await assert.rejects(store.registerRouter({ threadId: "router-thread", automationId: "automation-2" }), { code: "UI_REGISTRY" });
  await assert.rejects(store.heartbeat("other-thread"), { code: "UI_REGISTRY" });
  instant = new Date("2026-07-19T12:01:00Z");
  await store.heartbeat("router-thread");
  assert.deepEqual(await store.healthSnapshot(), { readyCount: 0, oldestReadyAt: null, heartbeatAt: "2026-07-19T12:01:00.000Z" });

  const directRoot = await mkdtemp(join(tmpdir(), "hermes-ui-direct-registry-"));
  const direct = createUiActionStore({ queueRoot: directRoot });
  await assert.rejects(direct.registerRouter({ threadId: "router-thread", automationId: "automation-1" }), { code: "UI_REGISTRY" });
  await writeFile(join(directRoot, "ui-router.json"), "{bad", "utf8");
  await assert.rejects(direct.registerRouter({ threadId: "router-thread", automationId: "pending" }), { code: "UI_REGISTRY" });
});

test("health snapshot reports only ready counts and timestamps", async () => {
  const fixture = await interaction({ text: "SECRET_PLAINTEXT_REPLY" });
  const store = createUiActionStore({ queueRoot: fixture.queueRoot, now: () => new Date("2026-07-19T12:00:00Z") });
  await store.enqueue(fixture);
  const snapshot = await store.healthSnapshot();
  assert.deepEqual(snapshot, { readyCount: 1, oldestReadyAt: "2026-07-19T12:00:00.000Z", heartbeatAt: null });
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET_PLAINTEXT_REPLY/u);
});
