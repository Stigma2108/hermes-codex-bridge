import assert from "node:assert/strict";
import test from "node:test";

import { resolveCodexCommand } from "../src/codex-command-resolver.mjs";

const windowsTest = process.platform === "win32" ? test : test.skip;

windowsTest("newer Desktop cached Codex wins over a stale configured CLI", async () => {
  const configured = "C:\\Programs\\OpenAI\\Codex\\codex.exe";
  const current = "C:\\Users\\demo\\AppData\\Local\\OpenAI\\Codex\\bin\\abcdef0123456789\\codex.exe";
  const resolved = await resolveCodexCommand({
    configured,
    localAppData: "C:\\Users\\demo\\AppData\\Local",
    discover: async () => [configured, current],
    inspect: async () => true,
    probeVersion: async (path) => path === current ? "codex-cli 0.145.0-alpha.18" : "codex-cli 0.144.4",
  });
  assert.equal(resolved, current);
});

windowsTest("non-Codex test executables remain untouched", async () => {
  let discovered = false;
  const configured = "C:\\Program Files\\nodejs\\node.exe";
  const resolved = await resolveCodexCommand({
    configured,
    discover: async () => { discovered = true; return []; },
  });
  assert.equal(resolved, configured);
  assert.equal(discovered, false);
});

windowsTest("invalid cached candidates are skipped and configured Codex remains usable", async () => {
  const configured = "C:\\Programs\\OpenAI\\Codex\\codex.exe";
  const invalid = "C:\\Users\\demo\\AppData\\Local\\OpenAI\\Codex\\bin\\abcdef0123456789\\codex.exe";
  const resolved = await resolveCodexCommand({
    configured,
    discover: async () => [configured, invalid],
    inspect: async (path) => {
      if (path === invalid) throw Object.assign(new Error("symlink"), { code: "CODEX_COMMAND_PATH" });
      return path;
    },
    probeVersion: async () => "codex-cli 0.144.4",
  });
  assert.equal(resolved, configured);
});
