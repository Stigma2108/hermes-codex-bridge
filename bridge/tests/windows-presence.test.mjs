import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { createWindowsPresenceProbe, runPowerShellProbe } from "../src/windows-presence.mjs";

const windowsTest = process.platform === "win32" ? test : test.skip;

test("maps idle and locked probe output without retaining input details", async () => {
  const desk = createWindowsPresenceProbe({ run: async () => '{"locked":false,"idleMs":1200}' });
  const idle = createWindowsPresenceProbe({ run: async () => '{"locked":false,"idleMs":90000}' });
  const locked = createWindowsPresenceProbe({ run: async () => '{"locked":true,"idleMs":0}' });
  assert.deepEqual(await desk.sample({ awayIdleMs: 90_000 }), { state: "DESK", idleMs: 1200 });
  assert.deepEqual(await idle.sample({ awayIdleMs: 90_000 }), { state: "AWAY", idleMs: 90000 });
  assert.deepEqual(await locked.sample({ awayIdleMs: 90_000 }), { state: "AWAY", idleMs: 0 });
});

test("malformed, oversized, or failed probe becomes UNKNOWN", async () => {
  for (const run of [
    async () => "not-json",
    async () => '{"locked":"no","idleMs":0}',
    async () => '{"locked":false,"idleMs":-1}',
    async () => { throw new Error("probe failed"); },
  ]) {
    const probe = createWindowsPresenceProbe({ run });
    assert.deepEqual(await probe.sample({ awayIdleMs: 90_000 }), { state: "UNKNOWN", idleMs: null });
  }
});

windowsTest("production runner uses hidden non-shell PowerShell with bounded output", async () => {
  let observed;
  const spawn = (command, args, options) => {
    observed = { command, args, options };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from('{"locked":false,"idleMs":7}'));
      child.emit("close", 0, null);
    });
    return child;
  };
  assert.equal(await runPowerShellProbe({ scriptPath: "C:\\bridge\\Get-WindowsPresence.ps1", spawn, timeoutMs: 100 }), '{"locked":false,"idleMs":7}');
  assert.equal(observed.command, "pwsh.exe");
  assert.deepEqual(observed.args, ["-NoProfile", "-NonInteractive", "-File", "C:\\bridge\\Get-WindowsPresence.ps1"]);
  assert.equal(observed.options.windowsHide, true);
  assert.equal(observed.options.shell, false);
  assert.deepEqual(observed.options.stdio, ["ignore", "pipe", "ignore"]);
});

windowsTest("probe forwards an explicit script path to the bounded production runner", async () => {
  let observed;
  const probe = createWindowsPresenceProbe({
    scriptPath: "C:\\e2e\\away.ps1",
    run: async (options) => {
      observed = options;
      return '{"locked":true,"idleMs":0}';
    },
  });
  assert.deepEqual(await probe.sample(), { state: "AWAY", idleMs: 0 });
  assert.deepEqual(observed, { scriptPath: "C:\\e2e\\away.ps1" });
});

windowsTest("production runner kills a timed-out probe", async () => {
  let killed = false;
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { killed = true; };
    return child;
  };
  await assert.rejects(
    runPowerShellProbe({ scriptPath: "C:\\bridge\\Get-WindowsPresence.ps1", spawn, timeoutMs: 5 }),
    (error) => error?.code === "PRESENCE_TIMEOUT",
  );
  assert.equal(killed, true);
});

windowsTest("production runner rejects stdout over four KiB", async () => {
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => child.stdout.emit("data", Buffer.alloc(4097, 0x78)));
    return child;
  };
  await assert.rejects(
    runPowerShellProbe({ scriptPath: "C:\\bridge\\Get-WindowsPresence.ps1", spawn, timeoutMs: 100 }),
    (error) => error?.code === "PRESENCE_OUTPUT",
  );
});
