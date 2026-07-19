import { isAbsolute, resolve } from "node:path";

import { createUiActionStore } from "./ui-action-store.mjs";

const MAX_OUTPUT = 256 * 1024;
const COMMAND_ARITY = new Map([
  ["list", 0],
  ["claim", 1],
  ["release", 3],
  ["applied", 3],
  ["reject", 3],
  ["heartbeat", 1],
  ["register", 2],
]);
const RETRYABLE = new Set(["UI_CLAIMED", "UI_CLAIM_CHANGED", "WRITE_ONCE_CONFLICT", "EEXIST"]);

function invalid() {
  const error = new Error("UI_ROUTER_INVALID");
  error.kind = "invalid";
  return error;
}

function safety() {
  const error = new Error("UI_ROUTER_SAFETY");
  error.kind = "safety";
  return error;
}

function parse(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string" || value.includes("\0"))) throw invalid();
  const queueFlags = argv.reduce((count, value) => count + (value === "--queue" ? 1 : 0), 0);
  if (queueFlags !== 1 || argv.length < 3 || argv.at(-2) !== "--queue") throw invalid();
  const command = argv[0];
  const arity = COMMAND_ARITY.get(command);
  if (arity === undefined || argv.length !== arity + 3) throw invalid();
  const queueRoot = argv.at(-1);
  if (!isAbsolute(queueRoot) || resolve(queueRoot) !== queueRoot) throw invalid();
  const values = argv.slice(1, -2);
  if (values.some((value) => value.length === 0 || value.startsWith("--"))) throw invalid();
  return { command, values, queueRoot };
}

async function execute({ command, values, queueRoot }) {
  const store = createUiActionStore({ queueRoot });
  if (command === "list") {
    const actions = (await store.listReady()).map(({ eventId, threadId, sourceTurnId }) => ({ eventId, threadId, sourceTurnId }));
    return { actions };
  }
  if (command === "claim") return store.claim(values[0]);
  if (command === "release") return store.release(values[0], values[1], values[2]);
  if (command === "applied") return store.applied(values[0], values[1], values[2]);
  if (command === "reject") return store.reject(values[0], values[1], values[2]);
  if (command === "heartbeat") return store.heartbeat(values[0]);
  if (command === "register") return store.registerRouter({ threadId: values[0], automationId: values[1] });
  throw invalid();
}

async function main() {
  try {
    const result = await execute(parse(process.argv.slice(2)));
    const output = `${JSON.stringify(result)}\n`;
    if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT) throw safety();
    process.stdout.write(output);
  } catch (error) {
    if (error?.kind === "invalid") {
      process.stderr.write("UI_ROUTER_INVALID\n");
      process.exitCode = 2;
    } else if (RETRYABLE.has(error?.code)) {
      process.stderr.write("UI_ROUTER_RETRY\n");
      process.exitCode = 3;
    } else {
      process.stderr.write("UI_ROUTER_SAFETY\n");
      process.exitCode = 4;
    }
  }
}

await main();
