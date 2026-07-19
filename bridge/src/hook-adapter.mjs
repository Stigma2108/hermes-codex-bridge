import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { writeJsonOnce } from "./atomic-store.mjs";
import { publishEvent } from "./event-publisher.mjs";
import { classifyApproval } from "./policy.mjs";
import { validateReply } from "./contracts.mjs";
import { createCodexThreadMetadataResolver } from "./service.mjs";

const MAX_STDIN = 1024 * 1024;
const EVENT_ID = /^evt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const deny = () => ({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "Remote approval was declined or expired." } } });

function safeId(value, fallback) { return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/u.test(value) ? value : fallback; }

export function handleSessionStart() {
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: [
        "Remote-input contract for the main thread:",
        "When human input is required, do not call request_user_input.",
        "End the turn with one concise question and the hidden marker <!-- HC3:WAITING_FOR_INPUT -->.",
        "Before starting a new workflow phase, use <!-- HC3:PHASE_CONFIRMATION -->.",
        "When the user's requested task is fully complete, use <!-- HC3:TASK_COMPLETED -->.",
        "Do not add these markers to commentary or subagent responses.",
      ].join("\n"),
    },
  };
}

export async function handleStop(payload, { stateRoot, now = () => new Date(), write = writeJsonOnce } = {}) {
  if (typeof stateRoot !== "string" || !stateRoot) throw new Error("HOOK_STATE_ROOT");
  const envelope = {
    schema: "hermes-codex-stop-ingress/v3",
    created_at: now().toISOString(),
    session_id: safeId(payload?.session_id ?? payload?.sessionId, "unknown"),
    thread_id: safeId(payload?.thread_id ?? payload?.threadId, "unknown"),
    transcript_path: typeof payload?.transcript_path === "string" ? basename(payload.transcript_path) : null,
  };
  const path = join(resolve(stateRoot), "ingress", `stop_${randomUUID()}.json`);
  await write(path, envelope);
  return { path };
}

function requestFrom(payload) {
  const commandValue = payload?.command ?? payload?.tool_input?.command;
  const command = Array.isArray(commandValue) ? commandValue.join(" ") : commandValue;
  return { command, cwd: payload?.cwd, action: "APPROVE_ONCE", forSession: false, persistent: false };
}

async function defaultWaitForReply({ queueRoot, eventId, expiresAt, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 1250 }) {
  if (!EVENT_ID.test(eventId)) return null;
  const root = resolve(queueRoot); const directory = join(root, "interactions", eventId); const path = join(directory, "reply.json");
  while (now() < expiresAt) {
    try {
      const directoryStat = await lstat(directory); const stat = await lstat(path);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return null;
      const physical = await realpath(path);
      if (!physical.toLowerCase().startsWith(`${(await realpath(root)).toLowerCase()}\\`)) return null;
      const reply = validateReply(JSON.parse(await readFile(path, "utf8")));
      if (reply.event_id !== eventId || !["APPROVE_ONCE", "DECLINE"].includes(reply.action) || Date.parse(reply.created_at) > expiresAt) return null;
      return reply;
    } catch (error) { if (error?.code !== "ENOENT") return null; }
    await sleep(Math.min(pollMs, Math.max(0, expiresAt - now())));
  }
  return null;
}

export async function handlePermissionRequest(payload, options = {}) {
  const request = requestFrom(payload);
  const classify = options.classify ?? ((value) => classifyApproval(value, options.config));
  if (classify(request, options.config) !== "REMOTE_ALLOWED") return {};
  const queueRoot = options.queueRoot ?? options.config?.queueRoot;
  const nowDate = options.nowDate?.() ?? new Date();
  const expiresAt = nowDate.getTime() + (options.ttlMs ?? 43_200_000);
  const eventId = `evt_${randomUUID()}`;
  const publish = options.publish ?? ((input) => publishEvent(input));
  const threadId = safeId(payload?.thread_id ?? payload?.threadId, "permission-request");
  let metadata = { title: "Codex permission request", projectLabel: "Codex", cwdLabel: "Codex" };
  try { metadata = { ...metadata, ...(await options.resolveThreadMetadata?.({ threadId, cwd: payload?.cwd })) }; } catch {}
  const result = await publish({
    queueRoot, event_id: eventId, kind: "APPROVAL_REQUEST", created_at: nowDate.toISOString(), expires_at: new Date(expiresAt).toISOString(),
    thread: { id: threadId, turn_id: safeId(payload?.turn_id ?? payload?.turnId, "pending"), title: metadata.title, project_label: metadata.projectLabel, cwd_label: metadata.cwdLabel },
    text: "Codex requests approval for a local operation.", is_replyable: true, allowed_actions: ["APPROVE_ONCE", "DECLINE"],
  });
  const publishedId = result?.event?.event_id ?? eventId;
  const waitForReply = options.waitForReply ?? ((input) => defaultWaitForReply(input));
  const reply = await waitForReply({ queueRoot, eventId: publishedId, expiresAt, now: options.now, sleep: options.sleep, pollMs: options.pollMs });
  if (reply?.action !== "APPROVE_ONCE") return deny();
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
}

async function readStdin(stream = process.stdin) {
  const chunks = []; let bytes = 0;
  for await (const chunk of stream) { bytes += chunk.length; if (bytes > MAX_STDIN) throw new Error("HOOK_INPUT_TOO_LARGE"); chunks.push(chunk); }
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text || "{}");
}

export async function runCli(argv = process.argv.slice(2), env = process.env) {
  const payload = await readStdin();
  const payloadEvent = payload?.hook_event_name ?? payload?.hookEventName;
  const event = argv.length > 0 ? argv[0] : payloadEvent;
  if (!["SessionStart", "Stop", "PermissionRequest"].includes(event)) throw new Error("HOOK_EVENT");
  if (event === "SessionStart") return handleSessionStart(payload);
  if (event === "Stop") { await handleStop(payload, { stateRoot: env.HERMES_CODEX_STATE_ROOT }); return {}; }
  if (event === "PermissionRequest") {
    let config = {};
    if (env.HERMES_CODEX_CONFIG) config = JSON.parse(await readFile(env.HERMES_CODEX_CONFIG, "utf8"));
    const resolveThreadMetadata = config.codexHome
      ? createCodexThreadMetadataResolver({ globalStatePath: join(config.codexHome, ".codex-global-state.json") })
      : undefined;
    return handlePermissionRequest(payload, { config, queueRoot: env.HERMES_CODEX_QUEUE_ROOT ?? config.queueRoot, resolveThreadMetadata });
  }
  throw new Error("HOOK_EVENT");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().then((output) => { process.stdout.write(`${JSON.stringify(output)}\n`); }, () => { process.stdout.write(`${JSON.stringify(deny())}\n`); process.exitCode = 2; });
}
