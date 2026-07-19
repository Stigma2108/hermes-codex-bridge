import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AppServerClient } from "../src/app-server-client.mjs";

const fake = fileURLToPath(new URL("fixtures/fake-app-server.mjs", import.meta.url));

async function client(mode = "normal", options = {}) { return AppServerClient.spawn(process.execPath, [fake, mode], options); }

test("initialize, correlates out-of-order responses, notification and server request", async () => {
  const rpc = await client();
  const initialized = await rpc.initialize({ name: "hermes_codex_bridge", title: "Hermes Codex Bridge", version: "3.0.0", capabilities: { experimentalApi: false } });
  assert.equal(initialized.accepted, true);
  const slow = rpc.request("slow", { value: 1 });
  const fast = rpc.request("fast", { value: 2 });
  assert.deepEqual(await fast, { value: 2 }); assert.deepEqual(await slow, { value: 1 });
  const notification = once(rpc, "notification");
  const serverRequest = once(rpc, "serverRequest");
  await rpc.notify("trigger/events", {});
  assert.equal((await notification)[0].method, "turn/started");
  const request = (await serverRequest)[0];
  assert.equal(request.method, "item/tool/requestUserInput");
  rpc.respond(request.id, { answers: {} });
  assert.deepEqual(await rpc.request("response/seen", {}), { answers: {} });
  await rpc.close(); await rpc.close();
});

test("server errors reject only their correlated request", async () => {
  const rpc = await client();
  await assert.rejects(rpc.request("server/error", {}), (error) => error.code === -32001 && error.message === "fictional failure");
  assert.deepEqual(await rpc.request("echo", { ok: true }), { ok: true });
  await rpc.close();
});

test("a timed-out request cannot block later app-server work", async () => {
  const rpc = await client();
  const outcome = await Promise.race([
    rpc.request("wait", {}, { timeoutMs: 5 }).then(
      () => "resolved",
      (error) => error.code,
    ),
    new Promise((resolve) => setTimeout(() => resolve("outer-timeout"), 50)),
  ]);
  assert.equal(outcome, "APP_SERVER_TIMEOUT");
  assert.deepEqual(await rpc.request("echo", { ok: true }), { ok: true });
  await rpc.close();
});

test("configured default timeout bounds every app-server request", async () => {
  const rpc = await client("normal", { requestTimeoutMs: 5 });
  await assert.rejects(rpc.request("wait", {}), (error) => error.code === "APP_SERVER_TIMEOUT");
  assert.deepEqual(await rpc.request("echo", { ok: true }, { timeoutMs: 2_000 }), { ok: true });
  await rpc.close();
});

for (const [mode, code] of [["malformed", "APP_SERVER_PROTOCOL"], ["oversize", "APP_SERVER_LINE_TOO_LARGE"], ["exit", "APP_SERVER_EXIT"]]) {
  test(`${mode} input rejects all pending with stable ${code}`, async () => {
    const rpc = await client(mode);
    await assert.rejects(rpc.request("wait", {}), (error) => error.code === code);
    await rpc.close();
  });
}

test("stderr is redacted before optional sink and is never printed by default", async () => {
  const lines = [];
  const rpc = await client("stderr", { stderrSink: (line) => lines.push(line) });
  await rpc.request("echo", { ok: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(lines.length, 1); assert.doesNotMatch(lines[0], /SUPERSECRET/u); assert.match(lines[0], /\[REDACTED\]/u);
  await rpc.close();
});

test("respondError sends exact JSON-RPC-ish error shape", async () => {
  const rpc = await client(); const serverRequest = once(rpc, "serverRequest");
  await rpc.notify("trigger/events", {}); const request = (await serverRequest)[0];
  rpc.respondError(request.id, 4001, "declined");
  assert.deepEqual(await rpc.request("response/seen", {}), { error: { code: 4001, message: "declined" } });
  await rpc.close();
});

test("an app-server error notification is namespaced and never becomes an EventEmitter error", async () => {
  const rpc = await client(); let rawErrors = 0; const namespaced = [];
  rpc.on("error", () => { rawErrors += 1; });
  rpc.on("notification:error", (params) => namespaced.push(params));
  assert.deepEqual(await rpc.request("trigger/error-notification", {}), { sent: true });
  assert.equal(rawErrors, 0);
  assert.deepEqual(namespaced, [{ error: { message: "fictional retry" }, willRetry: true }]);
  await rpc.close();
});
