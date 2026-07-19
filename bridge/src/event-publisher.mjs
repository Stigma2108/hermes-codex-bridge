import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { writeJsonOnce } from "./atomic-store.mjs";
import { validateEvent } from "./contracts.mjs";
import { toTelegramSafeText } from "./redaction.mjs";

const EVENT_ID_PATTERN = /^evt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const THREAD_FIELDS = ["id", "turn_id", "title", "project_label", "cwd_label"];

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashUtf8(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function summarize(value) {
  if ([...value].length <= 3500) return value;
  const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  let result = "";
  let codePoints = 0;
  for (const { segment } of segmenter.segment(value)) {
    const segmentCodePoints = [...segment].length;
    if (codePoints + segmentCodePoints > 3500) break;
    result += segment;
    codePoints += segmentCodePoints;
  }
  return result;
}

function writeConflict() {
  return stableError("WRITE_ONCE_CONFLICT");
}

export async function writeTextOnce(path, contents, { remove = rm } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${randomUUID()}.partial`;
  let handle;
  let ownsPartial = false;
  try {
    handle = await open(partial, "wx");
    ownsPartial = true;
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(partial, path);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readFile(path);
      if (!existing.equals(Buffer.from(contents, "utf8"))) throw writeConflict();
      let cleanupError = null;
      try { await remove(partial, { force: true }); } catch (cleanup) { cleanupError = cleanup; }
      return { path, published: false, existing: true, cleanupError };
    }
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* Preserve the primary failure. */ }
    }
    if (ownsPartial) {
      try { await remove(partial, { force: true }); } catch { /* Preserve the primary failure. */ }
    }
    throw error;
  }
  let cleanupError = null;
  try { await remove(partial, { force: true }); } catch (error) { cleanupError = error; }
  return { path, published: true, existing: false, cleanupError };
}

function validateRoot(value) {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0") || !isAbsolute(value)) {
    throw stableError("PUBLISH_ROOT");
  }
  return resolve(value);
}

function getSafeText(input) {
  const hasText = Object.hasOwn(input, "text") && input.text !== undefined;
  const hasFullText = Object.hasOwn(input, "fullText") && input.fullText !== undefined;
  if (hasText === hasFullText) throw stableError("PUBLISH_TEXT");
  const value = hasFullText ? input.fullText : input.text;
  if (typeof value !== "string") throw stableError("PUBLISH_TEXT");
  try {
    return toTelegramSafeText(value);
  } catch {
    throw stableError("PUBLISH_TEXT");
  }
}

function getSafeThread(value) {
  if (!isRecord(value) || !THREAD_FIELDS.every((field) => Object.hasOwn(value, field))) throw stableError("PUBLISH_THREAD");
  if (!THREAD_FIELDS.every((field) => typeof value[field] === "string")) throw stableError("PUBLISH_THREAD");

  let id;
  let turnId;
  let title;
  let projectLabel;
  let cwdLabel;
  try {
    id = toTelegramSafeText(value.id);
    turnId = toTelegramSafeText(value.turn_id);
    title = toTelegramSafeText(value.title);
    projectLabel = toTelegramSafeText(value.project_label);
    cwdLabel = toTelegramSafeText(value.cwd_label);
  } catch {
    throw stableError("PUBLISH_THREAD");
  }
  if (id !== value.id || turnId !== value.turn_id) throw stableError("PUBLISH_THREAD");
  return {
    id,
    turn_id: turnId,
    title,
    project_label: projectLabel,
    cwd_label: cwdLabel,
  };
}

function createEvent(input, safeText) {
  const longMessage = [...safeText].length > 3500;
  const messageBytes = longMessage ? `${safeText}\n` : safeText;
  const producer = input.producer ?? "codex-windows-local";
  let safeProducer;
  try { safeProducer = toTelegramSafeText(producer); } catch { throw stableError("PUBLISH_PRODUCER"); }
  if (typeof producer !== "string" || producer.length === 0 || safeProducer !== producer) {
    throw stableError("PUBLISH_PRODUCER");
  }

  const event = {
    schema: "hermes-codex-interaction-event/v3",
    event_id: input.event_id,
    kind: input.kind,
    created_at: input.created_at,
    expires_at: input.expires_at,
    thread: getSafeThread(input.thread),
    message: {
      summary: summarize(safeText),
      markdown_path: longMessage ? "message.md" : null,
      is_replyable: input.is_replyable,
      ...(input.replyMode === undefined ? {} : { reply_mode: input.replyMode }),
    },
    allowed_actions: Array.isArray(input.allowed_actions) ? [...input.allowed_actions] : input.allowed_actions,
    integrity: { producer, content_sha256: hashUtf8(messageBytes) },
  };

  try {
    validateEvent(event);
  } catch {
    throw stableError("PUBLISH_EVENT");
  }
  return { event, longMessage, messageBytes };
}

function mapWriteError(error) {
  if (error?.code === "EEXIST" || error?.code === "WRITE_ONCE_CONFLICT") return stableError("PUBLISH_CONFLICT");
  return stableError("PUBLISH_WRITE");
}

function isContained(root, candidate) {
  const result = relative(root.toLowerCase(), candidate.toLowerCase());
  return result === "" || (!result.startsWith("..\\") && !result.startsWith("../") && result !== ".." && !isAbsolute(result));
}

async function inspectPublicationPath(queueRoot, interactionPath, { create }) {
  // This rejects observable reparse points and physical escapes immediately before
  // each commit. Node cannot make the multi-component check race-free; ACLs and a
  // trusted queue owner remain part of the deployment boundary.
  try {
    const rootStat = await lstat(queueRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw stableError("PUBLISH_PATH");
    const physicalRoot = await realpath(queueRoot);
    for (const path of [join(queueRoot, "interactions"), interactionPath]) {
      if (create) {
        try { await mkdir(path); } catch (error) { if (error?.code !== "EEXIST") throw error; }
      }
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw stableError("PUBLISH_PATH");
      if (!isContained(physicalRoot, await realpath(path))) throw stableError("PUBLISH_PATH");
    }
  } catch (error) {
    if (error?.code === "PUBLISH_PATH") throw error;
    throw stableError("PUBLISH_PATH");
  }
}

async function inspectLeaf(path, queueRoot, expected, { allowMultipleLinks = false } = {}) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (!allowMultipleLinks && stat.nlink !== 1)) throw stableError("PUBLISH_PATH");
    const physicalRoot = await realpath(queueRoot);
    if (!isContained(physicalRoot, await realpath(path))) throw stableError("PUBLISH_PATH");
    return { exists: true, exact: (await readFile(path)).equals(Buffer.from(expected, "utf8")) };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, exact: false };
    if (error?.code === "PUBLISH_PATH") throw error;
    throw stableError("PUBLISH_WRITE");
  }
}

async function commitWithVerification(writer, path, value, expectedBytes, queueRoot, cleanupErrors) {
  const before = await inspectLeaf(path, queueRoot, expectedBytes);
  if (before.exists && !before.exact) throw stableError("PUBLISH_CONFLICT");
  let result;
  try {
    result = await writer(path, value);
  } catch (error) {
    if (error?.code !== "EEXIST" && error?.code !== "WRITE_ONCE_CONFLICT") throw mapWriteError(error);
    const afterConflict = await inspectLeaf(path, queueRoot, expectedBytes);
    if (afterConflict.exact) return;
    throw stableError("PUBLISH_CONFLICT");
  }
  if (!isRecord(result)) throw stableError("PUBLISH_WRITE");
  if (result.cleanupError != null) cleanupErrors.push(result.cleanupError);
  const after = await inspectLeaf(path, queueRoot, expectedBytes, { allowMultipleLinks: result.published === true });
  if (after.exact && (result.published === true || result.existing === true || result.published === false)) return;
  if (result.published === true || !after.exists) throw stableError("PUBLISH_WRITE");
  throw stableError("PUBLISH_CONFLICT");
}

export async function publishEvent(input, options = {}) {
  if (!isRecord(input)) throw stableError("PUBLISH_INPUT");
  if (!isRecord(options)) throw stableError("PUBLISH_OPTIONS");
  const writeText = options.writeText ?? writeTextOnce;
  const writeJson = options.writeJson ?? writeJsonOnce;
  if (typeof writeText !== "function" || typeof writeJson !== "function") throw stableError("PUBLISH_OPTIONS");

  const queueRoot = validateRoot(input.queueRoot);
  if (typeof input.event_id !== "string" || !EVENT_ID_PATTERN.test(input.event_id)) throw stableError("PUBLISH_EVENT_ID");
  const safeText = getSafeText(input);
  const { event, longMessage, messageBytes } = createEvent(input, safeText);

  const interactionPath = join(queueRoot, "interactions", input.event_id);
  if (resolve(interactionPath) !== interactionPath) throw stableError("PUBLISH_PATH");
  const messagePath = longMessage ? join(interactionPath, "message.md") : null;
  const eventPath = join(interactionPath, "event.json");
  const eventBytes = `${JSON.stringify(event, null, 2)}\n`;
  const cleanupErrors = [];

  await inspectPublicationPath(queueRoot, interactionPath, { create: true });
  const existingEvent = await inspectLeaf(eventPath, queueRoot, eventBytes);
  if (existingEvent.exists) {
    if (!existingEvent.exact) throw stableError("PUBLISH_CONFLICT");
    if (messagePath !== null) {
      const existingMessage = await inspectLeaf(messagePath, queueRoot, messageBytes);
      if (!existingMessage.exists || !existingMessage.exact) throw stableError("PUBLISH_CONFLICT");
    }
    return { event, interactionPath, eventPath, messagePath, cleanupErrors };
  }
  if (messagePath !== null) {
    await inspectPublicationPath(queueRoot, interactionPath, { create: false });
    await commitWithVerification(writeText, messagePath, messageBytes, messageBytes, queueRoot, cleanupErrors);
  }
  await inspectPublicationPath(queueRoot, interactionPath, { create: false });
  await commitWithVerification(writeJson, eventPath, event, eventBytes, queueRoot, cleanupErrors);

  return { event, interactionPath, eventPath, messagePath, cleanupErrors };
}
