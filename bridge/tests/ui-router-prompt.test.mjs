import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const promptUrl = new URL("../assets/UI_ROUTER_PROMPT.md", import.meta.url);

test("router stale guard uses native thread update time instead of cross-API turn IDs", async () => {
  const prompt = await readFile(promptUrl, "utf8");
  assert.match(prompt, /actionCreatedAt/u);
  assert.match(prompt, /updatedAt/u);
  assert.doesNotMatch(prompt, /after sourceTurnId/u);
});

test("router does not preflight an open target with the hanging read_thread path", async () => {
  const prompt = await readFile(promptUrl, "utf8");
  assert.match(prompt, /codex_app\.list_threads/u);
  assert.match(prompt, /updatedAt/u);
  assert.doesNotMatch(prompt, /claim it\. Read the target with `codex_app\.read_thread`/u);
  assert.match(prompt, /After sending, use `codex_app\.read_thread`/u);
});
