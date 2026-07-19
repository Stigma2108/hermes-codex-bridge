import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { handlePermissionRequest, handleSessionStart, handleStop } from "../src/hook-adapter.mjs";
import { mergeHooks } from "../src/hook-installer.mjs";

async function temp() { return mkdtemp(join(tmpdir(), "bridge-hook-")); }
const windowsTest = process.platform === "win32" ? test : test.skip;

test("SessionStart injects the remote-input contract without stopping the turn", () => {
  const output = handleSessionStart({ hook_event_name: "SessionStart", session_id: "T" });
  assert.equal(output.continue, true);
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(output.hookSpecificOutput.additionalContext, /HC3:WAITING_FOR_INPUT/u);
  assert.match(output.hookSpecificOutput.additionalContext, /do not call request_user_input/u);
  assert.match(output.hookSpecificOutput.additionalContext, /HC3:TASK_COMPLETED/u);
});

test("Stop writes only sanitized reference metadata", async () => {
  const stateRoot = await temp();
  const result = await handleStop({ session_id: "session-1", thread_id: "thread-1", transcript_path: "C:\\sessions\\rollout.jsonl", prompt: "Bearer TOPSECRET", tool_output: "TOPSECRET" }, { stateRoot });
  const stored = await readFile(result.path, "utf8");
  assert.match(stored, /session-1/u);
  assert.doesNotMatch(stored, /TOPSECRET|prompt|tool_output/u);
  assert.deepEqual(Object.keys(JSON.parse(stored)).sort(), ["created_at", "schema", "session_id", "thread_id", "transcript_path"]);
});

test("PermissionRequest is deny-first: local returns empty, approval allows once, decline and timeout deny", async () => {
  const local = await handlePermissionRequest({ command: "rm -rf .", cwd: "C:\\work" }, { classify: () => "LOCAL_ONLY" });
  assert.deepEqual(local, {});
  for (const [action, behavior] of [["APPROVE_ONCE", "allow"], ["DECLINE", "deny"]]) {
    const published = [];
    const result = await handlePermissionRequest({ command: "npm test", cwd: "C:\\work", thread_id: "thread-1" }, {
      classify: () => "REMOTE_ALLOWED",
      resolveThreadMetadata: async () => ({ title: "Подтверждение запуска фазы", projectLabel: "Komplektrybaka", cwdLabel: "Komplektrybaka" }),
      publish: async (request) => { published.push(request); return { event: { event_id: "evt_019f74b5-c168-7381-9629-d395da0255f7" } }; },
      waitForReply: async () => ({ action }),
    });
    assert.equal(result.hookSpecificOutput.decision.behavior, behavior);
    assert.equal(published[0].kind, "APPROVAL_REQUEST");
    assert.deepEqual(published[0].thread, { id: "thread-1", turn_id: "pending", title: "Подтверждение запуска фазы", project_label: "Komplektrybaka", cwd_label: "Komplektrybaka" });
    assert.doesNotMatch(JSON.stringify(result), /npm test/u);
  }
  const timed = await handlePermissionRequest({ command: "npm test", cwd: "C:\\work" }, {
    classify: () => "REMOTE_ALLOWED", publish: async () => ({ event: { event_id: "evt_019f74b5-c168-7381-9629-d395da0255f7" } }), waitForReply: async () => null,
  });
  assert.equal(timed.hookSpecificOutput.decision.behavior, "deny");
});

test("real CLI emits JSON only and Stop exits without leaking stdin", async () => {
  const stateRoot = await temp();
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/hook-adapter.mjs", import.meta.url)), "Stop"], {
    env: { ...process.env, HERMES_CODEX_STATE_ROOT: stateRoot }, stdio: ["pipe", "pipe", "pipe"], shell: false,
  });
  child.stdin.end(JSON.stringify({ session_id: "s", thread_id: "t", transcript_path: "C:\\fake.jsonl", prompt: "CLI_SECRET" }));
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(exit, 0); assert.deepEqual(JSON.parse(stdout), {}); assert.equal(stderr, "");
  const files = await readdir(join(stateRoot, "ingress"));
  assert.equal(files.length, 1);
  assert.doesNotMatch(await readFile(join(stateRoot, "ingress", files[0]), "utf8"), /CLI_SECRET/u);
});

test("CLI falls back to validated payload event name when installer argv is absent", async () => {
  const adapter = fileURLToPath(new URL("../src/hook-adapter.mjs", import.meta.url)); const stateRoot = await temp();
  for (const [payload, expected] of [[{ hook_event_name: "Stop", session_id: "fallback" }, {}], [{ hookEventName: "PermissionRequest", command: "rm -rf .", cwd: "C:\\work" }, {}]]) {
    const child = spawn(process.execPath, [adapter], { env: { ...process.env, HERMES_CODEX_STATE_ROOT: stateRoot }, stdio: ["pipe", "pipe", "pipe"], shell: false });
    child.stdin.end(JSON.stringify(payload)); let stdout = ""; child.stdout.on("data", (chunk) => { stdout += chunk; });
    const exit = await new Promise((resolve) => child.on("exit", resolve)); assert.equal(exit, 0); assert.deepEqual(JSON.parse(stdout), expected);
  }
  assert.equal((await readdir(join(stateRoot, "ingress"))).length, 1);
});

windowsTest("all exact installer commands spawn the intended adapter event", async () => {
  const adapter = fileURLToPath(new URL("../src/hook-adapter.mjs", import.meta.url)); const stateRoot = await temp();
  const merged = mergeHooks({ hooks: {} }, `"${process.execPath}" "${adapter}"`);
  const cases = [
    [merged.hooks.SessionStart[0].hooks[0].command, { session_id: "installed-start" }, /HC3:WAITING_FOR_INPUT/u],
    [merged.hooks.Stop[0].hooks[0].command, { session_id: "installed-stop" }, null],
    [merged.hooks.PermissionRequest[0].hooks[0].command, { command: "rm -rf .", cwd: "C:\\work" }, null],
  ];
  for (const [command, payload, contextPattern] of cases) {
    const child = spawn(command, [], { env: { ...process.env, HERMES_CODEX_STATE_ROOT: stateRoot }, stdio: ["pipe", "pipe", "pipe"], shell: true });
    child.stdin.end(JSON.stringify(payload)); let stdout = ""; child.stdout.on("data", (chunk) => { stdout += chunk; });
    const exit = await new Promise((resolve) => child.on("exit", resolve)); assert.equal(exit, 0);
    const output = JSON.parse(stdout);
    if (contextPattern) assert.match(output.hookSpecificOutput.additionalContext, contextPattern); else assert.deepEqual(output, {});
  }
  assert.equal((await readdir(join(stateRoot, "ingress"))).length, 1);
});
