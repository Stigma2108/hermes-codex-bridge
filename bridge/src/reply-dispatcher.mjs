import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { writeJsonOnce } from "./atomic-store.mjs";
import { validateEvent, validateReply } from "./contracts.mjs";

const EVENT_DIR = /^evt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MAX_JSON = 1024 * 1024;
function fail(code) { const error = new Error(code); error.code = code; return error; }
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function contained(root, path) { const value = relative(root.toLowerCase(), path.toLowerCase()); return value === "" || (!value.startsWith("..\\") && value !== ".." && !isAbsolute(value)); }

async function safeDirectory(path, physicalRoot) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail("DISPATCH_PATH");
  if (!contained(physicalRoot, await realpath(path))) throw fail("DISPATCH_PATH");
}

async function safeFile(path, physicalRoot, max = MAX_JSON) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max) throw fail("DISPATCH_PATH");
  if (!contained(physicalRoot, await realpath(path))) throw fail("DISPATCH_PATH");
  return readFile(path);
}

async function json(path, physicalRoot) {
  let value; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await safeFile(path, physicalRoot))); } catch (error) { if (error?.code?.startsWith?.("DISPATCH_")) throw error; throw fail("DISPATCH_JSON"); }
  return value;
}

async function writeOnceOrSame(path, value, writer) {
  try { return await writer(path, value); } catch (error) {
    if (error?.code !== "WRITE_ONCE_CONFLICT") throw error;
    const existing = JSON.parse(await readFile(path, "utf8"));
    if (JSON.stringify(existing) !== JSON.stringify(value)) throw fail("DISPATCH_CONFLICT");
    return { published: false };
  }
}

export function createReplyDispatcher({ queueRoot, stateRoot, threadDriver, hookResolver, replyGuard, uiActionStore, now = () => new Date(), write = writeJsonOnce }) {
  if (typeof queueRoot !== "string" || !isAbsolute(queueRoot) || typeof stateRoot !== "string" || !isAbsolute(stateRoot)) throw fail("DISPATCH_CONFIG");
  const root = resolve(queueRoot); const interactions = join(root, "interactions"); let running = Promise.resolve(); let closed = false;

  async function terminal(directory, eventId, status, details = {}) {
    await writeOnceOrSame(join(directory, "receipt.json"), { schema: "hermes-codex-interaction-receipt/v3", event_id: eventId, processed_at: now().toISOString(), status, ...details }, write);
  }
  async function recordFailure(directory, eventId, code) {
    try { await writeOnceOrSame(join(directory, "windows-failure.json"), { schema: "hermes-codex-windows-failure/v3", event_id: eventId, created_at: now().toISOString(), code }, write); } catch { /* Preserve the first terminal diagnostic. */ }
  }

  async function apply(event, reply, { alreadyRouted = false } = {}) {
    const idempotencyKey = event.event_id;
    const replyMode = event.message.reply_mode ?? (event.kind === "QUESTION" ? "LIVE_REQUEST" : "NONE");
    const liveQuestion = event.kind === "QUESTION" && reply.action === "REPLY" && replyMode === "LIVE_REQUEST";
    const ordinaryNewTurn = reply.action === "REPLY" && !liveQuestion;
    if (ordinaryNewTurn && uiActionStore) {
      if (!alreadyRouted && replyGuard && !(await replyGuard.isReplyCurrent(event))) return { rejected: true, code: "STALE" };
      await uiActionStore.enqueue({ event, reply });
      return { routed: true };
    }
    if (ordinaryNewTurn && replyGuard && !(await replyGuard.isReplyCurrent(event))) return { rejected: true, code: "STALE" };
    if (reply.action === "REPLY" && replyMode === "NEXT_TURN") {
      if (typeof threadDriver?.reply !== "function") throw fail("DISPATCH_SINK");
      return threadDriver.reply({ threadId: event.thread.id, expectedTurnId: event.thread.turn_id, text: reply.text, eventId: event.event_id, idempotencyKey });
    }
    if (event.kind === "QUESTION" && reply.action === "REPLY" && replyMode === "LIVE_REQUEST") {
      const resolver = threadDriver?.resolveInteraction ?? threadDriver?.handleInteraction;
      if (typeof resolver !== "function") throw fail("DISPATCH_SINK");
      return resolver.call(threadDriver, { eventId: event.event_id, threadId: event.thread.id, action: reply.action, text: reply.text, idempotencyKey });
    }
    if (["APPROVE_ONCE", "DECLINE"].includes(reply.action)) {
      if (hookResolver?.has?.(event.event_id)) return hookResolver.resolve(event.event_id, reply, { idempotencyKey });
      const resolver = threadDriver?.resolveInteraction ?? threadDriver?.handleInteraction;
      if (typeof resolver !== "function") throw fail("DISPATCH_SINK");
      return resolver.call(threadDriver, { eventId: event.event_id, threadId: event.thread.id, action: reply.action, text: reply.text, idempotencyKey });
    }
    if (reply.action !== "REPLY" || typeof threadDriver?.reply !== "function") throw fail("DISPATCH_SINK");
    const result = await threadDriver.reply({ threadId: event.thread.id, text: reply.text, eventId: event.event_id, idempotencyKey });
    if (result?.idempotencyKey !== undefined && result.idempotencyKey !== idempotencyKey) throw fail("DISPATCH_ACK");
    return result;
  }

  async function processDirectory(directory, name, physicalRoot, counts) {
    try {
      await safeDirectory(directory, physicalRoot);
      const names = await readdir(directory);
      if (names.some((entry) => /(?:conflict|\.partial$)/iu.test(entry))) throw fail("DISPATCH_CONFLICT");
      if (names.includes("receipt.json")) return;
      if (!names.includes("event.json") || !names.includes("reply.json")) return;
      const event = validateEvent(await json(join(directory, "event.json"), physicalRoot));
      const reply = validateReply(await json(join(directory, "reply.json"), physicalRoot));
      if (event.event_id !== name || reply.event_id !== name) throw fail("DISPATCH_EVENT_ID");
      const payload = event.message.markdown_path === null ? Buffer.from(event.message.summary, "utf8") : await safeFile(join(directory, event.message.markdown_path), physicalRoot, 16 * 1024 * 1024);
      if (hash(payload) !== event.integrity.content_sha256) throw fail("DISPATCH_HASH");
      if (!event.allowed_actions.includes(reply.action)) { await terminal(directory, name, "DECLINED"); counts.declined += 1; return; }
      const created = Date.parse(event.created_at); const declaredExpiry = Date.parse(event.expires_at); const ttl = event.kind === "APPROVAL_REQUEST" ? 43_200_000 : 604_800_000;
      const deadline = Math.min(declaredExpiry, created + ttl); const replied = Date.parse(reply.created_at);
      if (now().getTime() > deadline || replied > deadline || replied < created) { await terminal(directory, name, "EXPIRED"); counts.expired += 1; return; }
      const claim = { schema: "hermes-codex-dispatch-claim/v3", event_id: name, idempotency_key: name };
      await writeOnceOrSame(join(resolve(stateRoot), "dispatch-claims", `${name}.json`), claim, write);
      let result;
      try { result = await apply(event, reply, { alreadyRouted: names.includes("ui-action.json") }); } catch { counts.deferred += 1; return; }
      if (result?.rejected === true) {
        await terminal(directory, name, "REJECTED", { error: { code: result.code === "STALE" ? "STALE" : "REJECTED" } });
        counts.rejected += 1;
        return;
      }
      if (result?.routed === true) { counts.routed += 1; return; }
      await terminal(directory, name, "APPLIED"); counts.applied += 1;
    } catch (error) { await recordFailure(directory, name, error?.code?.startsWith?.("DISPATCH_") ? error.code : "DISPATCH_INVALID"); counts.failed += 1; }
  }

  async function scanInternal() {
    if (closed) throw fail("DISPATCH_CLOSED");
    const counts = { applied: 0, routed: 0, expired: 0, declined: 0, rejected: 0, failed: 0, deferred: 0 };
    let physicalRoot;
    try { await safeDirectory(root, await realpath(root)); physicalRoot = await realpath(root); await safeDirectory(interactions, physicalRoot); } catch (error) { if (error?.code === "ENOENT") return counts; throw fail("DISPATCH_ROOT"); }
    const entries = await readdir(interactions, { withFileTypes: true });
    for (const entry of entries) if (EVENT_DIR.test(entry.name)) await processDirectory(join(interactions, entry.name), entry.name, physicalRoot, counts);
    return counts;
  }
  return { scanOnce() { const result = running.then(scanInternal, scanInternal); running = result.catch(() => {}); return result; }, async close() { closed = true; await running; } };
}
