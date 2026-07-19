import { createHash } from "node:crypto";

function explicit(value) { return typeof value === "string" && value.length > 0 ? value : null; }

export function canonicalFinalIdentity({ threadId, turnId, itemId }) {
  const thread = explicit(threadId); const turn = explicit(turnId); const item = explicit(itemId);
  return thread && turn && item ? `codex:${thread}:${turn}:${item}:FINAL_RESPONSE` : null;
}

export function createDeterministicEventId(identity) {
  const digits = createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 32).split("");
  digits[12] = "5"; digits[16] = (8 + (Number.parseInt(digits[16], 16) & 3)).toString(16);
  const uuid = digits.join("");
  return `evt_${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
}
