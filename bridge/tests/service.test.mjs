import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBridgeService, createCodexThreadMetadataResolver, createSessionPublishAdapter, createUiRouterMonitor } from "../src/service.mjs";
import { createUiRouterHealth } from "../src/ui-router-health.mjs";

const validConfig = { schema: "hermes-codex-bridge-config/v3", queueRoot: join(tmpdir(), "fictional-queue"), pollMinMs: 1000, pollMaxMs: 1500 };

test("validates config/schema before sequential non-overlapping cycles and writes heartbeat", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "bridge-service-")); const order = []; const controller = new AbortController(); let sleeps = 0; let active = 0;
  const service = createBridgeService({ config: { schema: "ok" }, stateRoot, validateConfig: () => order.push("config"), validateSchemas: async () => order.push("schemas"), sessionWatcher: { scanOnce: async () => { assert.equal(active++, 0); order.push("watch"); active -= 1; } }, replyDispatcher: { scanOnce: async () => { assert.equal(active++, 0); order.push("dispatch"); active -= 1; } }, sleep: async (ms) => { assert.ok(ms >= 1000 && ms <= 1500); if (++sleeps === 2) controller.abort(); }, random: () => 0.5, now: () => new Date("2026-07-18T12:00:00Z") });
  await service.run({ signal: controller.signal });
  assert.deepEqual(order.slice(0, 4), ["config", "schemas", "watch", "dispatch"]); assert.equal(order.filter((x) => x === "watch").length, 2); assert.equal(order.filter((x) => x === "dispatch").length, 2);
  const heartbeat = JSON.parse(await readFile(join(stateRoot, "bridge-v3", "heartbeat.json"), "utf8")); assert.equal(heartbeat.schema, "hermes-codex-bridge-heartbeat/v3");
  await service.stop(); await service.stop();
});

test("cycle observes rollouts before flushing gate and dispatching replies", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "bridge-service-order-"));
  const order = [];
  const controller = new AbortController();
  const service = createBridgeService({ config: validConfig, stateRoot,
    sessionWatcher: { scanOnce: async () => order.push("observe") },
    notificationGate: { flush: async () => order.push("flush") },
    replyDispatcher: { scanOnce: async () => { order.push("dispatch"); } },
    uiRouterMonitor: { check: async () => { order.push("router-health"); controller.abort(); } },
    sleep: async () => {} });
  await service.run({ signal: controller.signal });
  assert.deepEqual(order, ["observe", "flush", "dispatch", "router-health"]);
});

test("native router monitor publishes one deterministic non-replyable safe warning", async () => {
  const calls = [];
  const snapshot = { readyCount: 1, oldestReadyAt: "2026-07-19T12:00:00Z", heartbeatAt: "2026-07-19T12:00:30Z" };
  const monitor = createUiRouterMonitor({
    queueRoot: join(tmpdir(), "queue", "bridge", "v3"),
    uiActionStore: { healthSnapshot: async () => snapshot },
    health: createUiRouterHealth({ now: () => new Date("2026-07-19T12:05:00Z") }),
    publish: async (input) => { calls.push(input); return { event: { event_id: input.event_id } }; },
  });
  assert.equal((await monitor.check()).action, "WARN");
  assert.equal((await monitor.check()).action, "NONE");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "ERROR");
  assert.equal(calls[0].is_replyable, false);
  assert.deepEqual(calls[0].allowed_actions, []);
  assert.deepEqual(calls[0].thread, { id: "hermes-codex-ui-router", turn_id: "router-health", title: "UI Router", project_label: "Hermes-Codex", cwd_label: "Hermes-Codex" });
  assert.equal(calls[0].text, "Codex UI router не обработал ожидающий Telegram-ответ более трёх минут. Ответ сохранён и будет повторён после восстановления Codex Desktop/router.");
  assert.match(calls[0].event_id, /^evt_[0-9a-f-]{36}$/u);
});

test("cycle errors are redacted, loop recovers, and fatal validation does no queue work", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "bridge-service-errors-")); const logs = []; const controller = new AbortController(); let attempts = 0; let dispatches = 0;
  const service = createBridgeService({ config: validConfig, stateRoot, sessionWatcher: { scanOnce: async () => { if (++attempts === 1) throw new Error("Bearer SERVICE_SECRET"); } }, replyDispatcher: { scanOnce: async () => { dispatches += 1; } }, log: (line) => logs.push(line), sleep: async () => { if (attempts >= 2) controller.abort(); } });
  await service.run({ signal: controller.signal }); assert.equal(attempts, 2); assert.equal(dispatches, 1); assert.doesNotMatch(logs.join(""), /SERVICE_SECRET/u);
  let queueCalls = 0; const fatal = createBridgeService({ config: validConfig, stateRoot, validateConfig: () => { throw new Error("CONFIG_INVALID"); }, sessionWatcher: { scanOnce: async () => { queueCalls += 1; } }, replyDispatcher: { scanOnce: async () => { queueCalls += 1; } } });
  await assert.rejects(fatal.run(), /CONFIG_INVALID/u); assert.equal(queueCalls, 0);
});

test("default config/schema validation fails before queue processing", async () => {
  let calls = 0; const stateRoot = await mkdtemp(join(tmpdir(), "bridge-service-invalid-")); const controller = new AbortController();
  const service = createBridgeService({ config: { schema: "wrong" }, stateRoot, sessionWatcher: { scanOnce: async () => { calls += 1; } }, replyDispatcher: { scanOnce: async () => { calls += 1; } }, sleep: async () => controller.abort() });
  await assert.rejects(service.run({ signal: controller.signal }), /SERVICE_CONFIG_SCHEMA/u); assert.equal(calls, 0);
});

test("session watcher adapter derives deterministic event and exact acknowledgment", async () => {
  const calls = []; const adapter = createSessionPublishAdapter({ queueRoot: "C:\\fictional-queue", publish: async (input) => { calls.push(input); return { event: { event_id: input.event_id } }; }, resolveThreadMetadata: async () => ({ title: "Название чата", projectLabel: "Komplektrybaka", cwdLabel: "Komplektrybaka" }), now: () => new Date("2026-07-18T12:00:00Z") });
  const eventId = ["evt_019f74b5", "c168", "7381", "9629", "d395da0255f7"].join("-");
  const ack = await adapter({ kind: "QUESTION", replyMode: "NEXT_TURN", text: "final", threadId: "T", turnId: "V", cwd: "D:\\Project Codex\\Komplektrybaka", eventId }, { idempotencyKey: eventId });
  assert.deepEqual(ack, { idempotencyKey: eventId }); assert.equal(calls[0].kind, "QUESTION"); assert.equal(calls[0].replyMode, "NEXT_TURN"); assert.deepEqual(calls[0].thread, { id: "T", turn_id: "V", title: "Название чата", project_label: "Komplektrybaka", cwd_label: "Komplektrybaka" });
});

test("Codex metadata resolver reads the chat title and derives the project from cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-codex-state-"));
  const statePath = join(root, ".codex-global-state.json");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(statePath, JSON.stringify({
    "electron-persisted-atom-state": { "thread-descriptions-v1": { T: "Каталог точных SKU" } },
    "thread-project-assignments": { T: { cwd: "D:\\Project Codex\\Komplektrybaka" } },
  })));
  const resolve = createCodexThreadMetadataResolver({ globalStatePath: statePath });
  assert.deepEqual(await resolve({ threadId: "T", cwd: "D:\\fallback\\Wrong" }), {
    title: "Каталог точных SKU",
    projectLabel: "Komplektrybaka",
    cwdLabel: "Komplektrybaka",
  });
});

test("live thread/read name wins over stale rollout description", async () => {
  const resolve = createCodexThreadMetadataResolver({
    readThread: async (threadId) => ({ thread: { id: threadId, name: "Добавить Telegram-мост для Hermes", cwd: "D:\\Tools\\Hermes-Codex" } }),
    globalStatePath: "C:\\missing.json",
  });
  assert.deepEqual(await resolve({ threadId: "T", cwd: "D:\\fallback\\Wrong", title: "komplektrybaka: старое описание" }), {
    title: "Добавить Telegram-мост для Hermes",
    projectLabel: "Hermes-Codex",
    cwdLabel: "Hermes-Codex",
  });
});

test("Codex metadata resolver falls back safely when global state is unavailable", async () => {
  const resolve = createCodexThreadMetadataResolver({ globalStatePath: join(tmpdir(), "missing-codex-state.json") });
  assert.deepEqual(await resolve({ threadId: "T", cwd: "D:\\Project Codex\\Knots" }), {
    title: "Codex thread",
    projectLabel: "Knots",
    cwdLabel: "Knots",
  });
});
