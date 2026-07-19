import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { acquireServiceLock, createInboundComponents, doctorForConfig, loadConfig, statusForConfig } from "../src/cli.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hc3-cli-"));
  const paths = { queueRoot: join(root, "queue", "bridge", "v3"), codexHome: join(root, "codex"), stateRoot: join(root, "state"), workspace: join(root, "workspace"), command: process.execPath };
  for (const path of [paths.queueRoot, join(paths.codexHome, "sessions"), paths.stateRoot, paths.workspace]) await mkdir(path, { recursive: true });
  const config = { schema: "hermes-codex-bridge-config/v3", queueRoot: paths.queueRoot, codexHome: paths.codexHome, codexCommand: paths.command, stateRoot: paths.stateRoot, allowedWorkspaceRoots: [paths.workspace], pollMinMs: 1000, pollMaxMs: 1500, replyTtlSeconds: 604800, approvalTtlSeconds: 43200, uiRouterMode: "external" };
  const configPath = join(root, "config.json"); await writeFile(configPath, JSON.stringify(config));
  return { root, paths, config, configPath };
}

test("strict config loader validates exact nonsecret physical boundaries", async () => {
  const f = await fixture();
  assert.equal((await loadConfig(f.configPath)).schema, "hermes-codex-bridge-config/v3");
  for (const bad of [{ ...f.config, token: "x" }, { ...f.config, queueRoot: f.paths.codexHome }, { ...f.config, pollMinMs: 1 }, { ...f.config, allowedWorkspaceRoots: [join(f.root, "missing")] }, { ...f.config, allowedWorkspaceRoots: [f.paths.queueRoot] }, { ...f.config, uiRouterMode: "sometimes" }]) {
    await writeFile(f.configPath, JSON.stringify(bad));
    await assert.rejects(loadConfig(f.configPath), /CONFIG_/u);
  }
});

test("native mode injects the UI action store while external mode keeps the fallback", async () => {
  const f = await fixture();
  for (const mode of ["external", "native"]) {
    const observed = { stores: 0 };
    const components = createInboundComponents({ ...f.config, uiRouterMode: mode }, {
      driver: { name: "driver" },
      notificationGate: { observe: async () => {}, name: "gate" },
      watcherFactory: (options) => { observed.watcher = options; return { name: "watcher" }; },
      dispatcherFactory: (options) => { observed.dispatcher = options; return { name: "dispatcher" }; },
      uiActionStoreFactory: (options) => { observed.stores += 1; observed.storeOptions = options; return { name: "ui-store" }; },
    });
    assert.equal(components.sessionWatcher.name, "watcher");
    assert.equal(components.replyDispatcher.name, "dispatcher");
    assert.equal(observed.watcher.routerRegistryPath, join(f.paths.queueRoot, "ui-router.json"));
    assert.equal(observed.stores, mode === "native" ? 1 : 0);
    assert.equal(observed.dispatcher.uiActionStore?.name, mode === "native" ? "ui-store" : undefined);
  }
});

test("config accepts a workspace parent while protected directories remain distinct", async () => {
  const f = await fixture();
  const broad = { ...f.config, allowedWorkspaceRoots: [f.root] };
  await writeFile(f.configPath, JSON.stringify(broad));
  assert.deepEqual((await loadConfig(f.configPath)).allowedWorkspaceRoots, [f.root]);
});

test("config resolves the runtime Codex command before returning", async () => {
  const f = await fixture();
  let observed = null;
  const loaded = await loadConfig(f.configPath, {
    resolveCommand: async ({ configured }) => {
      observed = configured;
      return configured;
    },
  });
  assert.equal(observed, f.paths.command);
  assert.equal(loaded.codexCommand, f.paths.command);
});

test("CLI uses stable invalid and unhealthy exit codes without private JSON paths", async () => {
  const f = await fixture();
  await writeFile(f.configPath, "{}");
  let result = spawnSync(process.execPath, [resolve("src/cli.mjs"), "validate-config", "--config", f.configPath], { cwd: resolve("."), encoding: "utf8" });
  assert.equal(result.status, 2); assert.doesNotMatch(result.stderr, new RegExp(f.root.replaceAll("\\", "\\\\"), "iu"));
  await writeFile(f.configPath, JSON.stringify(f.config));
  result = spawnSync(process.execPath, [resolve("src/cli.mjs"), "status", "--config", f.configPath, "--json"], { cwd: resolve("."), encoding: "utf8" });
  assert.equal(result.status, 3);
  const output = JSON.parse(result.stdout); assert.equal(output.healthy, false); assert.equal(JSON.stringify(output).includes(f.root), false);
});

test("heartbeat status becomes healthy and smoke never touches Telegram", async () => {
  const f = await fixture();
  await mkdir(join(f.paths.stateRoot, "bridge-v3"), { recursive: true });
  await writeFile(join(f.paths.stateRoot, "bridge-v3", "heartbeat.json"), JSON.stringify({ schema: "hermes-codex-bridge-heartbeat/v3", observed_at: new Date().toISOString(), status: "ok" }));
  assert.equal((await statusForConfig(await loadConfig(f.configPath))).healthy, true);
  const result = spawnSync(process.execPath, [resolve("src/cli.mjs"), "smoke", "--config", f.configPath], { cwd: resolve("."), encoding: "utf8", env: { ...process.env, HERMES_TELEGRAM_TOKEN: "must-not-be-read" } });
  assert.equal(result.status, 0); assert.match(result.stdout, /SMOKE_OK/u); assert.doesNotMatch(result.stdout + result.stderr, /must-not-be-read/u);
});

test("doctor reports only redacted named checks and uses fresh heartbeats as stable health evidence", async () => {
  const f = await fixture();
  const observedAt = "2026-07-19T12:00:00.000Z";
  await mkdir(join(f.paths.stateRoot, "bridge-v3"), { recursive: true });
  await writeFile(join(f.paths.stateRoot, "bridge-v3", "heartbeat.json"), JSON.stringify({ schema: "hermes-codex-bridge-heartbeat/v3", observed_at: observedAt, status: "ok" }));
  await writeFile(join(f.paths.queueRoot, "ui-router-heartbeat.json"), JSON.stringify({ schema: "hermes-codex-ui-router-heartbeat/v3", thread_id: "router-thread", observed_at: observedAt }));

  const report = await doctorForConfig({ ...await loadConfig(f.configPath), uiRouterMode: "native" }, () => new Date("2026-07-19T12:00:10.000Z"));
  assert.equal(report.schema, "hermes-codex-bridge-doctor/v3");
  assert.equal(report.healthy, true);
  assert.deepEqual(Object.keys(report.checks), ["config", "codexHome", "queue", "serviceHeartbeat", "uiRouterHeartbeat"]);
  assert.equal(report.checks.serviceHeartbeat.code, "DOCTOR_SERVICE_HEARTBEAT_OK");
  assert.equal(report.checks.uiRouterHeartbeat.code, "DOCTOR_UI_ROUTER_HEARTBEAT_OK");
  assert.equal(JSON.stringify(report).includes(f.root), false);
  assert.equal(JSON.stringify(report).includes(observedAt), false);
});

test("doctor returns stable unhealthy codes for stale service and required UI router heartbeats", async () => {
  const f = await fixture();
  await mkdir(join(f.paths.stateRoot, "bridge-v3"), { recursive: true });
  await writeFile(join(f.paths.stateRoot, "bridge-v3", "heartbeat.json"), JSON.stringify({ schema: "hermes-codex-bridge-heartbeat/v3", observed_at: "2026-07-19T11:00:00.000Z", status: "ok" }));
  const report = await doctorForConfig({ ...await loadConfig(f.configPath), uiRouterMode: "native" }, () => new Date("2026-07-19T12:00:00.000Z"));
  assert.equal(report.healthy, false);
  assert.equal(report.checks.serviceHeartbeat.code, "DOCTOR_SERVICE_HEARTBEAT_STALE");
  assert.equal(report.checks.uiRouterHeartbeat.code, "DOCTOR_UI_ROUTER_HEARTBEAT_MISSING");
});

test("doctor rejects a fresh service heartbeat unless its status is exactly ok", async () => {
  const f = await fixture();
  await mkdir(join(f.paths.stateRoot, "bridge-v3"), { recursive: true });
  await writeFile(join(f.paths.stateRoot, "bridge-v3", "heartbeat.json"), JSON.stringify({ schema: "hermes-codex-bridge-heartbeat/v3", observed_at: "2026-07-19T12:00:00.000Z", status: "degraded" }));
  const report = await doctorForConfig(await loadConfig(f.configPath), () => new Date("2026-07-19T12:00:10.000Z"));
  assert.equal(report.healthy, false);
  assert.equal(report.checks.serviceHeartbeat.code, "DOCTOR_SERVICE_HEARTBEAT_INVALID");
});

test("doctor CLI emits redacted JSON even when configuration is invalid", async () => {
  const f = await fixture();
  await writeFile(f.configPath, JSON.stringify({ token: "never-print-this", privatePath: f.root }));
  const result = spawnSync(process.execPath, [resolve("src/cli.mjs"), "doctor", "--config", f.configPath, "--json"], { cwd: resolve("."), encoding: "utf8" });
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stdout);
  assert.equal(report.healthy, false);
  assert.equal(report.checks.config.code, "DOCTOR_CONFIG_INVALID");
  assert.doesNotMatch(result.stdout + result.stderr, /never-print-this/u);
  assert.equal((result.stdout + result.stderr).includes(f.root), false);
});

test("service lock reclaims a dead or stale reused PID but refuses a fresh live PID", async () => {
  const f = await fixture();
  const lockPath = join(f.paths.stateRoot, "bridge-v3", "service.lock");
  await mkdir(join(f.paths.stateRoot, "bridge-v3"), { recursive: true });
  await writeFile(lockPath, "999999\n", "utf8");

  const lock = await acquireServiceLock(lockPath, { pid: 4242, isProcessAlive: () => false });
  assert.equal(await readFile(lockPath, "utf8"), "4242\n");
  await lock.close();

  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);
  const reused = await acquireServiceLock(lockPath, { pid: 4343, isProcessAlive: () => true, staleAfterMs: 30_000 });
  assert.equal(await readFile(lockPath, "utf8"), "4343\n");
  await reused.close();

  await assert.rejects(
    acquireServiceLock(lockPath, { pid: 4444, isProcessAlive: () => true, staleAfterMs: 30_000 }),
    (error) => error?.code === "SAFETY_SINGLE_INSTANCE" && error?.message === "SAFETY_SINGLE_INSTANCE",
  );
});

test("hook launcher injects only nonsecret config paths and accepts exact hook event", async () => {
  const f = await fixture();
  const result = spawnSync(process.execPath, [resolve("src/hook-launcher.mjs"), "--config", f.configPath, "--adapter", resolve("src/hook-adapter.mjs"), "Stop"], { cwd: resolve("."), encoding: "utf8", input: JSON.stringify({ session_id: "safe-session" }) });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout) instanceof Object, true);
  const ingress = await import("node:fs/promises").then(({ readdir }) => readdir(join(f.paths.stateRoot, "ingress")));
  assert.equal(ingress.length, 1);

  const session = spawnSync(process.execPath, [resolve("src/hook-launcher.mjs"), "--config", f.configPath, "--adapter", resolve("src/hook-adapter.mjs"), "SessionStart"], { cwd: resolve("."), encoding: "utf8", input: JSON.stringify({ session_id: "safe-session" }) });
  assert.equal(session.status, 0, session.stderr);
  assert.match(JSON.parse(session.stdout).hookSpecificOutput.additionalContext, /HC3:WAITING_FOR_INPUT/u);
});
