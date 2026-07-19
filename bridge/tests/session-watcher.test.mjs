import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, utimes, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, test } from "node:test";

import { createSessionWatcher } from "../src/session-watcher.mjs";
import { createThreadDriver } from "../src/thread-driver.mjs";

const temporaryDirectories = [];

function hasExactError(code) {
  return (error) => error?.code === code && error?.message === code;
}

function publisher(effect = async () => {}) {
  return async (message, options) => {
    await effect(message, options);
    return { idempotencyKey: options?.idempotencyKey };
  };
}

function stateFrame(record) {
  const payload = JSON.stringify(record);
  const length = Buffer.byteLength(payload, "utf8");
  const hash = createHash("sha256").update(payload, "utf8").digest("hex");
  return `${length}:${hash}:${payload}\n`;
}

function readStateFrames(contents) {
  return contents.trimEnd().split("\n").filter(Boolean).map((line) => {
    const match = /^(\d+):([0-9a-f]{64}):(.*)$/u.exec(line);
    assert.ok(match, "state line must be framed");
    assert.equal(Buffer.byteLength(match[3], "utf8"), Number(match[1]));
    assert.equal(createHash("sha256").update(match[3], "utf8").digest("hex"), match[2]);
    return JSON.parse(match[3]);
  });
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "hermes-watcher-"));
  temporaryDirectories.push(root);
  const sessionsRoot = join(root, "sessions");
  const ledgerPath = join(root, "state", "watcher.jsonl");
  await mkdir(sessionsRoot, { recursive: true });
  return { root, sessionsRoot, ledgerPath };
}

function sessionMeta(id = "fictional-session") {
  return JSON.stringify({ type: "session_meta", timestamp: "2026-04-05T06:07:08Z", payload: { id, cwd: "D:\\Fictional Workspace\\Demo" } });
}

function finalRecord({ text = "Финальный ответ", timestamp = "2026-04-05T06:07:09Z", itemId = "fictional-item", turnId = "fictional-turn", phase = "final_answer" } = {}) {
  return JSON.stringify({
    type: "response_item",
    timestamp,
    turn_id: turnId,
    payload: { id: itemId, type: "message", role: "assistant", phase, content: [{ type: "output_text", text }] },
  });
}

async function createSessionFile(sessionsRoot, name = join("2026", "04", "05", "rollout-fictional.jsonl"), lines = []) {
  const path = join(sessionsRoot, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, lines.length ? `${lines.join("\n")}\n` : "", "utf8");
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("first bootstrap checkpoints every existing file at EOF and publishes no history", async () => {
  const { sessionsRoot, ledgerPath } = await setup();
  const sessionPath = await createSessionFile(sessionsRoot, undefined, [sessionMeta(), finalRecord({ text: "PRIVATE HISTORY" })]);
  const published = [];
  const watcher = createSessionWatcher({ sessionsRoot, ledgerPath, publish: publisher((message) => published.push(message)) });

  await watcher.bootstrap();
  assert.deepEqual(await watcher.scanOnce(), { published: 0, diagnostics: [] });
  await watcher.close();

  assert.deepEqual(published, []);
  const state = await readFile(ledgerPath, "utf8");
  const frames = readStateFrames(state);
  assert.match(state, /"bootstrapped":true/);
  assert.match(state, new RegExp(`"byteOffset":${(await stat(sessionPath)).size}`));
  assert.equal(state.includes(sessionsRoot), false);
  assert.equal(state.includes("PRIVATE HISTORY"), false);
  assert.match(state, /2026\/04\/05\/rollout-fictional\.jsonl/);
  const checkpoint = frames.find((record) => record.type === "checkpoint");
  assert.deepEqual(Object.keys(checkpoint).sort(), ["byteOffset", "fileId", "lastCtimeMs", "lastMtimeMs", "observedSize", "path", "prefixSha256", "schema", "type"]);
  assert.match(checkpoint.fileId, /^\d+:\d+$/);
  assert.match(checkpoint.prefixSha256, /^[0-9a-f]{64}$/);
  assert.equal(checkpoint.observedSize, (await stat(sessionPath)).size);
  assert.equal(Number.isFinite(checkpoint.lastCtimeMs), true);
});

test("scanOnce before first bootstrap safely bootstraps without publishing history", async () => {
  const { sessionsRoot, ledgerPath } = await setup();
  await createSessionFile(sessionsRoot, undefined, [sessionMeta(), finalRecord({ text: "old history" })]);
  const published = [];
  const watcher = createSessionWatcher({ sessionsRoot, ledgerPath, publish: publisher((message) => published.push(message)) });

  assert.deepEqual(await watcher.scanOnce(), { published: 0, diagnostics: [] });
  assert.deepEqual(published, []);
  assert.match(await readFile(ledgerPath, "utf8"), /"bootstrapped":true/);
  await watcher.close();
});

test("an appended final publishes once and restart resumes without a duplicate", async () => {
  const { sessionsRoot, ledgerPath } = await setup();
  const sessionPath = await createSessionFile(sessionsRoot, undefined, [sessionMeta()]);
  const published = [];
  let watcher = createSessionWatcher({ sessionsRoot, ledgerPath, publish: publisher((message) => published.push(message)) });
  await watcher.bootstrap();
  await appendFile(sessionPath, `${finalRecord()}\n`, "utf8");

  assert.equal((await watcher.scanOnce()).published, 1);
  assert.equal((await watcher.scanOnce()).published, 0);
  await watcher.close();

  watcher = createSessionWatcher({ sessionsRoot, ledgerPath, publish: publisher((message) => published.push(message)) });
  assert.equal((await watcher.scanOnce()).published, 0);
  await watcher.close();
  assert.equal(published.length, 1);
});

test("lifecycle controls use the same durable sink acknowledgment and dedupe boundary", async () => {
  const { sessionsRoot, ledgerPath } = await setup();
  const sessionPath = await createSessionFile(sessionsRoot, undefined, [sessionMeta()]);
  const observations = [];
  const watcher = createSessionWatcher({ sessionsRoot, ledgerPath, publish: publisher((observation) => observations.push(observation)) });
  await watcher.bootstrap();
  await appendFile(sessionPath, `${[
    finalRecord({ text: "goal checkpoint", itemId: "goal-final", turnId: "goal-one" }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "goal-two" } }),
    JSON.stringify({ type: "response_item", turn_id: "goal-two", payload: { type: "message", role: "user", content: [{ type: "input_text", text: '<codex_internal_context source="goal">continue</codex_internal_context>' }] } }),
  ].join("\n")}\n`, "utf8");

  assert.equal((await watcher.scanOnce()).published, 3);
  assert.deepEqual(observations.map(({ channel, kind }) => ({ channel, kind })), [
    { channel: "final", kind: "FINAL_RESPONSE" },
    { channel: "control", kind: "TURN_STARTED" },
    { channel: "control", kind: "AUTO_GOAL_CONTINUATION" },
  ]);
  assert.equal((await watcher.scanOnce()).published, 0);
  await watcher.close();
});

test("a new session file after bootstrap is read from byte zero", async () => {
  const { sessionsRoot, ledgerPath } = await setup();
  const published = [];
  const watcher = createSessionWatcher({ sessionsRoot, ledgerPath, publish: publisher((message) => published.push(message)) });
  await watcher.bootstrap();
  await createSessionFile(sessionsRoot, join("2026", "04", "06", "rollout-new.jsonl"), [sessionMeta("new-session"), finalRecord({ text: "new final", itemId: "new-item" })]);

  assert.equal((await watcher.scanOnce()).published, 1);
  assert.equal(published[0].text, "new final");
  await watcher.close();
});

test("router registry suppresses only its exact session and refreshes before scan", async () => {
  const { root, sessionsRoot, ledgerPath } = await setup();
  const routerThread = "11111111-1111-4111-8111-111111111111";
  const userThread = "22222222-2222-4222-8222-222222222222";
  const routerRegistryPath = join(root, "Queue", "bridge", "v3", "ui-router.json");
  const routerSession = await createSessionFile(sessionsRoot, join("2026", "04", "06", "rollout-router.jsonl"));
  const userSession = await createSessionFile(sessionsRoot, join("2026", "04", "06", "rollout-user.jsonl"));
  const published = [];
  const watcher = createSessionWatcher({
    sessionsRoot,
    ledgerPath,
    routerRegistryPath,
    publish: publisher((message) => published.push(message)),
  });
  await watcher.bootstrap();
  await mkdir(dirname(routerRegistryPath), { recursive: true });
  await writeFile(routerRegistryPath, `${JSON.stringify({
    schema: "hermes-codex-ui-router-registry/v3",
    thread_id: routerThread,
    automation_id: "router-automation",
    created_at: "2026-07-19T12:00:00.000Z",
  })}\n`, "utf8");
  await appendFile(routerSession, `${sessionMeta(routerThread)}\n${finalRecord({ text: "router final must not publish", itemId: "router-item" })}\n`, "utf8");
  await appendFile(userSession, `${sessionMeta(userThread)}\n${finalRecord({ text: "user final", itemId: "user-item" })}\n`, "utf8");

  assert.equal((await watcher.scanOnce()).published, 1);
  assert.deepEqual(published.map(({ threadId, text }) => ({ threadId, text })), [{ threadId: userThread, text: "user final" }]);
  await watcher.close();
});

test("malformed existing router registry fails closed before publication", async () => {
  const { root, sessionsRoot, ledgerPath } = await setup();
  const routerRegistryPath = join(root, "Queue", "bridge", "v3", "ui-router.json");
  const sessionPath = await createSessionFile(sessionsRoot);
  const published = [];
  const watcher = createSessionWatcher({ sessionsRoot, ledgerPath, routerRegistryPath, publish: publisher((message) => published.push(message)) });
  await watcher.bootstrap();
  await mkdir(dirname(routerRegistryPath), { recursive: true });
  await writeFile(routerRegistryPath, "{bad", "utf8");
  await appendFile(sessionPath, `${sessionMeta("33333333-3333-4333-8333-333333333333")}\n${finalRecord({ text: "must wait" })}\n`, "utf8");

  await assert.rejects(watcher.scanOnce(), hasExactError("WATCHER_ROUTER_REGISTRY"));
  assert.deepEqual(published, []);
  await watcher.close();
});

test("canonical explicit final identity deduplicates the same app-server item across rollout paths", async () => {
  const { sessionsRoot, ledgerPath } = await setup(); const published = []; const sinkEffects = new Set();
  const sink = publisher((message, { idempotencyKey }) => { published.push({ message, idempotencyKey }); sinkEffects.add(idempotencyKey); });
  const watcher = createSessionWatcher({ sessionsRoot, ledgerPath, publish: sink });
  await watcher.bootstrap();
  class Client extends EventEmitter { async request() { return {}; } respond() {} respondError() {} }
  const client = new Client(); const driver = createThreadDriver({ client, publish: sink });
  client.emit("notification", { method: "item/completed", params: { threadId: "canonical-thread", turnId: "canonical-turn", item: { id: "canonical-item", type: "agentMessage", phase: "final_answer", text: "one final" } } });
  client.emit("notification", { method: "turn/completed", params: { threadId: "canonical-thread", turn: { id: "canonical-turn", status: { type: "completed" } } } });
  await driver.idle();
  const lines = [sessionMeta("canonical-thread"), finalRecord({ text: "one final", turnId: "canonical-turn", itemId: "canonical-item" })];
  await createSessionFile(sessionsRoot, join("2026", "04", "06", "rollout-one.jsonl"), lines);
  await createSessionFile(sessionsRoot, join("2026", "04", "07", "rollout-two.jsonl"), lines);
  assert.equal((await watcher.scanOnce()).published, 1); assert.equal(sinkEffects.size, 1);
  assert.ok(published.every(({ idempotencyKey }) => idempotencyKey === published[0].idempotencyKey));
  assert.ok(published.some(({ message }) => message.dedupeKey === "codex:canonical-thread:canonical-turn:canonical-item:FINAL_RESPONSE"));
  await driver.close(); await watcher.close();
});

test("partial UTF-8 record is withheld until newline completion and CRLF is accepted", async () => {
  const { sessionsRoot, ledgerPath } = await setup();
  const sessionPath = await createSessionFile(sessionsRoot, undefined, [sessionMeta()]);
  const published = [];
  const watcher = createSessionWatcher({ sessionsRoot, ledgerPath, publish: publisher((message) => published.push(message)) });
  await watcher.bootstrap();
  const record = finalRecord({ text: "Привет, мир 🌍" });
  const bytes = Buffer.from(record, "utf8");
  const split = bytes.indexOf(Buffer.from("🌍")) + 1;
  await appendFile(sessionPath, bytes.subarray(0, split));

  assert.equal((await watcher.scanOnce()).published, 0);
  await appendFile(sessionPath, Buffer.concat([bytes.subarray(split), Buffer.from("\r\n")]));
  assert.equal((await watcher.scanOnce()).published, 1);
  assert.equal(published[0].text, "Привет, мир 🌍");
  assert.equal((await watcher.scanOnce()).published, 0);
  await watcher.close();
});

test("large existing files bootstrap and resume with bounded reads", async () => {
  const { sessionsRoot, ledgerPath } = await setup();
  const historyLines = [sessionMeta("large-session")];
  for (let index = 0; index < 280; index += 1) {
    historyLines.push(JSON.stringify({
      type: "event_msg",
      payload: { type: "fictional_history", index, text: "x".repeat(8 * 1024) },
    }));
  }
  const sessionPath = await createSessionFile(sessionsRoot, join("2026", "04", "10", "rollout-large.jsonl"), historyLines);
  let contentBytesRead = 0;
  const published = [];
  const watcher = createSessionWatcher({
    sessionsRoot,
    ledgerPath,
    publish: publisher((message) => published.push(message)),
    onFileBytesRead: ({ relativePath, bytesRead }) => {
      assert.equal(relativePath, "2026/04/10/rollout-large.jsonl");
      contentBytesRead += bytesRead;
    },
  });

  const initialSize = (await stat(sessionPath)).size;
  assert.ok(initialSize > 2 * 1024 * 1024);
  await watcher.bootstrap();
  assert.ok(contentBytesRead <= 64 * 1024, `bootstrap read ${contentBytesRead} bytes`);

  const finalBytes = Buffer.from(finalRecord({ text: "large file final", itemId: "large-file-item" }), "utf8");
  const split = Math.floor(finalBytes.length / 2);
  contentBytesRead = 0;
  await appendFile(sessionPath, finalBytes.subarray(0, split));
  const partialSize = (await stat(sessionPath)).size;
  assert.deepEqual(await watcher.scanOnce(), { published: 0, diagnostics: [] });
  assert.ok(contentBytesRead <= (64 * 1024) + finalBytes.length, `partial append read ${contentBytesRead} bytes`);
  const partialCheckpoint = readStateFrames(await readFile(ledgerPath, "utf8")).at(-1);
  assert.equal(partialCheckpoint.byteOffset, initialSize);
  assert.equal(partialCheckpoint.observedSize, partialSize);

  contentBytesRead = 0;
  assert.deepEqual(await watcher.scanOnce(), { published: 0, diagnostics: [] });
  assert.equal(contentBytesRead, 0);

  contentBytesRead = 0;
  await appendFile(sessionPath, Buffer.concat([finalBytes.subarray(split), Buffer.from("\n")]));
  assert.equal((await watcher.scanOnce()).published, 1);
  assert.ok(contentBytesRead <= (64 * 1024) + finalBytes.length + 1, `completed append read ${contentBytesRead} bytes`);
  assert.equal(published.length, 1);

  contentBytesRead = 0;
  assert.equal((await watcher.scanOnce()).published, 0);
  assert.equal(contentBytesRead, 0);
  await watcher.close();
});

test("same-size same-inode rewrite with restored mtime is detected by ctime", async () => {
  const { sessionsRoot, ledgerPath } = await setup();
  const oldContents = `${sessionMeta("rewrite-old")}\n${finalRecord({ text: "old final", itemId: "item-old" })}\n`;
  const newContents = `${sessionMeta("rewrite-new")}\n${finalRecord({ text: "new final", itemId: "item-new" })}\n`;
  assert.equal(Buffer.byteLength(newContents), Buffer.byteLength(oldContents));
  const sessionPath = await createSessionFile(sessionsRoot);
  await writeFile(sessionPath, oldContents, "utf8");
  const fixedTime = new Date("2026-04-05T06:00:00.000Z");
  await utimes(sessionPath, fixedTime, fixedTime);

  let contentBytesRead = 0;
  const published = [];
  const watcher = createSessionWatcher({
    sessionsRoot,
    ledgerPath,
    publish: publisher((message) => published.push({ text: message.text, threadId: message.threadId })),
    onFileBytesRead: ({ bytesRead }) => { contentBytesRead += bytesRead; },
  });
  await watcher.bootstrap();
  const before = await stat(sessionPath, { bigint: true });

  await writeFile(sessionPath, newContents, "utf8");
  await utimes(sessionPath, fixedTime, fixedTime);
  const after = await stat(sessionPath, { bigint: true });
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.notEqual(after.ctimeNs, before.ctimeNs);

  contentBytesRead = 0;
  assert.equal((await watcher.scanOnce()).published, 1);
  assert.ok(contentBytesRead > 0);
  assert.deepEqual(published, [{ text: "new final", threadId: "rewrite-new" }]);

  contentBytesRead = 0;
  assert.equal((await watcher.scanOnce()).published, 0);
  assert.equal(contentBytesRead, 0);
  await watcher.close();
});

test("truncation and rewrite do not duplicate an old final but publish a new final", async () => {
  const { sessionsRoot, ledgerPath } = await setup();
  const sessionPath = await createSessionFile(sessionsRoot, undefined, [sessionMeta()]);
  const published = [];
  const watcher = createSessionWatcher({ sessionsRoot, ledgerPath, publish: publisher((message) => published.push(message.text)) });
  await watcher.bootstrap();
  const oldFinal = finalRecord({ text: "old", itemId: "old-item" });
  await appendFile(sessionPath, `${oldFinal}\n`, "utf8");
  assert.equal((await watcher.scanOnce()).published, 1);

  await truncate(sessionPath, 0);
  await appendFile(sessionPath, `${sessionMeta()}\n${oldFinal}\n${finalRecord({ text: "new", itemId: "new-item", timestamp: "2026-04-05T06:07:10Z" })}\n`, "utf8");
  assert.equal((await watcher.scanOnce()).published, 1);
  assert.deepEqual(published, ["old", "new"]);
  await watcher.close();
});

test("same-inode larger truncate-rewrite with a changed prefix resets from byte zero", async () => {
  const { sessionsRoot, ledgerPath } = await setup();
  const sessionPath = await createSessionFile(sessionsRoot, undefined, [sessionMeta("before-rewrite")]);
  const published = [];
  const watcher = createSessionWatcher({ sessionsRoot, ledgerPath, publish: publisher((message) => published.push({ text: message.text, threadId: message.threadId })) });
  await watcher.bootstrap();
  const oldFinal = finalRecord({ text: "old rewrite final", itemId: "rewrite-old" });
  await appendFile(sessionPath, `${oldFinal}\n`, "utf8");
  assert.equal((await watcher.scanOnce()).published, 1);

  const changedPrefix = `${sessionMeta("after-rewrite-with-a-longer-session-id")}\n${JSON.stringify({ type: "event_msg", payload: { type: "fictional_padding", text: "x".repeat(600) } })}\n`;
  await writeFile(sessionPath, `${changedPrefix}${finalRecord({ text: "new rewrite final", itemId: "rewrite-new", timestamp: "2026-04-05T06:07:11Z" })}\n`, "utf8");

  assert.equal((await watcher.scanOnce()).published, 1);
  assert.deepEqual(published, [
    { text: "old rewrite final", threadId: "before-rewrite" },
    { text: "new rewrite final", threadId: "after-rewrite-with-a-longer-session-id" },
  ]);
  await watcher.close();
});

test("bounded prefix fingerprint detects a rewrite that preserves the last 4 KiB", async () => {
  const { sessionsRoot, ledgerPath } = await setup();
  const relativeName = join("2026", "04", "05", "rollout-prefix.jsonl");
  const middleA = JSON.stringify({ type: "event_msg", payload: { type: "fictional_middle", text: "A".repeat(9_000) } });
  const middleB = JSON.stringify({ type: "event_msg", payload: { type: "fictional_middle", text: "B".repeat(9_000) } });
  const preservedTail = JSON.stringify({ type: "event_msg", payload: { type: "fictional_tail", text: "T".repeat(5_000) } });
  const oldFinal = finalRecord({ text: "old prefix final", itemId: "prefix-old" });
  const sessionPath = await createSessionFile(sessionsRoot, relativeName, [sessionMeta("thread-old"), middleA, preservedTail]);
  const published = [];
  const watcher = createSessionWatcher({ sessionsRoot, ledgerPath, publish: publisher((message) => published.push({ text: message.text, threadId: message.threadId })) });
  await watcher.bootstrap();
  await appendFile(sessionPath, `${oldFinal}\n`, "utf8");
  assert.equal((await watcher.scanOnce()).published, 1);

  const rewrittenPrefix = [sessionMeta("thread-new"), middleB, preservedTail, oldFinal].join("\n") + "\n";
  assert.ok(Buffer.byteLength(rewrittenPrefix, "utf8") > 8 * 1024);
  await writeFile(sessionPath, `${rewrittenPrefix}${finalRecord({ text: "new prefix final", itemId: "prefix-new", timestamp: "2026-04-05T06:07:12Z" })}\n`, "utf8");

  assert.equal((await watcher.scanOnce()).published, 2);
  assert.deepEqual(published, [
    { text: "old prefix final", threadId: "thread-old" },
    { text: "old prefix final", threadId: "thread-new" },
    { text: "new prefix final", threadId: "thread-new" },
  ]);
  await watcher.close();
});

test("publish failure leaves the record retryable", async () => {
  const { sessionsRoot, ledgerPath } = await setup();
  const sessionPath = await createSessionFile(sessionsRoot, undefined, [sessionMeta()]);
  let attempts = 0;
  const published = [];
  const watcher = createSessionWatcher({
    sessionsRoot,
    ledgerPath,
    publish: publisher(async (message) => {
      attempts += 1;
      if (attempts === 1) throw new Error("raw callback failure");
      published.push(message);
    }),
  });
  await watcher.bootstrap();
  await appendFile(sessionPath, `${finalRecord()}\n`, "utf8");

  await assert.rejects(watcher.scanOnce(), hasExactError("WATCHER_PUBLISH"));
  assert.equal((await watcher.scanOnce()).published, 1);
  assert.equal(attempts, 2);
  assert.equal(published.length, 1);
  await watcher.close();
});

test("concurrent scans are serialized and publish one copy", async () => {
  const { sessionsRoot, ledgerPath } = await setup();
  const sessionPath = await createSessionFile(sessionsRoot, undefined, [sessionMeta()]);
  let active = 0;
  let maxActive = 0;
  const published = [];
  const watcher = createSessionWatcher({
    sessionsRoot,
    ledgerPath,
    publish: publisher(async (message) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      published.push(message);
      active -= 1;
    }),
  });
  await watcher.bootstrap();
  await appendFile(sessionPath, `${finalRecord()}\n`, "utf8");

  const results = await Promise.all([watcher.scanOnce(), watcher.scanOnce(), watcher.scanOnce()]);
  assert.equal(results.reduce((sum, result) => sum + result.published, 0), 1);
  assert.equal(published.length, 1);
  assert.equal(maxActive, 1);
  await watcher.close();
});

test("publish must acknowledge the exact deterministic idempotency key before mark or checkpoint", async () => {
  const { sessionsRoot, ledgerPath } = await setup();
  const sessionPath = await createSessionFile(sessionsRoot, undefined, [sessionMeta()]);
  const attemptedKeys = [];
  const watcher = createSessionWatcher({
    sessionsRoot,
    ledgerPath,
    publish: async (message, { idempotencyKey, signal }) => {
      attemptedKeys.push(idempotencyKey);
      assert.equal(idempotencyKey, message.eventId);
      assert.ok(signal instanceof AbortSignal);
      return { idempotencyKey: "evt_00000000-0000-5000-8000-000000000000" };
    },
  });
  await watcher.bootstrap();
  const before = await readFile(ledgerPath, "utf8");
  await appendFile(sessionPath, `${finalRecord()}\n`, "utf8");

  await assert.rejects(watcher.scanOnce(), hasExactError("WATCHER_PUBLISH_CONTRACT"));
  assert.deepEqual(attemptedKeys, ["evt_b31604ad-5322-50e3-be83-62922b68dcfa"]);
  assert.equal(await readFile(ledgerPath, "utf8"), before);
  await watcher.close();
});

test("two watcher instances share one idempotent sink side effect", async () => {
  const { sessionsRoot, ledgerPath } = await setup();
  const sessionPath = await createSessionFile(sessionsRoot, undefined, [sessionMeta()]);
  const sideEffects = new Map();
  const attempts = [];
  const sink = async (message, { idempotencyKey }) => {
    assert.equal(idempotencyKey, message.eventId);
    attempts.push(idempotencyKey);
    if (!sideEffects.has(idempotencyKey)) sideEffects.set(idempotencyKey, message.text);
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { idempotencyKey };
  };
  const first = createSessionWatcher({ sessionsRoot, ledgerPath, publish: sink });
  const second = createSessionWatcher({ sessionsRoot, ledgerPath, publish: sink });
  await Promise.all([first.bootstrap(), second.bootstrap()]);
  await appendFile(sessionPath, `${finalRecord()}\n`, "utf8");

  const results = await Promise.all([first.scanOnce(), second.scanOnce()]);
  assert.equal(sideEffects.size, 1);
  assert.equal(results.reduce((total, result) => total + result.published, 0), 1);
  assert.ok(attempts.length >= 1);
  assert.ok(attempts.every((key) => key === attempts[0] && /^evt_/.test(key)));
  await Promise.all([first.close(), second.close()]);
});

test("fallback finals missing a turn id remain path-scoped across session files", async () => {
  const { sessionsRoot, ledgerPath } = await setup();
  const published = [];
  const watcher = createSessionWatcher({
    sessionsRoot,
    ledgerPath,
    publish: publisher((message, { idempotencyKey }) => published.push({ text: message.text, idempotencyKey })),
  });
  await watcher.bootstrap();
  await createSessionFile(sessionsRoot, join("2026", "04", "08", "rollout-first.jsonl"), [
    sessionMeta("shared-session"),
    finalRecord({ text: "first file", itemId: "shared-item", turnId: null }),
  ]);
  await createSessionFile(sessionsRoot, join("2026", "04", "09", "rollout-second.jsonl"), [
    sessionMeta("shared-session"),
    finalRecord({ text: "second file", itemId: "shared-item", turnId: null }),
  ]);

  assert.equal((await watcher.scanOnce()).published, 2);
  assert.deepEqual(published.map(({ text }) => text), ["first file", "second file"]);
  assert.notEqual(published[0].idempotencyKey, published[1].idempotencyKey);
  assert.ok(published.every(({ idempotencyKey }) => /^evt_/.test(idempotencyKey)));
  await watcher.close();
});

test("sink commit followed by throw retries the same key without a duplicate side effect", async () => {
  const { sessionsRoot, ledgerPath } = await setup();
  const sessionPath = await createSessionFile(sessionsRoot, undefined, [sessionMeta()]);
  const sideEffects = new Map();
  const attempts = [];
  const sink = async (message, { idempotencyKey }) => {
    attempts.push(idempotencyKey);
    if (!sideEffects.has(idempotencyKey)) {
      sideEffects.set(idempotencyKey, message.text);
      throw new Error("fictional crash after sink commit");
    }
    return { idempotencyKey };
  };
  let watcher = createSessionWatcher({ sessionsRoot, ledgerPath, publish: sink });
  await watcher.bootstrap();
  await appendFile(sessionPath, `${finalRecord()}\n`, "utf8");
  await assert.rejects(watcher.scanOnce(), hasExactError("WATCHER_PUBLISH"));
  await watcher.close();

  watcher = createSessionWatcher({ sessionsRoot, ledgerPath, publish: sink });
  assert.equal((await watcher.scanOnce()).published, 1);
  assert.equal(sideEffects.size, 1);
  assert.deepEqual(attempts, [attempts[0], attempts[0]]);
  assert.match(attempts[0], /^evt_/);
  await watcher.close();
});

test("symlink or junction session paths are skipped", async (context) => {
  const { root, sessionsRoot, ledgerPath } = await setup();
  const outside = join(root, "outside");
  await createSessionFile(outside, "rollout-linked.jsonl", [sessionMeta("linked"), finalRecord({ text: "must not publish", itemId: "linked-item" })]);
  const linkPath = join(sessionsRoot, "linked");
  try {
    await symlink(outside, linkPath, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
      context.diagnostic(`link creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const published = [];
  const watcher = createSessionWatcher({ sessionsRoot, ledgerPath, publish: publisher((message) => published.push(message)) });
  await watcher.bootstrap();
  assert.equal((await watcher.scanOnce()).published, 0);
  assert.deepEqual(published, []);
  const state = await readFile(ledgerPath, "utf8");
  assert.equal(state.includes("rollout-linked"), false);
  await watcher.close();
});

test("a directory swapped to an outside junction after enumeration cannot publish outside bytes", async (context) => {
  const { root, sessionsRoot, ledgerPath } = await setup();
  const relativeName = join("2026", "04", "07", "rollout-swap.jsonl");
  const insideDirectory = join(sessionsRoot, "2026", "04", "07");
  await createSessionFile(sessionsRoot, relativeName, [sessionMeta("inside-session")]);
  const outsideDirectory = join(root, "outside-swap");
  await createSessionFile(outsideDirectory, "rollout-swap.jsonl", [
    sessionMeta("outside-session"),
    finalRecord({ text: "outside bytes must not publish", itemId: "outside-swap-item" }),
  ]);
  let swapEnabled = false;
  let hookCalls = 0;
  let linkError;
  const published = [];
  const watcher = createSessionWatcher({
    sessionsRoot,
    ledgerPath,
    publish: publisher((message) => published.push(message)),
    beforeOpen: async ({ relativePath }) => {
      if (!swapEnabled || relativePath !== "2026/04/07/rollout-swap.jsonl" || hookCalls > 0) return;
      hookCalls += 1;
      await rm(insideDirectory, { recursive: true, force: true });
      try {
        await symlink(outsideDirectory, insideDirectory, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        linkError = error;
      }
    },
  });
  await watcher.bootstrap();
  swapEnabled = true;
  assert.equal((await watcher.scanOnce()).published, 0);
  await watcher.close();

  if (linkError && ["EPERM", "EACCES", "UNKNOWN"].includes(linkError.code)) {
    context.diagnostic(`junction creation unavailable: ${linkError.code}`);
    return;
  }
  if (linkError) throw linkError;
  assert.equal(hookCalls, 1);
  assert.deepEqual(published, []);
});

test("one scan appends at most one coalesced checkpoint frame per file", async () => {
  const { sessionsRoot, ledgerPath } = await setup();
  const sessionPath = await createSessionFile(sessionsRoot, undefined, [sessionMeta()]);
  const watcher = createSessionWatcher({ sessionsRoot, ledgerPath, publish: publisher() });
  await watcher.bootstrap();
  const beforeFrames = readStateFrames(await readFile(ledgerPath, "utf8"));
  await appendFile(sessionPath, [
    JSON.stringify({ type: "event_msg", payload: { type: "commentary", text: "fictional" } }),
    JSON.stringify({ type: "response_item", payload: { type: "reasoning", text: "fictional" } }),
    finalRecord(),
  ].join("\n") + "\n", "utf8");

  assert.equal((await watcher.scanOnce()).published, 1);
  const afterFrames = readStateFrames(await readFile(ledgerPath, "utf8"));
  assert.equal(afterFrames.length, beforeFrames.length + 1);
  assert.equal(afterFrames.at(-1).type, "checkpoint");
  await watcher.close();
});

test("a torn final framed append is discarded and the journal remains restartable", async () => {
  const { sessionsRoot, ledgerPath } = await setup();
  const sessionPath = await createSessionFile(sessionsRoot, undefined, [sessionMeta()]);
  let watcher = createSessionWatcher({ sessionsRoot, ledgerPath, publish: publisher() });
  await watcher.bootstrap();
  await watcher.close();
  const tornRecord = { schema: 1, type: "checkpoint", path: "2026/04/05/rollout-fictional.jsonl", byteOffset: 999, observedSize: 999, lastMtimeMs: 1, lastCtimeMs: 1, fileId: "1:1", prefixSha256: "0".repeat(64) };
  const completeFrame = stateFrame(tornRecord);
  await appendFile(ledgerPath, completeFrame.slice(0, -12), "utf8");
  await appendFile(sessionPath, `${finalRecord()}\n`, "utf8");

  const published = [];
  watcher = createSessionWatcher({ sessionsRoot, ledgerPath, publish: publisher((message) => published.push(message)) });
  assert.equal((await watcher.scanOnce()).published, 1);
  await watcher.close();
  assert.equal(published.length, 1);

  watcher = createSessionWatcher({ sessionsRoot, ledgerPath, publish: publisher((message) => published.push(message)) });
  assert.equal((await watcher.scanOnce()).published, 0);
  await watcher.close();
  assert.equal(published.length, 1);
  readStateFrames(await readFile(ledgerPath, "utf8"));
});

test("an incomplete bootstrap frame reruns no-history bootstrap safely", async () => {
  const { sessionsRoot, ledgerPath } = await setup();
  await createSessionFile(sessionsRoot, undefined, [sessionMeta(), finalRecord({ text: "pre-bootstrap history" })]);
  await mkdir(dirname(ledgerPath), { recursive: true });
  const bootstrapFrame = stateFrame({ schema: 1, type: "bootstrap", bootstrapped: true });
  await writeFile(ledgerPath, bootstrapFrame.slice(0, -8), "utf8");
  const published = [];
  let watcher = createSessionWatcher({ sessionsRoot, ledgerPath, publish: publisher((message) => published.push(message)) });

  assert.equal((await watcher.scanOnce()).published, 0);
  await watcher.close();
  assert.deepEqual(published, []);
  watcher = createSessionWatcher({ sessionsRoot, ledgerPath, publish: publisher((message) => published.push(message)) });
  assert.equal((await watcher.scanOnce()).published, 0);
  await watcher.close();
  assert.deepEqual(published, []);
});

test("every syntactically plausible final frame tear is discarded after the last valid newline", async () => {
  const bootstrap = { schema: 1, type: "bootstrap", bootstrapped: true };
  const validBootstrap = stateFrame(bootstrap);
  const payload = JSON.stringify({ schema: 1, type: "bootstrap", bootstrapped: true });
  const payloadLength = Buffer.byteLength(payload, "utf8");
  const hash = createHash("sha256").update(payload, "utf8").digest("hex");
  const header = `${payloadLength}:${hash}:`;
  const tails = [
    "12",
    `${payloadLength}:`,
    `${payloadLength}:${hash.slice(0, 19)}`,
    header,
    `${header}${payload.slice(0, 7)}`,
    stateFrame(bootstrap).slice(0, -1),
  ];

  for (const tail of tails) {
    const { sessionsRoot, ledgerPath } = await setup();
    await mkdir(dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, `${validBootstrap}${tail}`, "utf8");
    const watcher = createSessionWatcher({ sessionsRoot, ledgerPath, publish: publisher() });
    assert.deepEqual(await watcher.scanOnce(), { published: 0, diagnostics: [] });
    await watcher.close();
    assert.equal(await readFile(ledgerPath, "utf8"), validBootstrap);
  }
});

test("corrupt or unterminated watcher state fails closed", async () => {
  const bootstrap = { schema: 1, type: "bootstrap", bootstrapped: true };
  const validBootstrap = stateFrame(bootstrap);
  const strictCheckpoint = { schema: 1, type: "checkpoint", path: "2026/04/rollout.jsonl", byteOffset: 0, observedSize: 0, lastMtimeMs: 1, lastCtimeMs: 1, fileId: "1:2", prefixSha256: "0".repeat(64) };
  const badChecksum = validBootstrap.replace(/:[0-9a-f]{64}:/u, `:${"0".repeat(64)}:`);
  for (const contents of [
    "not-json\n",
    JSON.stringify(bootstrap),
    badChecksum,
    `${validBootstrap}malformed-middle-frame\n${validBootstrap}`,
    stateFrame({ ...bootstrap, privateText: "must reject" }),
    stateFrame({ ...strictCheckpoint, path: "2026\\04\\rollout.jsonl" }),
  ]) {
    const { sessionsRoot, ledgerPath } = await setup();
    await mkdir(dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, contents, "utf8");
    const watcher = createSessionWatcher({ sessionsRoot, ledgerPath, publish: publisher() });
    await assert.rejects(watcher.bootstrap(), hasExactError("WATCHER_STATE_CORRUPT"));
    await watcher.close();
  }
});

test("invalid UTF-8 is diagnosed and checkpointed without replacement-text publication", async () => {
  const { sessionsRoot, ledgerPath } = await setup();
  const sessionPath = await createSessionFile(sessionsRoot, undefined, [sessionMeta()]);
  const published = [];
  const watcher = createSessionWatcher({ sessionsRoot, ledgerPath, publish: publisher((message) => published.push(message)) });
  await watcher.bootstrap();
  await appendFile(sessionPath, Buffer.concat([
    Buffer.from([0xff, 0xfe, 0x0a]),
    Buffer.from(`${finalRecord({ text: "valid after invalid UTF-8" })}\n`, "utf8"),
  ]));

  assert.deepEqual(await watcher.scanOnce(), {
    published: 1,
    diagnostics: [{ code: "ROLLOUT_UTF8", path: "2026/04/05/rollout-fictional.jsonl" }],
  });
  assert.deepEqual(published.map((message) => message.text), ["valid after invalid UTF-8"]);
  assert.deepEqual(await watcher.scanOnce(), { published: 0, diagnostics: [] });
  await watcher.close();
});

test("external abort is stable and is passed to the publisher", async () => {
  const { sessionsRoot, ledgerPath } = await setup();
  const sessionPath = await createSessionFile(sessionsRoot, undefined, [sessionMeta()]);
  const controller = new AbortController();
  let started;
  const publisherStarted = new Promise((resolve) => { started = resolve; });
  const watcher = createSessionWatcher({
    sessionsRoot,
    ledgerPath,
    signal: controller.signal,
    publish: async (_message, { signal, idempotencyKey } = {}) => {
      assert.match(idempotencyKey, /^evt_/);
      started();
      if (!(signal instanceof AbortSignal)) throw new Error("missing signal");
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  await watcher.bootstrap();
  await appendFile(sessionPath, `${finalRecord()}\n`, "utf8");
  const scan = watcher.scanOnce();
  scan.catch(() => {});
  await publisherStarted;
  controller.abort();

  await assert.rejects(scan, hasExactError("WATCHER_ABORTED"));
  await watcher.close();
});

test("close aborts a signal-aware publisher and waits without leaking handles", async () => {
  const { sessionsRoot, ledgerPath } = await setup();
  const sessionPath = await createSessionFile(sessionsRoot, undefined, [sessionMeta()]);
  let started;
  const publisherStarted = new Promise((resolve) => { started = resolve; });
  const watcher = createSessionWatcher({
    sessionsRoot,
    ledgerPath,
    publish: async (_message, { signal } = {}) => {
      started();
      if (!(signal instanceof AbortSignal)) throw new Error("missing signal");
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  await watcher.bootstrap();
  await appendFile(sessionPath, `${finalRecord()}\n`, "utf8");
  const scan = watcher.scanOnce();
  scan.catch(() => {});
  await publisherStarted;
  const closing = watcher.close();

  await assert.rejects(scan, hasExactError("WATCHER_ABORTED"));
  await closing;
});

test("close is bounded even when the publisher ignores its abort signal", async () => {
  const { sessionsRoot, ledgerPath } = await setup();
  const sessionPath = await createSessionFile(sessionsRoot, undefined, [sessionMeta()]);
  let started;
  const publisherStarted = new Promise((resolve) => { started = resolve; });
  const watcher = createSessionWatcher({
    sessionsRoot,
    ledgerPath,
    publish: async () => {
      started();
      return new Promise(() => {});
    },
  });
  await watcher.bootstrap();
  await appendFile(sessionPath, `${finalRecord()}\n`, "utf8");
  const scan = watcher.scanOnce();
  scan.catch(() => {});
  await publisherStarted;
  const closing = watcher.close();
  let timeout;
  const outcome = await Promise.race([
    closing.then(() => "closed"),
    new Promise((resolve) => { timeout = setTimeout(() => resolve("timeout"), 250); }),
  ]);
  clearTimeout(timeout);

  assert.equal(outcome, "closed");
  await assert.rejects(scan, hasExactError("WATCHER_ABORTED"));
});

test("close waits queued work and all later operations report WATCHER_CLOSED", async () => {
  const { sessionsRoot, ledgerPath } = await setup();
  const sessionPath = await createSessionFile(sessionsRoot, undefined, [sessionMeta()]);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const watcher = createSessionWatcher({ sessionsRoot, ledgerPath, publish: publisher(async () => gate) });
  await watcher.bootstrap();
  await appendFile(sessionPath, `${finalRecord()}\n`, "utf8");
  const scan = watcher.scanOnce();
  scan.catch(() => {});
  const closing = watcher.close();
  release();
  await assert.rejects(scan, hasExactError("WATCHER_ABORTED"));
  await closing;

  await assert.rejects(watcher.scanOnce(), hasExactError("WATCHER_CLOSED"));
  await assert.rejects(watcher.bootstrap(), hasExactError("WATCHER_CLOSED"));
  assert.equal(relative(sessionsRoot, sessionPath).startsWith(".."), false);
});
