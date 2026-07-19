import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { EVENT_KINDS, REPLY_ACTIONS, REPLY_MODES, validateEvent, validateReply } from "../src/contracts.mjs";

const root = new URL("../../protocol/v3/", import.meta.url);
const load = async (name) => JSON.parse(await readFile(new URL(name, root), "utf8"));
const exampleRoot = new URL("../../examples/", import.meta.url);
const loadExample = async (name) => JSON.parse(await readFile(new URL(name, exampleRoot), "utf8"));
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

test("protocol manifest and schemas cannot drift from runtime contracts", async () => {
  const [protocol, eventSchema, replySchema, deliverySchema, receiptSchema] = await Promise.all([
    load("protocol.json"), load("schemas/event.schema.json"), load("schemas/reply.schema.json"),
    load("schemas/delivery.schema.json"), load("schemas/receipt.schema.json"),
  ]);
  assert.deepEqual(protocol.event_kinds, EVENT_KINDS);
  assert.deepEqual(protocol.reply_actions, REPLY_ACTIONS);
  assert.deepEqual(protocol.reply_modes, REPLY_MODES);
  assert.deepEqual(eventSchema.properties.kind.enum, EVENT_KINDS);
  assert.deepEqual(eventSchema.properties.message.properties.reply_mode.enum, REPLY_MODES);
  assert.deepEqual(replySchema.properties.action.enum, REPLY_ACTIONS);
  for (const schema of [eventSchema, replySchema, deliverySchema, receiptSchema]) {
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.match(schema.$id, /^hermes-codex-interaction-[a-z]+\/v3$/u);
    assert.equal(schema.additionalProperties, true);
  }
  assert.equal(deliverySchema.properties.delivery_ref.description.includes("opaque"), true);
  assert.equal(receiptSchema.properties.error.additionalProperties, false);
});

test("published examples are accepted by the current runtime", async () => {
  const protocol = await load("protocol.json");
  assert.strictEqual(validateEvent(protocol.examples.event), protocol.examples.event);
  assert.strictEqual(validateReply(protocol.examples.reply), protocol.examples.reply);
});

test("public queue example is synthetic, linked, and accepted by the v3 runtime", async () => {
  const directory = "queue/bridge/v3/interactions/evt_00000000-0000-4000-8000-000000000001/";
  const [event, delivery, reply] = await Promise.all([
    loadExample(`${directory}event.json`),
    loadExample(`${directory}delivery.json`),
    loadExample(`${directory}reply.json`),
  ]);

  assert.strictEqual(validateEvent(event), event);
  assert.strictEqual(validateReply(reply), reply);
  assert.equal(event.event_id, "evt_00000000-0000-4000-8000-000000000001");
  assert.equal(event.thread.project_label, "Example Project");
  assert.equal(event.integrity.content_sha256, sha256(event.message.summary));
  assert.deepEqual(delivery, {
    schema: "hermes-codex-interaction-delivery/v3",
    event_id: event.event_id,
    delivery_ref: "tgmsg_1",
    created_at: "2026-07-19T12:00:05.000Z",
    attempts: 1,
  });
  assert.equal(reply.event_id, event.event_id);
  assert.equal(reply.telegram.delivery_ref, delivery.delivery_ref);
  assert.equal(reply.telegram.sender_fingerprint, sha256("hermes-codex-v3:telegram-user:1000000001"));
  assert.deepEqual(
    [event.created_at, event.expires_at, delivery.created_at, reply.created_at],
    ["2026-07-19T12:00:00.000Z", "2026-07-26T12:00:00.000Z", "2026-07-19T12:00:05.000Z", "2026-07-19T12:01:00.000Z"],
  );
});

test("public setup examples contain placeholders instead of local credentials and paths", async () => {
  const [environment, config] = await Promise.all([
    readFile(new URL(".env.example", exampleRoot), "utf8"),
    loadExample("windows-config.example.json"),
  ]);

  assert.equal(
    environment.replaceAll("\r\n", "\n"),
    "HERMES_TELEGRAM_TOKEN=<SET_ON_HERMES_HOST>\nHERMES_TELEGRAM_CHAT_ID=<SET_ON_HERMES_HOST>\n",
  );
  assert.deepEqual(Object.keys(config), [
    "schema", "queueRoot", "codexHome", "codexCommand", "stateRoot", "allowedWorkspaceRoots",
    "pollMinMs", "pollMaxMs", "replyTtlSeconds", "approvalTtlSeconds", "uiRouterMode",
  ]);
  assert.equal(config.schema, "hermes-codex-bridge-config/v3");
  assert.equal(config.queueRoot, "<WINDOWS_SHARED_ROOT>\\Queue\\bridge\\v3");
  assert.equal(config.codexHome, "<WINDOWS_CODEX_HOME>");
  assert.equal(config.codexCommand, "<WINDOWS_CODEX_COMMAND>");
  assert.equal(config.stateRoot, "<WINDOWS_STATE_ROOT>");
  assert.deepEqual(config.allowedWorkspaceRoots, ["<WINDOWS_WORKSPACE_ROOT>"]);
  assert.equal(config.uiRouterMode, "native");
  assert.doesNotMatch(JSON.stringify(config), /(?:[A-Z]:\\Users\\|\/home\/|telegram.*(?:token|chat).*[=:])/iu);
});

test("package metadata and public policies define the 1.0.0 release contract", async () => {
  const repositoryRoot = new URL("../../", import.meta.url);
  const [packageJson, license, changelog, contributing, security] = await Promise.all([
    loadExample("../bridge/package.json"),
    readFile(new URL("LICENSE", repositoryRoot), "utf8"),
    readFile(new URL("CHANGELOG.md", repositoryRoot), "utf8"),
    readFile(new URL("CONTRIBUTING.md", repositoryRoot), "utf8"),
    readFile(new URL("SECURITY.md", repositoryRoot), "utf8"),
  ]);

  assert.equal(packageJson.private, true);
  assert.equal(packageJson.license, "MIT");
  assert.equal(packageJson.repository.url, "https://github.com/Stigma2108/hermes-codex-bridge");
  assert.equal(packageJson.engines.node, ">=24");
  assert.match(license, /MIT License/u);
  assert.match(license, /Copyright \(c\) 2026 Stigma2108/u);
  assert.match(changelog, /## \[1\.0\.0\]/u);
  for (const topic of ["bridge", "installers", "diagnostics", "prompts", "documentation", "subagent", "reviewer"]) {
    assert.match(changelog.toLowerCase(), new RegExp(topic, "u"));
  }
  assert.match(contributing, /wholly synthetic fixtures/iu);
  assert.match(contributing, /tests/iu);
  assert.match(security, /private vulnerability reporting/iu);
  assert.match(security, /never attach Queue records, credentials, or private paths/iu);
});
