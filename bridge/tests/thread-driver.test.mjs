import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createThreadDriver } from "../src/thread-driver.mjs";
import { createReplyDispatcher } from "../src/reply-dispatcher.mjs";

class FakeClient extends EventEmitter {
  requests = []; responses = [];
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === "thread/resume") return { thread: { id: params.threadId, status: { type: this.status ?? "idle" }, turns: this.turns ?? [] } };
    return { turn: { id: `turn-${params.threadId}` } };
  }
  respond(id, result) { this.responses.push({ id, result }); }
  respondError(id, code, message) { this.responses.push({ id, error: { code, message } }); }
}

test("resumes exact thread then starts text turn and serializes only same thread", async () => {
  const client = new FakeClient(); const driver = createThreadDriver({ client, publish: async () => ({ idempotencyKey: "unused" }) });
  await driver.reply({ threadId: "thread-A", text: "Запускай следующую фазу" });
  assert.deepEqual(client.requests.map(({ method }) => method), ["thread/resume", "turn/start"]);
  assert.deepEqual(client.requests[0].params, { threadId: "thread-A" });
  assert.deepEqual(client.requests[1].params, { threadId: "thread-A", input: [{ type: "text", text: "Запускай следующую фазу", text_elements: [] }] });
  await driver.close();
});

test("durable Telegram reply identifies its user message for the Codex Desktop history", async () => {
  const client = new FakeClient();
  const stateRoot = await mkdtemp(join(tmpdir(), "thread-client-id-"));
  const eventId = "evt_219f74b5-c168-7381-9629-d395da0255f7";
  const driver = createThreadDriver({ client, publish: async () => ({}), stateRoot });

  await driver.reply({ threadId: "thread-A", text: "Telegram reply", eventId, idempotencyKey: eventId });

  const turnStart = client.requests.find(({ method }) => method === "turn/start");
  assert.equal(turnStart.params.clientUserMessageId, "219f74b5-c168-7381-9629-d395da0255f7");
  await driver.close();
});

test("readThread is read-only and does not resume or start a turn", async () => {
  const client = new FakeClient();
  client.request = async function(method, params) {
    this.requests.push({ method, params });
    return { thread: { id: params.threadId, name: "Live" } };
  };
  const driver = createThreadDriver({ client, publish: async () => ({}) });
  assert.equal((await driver.readThread("T")).thread.name, "Live");
  assert.deepEqual(client.requests, [{ method: "thread/read", params: { threadId: "T", includeTurns: false } }]);
  await driver.close();
});

test("active thread fails retryably before turn/start", async () => {
  const client = new FakeClient(); client.status = "active"; const driver = createThreadDriver({ client, publish: async () => ({}) });
  await assert.rejects(driver.reply({ threadId: "thread-A", text: "later" }), (error) => error.code === "THREAD_BUSY" && error.retryable === true);
  assert.deepEqual(client.requests.map((item) => item.method), ["thread/resume"]); await driver.close();
});

test("schema status systemError and unknown status fail as THREAD_STATE", async () => {
  for (const status of ["systemError", "futureStatus"]) {
    const client = new FakeClient(); client.status = status; const driver = createThreadDriver({ client, publish: async () => ({}) });
    await assert.rejects(driver.reply({ threadId: "thread-A", text: "later" }), (value) => value.code === "THREAD_STATE" && value.retryable === false);
    assert.deepEqual(client.requests.map((item) => item.method), ["thread/resume"]); await driver.close();
  }
});

test("different threads run concurrently while same-thread replies preserve order", async () => {
  const client = new FakeClient(); let release; const gate = new Promise((resolve) => { release = resolve; });
  client.request = async function(method, params) { this.requests.push({ method, params }); if (method === "thread/resume" && params.threadId === "A" && this.requests.filter((x) => x.params.threadId === "A").length === 1) await gate; return method === "thread/resume" ? { thread: { status: { type: "idle" }, turns: [] } } : {}; };
  const driver = createThreadDriver({ client, publish: async () => ({}) });
  const a1 = driver.reply({ threadId: "A", text: "one" }); const a2 = driver.reply({ threadId: "A", text: "two" }); const b = driver.reply({ threadId: "B", text: "other" });
  await b; assert.ok(client.requests.some((x) => x.params.threadId === "B" && x.method === "turn/start"));
  assert.equal(client.requests.filter((x) => x.params.threadId === "A").length, 1); release(); await Promise.all([a1, a2]);
  assert.deepEqual(client.requests.filter((x) => x.params.threadId === "A" && x.method === "turn/start").map((x) => x.params.input[0].text), ["one", "two"]); await driver.close();
});

test("publishes only bridge-owned turns and ignores foreign app-server history", async () => {
  const client = new FakeClient(); const published = [];
  const driver = createThreadDriver({ client, publish: async (input, { idempotencyKey }) => { published.push({ input, idempotencyKey }); return { idempotencyKey }; } });
  await driver.reply({ threadId: "T", text: "owned final" });
  await driver.reply({ threadId: "F", text: "owned failure" });
  client.emit("notification", { method: "item/completed", params: { threadId: "FOREIGN", turnId: "historical", item: { type: "agentMessage", phase: "final", text: "must never publish" } } });
  client.emit("notification", { method: "turn/completed", params: { threadId: "FOREIGN", turn: { id: "historical", status: "completed" } } });
  client.emit("notification", { method: "item/completed", params: { threadId: "T", turnId: "turn-T", item: { type: "agentMessage", phase: "commentary", text: "skip" } } });
  client.emit("notification", { method: "item/completed", params: { threadId: "T", turnId: "turn-T", item: { type: "agentMessage", phase: "final_answer", text: "first" } } });
  client.emit("notification", { method: "item/completed", params: { threadId: "T", turnId: "turn-T", item: { type: "agentMessage", phase: "final", text: "last" } } });
  client.emit("notification", { method: "turn/completed", params: { threadId: "T", turn: { id: "turn-T", status: "completed" } } });
  client.emit("notification", { method: "turn/completed", params: { threadId: "F", turn: { id: "turn-F", status: "failed" } } });
  await driver.idle();
  assert.deepEqual(published.map((x) => [x.input.kind, x.input.text]), [["FINAL_RESPONSE", "last"], ["ERROR", "The Codex turn failed."]]);
  assert.ok(published.every((x) => x.idempotencyKey.startsWith("evt_") && x.input.event_id === x.idempotencyKey)); await driver.close();
});

test("answers known questions, cancels secrets, and approvals are once-or-decline only", async () => {
  const client = new FakeClient(); const interactions = [
    { action: "REPLY", answers: { scope: ["Current project"], injected: ["bad"] } },
    { action: "APPROVE_ONCE" }, { action: "DECLINE" },
  ];
  const driver = createThreadDriver({ client, publish: async (_input, { idempotencyKey }) => ({ idempotencyKey }), awaitInteraction: async () => interactions.shift(), policy: () => "REMOTE_ALLOWED" });
  client.emit("serverRequest", { id: 1, method: "item/tool/requestUserInput", params: { threadId: "T", questions: [{ id: "scope", question: "Scope?", options: [{ label: "Current project" }] }] } });
  client.emit("serverRequest", { id: 2, method: "item/tool/requestUserInput", params: { threadId: "T", questions: [{ id: "secret", question: "Token?", isSecret: true }] } });
  client.emit("serverRequest", { id: 3, method: "item/commandExecution/requestApproval", params: { command: "npm test", cwd: "C:\\work" } });
  client.emit("serverRequest", { id: 4, method: "item/fileChange/requestApproval", params: { command: "npm test", cwd: "C:\\work" } });
  await driver.idle();
  assert.deepEqual(client.responses.toSorted((a, b) => a.id - b.id), [
    { id: 1, result: { answers: { scope: { answers: ["Current project"] } } } },
    { id: 2, result: { answers: {} } },
    { id: 3, result: { decision: "accept" } },
    { id: 4, result: { decision: "decline" } },
  ]);
  assert.doesNotMatch(JSON.stringify(client.responses), /acceptForSession|execpolicy|network|Token\?/u); await driver.close();
});

test("dispatcher-facing resolveInteraction completes a pending server request exactly once", async () => {
  const client = new FakeClient(); let eventId; let published;
  const driver = createThreadDriver({ client, publish: async (input, { idempotencyKey }) => { published = input; eventId = idempotencyKey; return { idempotencyKey }; } });
  client.emit("serverRequest", { id: 7, method: "item/tool/requestUserInput", params: { threadId: "T", questions: [{ id: "scope", question: "Scope?", options: [{ label: "Current project" }] }] } });
  while (!eventId) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(published.kind, "QUESTION");
  assert.deepEqual(await driver.resolveInteraction({ eventId, action: "REPLY", text: "Current project", idempotencyKey: eventId }), { idempotencyKey: eventId });
  await driver.idle(); assert.deepEqual(client.responses, [{ id: 7, result: { answers: { scope: { answers: ["Current project"] } } } }]);
  assert.deepEqual(await driver.resolveInteraction({ eventId, action: "REPLY", text: "Current project", idempotencyKey: eventId }), { idempotencyKey: eventId });
  assert.equal(client.responses.length, 1); await driver.close();
});

test("question publication contains sanitized prompts/options and parses deterministic multi-question lines", async () => {
  const client = new FakeClient(); let eventId; let published; const root = await mkdtemp(join(tmpdir(), "question-e2e-")); const stateRoot = join(root, "state"); await mkdir(join(root, "interactions"));
  const driver = createThreadDriver({ client, stateRoot, publish: async (input, { idempotencyKey }) => {
    published = input; const directory = join(root, "interactions", idempotencyKey); await mkdir(directory);
    const event = { schema: "hermes-codex-interaction-event/v3", event_id: idempotencyKey, kind: "QUESTION", created_at: "2026-07-18T12:00:00Z", expires_at: "2026-07-25T12:00:00Z", thread: { id: "T", turn_id: "pending", title: "Question", project_label: "Codex", cwd_label: "local" }, message: { summary: input.text, markdown_path: null, is_replyable: true }, allowed_actions: ["REPLY"], integrity: { producer: "test", content_sha256: createHash("sha256").update(input.text).digest("hex") } };
    await writeFile(join(directory, "event.json"), `${JSON.stringify(event)}\n`); eventId = idempotencyKey; return { idempotencyKey };
  } });
  client.emit("serverRequest", { id: 8, method: "item/tool/requestUserInput", params: { threadId: "T", questions: [
    { id: "scope", header: "Scope", question: "Where?", options: [{ label: "Current project" }] },
    { id: "note", header: "Note", question: "Details?", isOther: true, options: [{ label: "Custom" }] },
  ] } });
  while (!eventId) await new Promise((resolve) => setImmediate(resolve));
  assert.match(published.text, /Scope|Where\?|Current project|scope: answer|Note|Details\?/u);
  const reply = { schema: "hermes-codex-interaction-reply/v3", event_id: eventId, created_at: "2026-07-18T12:01:00Z", action: "REPLY", text: "scope: Current project\nnote: Explain carefully", telegram: { delivery_ref: "delivery", sender_fingerprint: "a".repeat(64) } };
  await writeFile(join(root, "interactions", eventId, "reply.json"), `${JSON.stringify(reply)}\n`);
  const dispatcher = createReplyDispatcher({ queueRoot: root, stateRoot, threadDriver: driver, now: () => new Date("2026-07-18T12:02:00Z") });
  assert.equal((await dispatcher.scanOnce()).applied, 1);
  await driver.idle(); assert.deepEqual(client.responses, [{ id: 8, result: { answers: { scope: { answers: ["Current project"] }, note: { answers: ["Explain carefully"] } } } }]);
  assert.equal(client.requests.some(({ method }) => method === "turn/start"), false); await dispatcher.close(); await driver.close();
});

test("durable pending reply reconciles matching user turn after post-start crash", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "thread-actions-")); const text = "continue exactly once"; let starts = 0; let crashed = false; const turns = [];
  class CrashClient extends EventEmitter {
    async request(method, params) {
      if (method === "thread/resume") return { thread: { id: params.threadId, status: { type: "idle" }, turns: [...turns] } };
      starts += 1; turns.push({ id: "new-turn", items: [{ type: "userMessage", content: [{ type: "text", text: params.input[0].text }] }] });
      if (!crashed) { crashed = true; throw new Error("after side effect"); }
      return { turn: { id: "new-turn" } };
    }
    respond() {} respondError() {}
  }
  const eventId = "evt_219f74b5-c168-7381-9629-d395da0255f7";
  let driver = createThreadDriver({ client: new CrashClient(), publish: async () => ({}), stateRoot });
  await assert.rejects(driver.reply({ threadId: "T", text, eventId, idempotencyKey: eventId })); await driver.close();
  driver = createThreadDriver({ client: new CrashClient(), publish: async () => ({}), stateRoot });
  assert.deepEqual(await driver.reply({ threadId: "T", text, eventId, idempotencyKey: eventId }), { idempotencyKey: eventId });
  assert.equal(starts, 1); assert.doesNotMatch(await readFile(join(stateRoot, "thread-actions", `${eventId}.pending.json`), "utf8"), new RegExp(text, "u")); await driver.close();
});
