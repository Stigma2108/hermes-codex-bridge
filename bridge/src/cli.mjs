#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AppServerClient } from "./app-server-client.mjs";
import { createCodexThreadMetadataResolver, createSessionPublishAdapter, createBridgeService, createUiRouterMonitor } from "./service.mjs";
import { createSessionWatcher } from "./session-watcher.mjs";
import { openCandidateStore } from "./candidate-store.mjs";
import { createNotificationGate } from "./notification-gate.mjs";
import { createWindowsPresenceProbe } from "./windows-presence.mjs";
import { resolveCodexCommand } from "./codex-command-resolver.mjs";
import { createReplyDispatcher } from "./reply-dispatcher.mjs";
import { createThreadDriver } from "./thread-driver.mjs";
import { publishEvent } from "./event-publisher.mjs";
import { classifyApproval } from "./policy.mjs";
import { installHooks, uninstallHooks } from "./hook-installer.mjs";
import { createUiActionStore } from "./ui-action-store.mjs";

export const EXIT = Object.freeze({ OK: 0, INVALID_CONFIG: 2, UNHEALTHY: 3, SAFETY_REFUSAL: 4, PARTIAL_UNINSTALL: 5 });
const CONFIG_KEYS = Object.freeze(["schema", "queueRoot", "codexHome", "codexCommand", "stateRoot", "allowedWorkspaceRoots", "pollMinMs", "pollMaxMs", "replyTtlSeconds", "approvalTtlSeconds", "uiRouterMode"]);
const SECRET_KEY = /(?:token|chat.?id|password|secret|credential|api.?key)/iu;
const here = dirname(fileURLToPath(import.meta.url));

function fail(code) { const error = new Error(code); error.code = code; return error; }
function contained(parent, child) { const value = relative(parent.toLowerCase(), child.toLowerCase()); return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value)); }
function scanSecretKeys(value) { if (!value || typeof value !== "object") return; for (const [key, item] of Object.entries(value)) { if (SECRET_KEY.test(key)) throw fail("CONFIG_SECRET_KEY"); scanSecretKeys(item); } }
async function atomicJson(path, value) { const partial = `${path}.${randomUUID()}.partial`; let handle; try { handle = await open(partial, "wx", 0o600); await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); await handle.close(); handle = undefined; await rename(partial, path); } catch (error) { try { await handle?.close(); } catch {} try { await rm(partial, { force: true }); } catch {} throw error; } }

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

export async function acquireServiceLock(lockPath, { pid = process.pid, isProcessAlive = processIsAlive, heartbeatPath, staleAfterMs = 30_000 } = {}) {
  async function create() {
    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${pid}\n`);
      await handle.sync();
      return handle;
    } catch (error) {
      try { await handle?.close(); } catch {}
      if (handle) try { await rm(lockPath); } catch {}
      throw error;
    }
  }

  try { return await create(); }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  let ownerPid = null;
  let lockAgeMs = Number.POSITIVE_INFINITY;
  try {
    const contents = await readFile(lockPath, "utf8");
    if (/^[1-9]\d{0,9}\n?$/u.test(contents)) ownerPid = Number.parseInt(contents, 10);
    lockAgeMs = Math.max(0, Date.now() - (await stat(lockPath)).mtimeMs);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let heartbeatFresh = false;
  if (heartbeatPath) {
    try {
      const heartbeat = JSON.parse(await readFile(heartbeatPath, "utf8"));
      const age = Date.now() - Date.parse(heartbeat?.observed_at);
      heartbeatFresh = heartbeat?.schema === "hermes-codex-bridge-heartbeat/v3" && Number.isFinite(age) && age >= -60_000 && age <= staleAfterMs;
    } catch {}
  }
  if ((ownerPid === null && lockAgeMs <= staleAfterMs) ||
      (ownerPid !== null && isProcessAlive(ownerPid) && (lockAgeMs <= staleAfterMs || heartbeatFresh))) {
    throw fail("SAFETY_SINGLE_INSTANCE");
  }
  try { await rm(lockPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  try { return await create(); }
  catch (error) { if (error?.code === "EEXIST") throw fail("SAFETY_SINGLE_INSTANCE"); throw error; }
}

export async function loadConfig(path, { resolveCommand = resolveCodexCommand } = {}) {
  if (typeof path !== "string" || !isAbsolute(path)) throw fail("CONFIG_PATH");
  let value; try { value = JSON.parse(await readFile(path, "utf8")); } catch { throw fail("CONFIG_JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\0") !== [...CONFIG_KEYS].sort().join("\0")) throw fail("CONFIG_SHAPE");
  scanSecretKeys(value);
  if (value.schema !== "hermes-codex-bridge-config/v3") throw fail("CONFIG_SCHEMA");
  for (const key of ["queueRoot", "codexHome", "codexCommand", "stateRoot"]) if (typeof value[key] !== "string" || !isAbsolute(value[key]) || value[key].includes("\0")) throw fail(`CONFIG_${key.toUpperCase()}`);
  if (!Array.isArray(value.allowedWorkspaceRoots) || value.allowedWorkspaceRoots.length < 1 || value.allowedWorkspaceRoots.some((item) => typeof item !== "string" || !isAbsolute(item))) throw fail("CONFIG_ALLOWED_ROOTS");
  if (!Number.isInteger(value.pollMinMs) || !Number.isInteger(value.pollMaxMs) || value.pollMinMs < 100 || value.pollMaxMs < value.pollMinMs || value.pollMaxMs > 60000) throw fail("CONFIG_POLL");
  if (value.replyTtlSeconds !== 604800 || value.approvalTtlSeconds !== 43200) throw fail("CONFIG_TTL");
  if (!["external", "native"].includes(value.uiRouterMode)) throw fail("CONFIG_UI_ROUTER");
  let resolvedCommand;
  try { resolvedCommand = await resolveCommand({ configured: value.codexCommand, localAppData: process.env.LOCALAPPDATA }); } catch { throw fail("CONFIG_CODEXCOMMAND"); }
  if (typeof resolvedCommand !== "string" || !isAbsolute(resolvedCommand) || resolvedCommand.includes("\0")) throw fail("CONFIG_CODEXCOMMAND");
  let queue; let codex; let state; let command; let roots;
  try { [queue, codex, state, command, ...roots] = await Promise.all([realpath(value.queueRoot), realpath(value.codexHome), realpath(value.stateRoot), realpath(resolvedCommand), ...value.allowedWorkspaceRoots.map((item) => realpath(item))]); } catch { throw fail("CONFIG_PHYSICAL_PATH"); }
  if (!/[\\/]queue[\\/]bridge[\\/]v3$/iu.test(queue) || contained(codex, queue) || contained(queue, codex) || contained(state, queue) || contained(queue, state) || contained(codex, state) || contained(state, codex)) throw fail("CONFIG_BOUNDARY");
  if (roots.some((root) => [queue, codex, state].some((protectedRoot) => contained(protectedRoot, root)))) throw fail("CONFIG_ALLOWED_BOUNDARY");
  if (roots.some((root, index) => roots.some((other, otherIndex) => index !== otherIndex && root.toLowerCase() === other.toLowerCase()))) throw fail("CONFIG_ALLOWED_ROOTS");
  if (!(await stat(command)).isFile() || !(await stat(queue)).isDirectory() || !(await stat(codex)).isDirectory() || !(await stat(state)).isDirectory()) throw fail("CONFIG_PHYSICAL_PATH");
  return Object.freeze({ ...value, codexCommand: command, allowedWorkspaceRoots: Object.freeze([...value.allowedWorkspaceRoots]) });
}

function hookCommand(configPath) { return `"${process.execPath}" "${join(here, "hook-launcher.mjs")}" --config "${configPath}" --adapter "${join(here, "hook-adapter.mjs")}"`; }

export async function statusForConfig(config, now = () => new Date()) {
  let heartbeat = null;
  try { heartbeat = JSON.parse(await readFile(join(config.stateRoot, "bridge-v3", "heartbeat.json"), "utf8")); } catch {}
  const ageMs = heartbeat && Number.isFinite(Date.parse(heartbeat.observed_at)) ? now().getTime() - Date.parse(heartbeat.observed_at) : null;
  const fresh = ageMs !== null && ageMs >= -60000 && ageMs <= Math.max(30000, config.pollMaxMs * 10);
  let running = false; try { running = (await stat(join(config.stateRoot, "bridge-v3", "service.lock"))).isFile(); } catch {}
  const healthy = Boolean(fresh && heartbeat?.schema === "hermes-codex-bridge-heartbeat/v3" && heartbeat?.status === "ok");
  return { schema: "hermes-codex-bridge-status/v3", healthy, heartbeat: { fresh, status: heartbeat?.status === "ok" ? "ok" : "unknown" }, process: { running }, task: { state: "not-observed" } };
}

function doctorCheck(status, code) {
  return Object.freeze({ status, code });
}

async function directoryDoctorCheck(path, okCode, missingCode) {
  try {
    return (await stat(path)).isDirectory() ? doctorCheck("ok", okCode) : doctorCheck("error", missingCode);
  } catch {
    return doctorCheck("error", missingCode);
  }
}

async function heartbeatDoctorCheck(path, { schema, requiredStatus, okCode, missingCode, invalidCode, staleCode, maxAgeMs, now }) {
  let value;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { return doctorCheck("error", error?.code === "ENOENT" ? missingCode : invalidCode); }
  const ageMs = now().getTime() - Date.parse(value?.observed_at);
  if (value?.schema !== schema || (requiredStatus !== undefined && value?.status !== requiredStatus) || !Number.isFinite(ageMs) || ageMs < -60_000) return doctorCheck("error", invalidCode);
  if (ageMs > maxAgeMs) return doctorCheck("error", staleCode);
  return doctorCheck("ok", okCode);
}

export async function doctorForConfig(config, now = () => new Date()) {
  const serviceHeartbeat = await heartbeatDoctorCheck(join(config.stateRoot, "bridge-v3", "heartbeat.json"), {
    schema: "hermes-codex-bridge-heartbeat/v3",
    requiredStatus: "ok",
    okCode: "DOCTOR_SERVICE_HEARTBEAT_OK",
    missingCode: "DOCTOR_SERVICE_HEARTBEAT_MISSING",
    invalidCode: "DOCTOR_SERVICE_HEARTBEAT_INVALID",
    staleCode: "DOCTOR_SERVICE_HEARTBEAT_STALE",
    maxAgeMs: Math.max(30_000, config.pollMaxMs * 10),
    now,
  });
  const uiRouterHeartbeat = config.uiRouterMode === "native"
    ? await heartbeatDoctorCheck(join(config.queueRoot, "ui-router-heartbeat.json"), {
      schema: "hermes-codex-ui-router-heartbeat/v3",
      okCode: "DOCTOR_UI_ROUTER_HEARTBEAT_OK",
      missingCode: "DOCTOR_UI_ROUTER_HEARTBEAT_MISSING",
      invalidCode: "DOCTOR_UI_ROUTER_HEARTBEAT_INVALID",
      staleCode: "DOCTOR_UI_ROUTER_HEARTBEAT_STALE",
      maxAgeMs: 180_000,
      now,
    })
    : doctorCheck("skipped", "DOCTOR_UI_ROUTER_EXTERNAL");
  const checks = Object.freeze({
    config: doctorCheck("ok", "DOCTOR_CONFIG_OK"),
    codexHome: await directoryDoctorCheck(config.codexHome, "DOCTOR_CODEX_HOME_OK", "DOCTOR_CODEX_HOME_MISSING"),
    queue: await directoryDoctorCheck(config.queueRoot, "DOCTOR_QUEUE_OK", "DOCTOR_QUEUE_MISSING"),
    serviceHeartbeat,
    uiRouterHeartbeat,
  });
  return Object.freeze({
    schema: "hermes-codex-bridge-doctor/v3",
    healthy: Object.values(checks).every((check) => check.status !== "error"),
    checks,
  });
}

function invalidDoctorReport() {
  const skipped = doctorCheck("skipped", "DOCTOR_NOT_RUN");
  return {
    schema: "hermes-codex-bridge-doctor/v3",
    healthy: false,
    checks: {
      config: doctorCheck("error", "DOCTOR_CONFIG_INVALID"),
      codexHome: skipped,
      queue: skipped,
      serviceHeartbeat: skipped,
      uiRouterHeartbeat: skipped,
    },
  };
}

async function createLazyDriver(config, resolveThreadMetadata) {
  let resources;
  async function start() {
    if (!resources) resources = (async () => {
      const client = await AppServerClient.spawn(config.codexCommand, ["app-server"], { stderrSink: () => {}, requestTimeoutMs: 30_000 });
      await client.initialize({ name: "hermes-codex-bridge", title: "Hermes Codex Bridge", version: "3.0.0", capabilities: { experimentalApi: false, requestAttestation: false } });
      const publish = async (input, { idempotencyKey } = {}) => {
        const created = input.created_at ?? new Date().toISOString();
        const metadata = await resolveThreadMetadata({ threadId: input.threadId, cwd: input.cwd });
        const result = await publishEvent({ queueRoot: config.queueRoot, event_id: input.event_id ?? idempotencyKey, kind: input.kind, created_at: created, expires_at: new Date(Date.parse(created) + (input.kind === "APPROVAL_REQUEST" ? config.approvalTtlSeconds : config.replyTtlSeconds) * 1000).toISOString(), thread: { id: input.threadId, turn_id: input.turnId ?? "pending", title: metadata.title, project_label: metadata.projectLabel, cwd_label: metadata.cwdLabel }, text: input.text, replyMode: input.kind === "QUESTION" ? "LIVE_REQUEST" : undefined, is_replyable: true, allowed_actions: input.allowed_actions });
        return { idempotencyKey: result.event.event_id };
      };
      const driver = createThreadDriver({
        client,
        publish,
        policy: (request) => classifyApproval(request, config),
        stateRoot: config.stateRoot,
      });
      return { client, driver };
    })();
    return resources;
  }
  return {
    async readThread(threadId) { return (await start()).driver.readThread(threadId); },
    async reply(input) { return (await start()).driver.reply(input); },
    async resolveInteraction(input) { return (await start()).driver.resolveInteraction(input); },
    async close() { if (!resources) return; const current = await resources; await current.driver.close(); await current.client.close(); },
  };
}

export function createInboundComponents(config, {
  driver,
  notificationGate,
  watcherFactory = createSessionWatcher,
  dispatcherFactory = createReplyDispatcher,
  uiActionStoreFactory = createUiActionStore,
} = {}) {
  const uiActionStore = config.uiRouterMode === "native" ? uiActionStoreFactory({ queueRoot: config.queueRoot }) : undefined;
  const sessionWatcher = watcherFactory({
    sessionsRoot: join(config.codexHome, "sessions"),
    ledgerPath: join(config.stateRoot, "bridge-v3", "sessions.state"),
    routerRegistryPath: join(config.queueRoot, "ui-router.json"),
    publish: notificationGate.observe,
  });
  const replyDispatcher = dispatcherFactory({
    queueRoot: config.queueRoot,
    stateRoot: config.stateRoot,
    threadDriver: driver,
    replyGuard: notificationGate,
    uiActionStore,
  });
  return { sessionWatcher, replyDispatcher, uiActionStore };
}

async function runService(config, { presenceScriptPath } = {}) {
  const lockPath = join(config.stateRoot, "bridge-v3", "service.lock");
  await mkdir(dirname(lockPath), { recursive: true });
  const lock = await acquireServiceLock(lockPath, { heartbeatPath: join(config.stateRoot, "bridge-v3", "heartbeat.json") });
  const globalStatePath = join(config.codexHome, ".codex-global-state.json");
  let resolveThreadMetadata = createCodexThreadMetadataResolver({ globalStatePath });
  const driver = await createLazyDriver(config, (message) => resolveThreadMetadata(message));
  resolveThreadMetadata = createCodexThreadMetadataResolver({ readThread: (threadId) => driver.readThread(threadId), globalStatePath });
  const candidateStore = await openCandidateStore(join(config.stateRoot, "bridge-v3", "candidates"));
  const notificationGate = createNotificationGate({ store: candidateStore, publish: createSessionPublishAdapter({ queueRoot: config.queueRoot, resolveThreadMetadata }), presence: createWindowsPresenceProbe(presenceScriptPath ? { scriptPath: presenceScriptPath } : undefined) });
  const { sessionWatcher, replyDispatcher, uiActionStore } = createInboundComponents(config, { driver, notificationGate });
  const uiRouterMonitor = uiActionStore ? createUiRouterMonitor({ queueRoot: config.queueRoot, uiActionStore }) : undefined;
  const service = createBridgeService({ config, stateRoot: config.stateRoot, sessionWatcher, notificationGate, replyDispatcher, uiRouterMonitor });
  const controller = new AbortController(); const stop = () => controller.abort(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try { await service.run({ signal: controller.signal }); }
  finally { await service.stop({ timeoutMs: 5000 }); await sessionWatcher.close(); await replyDispatcher.close(); await candidateStore.close(); await driver.close(); await lock.close(); try { await import("node:fs/promises").then(({ unlink }) => unlink(lockPath)); } catch {} process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}

function option(argv, name) { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; }

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0]; const configPath = option(argv, "--config");
  let config;
  try { config = await loadConfig(configPath); }
  catch {
    if (command === "doctor") process.stdout.write(`${JSON.stringify(invalidDoctorReport())}\n`);
    else process.stderr.write("CONFIG_INVALID\n");
    return EXIT.INVALID_CONFIG;
  }
  try {
    if (command === "validate-config") process.stdout.write("CONFIG_OK\n");
    else if (command === "install-hooks") {
      const hooksPath = join(config.codexHome, "hooks.json"); const before = JSON.parse(await readFile(hooksPath, "utf8"));
      const ownershipPath = join(config.stateRoot, "bridge-v3", "hook-ownership.json"); let priorNames = [];
      try { const prior = JSON.parse(await readFile(ownershipPath, "utf8")); if (prior?.schema === "hermes-codex-hook-ownership/v3" && Array.isArray(prior.createdNames)) priorNames = prior.createdNames; } catch {}
      const hookNames = ["SessionStart", "Stop", "PermissionRequest"];
      const createdNames = [...new Set([...priorNames, ...hookNames.filter((name) => !Object.hasOwn(before.hooks, name))])].filter((name) => hookNames.includes(name));
      await installHooks({ hooksPath, command: hookCommand(configPath) });
      await mkdir(dirname(ownershipPath), { recursive: true });
      await atomicJson(ownershipPath, { schema: "hermes-codex-hook-ownership/v3", createdNames });
    }
    else if (command === "uninstall-hooks") {
      let createdNames = []; try { const ownership = JSON.parse(await readFile(join(config.stateRoot, "bridge-v3", "hook-ownership.json"), "utf8")); if (ownership?.schema === "hermes-codex-hook-ownership/v3" && Array.isArray(ownership.createdNames)) createdNames = ownership.createdNames.filter((name) => ["SessionStart", "Stop", "PermissionRequest"].includes(name)); } catch {}
      const hooksPath = join(config.codexHome, "hooks.json"); await uninstallHooks({ hooksPath, command: hookCommand(configPath) });
      if (createdNames.length) { const hooks = JSON.parse(await readFile(hooksPath, "utf8")); let changed = false; for (const name of createdNames) if (Array.isArray(hooks.hooks?.[name]) && hooks.hooks[name].length === 0) { delete hooks.hooks[name]; changed = true; } if (changed) await atomicJson(hooksPath, hooks); }
    }
    else if (command === "status") { const status = await statusForConfig(config); process.stdout.write(argv.includes("--json") ? `${JSON.stringify(status)}\n` : `${status.healthy ? "HEALTHY" : "UNHEALTHY"}\n`); return status.healthy ? EXIT.OK : EXIT.UNHEALTHY; }
    else if (command === "doctor") { const report = await doctorForConfig(config); process.stdout.write(`${JSON.stringify(report)}\n`); return report.healthy ? EXIT.OK : EXIT.UNHEALTHY; }
    else if (command === "smoke") { await stat(join(config.codexHome, "sessions")); await stat(join(config.queueRoot, "interactions")).catch((error) => { if (error.code !== "ENOENT") throw error; }); process.stdout.write("SMOKE_OK\n"); }
    else if (command === "run") await runService(config, { presenceScriptPath: option(argv, "--presence-script") });
    else { process.stderr.write("COMMAND_INVALID\n"); return EXIT.SAFETY_REFUSAL; }
    return EXIT.OK;
  } catch (error) {
    if (String(error?.code ?? error?.message).startsWith("SAFETY_")) { process.stderr.write("SAFETY_REFUSAL\n"); return EXIT.SAFETY_REFUSAL; }
    process.stderr.write(command === "uninstall-hooks" ? "UNINSTALL_PARTIAL\n" : "OPERATION_UNHEALTHY\n");
    return command === "uninstall-hooks" ? EXIT.PARTIAL_UNINSTALL : EXIT.UNHEALTHY;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then((code) => { process.exitCode = code; });
