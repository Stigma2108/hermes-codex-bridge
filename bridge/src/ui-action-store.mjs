import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { writeJsonOnce } from "./atomic-store.mjs";
import { validateEvent, validateReply } from "./contracts.mjs";

const EVENT_ID = /^evt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SAFE_CODE = /^(?:BUSY|SEND_FAILED|VERIFY_PENDING|STALE|EXPIRED)$/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ACTION_SCHEMA = "hermes-codex-ui-action/v3";
const CLAIM_SCHEMA = "hermes-codex-ui-claim/v3";
const APPLIED_SCHEMA = "hermes-codex-ui-applied/v3";
const RECEIPT_SCHEMA = "hermes-codex-interaction-receipt/v3";
const REGISTRY_SCHEMA = "hermes-codex-ui-router-registry/v3";
const HEARTBEAT_SCHEMA = "hermes-codex-ui-router-heartbeat/v3";
const LEASE_MS = 120_000;
const REPLY_TTL_MS = 604_800_000;
const MAX_JSON = 1024 * 1024;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function serialized(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function hash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function contained(root, path) {
  const value = relative(root.toLowerCase(), path.toLowerCase());
  return value === "" || (value !== ".." && !value.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(value));
}

function exactFields(value, fields) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

async function safeDirectory(path, physicalRoot) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw fail("UI_PATH");
  const physical = await realpath(path);
  if (!contained(physicalRoot, physical)) throw fail("UI_PATH");
  return physical;
}

async function safeFileBytes(path, physicalRoot) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_JSON) throw fail("UI_PATH");
  if (!contained(physicalRoot, await realpath(path))) throw fail("UI_PATH");
  return readFile(path);
}

async function safeJson(path, physicalRoot) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await safeFileBytes(path, physicalRoot));
    return { value: JSON.parse(text), bytes: text };
  } catch (error) {
    if (["ENOENT", "UI_PATH"].includes(error?.code)) throw error;
    throw fail("UI_JSON");
  }
}

function validateAction(value, event) {
  if (!exactFields(value, ["schema", "event_id", "thread_id", "source_turn_id", "reply_sha256", "created_at"])
    || value.schema !== ACTION_SCHEMA
    || value.event_id !== event.event_id
    || value.thread_id !== event.thread.id
    || value.source_turn_id !== event.thread.turn_id
    || !SHA256.test(value.reply_sha256)
    || !validTimestamp(value.created_at)) throw fail("UI_ACTION");
  return value;
}

function validateClaim(value, eventId, replyHash) {
  if (!exactFields(value, ["schema", "event_id", "reply_sha256", "lease_id", "claimed_at", "expires_at"])
    || value.schema !== CLAIM_SCHEMA
    || value.event_id !== eventId
    || value.reply_sha256 !== replyHash
    || !SAFE_IDENTIFIER.test(value.lease_id)
    || !validTimestamp(value.claimed_at)
    || !validTimestamp(value.expires_at)) throw fail("UI_CLAIM");
  return value;
}

async function writeOnceOrSame(path, value, write, physicalRoot) {
  try {
    await write(path, value);
    return { published: true };
  } catch (error) {
    if (error?.code !== "WRITE_ONCE_CONFLICT") throw error;
    let current;
    try {
      current = await safeFileBytes(path, physicalRoot);
    } catch (readError) {
      if (readError?.code === "UI_PATH") throw readError;
      throw fail("UI_ACTION_CONFLICT");
    }
    if (current.toString("utf8") !== serialized(value)) throw fail("UI_ACTION_CONFLICT");
    return { published: false };
  }
}

async function atomicReplace(path, value, expectedBytes = undefined) {
  await mkdir(dirname(path), { recursive: true });
  if (expectedBytes !== undefined) {
    let current;
    try { current = await readFile(path, "utf8"); } catch { throw fail("UI_REGISTRY"); }
    if (current !== expectedBytes) throw fail("UI_REGISTRY");
  }
  const partial = `${path}.${randomUUID()}.partial`;
  let handle;
  try {
    handle = await open(partial, "wx", 0o600);
    await handle.writeFile(serialized(value), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(partial, path);
    let directory;
    try {
      directory = await open(dirname(path), "r");
      await directory.sync();
    } catch {
      // Directory fsync is unavailable on some Windows filesystems.
    } finally {
      try { await directory?.close(); } catch {}
    }
  } catch (error) {
    try { await handle?.close(); } catch {}
    try { await rm(partial, { force: true }); } catch {}
    throw error;
  }
}

const paths = (directory) => ({
  action: join(directory, "ui-action.json"),
  claim: join(directory, "ui-claim.json"),
  applied: join(directory, "ui-applied.json"),
  receipt: join(directory, "receipt.json"),
});

export function createUiActionStore({ queueRoot, now = () => new Date(), randomId = randomUUID, write = writeJsonOnce }) {
  if (typeof queueRoot !== "string" || !isAbsolute(queueRoot) || resolve(queueRoot) !== queueRoot) throw fail("UI_ROOT");
  if (typeof now !== "function" || typeof randomId !== "function" || typeof write !== "function") throw fail("UI_OPTIONS");
  const root = resolve(queueRoot);
  const interactions = join(root, "interactions");

  async function physicalRoot() {
    const physical = await realpath(root);
    await safeDirectory(root, physical);
    return physical;
  }

  async function interactionDirectory(eventId) {
    if (!EVENT_ID.test(eventId)) throw fail("UI_EVENT_ID");
    const physical = await physicalRoot();
    await safeDirectory(interactions, physical);
    const directory = join(interactions, eventId);
    await safeDirectory(directory, physical);
    return { directory, physical };
  }

  async function load(eventId) {
    const { directory, physical } = await interactionDirectory(eventId);
    const event = validateEvent((await safeJson(join(directory, "event.json"), physical)).value);
    const reply = validateReply((await safeJson(join(directory, "reply.json"), physical)).value);
    if (event.event_id !== eventId || reply.event_id !== eventId || reply.action !== "REPLY" || typeof reply.text !== "string") throw fail("UI_EVENT_ID");
    const filePaths = paths(directory);
    const action = validateAction((await safeJson(filePaths.action, physical)).value, event);
    if (hash(reply.text) !== action.reply_sha256) throw fail("UI_HASH");
    return { directory, physical, filePaths, event, reply, action };
  }

  async function optionalJson(path, physical) {
    try { return await safeJson(path, physical); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }

  async function terminal(path, eventId, status, details, physical) {
    const value = { schema: RECEIPT_SCHEMA, event_id: eventId, processed_at: now().toISOString(), status, ...details };
    return writeOnceOrSame(path, value, write, physical);
  }

  async function terminalExists(filePaths, physical) {
    const current = await optionalJson(filePaths.receipt, physical);
    return current !== null;
  }

  async function readClaim(context) {
    const current = await safeJson(context.filePaths.claim, context.physical);
    return { ...current, claim: validateClaim(current.value, context.event.event_id, context.action.reply_sha256) };
  }

  async function removeExactClaim(context, leaseId) {
    const first = await readClaim(context);
    if (first.claim.lease_id !== leaseId) throw fail("UI_LEASE");
    const second = await safeFileBytes(context.filePaths.claim, context.physical);
    if (second.toString("utf8") !== first.bytes) throw fail("UI_CLAIM_CHANGED");
    await rm(context.filePaths.claim);
  }

  async function listReady({ limit = 10 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw fail("UI_LIMIT");
    let physical;
    try {
      physical = await physicalRoot();
      await safeDirectory(interactions, physical);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const entries = await readdir(interactions, { withFileTypes: true });
    const ready = [];
    for (const entry of entries) {
      if (!EVENT_ID.test(entry.name)) continue;
      const directory = join(interactions, entry.name);
      await safeDirectory(directory, physical);
      const names = await readdir(directory);
      if (!names.includes("ui-action.json")) continue;
      const context = await load(entry.name);
      if (await terminalExists(context.filePaths, context.physical)) continue;
      if ((await optionalJson(context.filePaths.applied, context.physical)) !== null) continue;
      const deadline = Math.min(Date.parse(context.event.expires_at), Date.parse(context.event.created_at) + REPLY_TTL_MS);
      if (now().getTime() > deadline) {
        await terminal(context.filePaths.receipt, entry.name, "EXPIRED", {}, context.physical);
        continue;
      }
      const claim = await optionalJson(context.filePaths.claim, context.physical);
      if (claim !== null) {
        const valid = validateClaim(claim.value, entry.name, context.action.reply_sha256);
        if (now().getTime() <= Date.parse(valid.expires_at)) continue;
      }
      ready.push({ eventId: entry.name, threadId: context.action.thread_id, sourceTurnId: context.action.source_turn_id, createdAt: context.action.created_at });
    }
    ready.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.eventId.localeCompare(right.eventId));
    return ready.slice(0, limit);
  }

  return {
    async enqueue({ event, reply }) {
      validateEvent(event);
      validateReply(reply);
      if (!EVENT_ID.test(event.event_id) || event.event_id !== reply.event_id) throw fail("UI_EVENT_ID");
      if (reply.action !== "REPLY" || typeof reply.text !== "string") throw fail("UI_REPLY_ACTION");
      const { directory, physical } = await interactionDirectory(event.event_id);
      const action = {
        schema: ACTION_SCHEMA,
        event_id: event.event_id,
        thread_id: event.thread.id,
        source_turn_id: event.thread.turn_id,
        reply_sha256: hash(reply.text),
        created_at: now().toISOString(),
      };
      const actionPath = paths(directory).action;
      await writeOnceOrSame(actionPath, action, write, physical);
      return { eventId: event.event_id, state: "READY" };
    },

    listReady,

    async claim(eventId) {
      const context = await load(eventId);
      if (await terminalExists(context.filePaths, context.physical) || (await optionalJson(context.filePaths.applied, context.physical)) !== null) throw fail("UI_TERMINAL");
      const deadline = Math.min(Date.parse(context.event.expires_at), Date.parse(context.event.created_at) + REPLY_TTL_MS);
      if (now().getTime() > deadline) {
        await terminal(context.filePaths.receipt, eventId, "EXPIRED", {}, context.physical);
        throw fail("UI_EXPIRED");
      }
      const existing = await optionalJson(context.filePaths.claim, context.physical);
      if (existing !== null) {
        const valid = validateClaim(existing.value, eventId, context.action.reply_sha256);
        if (now().getTime() <= Date.parse(valid.expires_at)) throw fail("UI_CLAIMED");
        if (await terminalExists(context.filePaths, context.physical)) throw fail("UI_TERMINAL");
        const current = await safeFileBytes(context.filePaths.claim, context.physical);
        if (current.toString("utf8") !== existing.bytes) throw fail("UI_CLAIM_CHANGED");
        await rm(context.filePaths.claim);
      }
      const leaseId = randomId();
      if (typeof leaseId !== "string" || !SAFE_IDENTIFIER.test(leaseId)) throw fail("UI_LEASE");
      const claimedAt = now();
      const claim = {
        schema: CLAIM_SCHEMA,
        event_id: eventId,
        reply_sha256: context.action.reply_sha256,
        lease_id: leaseId,
        claimed_at: claimedAt.toISOString(),
        expires_at: new Date(claimedAt.getTime() + LEASE_MS).toISOString(),
      };
      try { await write(context.filePaths.claim, claim); } catch (error) { if (error?.code === "WRITE_ONCE_CONFLICT") throw fail("UI_CLAIMED"); throw error; }
      const marker = `<!-- HC3_UI_EVENT:${eventId} -->`;
      return {
        eventId,
        threadId: context.action.thread_id,
        sourceTurnId: context.action.source_turn_id,
        actionCreatedAt: context.action.created_at,
        leaseId,
        marker,
        text: context.reply.text,
        prompt: `${marker}\n${context.reply.text}`,
      };
    },

    async release(eventId, leaseId, code) {
      if (!SAFE_CODE.test(code) || code === "STALE" || code === "EXPIRED") throw fail("UI_CODE");
      const context = await load(eventId);
      if (await terminalExists(context.filePaths, context.physical)) throw fail("UI_TERMINAL");
      await removeExactClaim(context, leaseId);
      return { state: "READY" };
    },

    async applied(eventId, leaseId, turnId) {
      if (typeof turnId !== "string" || !SAFE_IDENTIFIER.test(turnId)) throw fail("UI_TURN");
      const context = await load(eventId);
      const receipt = await optionalJson(context.filePaths.receipt, context.physical);
      if (receipt === null) await terminal(context.filePaths.receipt, eventId, "APPLIED", {}, context.physical);
      else if (receipt.value?.status !== "APPLIED") throw fail("UI_TERMINAL");
      const existing = await optionalJson(context.filePaths.applied, context.physical);
      let proof;
      if (existing !== null) {
        proof = existing.value;
        if (!exactFields(proof, ["schema", "event_id", "reply_sha256", "lease_id", "turn_id", "applied_at"])
          || proof.schema !== APPLIED_SCHEMA || proof.event_id !== eventId || proof.reply_sha256 !== context.action.reply_sha256
          || proof.lease_id !== leaseId || proof.turn_id !== turnId || !validTimestamp(proof.applied_at)) throw fail("UI_APPLIED");
      } else {
        const { claim } = await readClaim(context);
        if (claim.lease_id !== leaseId) throw fail("UI_LEASE");
        proof = { schema: APPLIED_SCHEMA, event_id: eventId, reply_sha256: context.action.reply_sha256, lease_id: leaseId, turn_id: turnId, applied_at: now().toISOString() };
        await writeOnceOrSame(context.filePaths.applied, proof, write, context.physical);
      }
      return { state: "APPLIED" };
    },

    async reject(eventId, leaseId, code) {
      if (!SAFE_CODE.test(code) || !["STALE", "EXPIRED"].includes(code)) throw fail("UI_CODE");
      const context = await load(eventId);
      const { claim } = await readClaim(context);
      if (claim.lease_id !== leaseId) throw fail("UI_LEASE");
      const status = code === "EXPIRED" ? "EXPIRED" : "REJECTED";
      const details = status === "REJECTED" ? { error: { code } } : {};
      await terminal(context.filePaths.receipt, eventId, status, details, context.physical);
      return { state: status };
    },

    async registerRouter({ threadId, automationId }) {
      if (typeof threadId !== "string" || !SAFE_IDENTIFIER.test(threadId) || typeof automationId !== "string" || !SAFE_IDENTIFIER.test(automationId)) throw fail("UI_REGISTRY");
      const path = join(root, "ui-router.json");
      const physical = await physicalRoot();
      let current;
      try { current = await optionalJson(path, physical); } catch { throw fail("UI_REGISTRY"); }
      if (current === null) {
        if (automationId !== "pending") throw fail("UI_REGISTRY");
        const value = { schema: REGISTRY_SCHEMA, thread_id: threadId, automation_id: automationId, created_at: now().toISOString() };
        await writeOnceOrSame(path, value, write, physical);
        return { threadId, automationId };
      }
      const value = current.value;
      if (!exactFields(value, ["schema", "thread_id", "automation_id", "created_at"]) || value.schema !== REGISTRY_SCHEMA
        || value.thread_id !== threadId || !validTimestamp(value.created_at)) throw fail("UI_REGISTRY");
      if (value.automation_id === automationId) return { threadId, automationId };
      if (value.automation_id !== "pending" || automationId === "pending") throw fail("UI_REGISTRY");
      const next = { ...value, automation_id: automationId };
      await atomicReplace(path, next, current.bytes);
      return { threadId, automationId };
    },

    async heartbeat(routerThreadId) {
      if (typeof routerThreadId !== "string" || !SAFE_IDENTIFIER.test(routerThreadId)) throw fail("UI_REGISTRY");
      const physical = await physicalRoot();
      const registry = await optionalJson(join(root, "ui-router.json"), physical);
      if (registry === null || registry.value?.schema !== REGISTRY_SCHEMA || registry.value.thread_id !== routerThreadId || registry.value.automation_id === "pending") throw fail("UI_REGISTRY");
      const value = { schema: HEARTBEAT_SCHEMA, thread_id: routerThreadId, observed_at: now().toISOString() };
      await atomicReplace(join(root, "ui-router-heartbeat.json"), value);
      return { heartbeatAt: value.observed_at };
    },

    async healthSnapshot() {
      const ready = await listReady();
      const physical = await physicalRoot();
      const heartbeat = await optionalJson(join(root, "ui-router-heartbeat.json"), physical);
      if (heartbeat !== null && (!exactFields(heartbeat.value, ["schema", "thread_id", "observed_at"])
        || heartbeat.value.schema !== HEARTBEAT_SCHEMA || !validTimestamp(heartbeat.value.observed_at))) throw fail("UI_HEARTBEAT");
      return { readyCount: ready.length, oldestReadyAt: ready[0]?.createdAt ?? null, heartbeatAt: heartbeat?.value.observed_at ?? null };
    },
  };
}
