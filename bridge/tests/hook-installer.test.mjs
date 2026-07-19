import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installHooks, mergeHooks, uninstallHooks } from "../src/hook-installer.mjs";

const fixture = (name) => new URL(`fixtures/${name}`, import.meta.url);
const windowsTest = process.platform === "win32" ? test : test.skip;

windowsTest("merge preserves existing hook objects and is semantically idempotent", async () => {
  const original = JSON.parse(await readFile(fixture("hooks-existing.json"), "utf8"));
  const command = 'node "C:\\Bridge\\hook-adapter.mjs"';
  const merged = mergeHooks(original, command);
  assert.deepEqual(merged.hooks.Stop.slice(0, original.hooks.Stop.length), original.hooks.Stop);
  assert.deepEqual(merged.hooks.OtherHook, original.hooks.OtherHook);
  assert.equal(merged.hooks.SessionStart.at(-1).hooks[0].timeout, 30);
  assert.equal(merged.hooks.Stop.at(-1).hooks[0].timeout, 30);
  assert.equal(merged.hooks.PermissionRequest.at(-1).hooks[0].timeout, 43230);
  assert.equal(merged.hooks.SessionStart.at(-1).hooks[0].command, `${command} SessionStart`);
  assert.equal(merged.hooks.Stop.at(-1).hooks[0].command, `${command} Stop`);
  assert.equal(merged.hooks.PermissionRequest.at(-1).hooks[0].command, `${command} PermissionRequest`);
  assert.deepEqual(mergeHooks(merged, 'NODE c:/bridge/HOOK-ADAPTER.mjs'), merged);
  assert.deepEqual(original.vendor, { kept: true });
});

windowsTest("install backs up before atomic mutation and uninstall removes only bridge entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-hooks-"));
  const hooksPath = join(directory, "hooks.json");
  const originalText = await readFile(fixture("hooks-existing.json"), "utf8");
  await writeFile(hooksPath, originalText);
  const command = `node "${join(directory, "hook-adapter.mjs")}"`;
  const installed = await installHooks({ hooksPath, command, now: () => new Date("2026-07-18T12:00:00Z") });
  assert.equal(await readFile(installed.backupPath, "utf8"), originalText);
  assert.equal(installed.changed, true);
  const second = await installHooks({ hooksPath, command, now: () => new Date("2026-07-18T12:00:01Z") });
  assert.equal(second.changed, false);
  const removed = await uninstallHooks({ hooksPath, command });
  assert.equal(removed.changed, true);
  assert.deepEqual(JSON.parse(await readFile(hooksPath, "utf8")), JSON.parse(originalText));
  assert.equal((await uninstallHooks({ hooksPath, command })).changed, false);
});

windowsTest("invalid JSON and invalid hook shape never mutate or create a backup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-hooks-bad-"));
  const hooksPath = join(directory, "hooks.json");
  await writeFile(hooksPath, "{bad");
  await assert.rejects(installHooks({ hooksPath, command: "node C:\\bridge\\hook-adapter.mjs" }), /HOOKS_JSON/u);
  assert.equal(await readFile(hooksPath, "utf8"), "{bad");
  await writeFile(hooksPath, JSON.stringify({ hooks: { Stop: {} } }));
  await assert.rejects(installHooks({ hooksPath, command: "node C:\\bridge\\hook-adapter.mjs" }), /HOOKS_SHAPE/u);
});
