import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { publishEvent } from "./event-publisher.mjs";
import { createPublicationEventId } from "./rollout-parser.mjs";
import { toTelegramSafeText } from "./redaction.mjs";
import { createUiRouterHealth } from "./ui-router-health.mjs";

const UI_ROUTER_WARNING = "Codex UI router не обработал ожидающий Telegram-ответ более трёх минут. Ответ сохранён и будет повторён после восстановления Codex Desktop/router.";

function abortableSleep(ms, signal) { return new Promise((resolve) => { if (signal?.aborted) return resolve(); const timer = setTimeout(done, ms); function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); } signal?.addEventListener("abort", done, { once: true }); }); }

export function validateBridgeConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config) || config.schema !== "hermes-codex-bridge-config/v3") throw new Error("SERVICE_CONFIG_SCHEMA");
  if (typeof config.queueRoot !== "string" || !isAbsolute(config.queueRoot) || config.queueRoot.includes("\0")) throw new Error("SERVICE_CONFIG_QUEUE");
  const minimum = config.pollMinMs ?? 1000; const maximum = config.pollMaxMs ?? 1500;
  if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || minimum < 100 || maximum < minimum || maximum > 60_000) throw new Error("SERVICE_CONFIG_POLL");
  return config;
}

export function createUiRouterMonitor({ queueRoot, uiActionStore, health = createUiRouterHealth(), publish = publishEvent } = {}) {
  if (typeof queueRoot !== "string" || !isAbsolute(queueRoot) || typeof uiActionStore?.healthSnapshot !== "function" || typeof health?.observe !== "function" || typeof publish !== "function") throw new Error("UI_ROUTER_MONITOR_CONFIG");
  return {
    async check() {
      const snapshot = await uiActionStore.healthSnapshot();
      const decision = health.observe(snapshot);
      if (decision.action !== "WARN") return decision;
      const created = new Date(snapshot.oldestReadyAt);
      const eventId = createPublicationEventId(decision.key);
      const result = await publish({
        queueRoot,
        event_id: eventId,
        kind: "ERROR",
        created_at: created.toISOString(),
        expires_at: new Date(created.getTime() + 604_800_000).toISOString(),
        thread: { id: "hermes-codex-ui-router", turn_id: "router-health", title: "UI Router", project_label: "Hermes-Codex", cwd_label: "Hermes-Codex" },
        text: UI_ROUTER_WARNING,
        replyMode: "NONE",
        is_replyable: false,
        allowed_actions: [],
      });
      if (result?.event?.event_id !== eventId) throw new Error("UI_ROUTER_MONITOR_ACK");
      return decision;
    },
  };
}

async function replaceJson(path, value) {
  await mkdir(dirname(path), { recursive: true }); const partial = `${path}.${randomUUID()}.partial`; let handle;
  try { handle = await open(partial, "wx"); await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); await handle.close(); handle = undefined; await rename(partial, path); }
  catch (error) { if (handle) try { await handle.close(); } catch {} try { await rm(partial, { force: true }); } catch {} throw error; }
}

function boundedMetadata(value, fallback, limit) {
  if (typeof value !== "string") return fallback;
  const safe = toTelegramSafeText(value).replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return safe ? [...safe].slice(0, limit).join("") : fallback;
}

function projectFromCwd(cwd) {
  if (typeof cwd !== "string") return null;
  return cwd.split(/[\\/]+/u).filter(Boolean).at(-1) ?? null;
}

async function readBoundedState(globalStatePath, maxBytes) {
  if (typeof globalStatePath !== "string") return null;
  try {
    if ((await stat(globalStatePath)).size > maxBytes) throw new Error("CODEX_STATE_TOO_LARGE");
    return JSON.parse(await readFile(globalStatePath, "utf8"));
  } catch {
    return null;
  }
}

export function createCodexThreadMetadataResolver({ readThread, globalStatePath, maxBytes = 4 * 1024 * 1024 } = {}) {
  return async (message = {}) => {
    const threadId = typeof message.threadId === "string" ? message.threadId : "";
    let live = null;
    try { live = typeof readThread === "function" && threadId ? (await readThread(threadId))?.thread : null; } catch {}
    const state = await readBoundedState(globalStatePath, maxBytes);
    const title = live?.name ??
      state?.["electron-persisted-atom-state"]?.["thread-titles-v1"]?.[threadId] ??
      state?.["electron-persisted-atom-state"]?.["thread-descriptions-v1"]?.[threadId] ??
      message.title;
    const assignedCwd = state?.["thread-project-assignments"]?.[threadId]?.cwd;
    const cwd = typeof live?.cwd === "string" && live.cwd ? live.cwd :
      (typeof assignedCwd === "string" && assignedCwd ? assignedCwd : message.cwd);
    const projectLabel = boundedMetadata(projectFromCwd(cwd), "Codex", 80);
    return {
      title: boundedMetadata(title, "Codex thread", 120),
      projectLabel,
      cwdLabel: projectLabel,
    };
  };
}

export function createSessionPublishAdapter({ queueRoot, publish = publishEvent, resolveThreadMetadata = async (message) => { const projectLabel = boundedMetadata(projectFromCwd(message?.cwd), "Codex", 80); return { title: "Codex thread", projectLabel, cwdLabel: projectLabel }; }, now = () => new Date() }) {
  return async (message, { idempotencyKey, signal } = {}) => {
    if (message?.eventId !== idempotencyKey || signal?.aborted) throw new Error("SESSION_PUBLISH_INPUT");
    const created = message.timestamp && Number.isFinite(Date.parse(message.timestamp)) ? new Date(message.timestamp) : now();
    let metadata;
    try { metadata = await resolveThreadMetadata(message); } catch { metadata = {}; }
    const projectLabel = boundedMetadata(metadata?.projectLabel, boundedMetadata(projectFromCwd(message.cwd), "Codex", 80), 80);
    const result = await publish({ queueRoot, event_id: idempotencyKey, kind: message.kind ?? "FINAL_RESPONSE", created_at: created.toISOString(), expires_at: new Date(created.getTime() + 604_800_000).toISOString(), thread: { id: message.threadId ?? "unknown-thread", turn_id: message.turnId ?? "unknown-turn", title: boundedMetadata(metadata?.title, "Codex thread", 120), project_label: projectLabel, cwd_label: boundedMetadata(metadata?.cwdLabel, projectLabel, 80) }, text: message.text, replyMode: message.replyMode ?? undefined, is_replyable: true, allowed_actions: ["REPLY"] });
    if (result?.event?.event_id !== idempotencyKey) throw new Error("SESSION_PUBLISH_ACK");
    return { idempotencyKey };
  };
}

export function createBridgeService({ config, stateRoot, validateConfig = validateBridgeConfig, validateSchemas = async () => {}, sessionWatcher, notificationGate = { flush: async () => ({ published: 0 }) }, replyDispatcher, uiRouterMonitor, sleep = abortableSleep, random = Math.random, now = () => new Date(), log = () => {}, heartbeatWriter = replaceJson }) {
  if (!sessionWatcher?.scanOnce || !notificationGate?.flush || !replyDispatcher?.scanOnce || (uiRouterMonitor !== undefined && typeof uiRouterMonitor?.check !== "function") || typeof stateRoot !== "string") throw new Error("SERVICE_CONFIG");
  let runPromise = null; const internal = new AbortController(); let initialized = false;
  async function initialize() { if (initialized) return; validateConfig(config); await validateSchemas(config); initialized = true; }
  async function loop(externalSignal) {
    await initialize();
    const onAbort = () => internal.abort(); externalSignal?.addEventListener("abort", onAbort, { once: true }); if (externalSignal?.aborted) internal.abort();
    try {
      while (!internal.signal.aborted) {
        let status = "ok";
        try { await sessionWatcher.scanOnce(); await notificationGate.flush({ signal: internal.signal }); await replyDispatcher.scanOnce(); await uiRouterMonitor?.check(); }
        catch { status = "degraded"; try { log(toTelegramSafeText("SERVICE_CYCLE_ERROR")); } catch {} }
        await heartbeatWriter(join(stateRoot, "bridge-v3", "heartbeat.json"), { schema: "hermes-codex-bridge-heartbeat/v3", observed_at: now().toISOString(), status });
        if (internal.signal.aborted) break;
        const minimum = Number.isFinite(config?.pollMinMs) ? config.pollMinMs : 1000; const maximum = Number.isFinite(config?.pollMaxMs) ? config.pollMaxMs : 1500;
        await sleep(Math.round(minimum + Math.max(0, Math.min(1, random())) * (maximum - minimum)), internal.signal);
      }
    } finally { externalSignal?.removeEventListener("abort", onAbort); }
  }
  return {
    run({ signal } = {}) { runPromise ??= loop(signal); return runPromise; },
    async stop({ timeoutMs = 2000 } = {}) { internal.abort(); if (!runPromise) return; await Promise.race([runPromise, new Promise((resolve) => setTimeout(resolve, timeoutMs))]); },
  };
}
