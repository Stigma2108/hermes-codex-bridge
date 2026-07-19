import { open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

function fail(code) { const error = new Error(code); error.code = code; return error; }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

function validate(value) {
  if (!record(value) || !record(value.hooks)) throw fail("HOOKS_SHAPE");
  for (const entries of Object.values(value.hooks)) {
    if (!Array.isArray(entries) || entries.some((entry) => !record(entry))) throw fail("HOOKS_SHAPE");
  }
  return value;
}

function adapterPath(command) {
  if (typeof command !== "string" || command.includes("\0")) throw fail("HOOK_COMMAND");
  const match = command.match(/(?:"([^"]*hook-adapter\.mjs)"|'([^']*hook-adapter\.mjs)'|([^\s"']*hook-adapter\.mjs))/iu);
  const path = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!path) throw fail("HOOK_COMMAND");
  const normalized = path.replaceAll("/", "\\").toLowerCase();
  if (!isAbsolute(normalized)) throw fail("HOOK_COMMAND");
  return normalized;
}

function containsAdapter(entry, target) {
  return Array.isArray(entry?.hooks) && entry.hooks.some((hook) => {
    try { return hook?.type === "command" && adapterPath(hook.command) === target; } catch { return false; }
  });
}

export function mergeHooks(existing, absoluteHookCommand) {
  validate(existing);
  const target = adapterPath(absoluteHookCommand);
  const merged = structuredClone(existing);
  for (const [name, timeout] of [["SessionStart", 30], ["Stop", 30], ["PermissionRequest", 43230]]) {
    merged.hooks[name] ??= [];
    if (!Array.isArray(merged.hooks[name])) throw fail("HOOKS_SHAPE");
    if (!merged.hooks[name].some((entry) => containsAdapter(entry, target))) {
      merged.hooks[name].push({ hooks: [{ type: "command", command: `${absoluteHookCommand} ${name}`, timeout }] });
    }
  }
  return merged;
}

async function parse(path) {
  let text;
  try { text = await readFile(path, "utf8"); } catch { throw fail("HOOKS_READ"); }
  let value;
  try { value = JSON.parse(text); } catch { throw fail("HOOKS_JSON"); }
  return { text, value: validate(value) };
}

async function atomicReplace(path, value) {
  const partial = `${path}.${randomUUID()}.partial`;
  let handle;
  try {
    handle = await open(partial, "wx");
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close(); handle = undefined;
    await rename(partial, path);
    try { const directory = await open(dirname(path), "r"); await directory.sync(); await directory.close(); } catch { /* Directory fsync is unavailable on some Windows filesystems. */ }
  } catch (error) {
    if (handle) try { await handle.close(); } catch {}
    try { await rm(partial, { force: true }); } catch {}
    throw error;
  }
}

function timestamp(date) { return date.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z"); }

export async function installHooks({ hooksPath, command, now = () => new Date() }) {
  const { text, value } = await parse(hooksPath);
  const merged = mergeHooks(value, command);
  if (JSON.stringify(merged) === JSON.stringify(value)) return { changed: false, backupPath: null, hooks: value };
  const backupPath = `${hooksPath}.hermes-codex-v3.${timestamp(now())}.bak`;
  let backup;
  try {
    backup = await open(backupPath, "wx");
    await backup.writeFile(text, "utf8"); await backup.sync(); await backup.close(); backup = undefined;
    await atomicReplace(hooksPath, merged);
  } catch (error) {
    if (backup) try { await backup.close(); } catch {}
    throw error;
  }
  return { changed: true, backupPath, hooks: merged };
}

export async function uninstallHooks({ hooksPath, command }) {
  const { value } = await parse(hooksPath);
  const target = adapterPath(command);
  const next = structuredClone(value);
  let changed = false;
  for (const name of ["SessionStart", "Stop", "PermissionRequest"]) {
    if (!Array.isArray(next.hooks[name])) continue;
    const kept = next.hooks[name].filter((entry) => !containsAdapter(entry, target));
    changed ||= kept.length !== next.hooks[name].length;
    if (kept.length === 0 && kept.length !== next.hooks[name].length) delete next.hooks[name];
    else next.hooks[name] = kept;
  }
  if (changed) await atomicReplace(hooksPath, next);
  return { changed, hooks: next };
}
