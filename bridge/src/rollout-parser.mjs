import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { TextDecoder } from "node:util";

import { canonicalFinalIdentity, createDeterministicEventId } from "./final-identity.mjs";

export const MAX_ROLLOUT_RECORD_BYTES = 2 * 1024 * 1024;
export const MAX_FINAL_MESSAGE_BYTES = 2 * 1024 * 1024;

const MARKERS = Object.freeze({
  "<!-- HC3:WAITING_FOR_INPUT -->": Object.freeze({ kind: "QUESTION", replyMode: "NEXT_TURN" }),
  "<!-- HC3:PHASE_CONFIRMATION -->": Object.freeze({ kind: "QUESTION", replyMode: "NEXT_TURN" }),
  "<!-- HC3:TASK_COMPLETED -->": Object.freeze({ kind: "TASK_COMPLETED", replyMode: null }),
});

function rolloutError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function explicitString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function exactRecordHash(recordText) {
  return createHash("sha256").update(recordText, "utf8").digest("hex");
}

function isFinalPhase(phase) {
  return phase === "final_answer" || phase === "final";
}

function classifyFinal(text) {
  for (const [marker, classification] of Object.entries(MARKERS)) {
    if (text.includes(marker)) {
      return { ...classification, text: text.replaceAll(marker, "").trim() };
    }
  }
  return { kind: "FINAL_RESPONSE", replyMode: null, text };
}

export function createPublicationEventId(dedupeKey) {
  return createDeterministicEventId(dedupeKey);
}

function normalizedFinal({ record, recordText, threadId, cwd, turnId, itemId, text }) {
  if (text.length === 0) {
    return [];
  }
  if (Buffer.byteLength(text, "utf8") > MAX_FINAL_MESSAGE_BYTES) {
    throw rolloutError("ROLLOUT_MESSAGE_TOO_LARGE");
  }
  const classified = classifyFinal(text);
  if (classified.text.length === 0) return [];
  const canonicalIdentity = canonicalFinalIdentity({ threadId, turnId, itemId });
  const dedupeKey = canonicalIdentity ?? (itemId ? `item:${itemId}` : `${threadId ?? ""}:${exactRecordHash(recordText)}`);
  return [{
    channel: "final",
    kind: classified.kind,
    replyMode: classified.replyMode,
    text: classified.text,
    threadId,
    cwd,
    turnId,
    itemId,
    timestamp: explicitString(record.timestamp),
    dedupeKey,
    canonicalIdentity,
    eventId: createPublicationEventId(dedupeKey),
  }];
}

function control(kind, context, record, suffix = "") {
  const turnId = explicitString(record?.payload?.turn_id) ?? explicitString(record?.turn_id) ?? context.turnId;
  const dedupeKey = `control:${context.threadId ?? "unknown"}:${turnId ?? "unknown"}:${kind}:${suffix}`;
  return [{
    channel: "control",
    kind,
    threadId: context.threadId,
    cwd: context.cwd,
    turnId,
    timestamp: explicitString(record?.timestamp),
    dedupeKey,
    eventId: createPublicationEventId(dedupeKey),
  }];
}

function userTextParts(record) {
  if (record?.type !== "response_item" || !record.payload || typeof record.payload !== "object" || Array.isArray(record.payload) ||
      record.payload.type !== "message" || record.payload.role !== "user" || !Array.isArray(record.payload.content)) {
    return null;
  }
  return record.payload.content
    .filter((part) => part && typeof part === "object" && !Array.isArray(part) && part.type === "input_text" && typeof part.text === "string")
    .map((part) => part.text);
}

function parseResponseItem(record, recordText, context) {
  if (record.type !== "response_item") {
    return [];
  }
  const payload = record.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  if (payload.type !== "message" || payload.role !== "assistant" || !isFinalPhase(payload.phase)) {
    return [];
  }
  if (!Array.isArray(payload.content)) {
    return [];
  }
  const outputParts = [];
  for (const part of payload.content) {
    if (part && typeof part === "object" && part.type === "output_text" && typeof part.text === "string") {
      outputParts.push(part.text);
    }
  }
  if (outputParts.length === 0 || outputParts.every((part) => part.length === 0)) {
    return [];
  }
  return normalizedFinal({
    record,
    recordText,
    threadId: context.threadId,
    cwd: context.cwd,
    turnId: explicitString(record.turn_id) ?? explicitString(payload.turn_id) ?? context.turnId,
    itemId: explicitString(payload.id) ?? explicitString(record.item_id),
    text: outputParts.join("\n"),
  });
}

function parseV2TurnItem(record, recordText, context) {
  if (record.type !== "turn_item" || !record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) {
    return [];
  }
  const payload = record.payload;
  const item = payload.item && typeof payload.item === "object" && !Array.isArray(payload.item)
    ? payload.item
    : payload;
  if (item.type !== "agentMessage" || !isFinalPhase(item.phase) || typeof item.text !== "string") {
    return [];
  }
  return normalizedFinal({
    record,
    recordText,
    threadId: context.threadId,
    cwd: context.cwd,
    turnId: explicitString(record.turn_id) ?? explicitString(payload.turn_id) ?? explicitString(item.turn_id) ?? context.turnId,
    itemId: explicitString(item.id) ?? explicitString(payload.item_id) ?? explicitString(record.item_id),
    text: item.text,
  });
}

export function createRolloutRecordParser({ isSuppressedThread = () => false } = {}) {
  if (typeof isSuppressedThread !== "function") throw rolloutError("ROLLOUT_INPUT");
  const context = { threadId: null, cwd: null, turnId: null, isSubagent: false, isSuppressed: false };

  return {
    parse(recordInput) {
      if (typeof recordInput !== "string" && !Buffer.isBuffer(recordInput) && !(recordInput instanceof Uint8Array)) {
        throw rolloutError("ROLLOUT_INPUT");
      }
      if (recordInput.byteLength > MAX_ROLLOUT_RECORD_BYTES ||
          (typeof recordInput === "string" && Buffer.byteLength(recordInput, "utf8") > MAX_ROLLOUT_RECORD_BYTES)) {
        throw rolloutError("ROLLOUT_RECORD_TOO_LARGE");
      }
      let recordText;
      if (typeof recordInput === "string") {
        recordText = recordInput;
      } else {
        try {
          recordText = new TextDecoder("utf-8", { fatal: true }).decode(recordInput);
        } catch {
          throw rolloutError("ROLLOUT_UTF8");
        }
      }
      if (recordText.endsWith("\r")) {
        recordText = recordText.slice(0, -1);
      }
      if (recordText.length === 0) {
        return [];
      }

      let record;
      try {
        record = JSON.parse(recordText);
      } catch {
        return [];
      }
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        return [];
      }

      if (record.type === "session_meta" && record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)) {
        context.threadId = explicitString(record.payload.id) ?? explicitString(record.payload.thread_id);
        context.cwd = explicitString(record.payload.cwd);
        context.turnId = null;
        const source = record.payload.source;
        context.isSubagent = context.isSubagent || explicitString(record.payload.parent_thread_id) !== null ||
          explicitString(record.payload.agent_role) !== null ||
          (source && typeof source === "object" && !Array.isArray(source) && Object.hasOwn(source, "subagent"));
        context.isSuppressed = context.threadId !== null && isSuppressedThread(context.threadId) === true;
        return [];
      }
      if (record.type === "turn_context" && record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)) {
        context.turnId = explicitString(record.payload.turn_id) ?? explicitString(record.turn_id);
        return [];
      }

      if (context.isSubagent || context.isSuppressed ||
          (context.threadId !== null && isSuppressedThread(context.threadId) === true)) return [];

      if (record.type === "event_msg" && record.payload && typeof record.payload === "object" && !Array.isArray(record.payload) &&
          record.payload.type === "task_started") {
        context.turnId = explicitString(record.payload.turn_id) ?? explicitString(record.turn_id) ?? context.turnId;
        return control("TURN_STARTED", context, record);
      }

      const inputParts = userTextParts(record);
      if (inputParts !== null) {
        const isGoalContinuation = inputParts.some((text) => text.includes('<codex_internal_context source="goal">'));
        return control(isGoalContinuation ? "AUTO_GOAL_CONTINUATION" : "USER_INPUT", context, record);
      }

      const response = parseResponseItem(record, recordText, context);
      return response.length > 0 ? response : parseV2TurnItem(record, recordText, context);
    },
  };
}

function appendUnique(messages, seen, parsed) {
  for (const message of parsed) {
    if (!seen.has(message.dedupeKey)) {
      seen.add(message.dedupeKey);
      messages.push(message);
    }
  }
}

async function parseCompleteRecordIterable(records) {
  if (!records || (!(Symbol.iterator in Object(records)) && !(Symbol.asyncIterator in Object(records)))) {
    throw rolloutError("ROLLOUT_INPUT");
  }
  const parser = createRolloutRecordParser();
  const messages = [];
  const seen = new Set();
  for await (const record of records) {
    appendUnique(messages, seen, parser.parse(record));
  }
  return messages;
}

async function parseChunkStream(readable) {
  const parser = createRolloutRecordParser();
  const messages = [];
  const seen = new Set();
  let pending = Buffer.alloc(0);
  for await (const chunk of readable) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    pending = pending.length === 0 ? bytes : Buffer.concat([pending, bytes]);
    let newline;
    while ((newline = pending.indexOf(0x0a)) !== -1) {
      const record = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      appendUnique(messages, seen, parser.parse(record));
    }
    if (pending.length > MAX_ROLLOUT_RECORD_BYTES) {
      throw rolloutError("ROLLOUT_RECORD_TOO_LARGE");
    }
  }
  if (pending.length > 0) {
    appendUnique(messages, seen, parser.parse(pending));
  }
  return messages;
}

export async function parseRollout(input) {
  if (typeof input === "string") {
    return parseChunkStream(createReadStream(input));
  }
  if (input && typeof input === "object" && "records" in input) {
    return parseCompleteRecordIterable(input.records);
  }
  if (input && typeof input[Symbol.asyncIterator] === "function") {
    return parseChunkStream(input);
  }
  throw rolloutError("ROLLOUT_INPUT");
}
