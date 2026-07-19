import assert from "node:assert/strict";
import test from "node:test";

import { canonicalFinalIdentity, createDeterministicEventId } from "../src/final-identity.mjs";

test("canonical final identity and event id are producer-independent", () => {
  const identity = canonicalFinalIdentity({ threadId: "thread", turnId: "turn", itemId: "item" });
  assert.equal(identity, "codex:thread:turn:item:FINAL_RESPONSE");
  assert.equal(createDeterministicEventId(identity), createDeterministicEventId("codex:thread:turn:item:FINAL_RESPONSE"));
  assert.equal(canonicalFinalIdentity({ threadId: "thread", turnId: null, itemId: "item" }), null);
});
