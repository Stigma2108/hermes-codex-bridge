import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { publishEvent, writeTextOnce } from "../src/event-publisher.mjs";
import { validateEvent } from "../src/contracts.mjs";

const temporaryDirectories = [];
const SECRET = "abcdefghijklmnopqrstuvwxyz123456";
const EVENT_ID = "evt_019f74b5-c168-7381-9629-d395da0255f7";

async function temporaryQueue() {
  const directory = await mkdtemp(join(tmpdir(), "hermes-event-publisher-"));
  temporaryDirectories.push(directory);
  return directory;
}

function input(queueRoot, overrides = {}) {
  return {
    queueRoot,
    event_id: EVENT_ID,
    kind: "FINAL_RESPONSE",
    created_at: "2026-07-18T12:00:00.000Z",
    expires_at: "2026-07-25T12:00:00.000Z",
    thread: {
      id: "019f74b5-c168-7381-9629-d395da0255f7",
      turn_id: "turn-1",
      title: "Чат 🧵",
      project_label: "Knots",
      cwd_label: "Knots",
    },
    text: "Готово",
    allowed_actions: ["REPLY"],
    is_replyable: true,
    ...overrides,
  };
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function doesNotExist(path) {
  try {
    await access(path);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("publishes a valid short redacted event without message.md and hashes the exact summary payload", async () => {
  const queueRoot = await temporaryQueue();
  const unsafeText = `Ответ\nAuthorization: Bearer ${SECRET}`;
  const safeText = "Ответ\nAuthorization: [REDACTED]";

  const result = await publishEvent(input(queueRoot, { text: unsafeText }));
  const eventPath = join(queueRoot, "interactions", EVENT_ID, "event.json");
  const messagePath = join(queueRoot, "interactions", EVENT_ID, "message.md");
  const eventBytes = await readFile(eventPath, "utf8");
  const event = JSON.parse(eventBytes);

  assert.strictEqual(validateEvent(event), event);
  assert.deepEqual(result.event, event);
  assert.equal(result.interactionPath, join(queueRoot, "interactions", EVENT_ID));
  assert.equal(event.message.summary, safeText);
  assert.equal(event.message.markdown_path, null);
  assert.equal(event.integrity.producer, "codex-windows-local");
  assert.equal(event.integrity.content_sha256, sha256(safeText));
  assert.equal(await doesNotExist(messagePath), true);
  assert.equal(eventBytes.includes(SECRET), false);
});

test("publishes reply_mode only when the caller supplies a valid mode", async () => {
  const queueRoot = await temporaryQueue();
  const { event } = await publishEvent(input(queueRoot, { replyMode: "NEXT_TURN" }));
  assert.equal(event.message.reply_mode, "NEXT_TURN");
  await assert.rejects(
    publishEvent(input(await temporaryQueue(), { replyMode: "FUTURE" })),
    (error) => error?.code === "PUBLISH_EVENT",
  );
});

test("publishes full safe text over 3500 Unicode code points with exact newline bytes and no split surrogate", async () => {
  const queueRoot = await temporaryQueue();
  const unsafeText = `${"🧵".repeat(3501)}\napi_key=${SECRET}`;
  const safeText = `${"🧵".repeat(3501)}\napi_key=[REDACTED]`;

  const { event } = await publishEvent(input(queueRoot, { fullText: unsafeText, text: undefined }));
  const interactionPath = join(queueRoot, "interactions", EVENT_ID);
  const messageBytes = await readFile(join(interactionPath, "message.md"), "utf8");
  const allBytes = `${messageBytes}\n${await readFile(join(interactionPath, "event.json"), "utf8")}`;

  assert.equal(event.message.markdown_path, "message.md");
  assert.ok([...event.message.summary].length <= 3500);
  assert.equal(/\p{Surrogate}$/u.test(event.message.summary), false);
  assert.equal(messageBytes, `${safeText}\n`);
  assert.equal(event.integrity.content_sha256, sha256(`${safeText}\n`));
  assert.equal(allBytes.includes(SECRET), false);
  assert.strictEqual(validateEvent(event), event);
});

test("uses the same Unicode code-point unit for short and exact-boundary messages", async () => {
  for (const count of [2000, 3500]) {
    const queueRoot = await temporaryQueue();
    const eventId = count === 2000 ? EVENT_ID : "evt_119f74b5-c168-7381-9629-d395da0255f7";
    const text = "🧵".repeat(count);
    const { event, messagePath } = await publishEvent(input(queueRoot, { event_id: eventId, text }));
    assert.equal(event.message.summary, text);
    assert.equal([...event.message.summary].length, count);
    assert.equal(event.message.markdown_path, null);
    assert.equal(messagePath, null);
  }
});

test("does not end a truncated summary inside a combining or ZWJ grapheme", async () => {
  const family = "👩‍👩‍👧‍👦";
  const cases = [
    [`${"a".repeat(3499)}e\u0301${family}`, "a".repeat(3499)],
    [`${"b".repeat(3496)}${family}tail`, "b".repeat(3496)],
  ];
  for (const [text, expected] of cases) {
    const queueRoot = await temporaryQueue();
    const eventId = expected[0] === "a" ? EVENT_ID : "evt_219f74b5-c168-7381-9629-d395da0255f7";
    const { event } = await publishEvent(input(queueRoot, { event_id: eventId, text }));
    assert.equal(event.message.summary, expected);
    assert.ok([...event.message.summary].length <= 3500);
  }
});

test("writes message.md before event.json and event.json is the final publication call", async () => {
  const queueRoot = await temporaryQueue();
  const order = [];

  await publishEvent(input(queueRoot, { text: "x".repeat(3501) }), {
    writeText: async (path, contents) => { order.push(["text", path, contents]); await writeFile(path, contents, { flag: "wx" }); return { published: true, cleanupError: null }; },
    writeJson: async (path, value) => { order.push(["json", path, value]); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" }); return { published: true, cleanupError: null }; },
  });

  assert.deepEqual(order.map(([kind]) => kind), ["text", "json"]);
  assert.match(order[0][1], /message\.md$/u);
  assert.match(order[1][1], /event\.json$/u);
});

test("a prior message write failure never attempts event.json", async () => {
  const queueRoot = await temporaryQueue();
  let eventAttempted = false;
  await assert.rejects(
    publishEvent(input(queueRoot, { text: "x".repeat(3501) }), {
      writeText: async () => { throw new Error("fixture writer failure"); },
      writeJson: async () => { eventAttempted = true; },
    }),
    (error) => error?.message === "PUBLISH_WRITE" && error?.code === "PUBLISH_WRITE",
  );
  assert.equal(eventAttempted, false);
  assert.equal(await doesNotExist(join(queueRoot, "interactions", EVENT_ID, "event.json")), true);
});

test("rejects traversal and malformed inputs before creating filesystem entries", async () => {
  const queueRoot = await temporaryQueue();
  const invalidInputs = [
    input(queueRoot, { event_id: "../escape" }),
    input(queueRoot, { event_id: "evt_019f74b5-c168-7381-9629-d395da0255f7\\escape" }),
    input("relative-queue"),
    input(queueRoot, { text: 42 }),
    input(queueRoot, { thread: { id: "missing-fields" } }),
    input(queueRoot, { allowed_actions: "REPLY" }),
    input(queueRoot, { created_at: "not-a-time" }),
  ];

  for (const invalid of invalidInputs) {
    await assert.rejects(publishEvent(invalid), (error) => /^PUBLISH_/u.test(error?.code));
  }
  assert.deepEqual(await readdir(queueRoot), []);
});

test("preserves the first event on write-once conflict", async () => {
  const queueRoot = await temporaryQueue();
  const first = await publishEvent(input(queueRoot, { text: "first" }));
  const eventPath = join(first.interactionPath, "event.json");
  const original = await readFile(eventPath);

  await assert.rejects(
    publishEvent(input(queueRoot, { text: "second" })),
    (error) => error?.message === "PUBLISH_CONFLICT" && error?.code === "PUBLISH_CONFLICT",
  );
  assert.deepEqual(await readFile(eventPath), original);
});

test("does not leak redacted metadata credentials into interaction files", async () => {
  const queueRoot = await temporaryQueue();
  const thread = { ...input(queueRoot).thread, title: `token=${SECRET}`, project_label: `X-API-Key: ${SECRET}` };
  const { interactionPath } = await publishEvent(input(queueRoot, { thread, text: `sk-${SECRET}` }));
  const files = await readdir(interactionPath);
  const bytes = await Promise.all(files.map((name) => readFile(join(interactionPath, name), "utf8")));
  assert.equal(bytes.join("\n").includes(SECRET), false);
});

test("rejects secret-like routing identifiers instead of mutating them", async () => {
  const queueRoot = await temporaryQueue();
  const thread = { ...input(queueRoot).thread, turn_id: `sk-${SECRET}` };
  await assert.rejects(
    publishEvent(input(queueRoot, { thread })),
    (error) => error?.message === "PUBLISH_THREAD" && error?.code === "PUBLISH_THREAD",
  );
  assert.deepEqual(await readdir(queueRoot), []);
});

test("rejects conflicting text aliases and malformed producer without creating directories", async () => {
  const queueRoot = await temporaryQueue();
  await assert.rejects(publishEvent(input(queueRoot, { text: "one", fullText: "two" })), /PUBLISH_TEXT/u);
  await assert.rejects(publishEvent(input(queueRoot, { producer: "" })), /PUBLISH_PRODUCER/u);
  assert.deepEqual(await readdir(queueRoot), []);
});

test("existing message.md blocks a long publication before the event commit marker", async () => {
  const queueRoot = await temporaryQueue();
  const interactionPath = join(queueRoot, "interactions", EVENT_ID);
  await writeFile(join(queueRoot, "placeholder"), "keeps root present");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(interactionPath, { recursive: true }));
  await writeFile(join(interactionPath, "message.md"), "owned elsewhere", { flag: "wx" });

  await assert.rejects(
    publishEvent(input(queueRoot, { text: "x".repeat(3501) })),
    (error) => error?.message === "PUBLISH_CONFLICT" && error?.code === "PUBLISH_CONFLICT",
  );
  assert.equal(await doesNotExist(join(interactionPath, "event.json")), true);
  assert.equal(await readFile(join(interactionPath, "message.md"), "utf8"), "owned elsewhere");
});

test("maps oversized text to PUBLISH_TEXT before filesystem creation", async () => {
  const queueRoot = await temporaryQueue();
  await assert.rejects(
    publishEvent(input(queueRoot, { text: "x".repeat(1024 * 1024 + 1) })),
    (error) => error?.message === "PUBLISH_TEXT" && error?.code === "PUBLISH_TEXT",
  );
  assert.deepEqual(await readdir(queueRoot), []);
});

test("maps oversized metadata to stable publisher codes before filesystem creation", async () => {
  const queueRoot = await temporaryQueue();
  const oversized = "x".repeat(1024 * 1024 + 1);
  await assert.rejects(
    publishEvent(input(queueRoot, { thread: { ...input(queueRoot).thread, title: oversized } })),
    (error) => error?.code === "PUBLISH_THREAD",
  );
  await assert.rejects(publishEvent(input(queueRoot, { producer: oversized })), (error) => error?.code === "PUBLISH_PRODUCER");
  assert.deepEqual(await readdir(queueRoot), []);
});

test("published bytes contain no original token-family remnants", async () => {
  const queueRoot = await temporaryQueue();
  const secrets = [
    ["123456789", ":AAabcdefghijklmnopqrstuvwxyz123456789"].join(""),
    ["eyJhbGciOiJIUzI1NiJ9", ".eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".abcdefghijklmnopqrstuvwxyz123456"].join(""),
    ["xoxb-", "123456789012-123456789012-abcdefghijklmnopqrstuvwxyz"].join(""),
    ["sk-", "proj-abcdefghijklmnopqrstuvwxyz1234567890"].join(""),
  ];
  const { eventPath } = await publishEvent(input(queueRoot, { text: secrets.join("\n") }));
  const bytes = await readFile(eventPath, "utf8");
  for (const secret of secrets) {
    assert.equal(bytes.includes(secret), false);
    assert.equal(bytes.includes(secret.slice(0, 12)), false);
    assert.equal(bytes.includes(secret.slice(-12)), false);
  }
});

test("writeTextOnce returns structured published and idempotent-existing results", async () => {
  const queueRoot = await temporaryQueue();
  const path = join(queueRoot, "message.md");
  assert.deepEqual(await writeTextOnce(path, "same\n"), { path, published: true, existing: false, cleanupError: null });
  assert.deepEqual(await writeTextOnce(path, "same\n"), { path, published: false, existing: true, cleanupError: null });
  await assert.rejects(writeTextOnce(path, "different\n"), (error) => error?.code === "WRITE_ONCE_CONFLICT");
});

test("writeTextOnce reports post-commit cleanup failure without losing publication", async () => {
  const queueRoot = await temporaryQueue();
  const path = join(queueRoot, "message.md");
  const cleanupFailure = new Error("cleanup failure");
  const result = await writeTextOnce(path, "durable\n", { remove: async () => { throw cleanupFailure; } });
  assert.equal(result.published, true);
  assert.equal(result.existing, false);
  assert.equal(result.cleanupError, cleanupFailure);
  assert.equal(await readFile(path, "utf8"), "durable\n");
});

test("retries after a transient event failure using the identical committed message", async () => {
  const queueRoot = await temporaryQueue();
  const value = input(queueRoot, { text: "x".repeat(3501) });
  await assert.rejects(
    publishEvent(value, { writeJson: async () => { throw new Error("transient"); } }),
    (error) => error?.code === "PUBLISH_WRITE",
  );
  const result = await publishEvent(value);
  assert.equal(result.event.message.markdown_path, "message.md");
  assert.equal(JSON.parse(await readFile(result.eventPath, "utf8")).event_id, EVENT_ID);
});

test("replaying an identical event is idempotent but different bytes conflict", async () => {
  const queueRoot = await temporaryQueue();
  const value = input(queueRoot, { text: "same" });
  const first = await publishEvent(value);
  const second = await publishEvent(value);
  assert.deepEqual(second.event, first.event);
  await assert.rejects(publishEvent(input(queueRoot, { text: "different" })), (error) => error?.code === "PUBLISH_CONFLICT");
});

test("requires structured writer success and exposes cleanup errors", async () => {
  const queueRoot = await temporaryQueue();
  await assert.rejects(
    publishEvent(input(queueRoot), { writeJson: async () => ({ published: false }) }),
    (error) => error?.code === "PUBLISH_WRITE",
  );

  const cleanupText = new Error("text cleanup");
  const cleanupJson = new Error("json cleanup");
  const result = await publishEvent(input(queueRoot, { event_id: "evt_319f74b5-c168-7381-9629-d395da0255f7", text: "x".repeat(3501) }), {
    writeText: async (path, contents) => { await writeFile(path, contents, { flag: "wx" }); return { published: true, cleanupError: cleanupText }; },
    writeJson: async (path, value) => { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" }); return { published: true, cleanupError: cleanupJson }; },
  });
  assert.deepEqual(result.cleanupErrors, [cleanupText, cleanupJson]);
});

test("rejects an interactions junction before any outside publication", async (t) => {
  const queueRoot = await temporaryQueue();
  const outside = await temporaryQueue();
  try {
    await symlink(outside, join(queueRoot, "interactions"), "junction");
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error?.code)) return t.skip("junction creation unavailable");
    throw error;
  }
  await assert.rejects(publishEvent(input(queueRoot)), (error) => error?.code === "PUBLISH_PATH");
  assert.deepEqual(await readdir(outside), []);
});

test("preflights a conflicting event before creating a long-message orphan", async () => {
  const queueRoot = await temporaryQueue();
  const interactionPath = join(queueRoot, "interactions", EVENT_ID);
  await mkdir(interactionPath, { recursive: true });
  await writeFile(join(interactionPath, "event.json"), "different\n");
  await assert.rejects(publishEvent(input(queueRoot, { text: "x".repeat(3501) })), (error) => error?.code === "PUBLISH_CONFLICT");
  assert.equal(await doesNotExist(join(interactionPath, "message.md")), true);
});

test("an exact existing long event fails closed when message.md is missing", async () => {
  const source = await temporaryQueue();
  const value = input(source, { text: "x".repeat(3501) });
  const sourceResult = await publishEvent(value);
  const eventBytes = await readFile(sourceResult.eventPath);

  const queueRoot = await temporaryQueue();
  const interactionPath = join(queueRoot, "interactions", EVENT_ID);
  await mkdir(interactionPath, { recursive: true });
  await writeFile(join(interactionPath, "event.json"), eventBytes);
  await assert.rejects(
    publishEvent(input(queueRoot, { text: "x".repeat(3501) })),
    (error) => error?.code === "PUBLISH_CONFLICT",
  );
  assert.equal(await doesNotExist(join(interactionPath, "message.md")), true);
});

test("an exact existing long event requires exact regular single-link message bytes", async (t) => {
  const source = await temporaryQueue();
  const value = input(source, { text: "x".repeat(3501) });
  const sourceResult = await publishEvent(value);
  const eventBytes = await readFile(sourceResult.eventPath);

  const differentRoot = await temporaryQueue();
  const differentPath = join(differentRoot, "interactions", EVENT_ID);
  await mkdir(differentPath, { recursive: true });
  await writeFile(join(differentPath, "event.json"), eventBytes);
  await writeFile(join(differentPath, "message.md"), "different\n");
  await assert.rejects(publishEvent(input(differentRoot, { text: "x".repeat(3501) })), (error) => error?.code === "PUBLISH_CONFLICT");

  for (const kind of ["hardlink", "symlink"]) {
    const queueRoot = await temporaryQueue();
    const interactionPath = join(queueRoot, "interactions", EVENT_ID);
    await mkdir(interactionPath, { recursive: true });
    await writeFile(join(interactionPath, "event.json"), eventBytes);
    try {
      if (kind === "hardlink") await link(sourceResult.messagePath, join(interactionPath, "message.md"));
      else await symlink(sourceResult.messagePath, join(interactionPath, "message.md"), "file");
    } catch (error) {
      if (["EPERM", "EACCES"].includes(error?.code)) { t.diagnostic(`${kind} unavailable`); continue; }
      throw error;
    }
    await assert.rejects(publishEvent(input(queueRoot, { text: "x".repeat(3501) })), (error) => error?.code === "PUBLISH_PATH");
  }
});

test("rejects pre-existing symlink and hard-link leaves even when bytes match", async (t) => {
  for (const kind of ["symlink", "hardlink"]) {
    const queueRoot = await temporaryQueue();
    const outside = await temporaryQueue();
    const interactionPath = join(queueRoot, "interactions", EVENT_ID);
    await mkdir(interactionPath, { recursive: true });
    const outsideMessage = join(outside, `${kind}.md`);
    await writeFile(outsideMessage, `${"x".repeat(3501)}\n`);
    try {
      if (kind === "symlink") await symlink(outsideMessage, join(interactionPath, "message.md"), "file");
      else await link(outsideMessage, join(interactionPath, "message.md"));
    } catch (error) {
      if (["EPERM", "EACCES"].includes(error?.code)) { t.diagnostic(`${kind} unavailable`); continue; }
      throw error;
    }
    await assert.rejects(publishEvent(input(queueRoot, { text: "x".repeat(3501) })), (error) => error?.code === "PUBLISH_PATH");
    assert.equal(await doesNotExist(join(interactionPath, "event.json")), true);
  }
});

test("rejects linked event leaves before any message commit", async (t) => {
  const source = await temporaryQueue();
  const sourceResult = await publishEvent(input(source, { text: "x".repeat(3501) }));
  for (const kind of ["symlink", "hardlink"]) {
    const queueRoot = await temporaryQueue();
    const interactionPath = join(queueRoot, "interactions", EVENT_ID);
    await mkdir(interactionPath, { recursive: true });
    try {
      if (kind === "symlink") await symlink(sourceResult.eventPath, join(interactionPath, "event.json"), "file");
      else await link(sourceResult.eventPath, join(interactionPath, "event.json"));
    } catch (error) {
      if (["EPERM", "EACCES"].includes(error?.code)) { t.diagnostic(`${kind} unavailable`); continue; }
      throw error;
    }
    await assert.rejects(publishEvent(input(queueRoot, { text: "x".repeat(3501) })), (error) => error?.code === "PUBLISH_PATH");
    assert.equal(await doesNotExist(join(interactionPath, "message.md")), true);
  }
});

test("published true is rejected unless the expected regular leaf exists", async () => {
  const queueRoot = await temporaryQueue();
  await assert.rejects(
    publishEvent(input(queueRoot), { writeJson: async () => ({ published: true, cleanupError: null }) }),
    (error) => error?.code === "PUBLISH_WRITE",
  );
});

test("collects cleanupError before accepting an identical existing message", async () => {
  const queueRoot = await temporaryQueue();
  const value = input(queueRoot, { text: "x".repeat(3501) });
  await assert.rejects(publishEvent(value, { writeJson: async () => { throw new Error("transient"); } }));
  const cleanupError = new Error("existing cleanup");
  const result = await publishEvent(value, {
    writeText: async () => ({ published: false, existing: true, cleanupError }),
  });
  assert.deepEqual(result.cleanupErrors, [cleanupError]);
});
