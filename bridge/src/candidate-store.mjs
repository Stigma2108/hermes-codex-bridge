import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const EVENT_ID = /^evt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const STATES = new Set([
  "PENDING_PRESENCE", "READY", "PUBLISHED", "CANCELLED_AUTO_CONTINUATION",
  "CANCELLED_LOCAL_REPLY", "STALE_LOCAL_REPLY", "APPLIED", "EXPIRED", "FAILED",
]);
const TRANSITIONS = Object.freeze({
  PENDING_PRESENCE: new Set(["CANCELLED_AUTO_CONTINUATION", "CANCELLED_LOCAL_REPLY", "READY"]),
  READY: new Set(["CANCELLED_AUTO_CONTINUATION", "CANCELLED_LOCAL_REPLY", "PUBLISHED"]),
  PUBLISHED: new Set(["STALE_LOCAL_REPLY", "APPLIED", "EXPIRED", "FAILED"]),
  CANCELLED_AUTO_CONTINUATION: new Set(),
  CANCELLED_LOCAL_REPLY: new Set(),
  STALE_LOCAL_REPLY: new Set(),
  APPLIED: new Set(),
  EXPIRED: new Set(),
  FAILED: new Set(),
});
const RECORD_KEYS = new Set([
  "schema", "eventId", "threadId", "turnId", "contentHash", "kind", "state", "message",
  "observedAtMs", "localDeadlineMs", "stabilizeUntilMs", "reason",
]);
const MAX_RECORD_BYTES = 3 * 1024 * 1024;

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validEventId(value) {
  if (typeof value !== "string" || !EVENT_ID.test(value)) throw failure("CANDIDATE_EVENT_ID");
  return value;
}

function validString(value, code, limit = 512) {
  if (typeof value !== "string" || value.length === 0 || value.length > limit || value.includes("\0")) throw failure(code);
  return value;
}

function validTime(value, fallback) {
  const effective = value ?? fallback;
  if (!Number.isSafeInteger(effective) || effective < 0) throw failure("CANDIDATE_TIME");
  return effective;
}

function serializedMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) throw failure("CANDIDATE_MESSAGE");
  let serialized;
  try { serialized = JSON.stringify(message); } catch { throw failure("CANDIDATE_MESSAGE"); }
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > 2 * 1024 * 1024) throw failure("CANDIDATE_MESSAGE");
  return serialized;
}

function normalizeCandidate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.schema !== 1) throw failure("CANDIDATE_SCHEMA");
  const eventId = validEventId(input.eventId);
  const threadId = validString(input.threadId, "CANDIDATE_THREAD");
  const turnId = validString(input.turnId, "CANDIDATE_TURN");
  if (!STATES.has(input.state)) throw failure("CANDIDATE_STATE");
  const kind = validString(input.kind ?? "FINAL_RESPONSE", "CANDIDATE_KIND", 64);
  const messageJson = serializedMessage(input.message);
  const contentHash = createHash("sha256").update(messageJson, "utf8").digest("hex");
  if (input.contentHash !== undefined && input.contentHash !== contentHash) throw failure("CANDIDATE_HASH");
  const observedAtMs = validTime(input.observedAtMs, 0);
  const localDeadlineMs = validTime(input.localDeadlineMs, Number.MAX_SAFE_INTEGER);
  const stabilizeUntilMs = validTime(input.stabilizeUntilMs, 0);
  if (input.reason !== undefined) validString(input.reason, "CANDIDATE_REASON", 80);
  return {
    schema: 1,
    eventId,
    threadId,
    turnId,
    contentHash,
    kind,
    state: input.state,
    message: JSON.parse(messageJson),
    observedAtMs,
    localDeadlineMs,
    stabilizeUntilMs,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
}

function validateStoredRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !RECORD_KEYS.has(key))) {
    throw failure("CANDIDATE_CORRUPT");
  }
  let normalized;
  try { normalized = normalizeCandidate(value); } catch { throw failure("CANDIDATE_CORRUPT"); }
  if (value.contentHash !== normalized.contentHash || JSON.stringify(value) !== JSON.stringify(normalized)) throw failure("CANDIDATE_CORRUPT");
  return normalized;
}

async function readRecord(root, eventId, { missing = false } = {}) {
  validEventId(eventId);
  const path = join(root, `${eventId}.json`);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw failure("CANDIDATE_CORRUPT");
    if (info.size > MAX_RECORD_BYTES) throw failure("CANDIDATE_CORRUPT");
    return validateStoredRecord(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT" && missing) return null;
    if (error?.code?.startsWith?.("CANDIDATE_")) throw error;
    throw failure("CANDIDATE_CORRUPT");
  }
}

async function replaceRecord(root, record) {
  const path = join(root, `${record.eventId}.json`);
  const partial = `${path}.${randomUUID()}.partial`;
  let handle;
  try {
    handle = await open(partial, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(partial, path);
  } catch (error) {
    try { await handle?.close(); } catch {}
    try { await rm(partial, { force: true }); } catch {}
    throw error?.code?.startsWith?.("CANDIDATE_") ? error : failure("CANDIDATE_WRITE");
  }
  return record;
}

export async function openCandidateStore(root) {
  if (typeof root !== "string" || !isAbsolute(root) || root.includes("\0")) throw failure("CANDIDATE_ROOT");
  await mkdir(root, { recursive: true });
  let closed = false;
  let tail = Promise.resolve();

  function enqueue(operation) {
    if (closed) return Promise.reject(failure("CANDIDATE_CLOSED"));
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  }

  return {
    put(input) {
      return enqueue(async () => {
        const candidate = normalizeCandidate(input);
        const existing = await readRecord(root, candidate.eventId, { missing: true });
        if (existing) {
          const sameIdentity = existing.eventId === candidate.eventId && existing.threadId === candidate.threadId &&
            existing.turnId === candidate.turnId && existing.contentHash === candidate.contentHash;
          if (!sameIdentity) throw failure("CANDIDATE_CONFLICT");
          return existing;
        }
        return replaceRecord(root, candidate);
      });
    },

    get(eventId) {
      return enqueue(() => readRecord(root, eventId, { missing: true }));
    },

    list(states) {
      return enqueue(async () => {
        let selected = null;
        if (states !== undefined) {
          if (!Array.isArray(states) || states.some((state) => !STATES.has(state))) throw failure("CANDIDATE_STATE");
          selected = new Set(states);
        }
        const entries = await readdir(root, { withFileTypes: true });
        const records = [];
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
          if (!entry.name.endsWith(".json") || !entry.name.startsWith("evt_")) continue;
          if (!entry.isFile()) throw failure("CANDIDATE_CORRUPT");
          const eventId = entry.name.slice(0, -5);
          const record = await readRecord(root, eventId);
          if (!selected || selected.has(record.state)) records.push(record);
        }
        return records;
      });
    },

    transition(eventId, nextState, patch = {}) {
      return enqueue(async () => {
        validEventId(eventId);
        if (!STATES.has(nextState)) throw failure("CANDIDATE_STATE");
        if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some((key) => key !== "reason")) throw failure("CANDIDATE_PATCH");
        const current = await readRecord(root, eventId);
        if (!TRANSITIONS[current.state].has(nextState)) throw failure("CANDIDATE_TRANSITION");
        return replaceRecord(root, normalizeCandidate({ ...current, ...patch, state: nextState }));
      });
    },

    async close() {
      if (closed) return;
      closed = true;
      await tail;
    },
  };
}
