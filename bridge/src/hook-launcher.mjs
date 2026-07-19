#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { runCli } from "./hook-adapter.mjs";

function option(argv, name) { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; }

export async function main(argv = process.argv.slice(2)) {
  const configPath = option(argv, "--config"); const event = argv.find((value) => ["SessionStart", "Stop", "PermissionRequest"].includes(value));
  if (!configPath || !isAbsolute(configPath) || !event) throw new Error("HOOK_LAUNCH_INPUT");
  let config; try { config = JSON.parse(await readFile(configPath, "utf8")); } catch { throw new Error("HOOK_LAUNCH_CONFIG"); }
  if (config?.schema !== "hermes-codex-bridge-config/v3" || !isAbsolute(config.queueRoot) || !isAbsolute(config.stateRoot)) throw new Error("HOOK_LAUNCH_CONFIG");
  const env = { ...process.env, HERMES_CODEX_CONFIG: configPath, HERMES_CODEX_QUEUE_ROOT: config.queueRoot, HERMES_CODEX_STATE_ROOT: config.stateRoot };
  return runCli([event], env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((output) => process.stdout.write(`${JSON.stringify(output)}\n`), () => { process.stderr.write("HOOK_LAUNCH_FAILED\n"); process.exitCode = 4; });
}
