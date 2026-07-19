import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const promptNames = [
  "INSTALL_WITH_CODEX.md",
  "INSTALL_CODEX.md",
  "INSTALL_HERMES.md",
  "VERIFY_INSTALLATION.md",
  "UNINSTALL_WITH_CODEX.md",
];
const privateMachinePattern = new RegExp([
  "test-ai-second-", "brain-vault",
  "|C:\\\\Users\\\\", "stigm",
  "|D:\\\\", "Tools",
].join(""), "iu");

async function loadPrompts() {
  return new Map(await Promise.all(promptNames.map(async (name) => [
    name,
    await readFile(resolve(repoRoot, "prompts", name), "utf8"),
  ])));
}

function assertInOrder(text, labels, context) {
  let cursor = -1;
  for (const label of labels) {
    const next = text.indexOf(label, cursor + 1);
    assert.notEqual(next, -1, `${context}: missing ${label}`);
    assert.ok(next > cursor, `${context}: ${label} is out of order`);
    cursor = next;
  }
}

test("all guided prompts enforce the shared safety contract", async () => {
  const prompts = await loadPrompts();
  assert.deepEqual([...prompts.keys()], promptNames);

  for (const [name, text] of prompts) {
    assert.doesNotMatch(text, /[\u0400-\u04ff]/u, `${name}: prompt must be English`);
    assertInOrder(text, [
      "## Read-only preflight",
      "## Approval gate",
      "## Approved mutation",
      "## Verification",
      "## Owned-only rollback",
    ], name);
    assert.match(text, /redacted (?:JSON )?(?:output|report)/iu, `${name}: redacted output is required`);
    assert.match(text, /Never ask (?:the user )?to paste (?:a )?(?:Telegram )?token or chat ID/iu, `${name}: chat must not collect secrets`);
    assert.match(text, /protected local (?:environment|env) file/iu, `${name}: local protected secret storage is required`);
    assert.match(text, /explicit (?:user )?approval/iu, `${name}: mutation requires explicit approval`);
    assert.match(text, /Stop (?:immediately )?if/iu, `${name}: stop conditions are required`);
    assert.match(text, /owned-only/iu, `${name}: rollback ownership boundary is required`);
    assert.doesNotMatch(text, privateMachinePattern, `${name}: private path leaked`);
  }
});

test("master prompt defines the exact installation state machine and authority boundary", async () => {
  const master = (await loadPrompts()).get("INSTALL_WITH_CODEX.md");
  const states = [
    "DISCOVER",
    "PREFLIGHT",
    "PLAN",
    "WAIT_FOR_APPROVAL",
    "WINDOWS_INSTALL",
    "SYNCTHING_VERIFY",
    "HERMES_HANDOFF",
    "HERMES_VERIFY",
    "NATIVE_ROUTER_SETUP",
    "REAL_E2E",
    "REDACTED_REPORT",
  ];
  assert.match(master, new RegExp(states.join(" → ")));
  assertInOrder(master, states, "master state machine");
  assertInOrder(master, ["Hermes", "Telegram", "Syncthing", "Windows", "E2E"], "master prerequisites");
  for (const condition of ["missing authority", "failed sync", "failed unit tests", "unhealthy service", "ambiguous Codex thread identity"]) {
    assert.match(master, new RegExp(condition, "iu"));
  }
  assert.match(master, /Without explicitly authorized SSH access/iu);
  assert.match(master, /prompts\/INSTALL_HERMES\.md/u);
  assert.match(master, /wait for (?:the )?redacted Hermes result/iu);
  assert.doesNotMatch(master, /pretend (?:that )?remote setup succeeded/iu);
  assert.match(master, /Syncthing bootstrap/iu);
  assertInOrder(master, [
    "installed, running",
    "configured",
    "official/manual installation",
    "device ID",
    "Send & Receive",
    ".stignore",
    "autostart",
    "two-sided sentinel",
    "WINDOWS_INSTALL",
  ], "clean Syncthing bootstrap");
  assert.match(master, /explicit user approval[^.]*Syncthing/iu);
  assert.match(master, /Do not automate[^.]*remote Hermes[^.]*authority/iu);
  assert.match(master, /Never[^.]*tokens? or chat IDs?[^.]*chat/iu);
});

test("Windows prompt names the portable installer, doctor, and native router targets", async () => {
  const text = (await loadPrompts()).get("INSTALL_CODEX.md");
  for (const path of [
    "bridge/scripts/Test-Prerequisites.ps1",
    "bridge/scripts/Install-Bridge.ps1",
    "bridge/src/cli.mjs",
    "bridge/assets/UI_ROUTER_PROMPT.md",
    "bridge/src/ui-router-cli.mjs",
  ]) assert.match(text, new RegExp(path.replaceAll("/", "\\/"), "u"), `missing ${path}`);
  assert.match(text, /-WhatIf/u);
  assert.match(text, /doctor --config/u);
  assert.match(text, /UiRouterMode native/u);
});

test("Hermes prompt requires official onboarding before bridge mutation", async () => {
  const text = (await loadPrompts()).get("INSTALL_HERMES.md");
  assertInOrder(text, ["`hermes`", "normal local Hermes chat", "`hermes gateway setup`", "normal Telegram conversation", "<shared-root>/v3/hermes", "scripts/install.sh"], "Hermes onboarding");
  for (const path of ["scripts/install.sh", "doctor.py", "hermes/templates/hermes-codex-bridge.service.in", "hermes/templates/SKILL.md.in"]) {
    assert.match(text, new RegExp(path.replaceAll("/", "\\/"), "u"), `missing ${path}`);
  }
  assert.match(text, /installer verifies these permissions; it does not create the account or grant them/iu);
  assert.match(text, /preserves the pre-existing dedicated env file by default/iu);
  assert.match(text, /HERMES_TELEGRAM_TOKEN/u);
  assert.match(text, /HERMES_TELEGRAM_CHAT_ID/u);
  assert.match(text, /chmod 600/u);
  assert.match(text, /--apply/u);
});

test("verification prompt requires convergence and a routed round trip", async () => {
  const text = (await loadPrompts()).get("VERIFY_INSTALLATION.md");
  assertInOrder(text, ["Syncthing convergence", "Windows health", "Hermes health", "originating Codex", "real E2E"], "verification sequence");
  assert.match(text, /Telegram Reply/iu);
  assert.match(text, /exact originating (?:Codex )?(?:task|thread)/iu);
  assert.match(text, /Do not copy (?:raw )?Queue records/iu);
  assert.match(text, /tests\/Run-V3Tests\.ps1/u);
});

test("uninstall prompt preserves user-owned data and requests authority per host", async () => {
  const text = (await loadPrompts()).get("UNINSTALL_WITH_CODEX.md");
  assert.match(text, /bridge\/scripts\/Uninstall-Bridge\.ps1/u);
  assert.match(text, /hermes\/scripts\/uninstall\.sh/u);
  assert.match(text, /separate explicit approval for each authority/iu);
  assert.match(text, /Do not delete (?:the )?Queue, Syncthing (?:configuration|data), or user-owned Hermes data/iu);
  assert.match(text, /separately authorized/iu);
  assertInOrder(text, [
    "--apply",
    "preserves the dedicated env file",
    "separate explicit approval",
    "--remove-env",
  ], "Hermes env removal approval");
  assert.doesNotMatch(text, /installer owns (?:the )?pre-existing env file/iu);
  assert.doesNotMatch(text, /Both uninstallers are transactional/iu);
  assert.match(text, /Hermes uninstall[^.]*transactionally rolls back/iu);
  assert.match(text, /Windows uninstall[^.]*fails closed before mutation[^.]*provenance[^.]*task/iu);
  assert.match(text, /UNINSTALL_PARTIAL[^.]*non-transactional/iu);
  assert.match(text, /preserve (?:the )?evidence[^.]*do not retry destructive steps blindly/iu);
});
