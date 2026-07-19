import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { writeJsonOnce } from "./atomic-store.mjs";
import { canonicalFinalIdentity, createDeterministicEventId } from "./final-identity.mjs";
import { toTelegramSafeText } from "./redaction.mjs";

function error(code, retryable = false) { const value = new Error(code); value.code = code; value.retryable = retryable; return value; }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function bounded(value, max = 256 * 1024) { return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= max; }
function eventId(...parts) {
  return createDeterministicEventId(parts.join("\0"));
}
function statusType(status) { return typeof status === "string" ? status : status?.type; }
function sha256(text) { return createHash("sha256").update(text, "utf8").digest("hex"); }
function clientUserMessageId(actionEventId) {
  const match = /^evt_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu.exec(actionEventId ?? "");
  return match?.[1];
}
function turnIds(thread) { return Array.isArray(thread?.turns) ? thread.turns.map((turn) => turn?.id).filter((id) => typeof id === "string") : []; }
function userText(turn) {
  for (const item of Array.isArray(turn?.items) ? turn.items : []) {
    if (item?.type !== "userMessage") continue;
    if (typeof item.text === "string") return item.text;
    if (Array.isArray(item.content)) return item.content.filter((part) => ["text", "input_text"].includes(part?.type) && typeof part.text === "string").map((part) => part.text).join("\n");
  }
  return null;
}

export function createThreadDriver({ client, publish, policy = () => "LOCAL_ONLY", awaitInteraction, now = () => new Date(), stateRoot = null, writeState = writeJsonOnce }) {
  if (!client?.on || typeof client.request !== "function" || typeof publish !== "function") throw error("THREAD_DRIVER_CONFIG");
  const queues = new Map(); const finals = new Map(); const ownedTurns = new Set(); const startingThreads = new Set(); const completedDuringStart = new Set(); const tasks = new Set(); const pendingInteractions = new Map(); const resolvedInteractions = new Set(); let closed = false;

  function turnKey(threadId, turnId) { return `${threadId}\0${turnId}`; }

  function track(promise) { tasks.add(promise); promise.finally(() => tasks.delete(promise)).catch(() => {}); return promise; }
  function enqueue(threadId, operation) {
    const previous = queues.get(threadId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    queues.set(threadId, current); current.finally(() => { if (queues.get(threadId) === current) queues.delete(threadId); }).catch(() => {});
    return current;
  }

  async function stateRecord(path, expected) {
    try { await writeState(path, expected); return expected; }
    catch (cause) {
      if (cause?.code !== "WRITE_ONCE_CONFLICT") throw cause;
      let existing; try { existing = JSON.parse(await readFile(path, "utf8")); } catch { throw error("THREAD_ACTION_STATE"); }
      if (JSON.stringify(existing) !== JSON.stringify(expected)) throw error("THREAD_ACTION_CONFLICT");
      return existing;
    }
  }

  async function readState(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch (cause) { if (cause?.code === "ENOENT") return null; throw error("THREAD_ACTION_STATE"); } }

  async function reply({ threadId, text, eventId: actionEventId, idempotencyKey }) {
    if (closed) throw error("THREAD_DRIVER_CLOSED");
    if (!bounded(threadId, 500) || !bounded(text)) throw error("THREAD_REPLY_INVALID");
    return enqueue(threadId, async () => {
      const resumed = await client.request("thread/resume", { threadId });
      const thread = resumed?.thread ?? resumed; const status = statusType(thread?.status);
      const durable = typeof stateRoot === "string" && bounded(actionEventId, 100) && actionEventId === idempotencyKey;
      let pendingPath; let startedPath; let pending;
      if (durable) {
        const directory = join(resolve(stateRoot), "thread-actions"); pendingPath = join(directory, `${actionEventId}.pending.json`); startedPath = join(directory, `${actionEventId}.started.json`);
        const started = await readState(startedPath); if (started?.event_id === actionEventId && started?.thread_id === threadId) { if (bounded(started.turn_id, 500)) ownedTurns.add(turnKey(threadId, started.turn_id)); return { idempotencyKey }; }
        pending = await readState(pendingPath);
        if (pending && (pending.event_id !== actionEventId || pending.thread_id !== threadId || pending.text_sha256 !== sha256(text) || !Array.isArray(pending.baseline_turn_ids))) throw error("THREAD_ACTION_CONFLICT");
        if (pending) {
          const baseline = new Set(pending.baseline_turn_ids);
          const matched = (Array.isArray(thread?.turns) ? thread.turns : []).find((turn) => !baseline.has(turn?.id) && userText(turn) !== null && sha256(userText(turn)) === pending.text_sha256);
          if (matched) { await stateRecord(startedPath, { schema: "hermes-codex-thread-action-started/v3", event_id: actionEventId, thread_id: threadId, turn_id: matched.id }); ownedTurns.add(turnKey(threadId, matched.id)); return { idempotencyKey }; }
        }
      }
      if (!["idle", "notLoaded"].includes(status)) {
        if (["active", "running", "busy"].includes(status)) throw error("THREAD_BUSY", true);
        throw error("THREAD_STATE");
      }
      if (durable && !pending) {
        pending = { schema: "hermes-codex-thread-action-pending/v3", event_id: actionEventId, thread_id: threadId, text_sha256: sha256(text), baseline_turn_ids: turnIds(thread) };
        await stateRecord(pendingPath, pending);
      }
      let started;
      const messageId = durable ? clientUserMessageId(actionEventId) : undefined;
      const turnStart = { threadId, input: [{ type: "text", text, text_elements: [] }] };
      if (messageId !== undefined) turnStart.clientUserMessageId = messageId;
      startingThreads.add(threadId);
      try { started = await client.request("turn/start", turnStart); }
      finally { startingThreads.delete(threadId); }
      if (bounded(started?.turn?.id, 500)) {
        const key = turnKey(threadId, started.turn.id);
        if (!completedDuringStart.delete(key)) ownedTurns.add(key);
      }
      if (!durable) return started;
      await stateRecord(startedPath, { schema: "hermes-codex-thread-action-started/v3", event_id: actionEventId, thread_id: threadId, turn_id: started?.turn?.id ?? "unknown" });
      return { idempotencyKey };
    });
  }

  async function publishWithAck(input, key) {
    const acknowledgment = await publish({ ...input, event_id: key }, { idempotencyKey: key });
    if (acknowledgment?.idempotencyKey !== key) throw error("THREAD_PUBLISH_ACK");
    return acknowledgment;
  }

  function waitForInteraction(context) {
    if (typeof awaitInteraction === "function") return awaitInteraction(context);
    return new Promise((resolve) => pendingInteractions.set(context.eventId, { context, resolve }));
  }

  async function resolveInteraction({ eventId: key, action, text, answers, idempotencyKey }) {
    if (key !== idempotencyKey || !bounded(key, 100)) throw error("THREAD_INTERACTION_ID");
    if (resolvedInteractions.has(key)) return { idempotencyKey: key };
    const pending = pendingInteractions.get(key); if (!pending) throw error("THREAD_INTERACTION_NOT_PENDING", true);
    let normalizedAnswers = record(answers) ? answers : undefined;
    if (pending.context.kind === "QUESTION" && normalizedAnswers === undefined && action === "REPLY" && typeof text === "string") {
      const questions = pending.context.questions;
      normalizedAnswers = parseQuestionText(questions, text);
    }
    pendingInteractions.delete(key); resolvedInteractions.add(key); pending.resolve({ action, text, answers: normalizedAnswers });
    return { idempotencyKey: key };
  }

  function onNotification(message) {
    if (!record(message) || typeof message.method !== "string") return;
    const params = message.params ?? {};
    if (message.method === "item/completed") {
      const item = params.item;
      const key = turnKey(params.threadId, params.turnId);
      if ((ownedTurns.has(key) || startingThreads.has(params.threadId)) && item?.type === "agentMessage" && ["final", "final_answer"].includes(item.phase) && bounded(item.text)) finals.set(key, { text: item.text, itemId: typeof item.id === "string" ? item.id : null });
      return;
    }
    if (message.method !== "turn/completed" && message.method !== "turn/failed") return;
    const notificationThreadId = params.threadId ?? params.turn?.threadId ?? "unknown";
    const notificationTurnId = params.turn?.id ?? params.turnId ?? "unknown";
    const ownedKey = turnKey(notificationThreadId, notificationTurnId);
    if (!ownedTurns.has(ownedKey) && startingThreads.has(notificationThreadId)) { ownedTurns.add(ownedKey); completedDuringStart.add(ownedKey); }
    if (!ownedTurns.delete(ownedKey)) return;
    track((async () => {
      const turn = params.turn ?? {}; const threadId = params.threadId ?? turn.threadId ?? "unknown"; const turnId = turn.id ?? params.turnId ?? "unknown";
      const failed = message.method === "turn/failed" || statusType(turn.status) === "failed";
      const final = finals.get(`${threadId}\0${turnId}`); const text = failed ? "The Codex turn failed." : final?.text;
      if (!text) { finals.delete(turnKey(threadId, turnId)); return; }
      const kind = failed ? "ERROR" : "FINAL_RESPONSE"; const canonical = failed ? null : canonicalFinalIdentity({ threadId, turnId, itemId: final?.itemId }); const key = canonical ? createDeterministicEventId(canonical) : eventId("turn", threadId, turnId, kind, text);
      await publishWithAck({ kind, text, threadId, turnId, itemId: final?.itemId ?? null, dedupeKey: canonical, created_at: now().toISOString(), allowed_actions: failed ? [] : ["REPLY"] }, key);
      finals.delete(`${threadId}\0${turnId}`);
    })());
  }

  function allowedOption(question, answer) {
    if (!bounded(answer, 3500)) return false;
    const options = Array.isArray(question.options) ? question.options : [];
    const labels = options.map((option) => typeof option === "string" ? option : option?.label).filter((value) => typeof value === "string");
    return labels.includes(answer) || question.isOther === true;
  }

  function parseQuestionText(questions, text) {
    if (typeof text !== "string") return {};
    if (questions.length === 1 && allowedOption(questions[0], text.trim())) return { [questions[0].id]: [text.trim()] };
    const parsed = {};
    for (const line of text.split(/\r?\n/gu)) {
      const match = /^([^:]+):\s*(.+)$/u.exec(line); if (!match) return {};
      const id = match[1].trim(); const question = questions.find((candidate) => candidate.id === id); const answer = match[2].trim();
      if (!question || Object.hasOwn(parsed, id) || !allowedOption(question, answer)) return {};
      parsed[id] = [answer];
    }
    return Object.keys(parsed).length === questions.length ? parsed : {};
  }

  function questionText(questions) {
    const lines = ["Codex needs answers. Reply with one `id: answer` line per question."];
    for (const question of questions) {
      const header = typeof question.header === "string" ? toTelegramSafeText(question.header) : question.id;
      const prompt = typeof question.question === "string" ? toTelegramSafeText(question.question) : "Choose an answer.";
      lines.push(`\n${header}\n[${question.id}] ${prompt}`);
      const labels = (Array.isArray(question.options) ? question.options : []).map((option) => typeof option === "string" ? option : option?.label).filter((label) => typeof label === "string").map((label) => toTelegramSafeText(label));
      if (labels.length) lines.push(`Options: ${labels.join(" | ")}`);
      lines.push(`${question.id}: answer`);
    }
    return lines.join("\n");
  }

  async function handleQuestion(request) {
    const questions = request.params?.questions;
    if (!Array.isArray(questions) || questions.length === 0 || questions.some((question) => !record(question) || !bounded(question.id, 200))) return client.respondError(request.id, 4000, "Invalid question request");
    if (questions.some((question) => question.isSecret === true)) return client.respond(request.id, { answers: {} });
    const ids = new Set();
    for (const question of questions) {
      if (ids.has(question.id) || (Object.hasOwn(question, "isOther") && typeof question.isOther !== "boolean") || !Array.isArray(question.options) || question.options.length === 0 || question.options.some((option) => typeof option !== "string" && (!record(option) || !bounded(option.label, 3500)))) return client.respondError(request.id, 4000, "Invalid question request");
      ids.add(question.id);
    }
    const key = eventId("question", request.params?.threadId ?? "unknown", String(request.id));
    const context = { eventId: key, kind: "QUESTION", questions };
    const waiting = typeof awaitInteraction === "function" ? null : waitForInteraction(context);
    try { await publishWithAck({ kind: "QUESTION", text: questionText(questions), threadId: request.params?.threadId ?? "unknown", turnId: request.params?.turnId ?? "pending", questions, allowed_actions: ["REPLY"] }, key); }
    catch (cause) { pendingInteractions.delete(key); throw cause; }
    const reply = waiting ? await waiting : await waitForInteraction(context);
    const answers = {};
    if (reply?.action === "REPLY" && record(reply.answers)) {
      for (const question of questions) {
        const values = reply.answers[question.id];
        if (Array.isArray(values) && values.length > 0 && values.every((value) => typeof value === "string" && allowedOption(question, value))) answers[question.id] = { answers: [...values] };
      }
    }
    client.respond(request.id, { answers });
  }

  async function handleApproval(request) {
    const approval = { command: request.params?.command, cwd: request.params?.cwd, action: "APPROVE_ONCE", forSession: false, persistent: false };
    if (policy(approval) !== "REMOTE_ALLOWED") return client.respond(request.id, { decision: "decline" });
    const key = eventId("approval", request.params?.threadId ?? "unknown", String(request.id));
    const context = { eventId: key, kind: "APPROVAL_REQUEST" };
    const waiting = typeof awaitInteraction === "function" ? null : waitForInteraction(context);
    try { await publishWithAck({ kind: "APPROVAL_REQUEST", text: "Codex requests one-time approval for a local operation.", threadId: request.params?.threadId ?? "unknown", turnId: request.params?.turnId ?? "pending", allowed_actions: ["APPROVE_ONCE", "DECLINE"] }, key); }
    catch (cause) { pendingInteractions.delete(key); throw cause; }
    const reply = waiting ? await waiting : await waitForInteraction(context);
    client.respond(request.id, { decision: reply?.action === "APPROVE_ONCE" ? "accept" : "decline" });
  }

  function onServerRequest(request) {
    if (!record(request) || !Number.isInteger(request.id)) return;
    let operation;
    if (request.method === "item/tool/requestUserInput") operation = handleQuestion(request);
    else if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(request.method)) operation = handleApproval(request);
    else { client.respondError(request.id, -32601, "Unsupported server request"); return; }
    track(Promise.resolve(operation).catch(() => { try { client.respondError(request.id, 4002, "Request safely declined"); } catch {} }));
  }

  client.on("notification", onNotification); client.on("serverRequest", onServerRequest);
  return {
    async readThread(threadId) {
      if (closed) throw error("THREAD_DRIVER_CLOSED");
      if (!bounded(threadId, 500)) throw error("THREAD_READ_ID");
      return client.request("thread/read", { threadId, includeTurns: false });
    },
    reply,
    resolveInteraction,
    async idle() { while (tasks.size || queues.size) await Promise.allSettled([...tasks, ...queues.values()]); },
    async close() { if (closed) return; closed = true; client.off("notification", onNotification); client.off("serverRequest", onServerRequest); for (const [key, pending] of pendingInteractions) { pendingInteractions.delete(key); resolvedInteractions.add(key); pending.resolve({ action: "DECLINE" }); } await this.idle(); },
  };
}
