import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

import { createUiActionStore } from "../src/ui-action-store.mjs";

const execute = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/ui-router-cli.mjs", import.meta.url));
const EVENT_ID = "evt_019f74b5-c168-7381-9629-d395da0255f7";
const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");

async function fixture({ text = "Telegram text" } = {}) {
  const queueRoot = await mkdtemp(join(tmpdir(), "hermes-ui-cli-"));
  const directory = join(queueRoot, "interactions", EVENT_ID);
  await mkdir(directory, { recursive: true });
  const event = {
    schema: "hermes-codex-interaction-event/v3",
    event_id: EVENT_ID,
    kind: "FINAL_RESPONSE",
    created_at: new Date(Date.now() - 60_000).toISOString(),
    expires_at: new Date(Date.now() + 604_000_000).toISOString(),
    thread: { id: "T", turn_id: "V", title: "Title", project_label: "Project", cwd_label: "cwd" },
    message: { summary: "safe", markdown_path: null, is_replyable: true },
    allowed_actions: ["REPLY"],
    integrity: { producer: "test", content_sha256: hash("safe") },
  };
  const reply = {
    schema: "hermes-codex-interaction-reply/v3",
    event_id: EVENT_ID,
    created_at: new Date().toISOString(),
    action: "REPLY",
    text,
    telegram: { delivery_ref: "tgmsg_1", sender_fingerprint: "a".repeat(64) },
  };
  await writeFile(join(directory, "event.json"), `${JSON.stringify(event)}\n`, "utf8");
  await writeFile(join(directory, "reply.json"), `${JSON.stringify(reply)}\n`, "utf8");
  await createUiActionStore({ queueRoot }).enqueue({ event, reply });
  return { queueRoot, directory, event, reply };
}

async function invoke(...args) {
  try {
    const result = await execute(process.execPath, [CLI, ...args], { encoding: "utf8", maxBuffer: 512 * 1024, windowsHide: true });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function cli(...args) {
  const result = await invoke(...args);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 256 * 1024);
  return JSON.parse(result.stdout);
}

test("list claim release and applied expose only the narrow JSON contract", async () => {
  const { queueRoot } = await fixture();
  assert.deepEqual(await cli("list", "--queue", queueRoot), { actions: [{ eventId: EVENT_ID, threadId: "T", sourceTurnId: "V" }] });
  const first = await cli("claim", EVENT_ID, "--queue", queueRoot);
  assert.equal(first.text, "Telegram text");
  assert.match(first.actionCreatedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(first.prompt, `<!-- HC3_UI_EVENT:${EVENT_ID} -->\nTelegram text`);
  assert.doesNotMatch(JSON.stringify(first), /sender_fingerprint|delivery_ref/u);
  assert.deepEqual(await cli("release", EVENT_ID, first.leaseId, "BUSY", "--queue", queueRoot), { state: "READY" });
  const second = await cli("claim", EVENT_ID, "--queue", queueRoot);
  assert.deepEqual(await cli("applied", EVENT_ID, second.leaseId, "visible-turn", "--queue", queueRoot), { state: "APPLIED" });
  assert.deepEqual(await cli("list", "--queue", queueRoot), { actions: [] });
});

test("register and heartbeat expose timestamps without arbitrary file access", async () => {
  const queueRoot = await mkdtemp(join(tmpdir(), "hermes-ui-cli-registry-"));
  assert.deepEqual(await cli("register", "router-thread", "pending", "--queue", queueRoot), { threadId: "router-thread", automationId: "pending" });
  assert.deepEqual(await cli("register", "router-thread", "automation-1", "--queue", queueRoot), { threadId: "router-thread", automationId: "automation-1" });
  assert.match((await cli("heartbeat", "router-thread", "--queue", queueRoot)).heartbeatAt, /^\d{4}-\d{2}-\d{2}T/u);
});

test("invalid, retryable, and safety failures use closed exit contracts", async () => {
  const { queueRoot, directory } = await fixture();
  for (const args of [
    ["unknown", "--queue", queueRoot],
    ["list", "--queue", queueRoot, "extra"],
    ["list", "--queue", queueRoot, "--queue", queueRoot],
    ["list", "--queue", "relative"],
  ]) {
    const result = await invoke(...args);
    assert.deepEqual(result, { code: 2, stdout: "", stderr: "UI_ROUTER_INVALID\n" });
  }

  await cli("claim", EVENT_ID, "--queue", queueRoot);
  assert.deepEqual(await invoke("claim", EVENT_ID, "--queue", queueRoot), { code: 3, stdout: "", stderr: "UI_ROUTER_RETRY\n" });

  await writeFile(join(directory, "reply.json"), "{bad", "utf8");
  assert.deepEqual(await invoke("list", "--queue", queueRoot), { code: 4, stdout: "", stderr: "UI_ROUTER_SAFETY\n" });
});

test("bounded output rejects an oversized reply without printing it", async () => {
  const secret = `SECRET_${"x".repeat(300 * 1024)}`;
  const { queueRoot } = await fixture({ text: secret });
  const result = await invoke("claim", EVENT_ID, "--queue", queueRoot);
  assert.deepEqual({ code: result.code, stderr: result.stderr }, { code: 4, stderr: "UI_ROUTER_SAFETY\n" });
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /SECRET_/u);
});
