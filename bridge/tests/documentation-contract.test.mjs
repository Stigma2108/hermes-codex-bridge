import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const docs = [
  "README.md",
  "docs/ARCHITECTURE.md",
  "docs/INSTALL-CODEX.md",
  "docs/INSTALL-HERMES.md",
  "docs/SYNCTHING.md",
  "docs/USAGE.md",
  "docs/CONFIGURATION.md",
  "docs/TROUBLESHOOTING.md",
  "docs/UNINSTALL.md",
];
const privateMachinePattern = new RegExp([
  "C:\\\\Users\\\\",
  "|D:\\\\", "Tools",
  "|test-ai-second-", "brain-vault",
  "|", "stigm",
].join(""), "iu");

const exactMermaid = `flowchart LR
 C["Codex Desktop on Windows"] --> QW["Write-once Queue"]
 QW <-->|"Syncthing"| QH["Queue on Linux"]
 QH --> H["Hermes watcher"]
 H --> T["Telegram"]
 T --> H
 H --> QH
 QW --> C`;

async function contents() {
  return new Map(await Promise.all(docs.map(async (name) => [name, (await readFile(resolve(repoRoot, name), "utf8")).replaceAll("\r\n", "\n")])));
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

function githubSlug(heading) {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/gu, "-");
}

test("public documentation exists, is English, and contains no private data", async () => {
  const files = await contents();
  assert.deepEqual([...files.keys()], docs);
  for (const [name, text] of files) {
    assert.doesNotMatch(text, /[\u0400-\u04ff]/u, `${name}: must be English`);
    assert.doesNotMatch(text, privateMachinePattern, `${name}: private machine detail leaked`);
    assert.doesNotMatch(text, /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/u, `${name}: Telegram bot token leaked`);
    assert.doesNotMatch(text, /HERMES_TELEGRAM_(?:TOKEN|CHAT_ID)=\s*[^<\s`]/u, `${name}: credential value must stay local`);
  }
});

test("README presents the product promise and exact ten-step path", async () => {
  const readme = (await contents()).get("README.md");
  assertInOrder(readme, [
    "## Promise",
    "## Status",
    "## What You Get",
    "## Architecture",
    "## Prerequisites",
    "## 10-Step Quick Start",
    "## Security Properties",
    "## Supported Events and Actions",
    "## Tests",
    "## Limitations",
    "## Documentation",
    "## Contributing",
    "## License",
    "## Independence Disclaimer",
  ], "README sections");
  assert.match(readme, /Production-ready for self-hosted use/u);
  assert.match(readme, /Codex\s*(?:→|->)\s*Telegram\s*(?:→|->)\s*Reply\s*(?:→|->)\s*same originating (?:Codex )?(?:thread|task)/iu);
  assert.match(readme, /does not start arbitrary new Codex tasks from unthreaded Telegram messages/u);
  assert.match(readme, /not affiliated with OpenAI, Telegram, Syncthing, or Nous Research/iu);
  assert.match(readme, new RegExp(exactMermaid.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  const quickStart = readme.slice(readme.indexOf("## 10-Step Quick Start"), readme.indexOf("## Security Properties"));
  assert.deepEqual([...quickStart.matchAll(/^\d+\. /gmu)].map((match) => match[0]), ["1. ", "2. ", "3. ", "4. ", "5. ", "6. ", "7. ", "8. ", "9. ", "10. "]);
  assert.match(quickStart, /prompts\/INSTALL_WITH_CODEX\.md/u);
  assert.match(quickStart, /guided|master prompt/iu);
});

test("guides document prerequisites, real commands, redacted evidence, failures, and recovery", async () => {
  const files = await contents();
  for (const name of docs.filter((name) => name !== "README.md" && name !== "docs/ARCHITECTURE.md")) {
    const text = files.get(name);
    for (const heading of ["## Prerequisites", "## Expected Redacted Output", "## Failure Behavior", "## Rollback and Recovery"]) {
      assert.match(text, new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "mu"), `${name}: missing ${heading}`);
    }
  }

  assert.match(files.get("docs/INSTALL-CODEX.md"), /Test-Prerequisites\.ps1[^\n]*-SharedRoot "<WINDOWS_SHARED_ROOT>"[^\n]*-CodexHome "<CODEX_HOME>"[^\n]*-Json/u);
  assert.match(files.get("docs/INSTALL-CODEX.md"), /Install-Bridge\.ps1[^\n]*-IntegrationRoot "<WINDOWS_INTEGRATION_ROOT>"[^\n]*-QueueRoot "<WINDOWS_SHARED_ROOT>[\\/]Queue[\\/]bridge[\\/]v3"[^\n]*-AllowedWorkspaceRoots "<WINDOWS_WORKSPACE_ROOT>"[^\n]*-UiRouterMode external[^\n]*-WhatIf/u);
  assert.match(files.get("docs/INSTALL-CODEX.md"), /doctor --config "<WINDOWS_TARGET_ROOT>[\\/]config\.json"/u);
  assert.match(files.get("docs/INSTALL-HERMES.md"), /cd "<HERMES_PAYLOAD_ROOT>"[\s\S]*\.\/scripts\/install\.sh --queue-root "<LINUX_SHARED_ROOT>\/Queue\/bridge\/v3" --hermes-home "<HERMES_HOME>" --env-file "<HERMES_ENV_FILE>" --service-user hermes --apply/u);
  assert.match(files.get("docs/INSTALL-HERMES.md"), /\.\/doctor\.py --queue-root "<LINUX_SHARED_ROOT>\/Queue\/bridge\/v3" --env-file "<HERMES_ENV_FILE>" --runtime-root \/opt\/hermes-codex-bridge-v3/u);
  assert.match(files.get("docs/INSTALL-HERMES.md"), /sudo -u hermes test -[rwx] "<LINUX_SHARED_ROOT>\/Queue\/bridge\/v3/u);
  assert.match(files.get("docs/INSTALL-CODEX.md"), /<WINDOWS_INTEGRATION_ROOT>.*use `<WINDOWS_SHARED_ROOT>` itself/iu);
  assert.match(files.get("docs/UNINSTALL.md"), /uninstall\.sh[^\n]*--remove-env[^\n]*--apply/u);
  assert.match(files.get("docs/UNINSTALL.md"), /UNINSTALL_PARTIAL/u);
  assert.match(files.get("docs/UNINSTALL.md"), /UNINSTALL_ROLLBACK/u);
});

test("architecture, operations, security, and behavior match the v3 contract", async () => {
  const files = await contents();
  const all = [...files.values()].join("\n");
  for (const phrase of [
    "write-once",
    "ownership manifest",
    "reparse",
    "redacted",
    "--remove-env",
    "protected local env file",
    "task start",
    "bounded heartbeat",
    "subagent",
    "reviewer",
  ]) assert.match(all, new RegExp(phrase, "iu"), `missing operational contract: ${phrase}`);

  const usage = files.get("docs/USAGE.md");
  for (const scenario of ["Final response", "Question", "Approve once", "Decline", "Windows offline", "Hermes offline", "Busy thread", "Stale reply", "Telegram Reply"]) {
    assert.match(usage, new RegExp(scenario, "iu"), `usage scenario missing: ${scenario}`);
  }
  assert.match(usage, /same originating (?:Codex )?(?:thread|task)/iu);
  assert.match(usage, /subagent.*suppressed|suppressed.*subagent/isu);
  assert.match(usage, /reviewer.*suppressed|suppressed.*reviewer/isu);

  const config = files.get("docs/CONFIGURATION.md");
  for (const field of ["queueRoot", "codexHome", "codexCommand", "stateRoot", "allowedWorkspaceRoots", "pollMinMs", "pollMaxMs", "replyTtlSeconds", "approvalTtlSeconds", "uiRouterMode"]) {
    assert.match(config, new RegExp(`\\b${field}\\b`, "u"), `config field missing: ${field}`);
  }
  assert.match(config, /HERMES_TELEGRAM_TOKEN/u);
  assert.match(config, /HERMES_TELEGRAM_CHAT_ID/u);
});

test("Syncthing and Hermes prerequisites point to official primary sources", async () => {
  const files = await contents();
  const all = [...files.values()].join("\n");
  for (const url of [
    "https://github.com/NousResearch/hermes-agent",
    "https://docs.syncthing.net/intro/getting-started.html",
    "https://docs.syncthing.net/users/autostart.html",
    "https://docs.syncthing.net/users/ignoring.html",
  ]) assert.match(all, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), `official source missing: ${url}`);
  const hermes = files.get("docs/INSTALL-HERMES.md");
  assertInOrder(hermes, [
    "install Hermes",
    "verify `hermes`",
    "normal local Hermes chat",
    "hermes gateway setup",
    "normal Telegram conversation",
    "bridge preflight",
    "install.sh",
  ], "Hermes prerequisite order");
  const sync = files.get("docs/SYNCTHING.md");
  for (const phrase of ["device pairing", "Send & Receive", "autostart", ".stignore", "conflict", "not a backup"]) assert.match(sync, new RegExp(phrase, "iu"));
});

test("configuration defines illustrative placeholders before their first use", async () => {
  const config = (await contents()).get("docs/CONFIGURATION.md");
  const illustrative = config.indexOf("Illustrative shape only");
  assert.notEqual(illustrative, -1);
  for (const placeholder of [
    "<ABSOLUTE_QUEUE_ROOT>",
    "<ABSOLUTE_CODEX_HOME>",
    "<ABSOLUTE_CODEX_COMMAND>",
    "<ABSOLUTE_STATE_ROOT>",
    "<ABSOLUTE_WORKSPACE_ROOT>",
  ]) {
    const definition = config.indexOf(`- \`${placeholder}\` —`);
    const firstUse = config.indexOf(placeholder);
    assert.notEqual(definition, -1, `missing definition for ${placeholder}`);
    assert.equal(firstUse, definition + 3, `${placeholder} must be defined at its first use`);
    assert.ok(definition < illustrative, `${placeholder} must be defined before the example`);
  }
});

test("troubleshooting maps stable codes without asking for sensitive evidence", async () => {
  const troubleshooting = (await contents()).get("docs/TROUBLESHOOTING.md");
  for (const code of [
    "PREREQ_NODE_VERSION",
    "PREREQ_SYNCTHING_MISSING",
    "SAFETY_REPARSE_POINT",
    "INSTALL_OWNERSHIP_CONFLICT",
    "DOCTOR_SERVICE_HEARTBEAT_STALE",
    "DOCTOR_UI_ROUTER_HEARTBEAT_STALE",
    "DOCTOR_ENV_MODE",
    "DOCTOR_QUEUE_WRITE",
    "UNINSTALL_PARTIAL",
    "UNINSTALL_ROLLBACK",
  ]) assert.match(troubleshooting, new RegExp(`\\b${code}\\b`, "u"), `stable code missing: ${code}`);
  assert.doesNotMatch(troubleshooting, /(?:post|paste|publish|upload|send|share).{0,40}(?:Queue payload|event\.json|reply\.json|credential|token|absolute path)/isu);
});

test("repository-relative documentation links resolve, including anchors", async () => {
  const files = await contents();
  for (const [sourceName, text] of files) {
    for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
      const raw = match[1].trim().replace(/^<|>$/gu, "");
      if (/^(?:https?:|mailto:)/iu.test(raw)) continue;
      const [targetPart, anchor] = raw.split("#", 2);
      const targetName = targetPart || sourceName;
      const target = resolve(repoRoot, dirname(sourceName), targetName);
      await assert.doesNotReject(access(target), `${sourceName}: missing link target ${raw}`);
      if (anchor) {
        const targetText = await readFile(target, "utf8");
        const slugs = [...targetText.matchAll(/^#{1,6}\s+(.+)$/gmu)].map((heading) => githubSlug(heading[1]));
        assert.ok(slugs.includes(anchor.toLowerCase()), `${sourceName}: missing anchor ${raw}`);
      }
    }
  }
});
