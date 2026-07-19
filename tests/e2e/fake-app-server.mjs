import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const recordPath = process.env.HERMES_E2E_APP_RECORD;
const crashMarker = process.env.HERMES_E2E_CRASH_MARKER;
const pidPath = process.env.HERMES_E2E_APP_PID;
const logPath = process.env.HERMES_E2E_APP_LOG;
if (!recordPath || !crashMarker || !pidPath || !logPath) process.exit(64);
writeFileSync(pidPath, `${process.pid}\n`, "utf8");
appendFileSync(logPath, `${JSON.stringify({ level: "info", message: "fictional app-server started" })}\n`, "utf8");

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const log = (value) => appendFileSync(recordPath, `${JSON.stringify(value)}\n`, "utf8");
const records = () => {
  if (!existsSync(recordPath)) return [];
  return readFileSync(recordPath, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
};
const startsFor = (threadId) => records().filter((entry) => entry.type === "turn/start" && entry.threadId === threadId);
const turnsFor = (threadId) => startsFor(threadId).map((entry) => ({
  id: entry.turnId,
  items: [{ type: "userMessage", content: entry.input }],
}));

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const message = JSON.parse(line);
  if (!Object.hasOwn(message, "id")) return;
  if (!message.method) return;
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fictional-e2e-app-server" } });
    return;
  }
  if (message.method === "thread/resume") {
    const threadId = message.params.threadId;
    send({ id: message.id, result: { thread: { id: threadId, status: { type: "idle" }, turns: turnsFor(threadId) } } });
    return;
  }
  if (message.method === "turn/start") {
    const { threadId, input } = message.params;
    const count = startsFor(threadId).length + 1;
    const turnId = `followup-${threadId}-${count}`;
    log({ type: "turn/start", threadId, input, turnId });
    const text = input?.[0]?.text;
    send({ method: "item/completed", params: { threadId, turnId, item: { id: `item-${threadId}-${count}`, type: "agentMessage", phase: "final_answer", text: text === "answer-for-B" ? "B3" : "A3" } } });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: { type: "completed" } } } });
    if (text === "answer-for-B" && !existsSync(crashMarker)) {
      setTimeout(() => writeFileSync(crashMarker, `${JSON.stringify({ threadId, turnId, phase: "after-side-effect-before-ack" })}\n`, "utf8"), 200);
      setTimeout(() => process.exit(86), 1200).unref();
      return;
    }
    send({ id: message.id, result: { turn: { id: turnId, status: { type: "inProgress" } } } });
    return;
  }
  send({ id: message.id, result: {} });
});

process.once("exit", (code) => appendFileSync(logPath, `${JSON.stringify({ level: "info", message: "fictional app-server stopped", code })}\n`, "utf8"));
