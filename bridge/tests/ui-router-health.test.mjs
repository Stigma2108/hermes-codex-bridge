import assert from "node:assert/strict";
import test from "node:test";

import { createUiRouterHealth } from "../src/ui-router-health.mjs";

test("warns once only when pending exceeds three minutes and heartbeat is stale", () => {
  const health = createUiRouterHealth({ now: () => new Date("2026-07-19T12:05:00Z") });
  assert.deepEqual(health.observe({ oldestReadyAt: "2026-07-19T12:00:00Z", heartbeatAt: "2026-07-19T12:00:30Z" }), {
    action: "WARN",
    key: "ui-router-stale:2026-07-19T12:00:00Z",
  });
  assert.equal(health.observe({ oldestReadyAt: "2026-07-19T12:00:00Z", heartbeatAt: "2026-07-19T12:00:30Z" }).action, "NONE");
  assert.equal(health.observe({ oldestReadyAt: null, heartbeatAt: "2026-07-19T12:05:00Z" }).action, "RECOVERED");
});

test("fresh heartbeat, young backlog, malformed state, and future timestamps do not warn", () => {
  const health = createUiRouterHealth({ now: () => new Date("2026-07-19T12:05:00Z") });
  for (const snapshot of [
    { oldestReadyAt: null, heartbeatAt: null },
    { oldestReadyAt: "2026-07-19T12:03:00Z", heartbeatAt: "2026-07-19T12:00:00Z" },
    { oldestReadyAt: "2026-07-19T12:00:00Z", heartbeatAt: "2026-07-19T12:04:00Z" },
    { oldestReadyAt: "bad", heartbeatAt: null },
    { oldestReadyAt: "2026-07-19T12:06:00Z", heartbeatAt: "2026-07-19T12:00:00Z" },
    { oldestReadyAt: "2026-07-19T12:00:00Z", heartbeatAt: "2026-07-19T12:06:00Z" },
  ]) assert.equal(health.observe(snapshot).action, "NONE");
});

test("recovery clears one-shot state so a later outage warns again", () => {
  let instant = new Date("2026-07-19T12:05:00Z");
  const health = createUiRouterHealth({ now: () => instant });
  const stale = { oldestReadyAt: "2026-07-19T12:00:00Z", heartbeatAt: null };
  assert.equal(health.observe(stale).action, "WARN");
  assert.equal(health.observe({ oldestReadyAt: null, heartbeatAt: "2026-07-19T12:05:00Z" }).action, "RECOVERED");
  instant = new Date("2026-07-19T12:10:00Z");
  assert.equal(health.observe({ oldestReadyAt: "2026-07-19T12:06:00Z", heartbeatAt: null }).action, "WARN");
});
