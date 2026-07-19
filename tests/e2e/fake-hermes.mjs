import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [queueRoot, resultPath] = process.argv.slice(2);
if (!queueRoot || !resultPath) process.exit(64);
const interactions = join(queueRoot, "interactions");
const senderFingerprint = createHash("sha256").update("fictional-local-sender", "utf8").digest("hex");
const delivered = new Set();
const initial = new Map();
const replyOrder = [];
const deadline = Date.now() + 30_000;

async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
async function exists(path) { try { await readFile(path); return true; } catch { return false; } }
async function writeOnce(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}
async function scan() {
  let names = [];
  try { names = await readdir(interactions); } catch {}
  for (const name of names.sort()) {
    const directory = join(interactions, name);
    let event;
    try { event = await readJson(join(directory, "event.json")); } catch { continue; }
    if (!delivered.has(name)) {
      const deliveryPath = join(directory, "delivery.json");
      if (!(await exists(deliveryPath))) await writeOnce(deliveryPath, { schema: "hermes-codex-interaction-delivery/v3", event_id: name, delivery_ref: `opaque-${delivered.size + 1}`, created_at: new Date().toISOString(), attempts: 1 });
      delivered.add(name);
    }
    if (event.message.summary === "A2") initial.set("A", event);
    if (event.message.summary === "B2") initial.set("B", event);
  }
}

await mkdir(interactions, { recursive: true });
while (Date.now() < deadline) {
  await scan();
  if (initial.size === 2) break;
  await new Promise((resolve) => setTimeout(resolve, 50));
}
if (initial.size !== 2) throw new Error("INITIAL_EVENTS_TIMEOUT");

for (const label of ["B", "A"]) {
  const event = initial.get(label);
  await writeOnce(join(interactions, event.event_id, "reply.json"), { schema: "hermes-codex-interaction-reply/v3", event_id: event.event_id, created_at: new Date().toISOString(), action: "REPLY", text: `answer-for-${label}`, telegram: { delivery_ref: `opaque-reply-${label}`, sender_fingerprint: senderFingerprint } });
  replyOrder.push(label);
}

while (Date.now() < deadline) {
  await scan();
  const receipts = await Promise.all([...initial.values()].map((event) => exists(join(interactions, event.event_id, "receipt.json"))));
  const summaries = [];
  for (const name of delivered) { try { summaries.push((await readJson(join(interactions, name, "event.json"))).message.summary); } catch {} }
  if (receipts.every(Boolean) && summaries.includes("A3") && summaries.includes("B3")) {
    const events = [];
    for (const name of delivered) {
      const event = await readJson(join(interactions, name, "event.json"));
      const delivery = await readJson(join(interactions, name, "delivery.json"));
      events.push({ eventId: name, threadId: event.thread.id, turnId: event.thread.turn_id, summary: event.message.summary, attempts: delivery.attempts });
    }
    await writeFile(resultPath, `${JSON.stringify({ events, replyOrder, initialEventIds: Object.fromEntries([...initial].map(([key, event]) => [key, event.event_id])) }, null, 2)}\n`, "utf8");
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}
throw new Error("RECEIPTS_OR_FOLLOWUPS_TIMEOUT");
