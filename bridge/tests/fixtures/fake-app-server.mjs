import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "normal";
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
if (mode === "malformed") process.stdout.write("{not-json}\n");
if (mode === "oversize") process.stdout.write(`{"x":"${"x".repeat(8 * 1024 * 1024)}"}\n`);
if (mode === "exit") setTimeout(() => process.exit(17), 10);
if (mode === "stderr") process.stderr.write("Authorization: Bearer SUPERSECRET\n");

let slow; let response;
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const message = JSON.parse(line);
  if (!Object.hasOwn(message, "id")) return;
  if (!message.method) { response = Object.hasOwn(message, "result") ? message.result : { error: message.error }; return; }
  if (message.method === "initialize") return send({ id: message.id, result: { accepted: message.params.clientInfo?.name === "hermes_codex_bridge" } });
  if (message.method === "thread/resume") return send({ id: message.id, result: { thread: { id: message.params.threadId, status: { type: "idle" }, turns: [] } } });
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: `turn-${message.params.threadId}`, status: { type: "inProgress" } } } });
    send({ method: "item/completed", params: { threadId: message.params.threadId, turnId: `turn-${message.params.threadId}`, item: { type: "agentMessage", phase: "final_answer", text: `continued:${message.params.input?.[0]?.text ?? ""}` } } });
    send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: `turn-${message.params.threadId}`, status: { type: "completed" } } } });
    return;
  }
  if (message.method === "slow") { slow = message; return; }
  if (message.method === "fast") { send({ id: message.id, result: message.params }); send({ id: slow.id, result: slow.params }); return; }
  if (message.method === "server/error") return send({ id: message.id, error: { code: -32001, message: "fictional failure" } });
  if (message.method === "trigger/events") return;
  if (message.method === "response/seen") return send({ id: message.id, result: response });
  if (message.method === "trigger/error-notification") { send({ method: "error", params: { error: { message: "fictional retry" }, willRetry: true } }); return send({ id: message.id, result: { sent: true } }); }
  if (message.method === "wait") return;
  send({ id: message.id, result: message.params });
});

process.stdin.on("data", (chunk) => {
  if (chunk.includes(Buffer.from('"method":"trigger/events"'))) {
    send({ method: "turn/started", params: { turnId: "turn-1" } });
    send({ id: 9001, method: "item/tool/requestUserInput", params: { questions: [] } });
  }
});
