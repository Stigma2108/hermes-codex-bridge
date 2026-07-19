import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createReplyDispatcher } from "../src/reply-dispatcher.mjs";
import { createThreadDriver } from "../src/thread-driver.mjs";
import { createUiActionStore } from "../src/ui-action-store.mjs";

const IDS = ["evt_019f74b5-c168-7381-9629-d395da0255f7", "evt_119f74b5-c168-7381-9629-d395da0255f7"];
const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");
async function queue() { const root = await mkdtemp(join(tmpdir(), "bridge-replies-")); await mkdir(join(root, "interactions")); return root; }
async function exists(path) { try { await access(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } }
async function interaction(root, { id = IDS[0], threadId = "T", turnId = "turn", kind = "FINAL_RESPONSE", replyMode, action = "REPLY", text = "continue", now = "2026-07-18T12:00:00Z", expires = "2026-07-25T12:00:00Z", summary = "safe", badHash = false } = {}) {
  const directory = join(root, "interactions", id); await mkdir(directory);
  const event = { schema: "hermes-codex-interaction-event/v3", event_id: id, kind, created_at: now, expires_at: expires, thread: { id: threadId, turn_id: turnId, title: "Title", project_label: "Project", cwd_label: "cwd" }, message: { summary, markdown_path: null, is_replyable: true, ...(replyMode === undefined ? {} : { reply_mode: replyMode }) }, allowed_actions: kind === "APPROVAL_REQUEST" ? ["APPROVE_ONCE", "DECLINE"] : ["REPLY"], integrity: { producer: "test", content_sha256: badHash ? "0".repeat(64) : hash(summary) } };
  const reply = { schema: "hermes-codex-interaction-reply/v3", event_id: id, created_at: "2026-07-18T12:01:00Z", action, text: action === "REPLY" ? text : null, telegram: { delivery_ref: `delivery-${threadId}`, sender_fingerprint: "a".repeat(64) } };
  await writeFile(join(directory, "event.json"), `${JSON.stringify(event)}\n`); await writeFile(join(directory, "reply.json"), `${JSON.stringify(reply)}\n`); return directory;
}

test("routes reverse-arrival replies to exact threads once and writes receipts", async () => {
  const root = await queue(); await interaction(root, { id: IDS[1], threadId: "B", text: "B2" }); await interaction(root, { id: IDS[0], threadId: "A", text: "A2" });
  const calls = []; const dispatcher = createReplyDispatcher({ queueRoot: root, stateRoot: join(root, "state"), threadDriver: { reply: async (input) => { calls.push(input); return { idempotencyKey: input.idempotencyKey }; } }, now: () => new Date("2026-07-18T12:02:00Z") });
  assert.equal((await dispatcher.scanOnce()).applied, 2); assert.deepEqual(calls.map((x) => [x.threadId, x.text]).sort(), [["A", "A2"], ["B", "B2"]]);
  assert.equal((await dispatcher.scanOnce()).applied, 0); assert.equal(calls.length, 2);
  assert.equal(JSON.parse(await readFile(join(root, "interactions", IDS[0], "receipt.json"))).status, "APPLIED");
});

test("approval uses pending hook resolver, otherwise thread interaction resolver", async () => {
  const root = await queue(); await interaction(root, { kind: "APPROVAL_REQUEST", action: "APPROVE_ONCE", expires: "2026-07-19T00:00:00Z" });
  const hook = []; const dispatcher = createReplyDispatcher({ queueRoot: root, stateRoot: join(root, "state"), hookResolver: { has: (id) => id === IDS[0], resolve: async (id, reply) => hook.push([id, reply.action]) }, threadDriver: {}, now: () => new Date("2026-07-18T12:02:00Z") });
  await dispatcher.scanOnce(); assert.deepEqual(hook, [[IDS[0], "APPROVE_ONCE"]]);
});

test("QUESTION reply resolves pending interaction and never starts a new turn", async () => {
  const root = await queue(); await interaction(root, { kind: "QUESTION", action: "REPLY", text: "scope: Current project" });
  const resolved = []; let turns = 0;
  const dispatcher = createReplyDispatcher({ queueRoot: root, stateRoot: join(root, "state"), threadDriver: {
    resolveInteraction: async (input) => { resolved.push(input); return { idempotencyKey: input.idempotencyKey }; },
    reply: async () => { turns += 1; },
  }, now: () => new Date("2026-07-18T12:02:00Z") });
  assert.equal((await dispatcher.scanOnce()).applied, 1); assert.equal(turns, 0);
  assert.deepEqual(resolved.map(({ eventId, action, text }) => ({ eventId, action, text })), [{ eventId: IDS[0], action: "REPLY", text: "scope: Current project" }]);
});

test("completed QUESTION with NEXT_TURN starts exact thread instead of resolving a live request", async () => {
  const root = await queue();
  await interaction(root, { kind: "QUESTION", replyMode: "NEXT_TURN", turnId: "turn-A", action: "REPLY", text: "Продолжай" });
  const calls = [];
  const dispatcher = createReplyDispatcher({ queueRoot: root, stateRoot: join(root, "state"),
    replyGuard: { isReplyCurrent: async () => true },
    threadDriver: { reply: async (input) => { calls.push(input); return { idempotencyKey: input.idempotencyKey }; }, resolveInteraction: async () => assert.fail("live resolver") },
    now: () => new Date("2026-07-18T12:02:00Z") });
  assert.equal((await dispatcher.scanOnce()).applied, 1);
  assert.equal(calls[0].expectedTurnId, "turn-A");
});

test("native mode enqueues explicit NEXT_TURN without app-server start or receipt", async () => {
  const root = await queue();
  const directory = await interaction(root, { kind: "QUESTION", replyMode: "NEXT_TURN", text: "Продолжай" });
  const queued = []; let starts = 0;
  const dispatcher = createReplyDispatcher({
    queueRoot: root,
    stateRoot: join(root, "state"),
    replyGuard: { isReplyCurrent: async () => true },
    uiActionStore: { enqueue: async (input) => { queued.push(input); return { state: "READY" }; } },
    threadDriver: { reply: async () => { starts += 1; } },
    now: () => new Date("2026-07-18T12:02:00Z"),
  });

  const result = await dispatcher.scanOnce();
  assert.equal(result.routed, 1);
  assert.equal(starts, 0);
  assert.equal(queued[0].reply.text, "Продолжай");
  assert.equal(await exists(join(directory, "receipt.json")), false);
});

test("native mode also enqueues a legacy FINAL_RESPONSE reply", async () => {
  const root = await queue();
  const directory = await interaction(root, { kind: "FINAL_RESPONSE", replyMode: undefined, text: "next" });
  const queued = []; let starts = 0;
  const dispatcher = createReplyDispatcher({
    queueRoot: root,
    stateRoot: join(root, "state"),
    replyGuard: { isReplyCurrent: async () => true },
    uiActionStore: { enqueue: async (input) => { queued.push(input); return { state: "READY" }; } },
    threadDriver: { reply: async () => { starts += 1; } },
    now: () => new Date("2026-07-18T12:02:00Z"),
  });

  const result = await dispatcher.scanOnce();
  assert.equal(result.routed, 1);
  assert.equal(starts, 0);
  assert.equal(queued[0].event.kind, "FINAL_RESPONSE");
  assert.equal(await exists(join(directory, "receipt.json")), false);
});

test("native retry preserves an existing UI action after the marker makes the candidate stale", async () => {
  const root = await queue();
  const directory = await interaction(root, { kind: "FINAL_RESPONSE", text: "native once" });
  let current = true;
  const dispatcher = createReplyDispatcher({
    queueRoot: root,
    stateRoot: join(root, "state"),
    replyGuard: { isReplyCurrent: async () => current },
    uiActionStore: createUiActionStore({ queueRoot: root, now: () => new Date("2026-07-18T12:02:00Z") }),
    threadDriver: { reply: async () => assert.fail("native must not use app-server") },
    now: () => new Date("2026-07-18T12:02:00Z"),
  });

  assert.equal((await dispatcher.scanOnce()).routed, 1);
  current = false;
  const retry = await dispatcher.scanOnce();
  assert.equal(retry.routed, 1);
  assert.equal(retry.rejected, 0);
  assert.equal(await exists(join(directory, "receipt.json")), false);
});

test("native mode keeps live questions and approvals on their existing resolvers", async () => {
  for (const fixture of [
    { kind: "QUESTION", replyMode: "LIVE_REQUEST", action: "REPLY" },
    { kind: "APPROVAL_REQUEST", action: "APPROVE_ONCE" },
    { kind: "APPROVAL_REQUEST", action: "DECLINE" },
  ]) {
    const root = await queue();
    await interaction(root, fixture);
    let enqueues = 0; let resolutions = 0;
    const dispatcher = createReplyDispatcher({
      queueRoot: root,
      stateRoot: join(root, "state"),
      uiActionStore: { enqueue: async () => { enqueues += 1; } },
      threadDriver: { resolveInteraction: async () => { resolutions += 1; } },
      now: () => new Date("2026-07-18T12:02:00Z"),
    });
    const result = await dispatcher.scanOnce();
    assert.equal(result.applied, 1);
    assert.equal(enqueues, 0);
    assert.equal(resolutions, 1);
  }
});

test("stale local reply writes REJECTED receipt and starts no turn", async () => {
  const root = await queue();
  const directory = await interaction(root, { kind: "QUESTION", replyMode: "NEXT_TURN" });
  let starts = 0;
  const dispatcher = createReplyDispatcher({ queueRoot: root, stateRoot: join(root, "state"),
    replyGuard: { isReplyCurrent: async () => false },
    threadDriver: { reply: async () => { starts += 1; } },
    now: () => new Date("2026-07-18T12:02:00Z") });
  const result = await dispatcher.scanOnce();
  assert.equal(result.rejected, 1);
  assert.equal(starts, 0);
  const receipt = JSON.parse(await readFile(join(directory, "receipt.json"), "utf8"));
  assert.equal(receipt.status, "REJECTED");
  assert.deepEqual(receipt.error, { code: "STALE" });
});

test("legacy final without reply_mode is also rejected after newer local input", async () => {
  const root = await queue();
  const directory = await interaction(root, { kind: "FINAL_RESPONSE" });
  let starts = 0;
  const dispatcher = createReplyDispatcher({ queueRoot: root, stateRoot: join(root, "state"),
    replyGuard: { isReplyCurrent: async () => false },
    threadDriver: { reply: async () => { starts += 1; } },
    now: () => new Date("2026-07-18T12:02:00Z") });
  const result = await dispatcher.scanOnce();
  assert.equal(result.rejected, 1);
  assert.equal(starts, 0);
  const receipt = JSON.parse(await readFile(join(directory, "receipt.json"), "utf8"));
  assert.equal(receipt.status, "REJECTED");
  assert.deepEqual(receipt.error, { code: "STALE" });
});

test("expired approval receives terminal EXPIRED without side effect", async () => {
  const root = await queue(); const directory = await interaction(root, { kind: "APPROVAL_REQUEST", action: "APPROVE_ONCE", expires: "2026-07-18T12:10:00Z" }); let calls = 0;
  const dispatcher = createReplyDispatcher({ queueRoot: root, stateRoot: join(root, "state"), threadDriver: { resolveInteraction: async () => { calls += 1; } }, now: () => new Date("2026-07-19T01:00:00Z") });
  const result = await dispatcher.scanOnce(); assert.equal(result.expired, 1); assert.equal(calls, 0); assert.equal(JSON.parse(await readFile(join(directory, "receipt.json"))).status, "EXPIRED");
});

test("hash mismatch writes safe write-once windows failure", async () => {
  const root = await queue(); const directory = await interaction(root, { badHash: true, text: "Bearer NEVER_WRITE_THIS" });
  const dispatcher = createReplyDispatcher({ queueRoot: root, stateRoot: join(root, "state"), threadDriver: { reply: async () => assert.fail("must not call") }, now: () => new Date("2026-07-18T12:02:00Z") });
  assert.equal((await dispatcher.scanOnce()).failed, 1); const contents = await readFile(join(directory, "windows-failure.json"), "utf8"); assert.match(contents, /DISPATCH_HASH/u); assert.doesNotMatch(contents, /NEVER_WRITE_THIS/u);
});

test("restart discovers unprocessed reply and crash retry relies on deterministic sink idempotency", async () => {
  const root = await queue(); const directory = await interaction(root); const effects = new Set(); let first = true;
  const driver = { reply: async ({ idempotencyKey }) => { effects.add(idempotencyKey); if (first) { first = false; throw new Error("post-effect crash"); } return { idempotencyKey }; } };
  let dispatcher = createReplyDispatcher({ queueRoot: root, stateRoot: join(root, "state"), threadDriver: driver, now: () => new Date("2026-07-18T12:02:00Z") });
  assert.equal((await dispatcher.scanOnce()).deferred, 1); await assert.rejects(readFile(join(directory, "receipt.json")));
  dispatcher = createReplyDispatcher({ queueRoot: root, stateRoot: join(root, "state"), threadDriver: driver, now: () => new Date("2026-07-18T12:02:01Z") });
  assert.equal((await dispatcher.scanOnce()).applied, 1); assert.equal(effects.size, 1);
});

test("driver and dispatcher restart reconcile a post-turn-start crash without a second turn", async () => {
  const root = await queue(); const directory = await interaction(root, { text: "continue once" }); const stateRoot = join(root, "state"); const turns = []; let starts = 0; let crash = true;
  class Client extends EventEmitter {
    async request(method, params) {
      if (method === "thread/resume") return { thread: { id: params.threadId, status: { type: "idle" }, turns: [...turns] } };
      starts += 1; turns.push({ id: "started-turn", items: [{ type: "userMessage", content: [{ type: "text", text: params.input[0].text }] }] });
      if (crash) { crash = false; throw new Error("post-start crash"); }
      return { turn: { id: "started-turn" } };
    }
    respond() {} respondError() {}
  }
  let driver = createThreadDriver({ client: new Client(), publish: async () => ({}), stateRoot });
  let dispatcher = createReplyDispatcher({ queueRoot: root, stateRoot, threadDriver: driver, now: () => new Date("2026-07-18T12:02:00Z") });
  assert.equal((await dispatcher.scanOnce()).deferred, 1); await driver.close(); await dispatcher.close();
  driver = createThreadDriver({ client: new Client(), publish: async () => ({}), stateRoot });
  dispatcher = createReplyDispatcher({ queueRoot: root, stateRoot, threadDriver: driver, now: () => new Date("2026-07-18T12:02:01Z") });
  assert.equal((await dispatcher.scanOnce()).applied, 1); assert.equal(starts, 1); assert.equal(JSON.parse(await readFile(join(directory, "receipt.json"))).status, "APPLIED");
  await driver.close(); await dispatcher.close();
});
