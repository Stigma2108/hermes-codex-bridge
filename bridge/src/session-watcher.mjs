import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, truncate } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { TextDecoder } from "node:util";

import { openLedger } from "./ledger.mjs";
import { MAX_ROLLOUT_RECORD_BYTES, createPublicationEventId, createRolloutRecordParser } from "./rollout-parser.mjs";

const STATE_SCHEMA = 1;
const READ_CHUNK_BYTES = 64 * 1024;
const CHECKPOINT_FINGERPRINT_BYTES = 64 * 1024;
const MAX_STATE_PAYLOAD_BYTES = 1024 * 1024;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const FILE_ID_PATTERN = /^\d+:\d+$/u;
const ROUTER_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ROUTER_REGISTRY_SCHEMA = "hermes-codex-ui-router-registry/v3";

function watcherError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function checkAbort(signal) {
  if (signal.aborted) throw watcherError("WATCHER_ABORTED");
}

function normalizeRelativePath(path) {
  return path.split(sep).join("/");
}

function validRelativePath(path) {
  return typeof path === "string" &&
    path.length > 0 &&
    !path.includes("\\") &&
    !isAbsolute(path) &&
    !path.startsWith("/") &&
    path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function hasExactlyKeys(record, expected) {
  const actual = Object.keys(record).sort();
  const sortedExpected = expected.slice().sort();
  return actual.length === sortedExpected.length &&
    sortedExpected.every((key, index) => actual[index] === key);
}

function validateStateRecord(record, checkpoints) {
  if (!record || typeof record !== "object" || Array.isArray(record) || record.schema !== STATE_SCHEMA) {
    throw watcherError("WATCHER_STATE_CORRUPT");
  }
  if (record.type === "checkpoint") {
    if (!hasExactlyKeys(record, ["schema", "type", "path", "byteOffset", "observedSize", "lastMtimeMs", "lastCtimeMs", "fileId", "prefixSha256"]) ||
        !validRelativePath(record.path) || !record.path.toLowerCase().endsWith(".jsonl") ||
        !Number.isSafeInteger(record.byteOffset) || record.byteOffset < 0 ||
        !Number.isSafeInteger(record.observedSize) || record.observedSize < record.byteOffset ||
        typeof record.lastMtimeMs !== "number" || !Number.isFinite(record.lastMtimeMs) || record.lastMtimeMs < 0 ||
        typeof record.lastCtimeMs !== "number" || !Number.isFinite(record.lastCtimeMs) || record.lastCtimeMs < 0 ||
        typeof record.fileId !== "string" || !FILE_ID_PATTERN.test(record.fileId) ||
        typeof record.prefixSha256 !== "string" || !HASH_PATTERN.test(record.prefixSha256)) {
      throw watcherError("WATCHER_STATE_CORRUPT");
    }
    checkpoints.set(record.path, {
      byteOffset: record.byteOffset,
      observedSize: record.observedSize,
      lastMtimeMs: record.lastMtimeMs,
      lastCtimeMs: record.lastCtimeMs,
      fileId: record.fileId,
      prefixSha256: record.prefixSha256,
    });
    return false;
  }
  if (record.type === "bootstrap" &&
      hasExactlyKeys(record, ["schema", "type", "bootstrapped"]) &&
      record.bootstrapped === true) {
    return true;
  }
  throw watcherError("WATCHER_STATE_CORRUPT");
}

function parseState(contents) {
  const checkpoints = new Map();
  let bootstrapped = false;
  let offset = 0;
  while (offset < contents.length) {
    const frameStart = offset;
    const lengthEnd = contents.indexOf(0x3a, offset);
    if (lengthEnd === -1) {
      const partialLength = contents.subarray(offset).toString("ascii");
      if (/^\d+$/u.test(partialLength)) {
        return { checkpoints, bootstrapped, validBytes: frameStart };
      }
      throw watcherError("WATCHER_STATE_CORRUPT");
    }
    const lengthText = contents.subarray(offset, lengthEnd).toString("ascii");
    if (!/^(?:0|[1-9]\d*)$/u.test(lengthText)) throw watcherError("WATCHER_STATE_CORRUPT");
    const payloadLength = Number(lengthText);
    if (!Number.isSafeInteger(payloadLength) || payloadLength > MAX_STATE_PAYLOAD_BYTES) {
      throw watcherError("WATCHER_STATE_CORRUPT");
    }
    const hashEnd = contents.indexOf(0x3a, lengthEnd + 1);
    if (hashEnd === -1) {
      const partialHash = contents.subarray(lengthEnd + 1).toString("ascii");
      if (/^[0-9a-f]{0,64}$/u.test(partialHash)) {
        return { checkpoints, bootstrapped, validBytes: frameStart };
      }
      throw watcherError("WATCHER_STATE_CORRUPT");
    }
    const expectedHash = contents.subarray(lengthEnd + 1, hashEnd).toString("ascii");
    if (!HASH_PATTERN.test(expectedHash)) throw watcherError("WATCHER_STATE_CORRUPT");
    const payloadStart = hashEnd + 1;
    const payloadEnd = payloadStart + payloadLength;
    if (payloadEnd > contents.length) {
      return { checkpoints, bootstrapped, validBytes: frameStart };
    }
    if (payloadEnd === contents.length) {
      return { checkpoints, bootstrapped, validBytes: frameStart };
    }
    if (contents[payloadEnd] !== 0x0a) {
      throw watcherError("WATCHER_STATE_CORRUPT");
    }
    const payload = contents.subarray(payloadStart, payloadEnd);
    const actualHash = createHash("sha256").update(payload).digest("hex");
    if (actualHash !== expectedHash) throw watcherError("WATCHER_STATE_CORRUPT");
    let record;
    try {
      const json = new TextDecoder("utf-8", { fatal: true }).decode(payload);
      record = JSON.parse(json);
    } catch {
      throw watcherError("WATCHER_STATE_CORRUPT");
    }
    bootstrapped = validateStateRecord(record, checkpoints) || bootstrapped;
    offset = payloadEnd + 1;
  }
  return { checkpoints, bootstrapped, validBytes: offset };
}

async function loadState(ledgerPath) {
  try {
    const contents = await readFile(ledgerPath);
    return { ...parseState(contents), totalBytes: contents.length };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { checkpoints: new Map(), bootstrapped: false, validBytes: 0, totalBytes: 0 };
    }
    if (error?.code === "WATCHER_STATE_CORRUPT") throw error;
    throw watcherError("WATCHER_STATE_CORRUPT");
  }
}

function frameStateRecord(record) {
  const payload = Buffer.from(JSON.stringify(record), "utf8");
  const hash = createHash("sha256").update(payload).digest("hex");
  return Buffer.concat([Buffer.from(`${payload.length}:${hash}:`, "ascii"), payload, Buffer.from("\n")]);
}

async function appendDurableState(path, record) {
  await mkdir(dirname(path), { recursive: true });
  const frame = frameStateRecord(record);
  let handle;
  try {
    handle = await open(path, "a");
    const { bytesWritten } = await handle.write(frame, 0, frame.length, null);
    if (bytesWritten !== frame.length) throw watcherError("WATCHER_STATE_WRITE");
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

function statFileId(stat) {
  return `${stat.dev}:${stat.ino}`;
}

function statMtimeMs(stat) {
  return Number(stat.mtimeNs) / 1_000_000;
}

function statCtimeMs(stat) {
  return Number(stat.ctimeNs) / 1_000_000;
}

function physicallyContained(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

async function verifiedRoot(sessionsRoot) {
  let before;
  let physicalRoot;
  let after;
  try {
    before = await lstat(sessionsRoot, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) throw watcherError("WATCHER_PATH");
    physicalRoot = await realpath(sessionsRoot);
    after = await lstat(sessionsRoot, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code === "WATCHER_PATH") throw error;
    throw watcherError("WATCHER_PATH");
  }
  if (after.isSymbolicLink() || !after.isDirectory() || statFileId(before) !== statFileId(after)) {
    throw watcherError("WATCHER_PATH");
  }
  return physicalRoot;
}

async function verifiedPathStat(path, kind, physicalRoot) {
  let pathStat;
  let physicalPath;
  try {
    pathStat = await lstat(path, { bigint: true });
    if (pathStat.isSymbolicLink() || (kind === "directory" ? !pathStat.isDirectory() : !pathStat.isFile())) {
      return null;
    }
    physicalPath = await realpath(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw watcherError("WATCHER_PATH");
  }
  if (!physicallyContained(physicalRoot, physicalPath)) return null;
  return { pathStat, physicalPath };
}

async function enumerateSessionFiles(sessionsRoot) {
  const physicalRoot = await verifiedRoot(sessionsRoot);
  if (physicalRoot === null) return { physicalRoot: null, files: [] };
  const files = [];

  async function visit(directory) {
    const before = await verifiedPathStat(directory, "directory", physicalRoot);
    if (!before) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      throw watcherError("WATCHER_PATH");
    }
    const after = await verifiedPathStat(directory, "directory", physicalRoot);
    if (!after || statFileId(before.pathStat) !== statFileId(after.pathStat) || before.physicalPath !== after.physicalPath) {
      throw watcherError("WATCHER_PATH");
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      const entryStat = await verifiedPathStat(fullPath, entry.isDirectory() ? "directory" : "file", physicalRoot);
      if (!entryStat) continue;
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
        const relativePath = normalizeRelativePath(relative(sessionsRoot, fullPath));
        if (!validRelativePath(relativePath)) throw watcherError("WATCHER_PATH");
        files.push({ fullPath, relativePath });
      }
    }
  }

  await visit(sessionsRoot);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return { physicalRoot, files };
}

async function openVerifiedFile(file, physicalRoot) {
  const before = await verifiedPathStat(file.fullPath, "file", physicalRoot);
  if (!before) return null;
  let handle;
  try {
    handle = await open(file.fullPath, "r");
    const handleStat = await handle.stat({ bigint: true });
    const after = await verifiedPathStat(file.fullPath, "file", physicalRoot);
    if (!after || !handleStat.isFile() ||
        statFileId(before.pathStat) !== statFileId(handleStat) ||
        statFileId(after.pathStat) !== statFileId(handleStat) ||
        before.physicalPath !== after.physicalPath) {
      await handle.close();
      return null;
    }
    const size = Number(handleStat.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      await handle.close();
      throw watcherError("WATCHER_PATH");
    }
    return {
      handle,
      fileId: statFileId(handleStat),
      lastMtimeMs: statMtimeMs(handleStat),
      lastCtimeMs: statCtimeMs(handleStat),
      size,
    };
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* Preserve the verified-open failure. */ }
    }
    if (error?.code === "ENOENT") return null;
    if (error?.code === "WATCHER_PATH") throw error;
    throw watcherError("WATCHER_PATH");
  }
}

async function readExact(handle, offset, length, observeBytes) {
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const { bytesRead } = await handle.read(buffer, total, length - total, offset + total);
    if (bytesRead === 0) throw watcherError("WATCHER_FILE_CHANGED");
    observeBytes(bytesRead);
    total += bytesRead;
  }
  return buffer;
}

async function buildCheckpointFingerprint(handle, byteOffset, signal, observeBytes) {
  const hash = createHash("sha256");
  checkAbort(signal);
  const length = Math.min(byteOffset, CHECKPOINT_FINGERPRINT_BYTES);
  if (length > 0) hash.update(await readExact(handle, 0, length, observeBytes));
  return hash;
}

async function walkCompleteRecords(handle, startOffset, endOffset, maxRecordBytes, signal, prefixHash, observeBytes, onRecord) {
  let confirmedHash = prefixHash.copy();
  if (endOffset <= startOffset) {
    return { durableOffset: startOffset, confirmedHash, workingHash: prefixHash };
  }
  let position = startOffset;
  let durableOffset = startOffset;
  let pieces = [];
  let recordBytes = 0;
  let oversize = false;
  while (position < endOffset) {
    checkAbort(signal);
    const readLength = Math.min(READ_CHUNK_BYTES, endOffset - position);
    const buffer = await readExact(handle, position, readLength, observeBytes);
    let segmentStart = 0;
    for (let index = 0; index < buffer.length; index += 1) {
      if (buffer[index] !== 0x0a) continue;
      const segment = buffer.subarray(segmentStart, index);
      prefixHash.update(buffer.subarray(segmentStart, index + 1));
      if (!oversize) {
        if (recordBytes + segment.length > maxRecordBytes) {
          oversize = true;
          pieces = [];
        } else if (segment.length > 0) {
          pieces.push(segment);
          recordBytes += segment.length;
        }
      }
      const recordEnd = position + index + 1;
      const record = oversize ? null : Buffer.concat(pieces, recordBytes);
      checkAbort(signal);
      await onRecord({ record, recordEnd, oversize });
      durableOffset = recordEnd;
      confirmedHash = prefixHash.copy();
      pieces = [];
      recordBytes = 0;
      oversize = false;
      segmentStart = index + 1;
    }
    const remainder = buffer.subarray(segmentStart);
    prefixHash.update(remainder);
    if (!oversize) {
      if (recordBytes + remainder.length > maxRecordBytes) {
        oversize = true;
        pieces = [];
      } else if (remainder.length > 0) {
        pieces.push(remainder);
        recordBytes += remainder.length;
      }
    }
    position += buffer.length;
  }
  return { durableOffset, confirmedHash, workingHash: prefixHash };
}

export function createSessionWatcher({
  sessionsRoot,
  ledgerPath,
  publish,
  routerRegistryPath,
  maxRecordBytes = MAX_ROLLOUT_RECORD_BYTES,
  signal: externalSignal,
  beforeOpen = async () => {},
  onFileBytesRead = () => {},
} = {}) {
  if (typeof sessionsRoot !== "string" || sessionsRoot.length === 0 ||
      typeof ledgerPath !== "string" || ledgerPath.length === 0 ||
      typeof publish !== "function" ||
      (routerRegistryPath !== undefined && (typeof routerRegistryPath !== "string" || !isAbsolute(routerRegistryPath))) ||
      !Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1 ||
      (externalSignal !== undefined && !(externalSignal instanceof AbortSignal)) ||
      typeof beforeOpen !== "function" || typeof onFileBytesRead !== "function") {
    throw watcherError("WATCHER_INPUT");
  }

  const internalController = new AbortController();
  const signal = externalSignal
    ? AbortSignal.any([internalController.signal, externalSignal])
    : internalController.signal;
  let closed = false;
  let closePromise;
  let tail = Promise.resolve();
  let initialized = false;
  let bootstrapped = false;
  let checkpoints = new Map();
  let dedupeLedger;
  const parsers = new Map();
  const suppressedThreads = new Set();

  function createParser() {
    return createRolloutRecordParser({ isSuppressedThread: (threadId) => suppressedThreads.has(threadId) });
  }

  async function refreshRouterRegistry() {
    suppressedThreads.clear();
    if (routerRegistryPath === undefined) return;
    let handle;
    try {
      const leaf = await lstat(routerRegistryPath);
      if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.nlink !== 1 || leaf.size > READ_CHUNK_BYTES) throw watcherError("WATCHER_ROUTER_REGISTRY");
      handle = await open(routerRegistryPath, "r");
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.size > READ_CHUNK_BYTES) throw watcherError("WATCHER_ROUTER_REGISTRY");
      const bytes = await handle.readFile();
      let value;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw watcherError("WATCHER_ROUTER_REGISTRY"); }
      const keys = ["automation_id", "created_at", "schema", "thread_id"];
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).sort().join("\0") !== keys.join("\0") ||
          value.schema !== ROUTER_REGISTRY_SCHEMA || !ROUTER_THREAD_ID.test(value.thread_id) ||
          typeof value.automation_id !== "string" || value.automation_id.length === 0 ||
          typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at))) {
        throw watcherError("WATCHER_ROUTER_REGISTRY");
      }
      suppressedThreads.add(value.thread_id);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      if (error?.code === "WATCHER_ROUTER_REGISTRY") throw error;
      throw watcherError("WATCHER_ROUTER_REGISTRY");
    } finally {
      try { await handle?.close(); } catch {}
    }
  }

  function assertOpen() {
    if (closed) throw watcherError("WATCHER_CLOSED");
  }

  function enqueue(operation) {
    try {
      assertOpen();
    } catch (error) {
      return Promise.reject(error);
    }
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  }

  async function initialize() {
    checkAbort(signal);
    if (initialized) return;
    const state = await loadState(ledgerPath);
    if (state.validBytes < state.totalBytes) {
      try {
        await truncate(ledgerPath, state.validBytes);
      } catch {
        throw watcherError("WATCHER_STATE_WRITE");
      }
    }
    checkpoints = state.checkpoints;
    bootstrapped = state.bootstrapped;
    try {
      dedupeLedger = await openLedger(`${ledgerPath}.dedupe`);
    } catch {
      throw watcherError("WATCHER_DEDUPE");
    }
    initialized = true;
  }

  function observeBytes(relativePath) {
    return (bytesRead) => {
      try {
        onFileBytesRead({ relativePath, bytesRead });
      } catch {
        throw watcherError("WATCHER_HOOK");
      }
    };
  }

  async function checkpoint(relativePath, snapshot, byteOffset, prefixSha256) {
    const record = {
      schema: STATE_SCHEMA,
      type: "checkpoint",
      path: relativePath,
      byteOffset,
      observedSize: snapshot.size,
      lastMtimeMs: snapshot.lastMtimeMs,
      lastCtimeMs: snapshot.lastCtimeMs,
      fileId: snapshot.fileId,
      prefixSha256,
    };
    try {
      await appendDurableState(ledgerPath, record);
    } catch (error) {
      if (error?.code === "WATCHER_FILE_CHANGED" || error?.code === "WATCHER_ABORTED") throw error;
      throw watcherError("WATCHER_STATE_WRITE");
    }
    checkpoints.set(relativePath, {
      byteOffset,
      observedSize: record.observedSize,
      lastMtimeMs: record.lastMtimeMs,
      lastCtimeMs: record.lastCtimeMs,
      fileId: record.fileId,
      prefixSha256: record.prefixSha256,
    });
  }

  async function runBeforeOpen(relativePath) {
    try {
      await beforeOpen({ relativePath });
    } catch {
      throw watcherError("WATCHER_HOOK");
    }
    checkAbort(signal);
  }

  async function bootstrapInternal() {
    await refreshRouterRegistry();
    await initialize();
    checkAbort(signal);
    if (bootstrapped) return;
    const { physicalRoot, files } = await enumerateSessionFiles(sessionsRoot);
    for (const file of files) {
      checkAbort(signal);
      await runBeforeOpen(file.relativePath);
      const snapshot = await openVerifiedFile(file, physicalRoot);
      if (!snapshot) throw watcherError("WATCHER_PATH");
      try {
        const { parser, fingerprint } = await recoverParserAndFingerprint(file, snapshot, snapshot.size);
        await checkpoint(
          file.relativePath,
          snapshot,
          snapshot.size,
          fingerprint.copy().digest("hex"),
        );
        parsers.set(file.relativePath, { fileId: snapshot.fileId, parser });
      } finally {
        await snapshot.handle.close();
      }
    }
    try {
      await appendDurableState(ledgerPath, { schema: STATE_SCHEMA, type: "bootstrap", bootstrapped: true });
    } catch {
      throw watcherError("WATCHER_STATE_WRITE");
    }
    bootstrapped = true;
  }

  async function recoverParserAndFingerprint(file, snapshot, offset) {
    const parser = createParser();
    const fingerprintEnd = Math.min(offset, CHECKPOINT_FINGERPRINT_BYTES);
    const result = await walkCompleteRecords(
      snapshot.handle,
      0,
      fingerprintEnd,
      maxRecordBytes,
      signal,
      createHash("sha256"),
      observeBytes(file.relativePath),
      async ({ record, oversize }) => {
        if (!oversize) {
          try { parser.parse(record); } catch { /* History context recovery is fail-closed. */ }
        }
      },
    );
    parsers.set(file.relativePath, { fileId: snapshot.fileId, parser });
    return { parser, fingerprint: result.workingHash };
  }

  async function deliverObservation(observation, diagnostics, relativePath) {
    const effectiveDedupeKey = observation.canonicalIdentity ?? `rollout:${relativePath}:${observation.dedupeKey}`;
    const eventId = observation.canonicalIdentity ? observation.eventId : createPublicationEventId(effectiveDedupeKey);
    const deliveredObservation = { ...observation, eventId };
    let alreadyPublished;
    try {
      alreadyPublished = dedupeLedger.has(effectiveDedupeKey);
    } catch {
      throw watcherError("WATCHER_DEDUPE");
    }
    if (alreadyPublished) return false;
    checkAbort(signal);
    let acknowledgment;
    try {
      const publication = Promise.resolve().then(() =>
        publish(deliveredObservation, { idempotencyKey: eventId, signal }),
      );
      let removeAbortListener;
      const aborted = new Promise((resolve) => {
        const onAbort = () => resolve({ aborted: true });
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
        if (signal.aborted) onAbort();
      });
      const observedPublication = publication.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      const outcome = await Promise.race([observedPublication, aborted]);
      removeAbortListener();
      if (outcome.aborted) throw watcherError("WATCHER_ABORTED");
      if (Object.hasOwn(outcome, "error")) throw outcome.error;
      acknowledgment = outcome.value;
    } catch {
      if (signal.aborted) throw watcherError("WATCHER_ABORTED");
      throw watcherError("WATCHER_PUBLISH");
    }
    checkAbort(signal);
    if (!acknowledgment || typeof acknowledgment !== "object" ||
        acknowledgment.idempotencyKey !== eventId) {
      throw watcherError("WATCHER_PUBLISH_CONTRACT");
    }

    // The deterministic sink is the exactly-once boundary: never claim before its acknowledgment.
    let markResult;
    try {
      markResult = await dedupeLedger.mark(effectiveDedupeKey);
    } catch {
      throw watcherError("WATCHER_DEDUPE");
    }
    if (markResult.ledgerError) diagnostics.push({ code: "WATCHER_DEDUPE_DERIVED", path: relativePath });
    if (markResult.cleanupError) diagnostics.push({ code: "WATCHER_DEDUPE_CLEANUP", path: relativePath });
    return markResult.marked;
  }

  async function scanInternal() {
    await refreshRouterRegistry();
    await initialize();
    checkAbort(signal);
    if (!bootstrapped) {
      await bootstrapInternal();
      return { published: 0, diagnostics: [] };
    }

    let published = 0;
    const diagnostics = [];
    const { physicalRoot, files } = await enumerateSessionFiles(sessionsRoot);
    for (const file of files) {
      checkAbort(signal);
      await runBeforeOpen(file.relativePath);
      const snapshot = await openVerifiedFile(file, physicalRoot);
      if (!snapshot) continue;
      try {
        const existing = checkpoints.get(file.relativePath);
        let offset = existing?.byteOffset ?? 0;
        let reset = !existing;
        if (existing && snapshot.fileId === existing.fileId &&
            snapshot.size === existing.observedSize &&
            snapshot.lastMtimeMs === existing.lastMtimeMs &&
            snapshot.lastCtimeMs === existing.lastCtimeMs) {
          continue;
        }

        if (existing && (snapshot.fileId !== existing.fileId || snapshot.size < offset ||
            snapshot.lastMtimeMs < existing.lastMtimeMs)) {
          offset = 0;
          reset = true;
          parsers.delete(file.relativePath);
        }

        let parser;
        let fingerprint;
        if (reset) {
          parser = createParser();
          fingerprint = createHash("sha256");
          parsers.set(file.relativePath, { fileId: snapshot.fileId, parser });
        } else {
          const cached = parsers.get(file.relativePath);
          if (cached?.fileId === snapshot.fileId) {
            parser = cached.parser;
            fingerprint = await buildCheckpointFingerprint(
              snapshot.handle,
              offset,
              signal,
              observeBytes(file.relativePath),
            );
          } else {
            ({ parser, fingerprint } = await recoverParserAndFingerprint(file, snapshot, offset));
          }
          if (fingerprint.copy().digest("hex") !== existing.prefixSha256) {
            offset = 0;
            reset = true;
            parser = createParser();
            fingerprint = createHash("sha256");
            parsers.set(file.relativePath, { fileId: snapshot.fileId, parser });
          }
        }

        let walkResult = {
          durableOffset: offset,
          confirmedHash: createHash("sha256"),
          workingHash: createHash("sha256"),
        };
        if (snapshot.size > offset) {
          walkResult = await walkCompleteRecords(
            snapshot.handle,
            offset,
            snapshot.size,
            maxRecordBytes,
            signal,
            createHash("sha256"),
            observeBytes(file.relativePath),
            async ({ record, recordEnd, oversize }) => {
              let messages = [];
              if (oversize) {
                diagnostics.push({ code: "ROLLOUT_RECORD_TOO_LARGE", path: file.relativePath });
              } else {
                try {
                  messages = parser.parse(record);
                } catch (error) {
                  diagnostics.push({
                    code: typeof error?.code === "string" ? error.code : "ROLLOUT_RECORD_INVALID",
                    path: file.relativePath,
                  });
                }
              }
              for (const observation of messages) {
                if (await deliverObservation(observation, diagnostics, file.relativePath)) published += 1;
              }
            },
          );
        }
        if (reset || offset < CHECKPOINT_FINGERPRINT_BYTES) {
          fingerprint = await buildCheckpointFingerprint(
            snapshot.handle,
            walkResult.durableOffset,
            signal,
            observeBytes(file.relativePath),
          );
        }
        await checkpoint(
          file.relativePath,
          snapshot,
          walkResult.durableOffset,
          fingerprint.copy().digest("hex"),
        );
      } finally {
        await snapshot.handle.close();
      }
    }
    return { published, diagnostics };
  }

  return {
    bootstrap() {
      return enqueue(bootstrapInternal);
    },

    scanOnce() {
      return enqueue(scanInternal);
    },

    close() {
      if (!closePromise) {
        closed = true;
        internalController.abort(watcherError("WATCHER_ABORTED"));
        closePromise = tail.then(async () => {
          await dedupeLedger?.close();
        });
      }
      return closePromise;
    },
  };
}
