const ACTIVE_STATES = Object.freeze(["PENDING_PRESENCE", "READY"]);

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function finiteDateMs(now) {
  const value = now().getTime();
  if (!Number.isSafeInteger(value) || value < 0) throw failure("GATE_CLOCK");
  return value;
}

function exactObservation(observation, idempotencyKey) {
  if (!observation || typeof observation !== "object" || Array.isArray(observation) ||
      !["final", "control"].includes(observation.channel) || typeof observation.kind !== "string" ||
      typeof observation.eventId !== "string" || observation.eventId !== idempotencyKey) {
    throw failure("GATE_OBSERVATION");
  }
  return observation;
}

export function createNotificationGate({
  store,
  publish,
  presence,
  now = () => new Date(),
  localGraceMs = 300_000,
  awayIdleMs = 90_000,
  goalSettleMs = 15_000,
} = {}) {
  if (!store?.put || !store?.get || !store?.list || !store?.transition || typeof publish !== "function" ||
      !presence?.sample || typeof now !== "function" ||
      !Number.isSafeInteger(localGraceMs) || localGraceMs < 1 ||
      !Number.isSafeInteger(awayIdleMs) || awayIdleMs < 1 ||
      !Number.isSafeInteger(goalSettleMs) || goalSettleMs < 0) {
    throw failure("GATE_INPUT");
  }

  async function cancelThread(threadId, targetState, states) {
    if (typeof threadId !== "string" || threadId.length === 0) return 0;
    let changed = 0;
    for (const candidate of await store.list(states)) {
      if (candidate.threadId !== threadId) continue;
      await store.transition(candidate.eventId, targetState, { reason: targetState });
      changed += 1;
    }
    return changed;
  }

  async function observeFinal(observation) {
    const observedAtMs = finiteDateMs(now);
    const threadId = typeof observation.threadId === "string" && observation.threadId ? observation.threadId : "unknown-thread";
    const turnId = typeof observation.turnId === "string" && observation.turnId ? observation.turnId : "unknown-turn";
    return store.put({
      schema: 1,
      eventId: observation.eventId,
      threadId,
      turnId,
      kind: observation.kind,
      state: "PENDING_PRESENCE",
      message: observation,
      observedAtMs,
      localDeadlineMs: observedAtMs + localGraceMs,
      stabilizeUntilMs: observation.kind === "FINAL_RESPONSE" ? observedAtMs + goalSettleMs : observedAtMs,
    });
  }

  async function observeControl(observation) {
    if (observation.kind === "AUTO_GOAL_CONTINUATION") {
      return cancelThread(observation.threadId, "CANCELLED_AUTO_CONTINUATION", ACTIVE_STATES);
    }
    if (observation.kind === "USER_INPUT") {
      const pending = await cancelThread(observation.threadId, "CANCELLED_LOCAL_REPLY", ACTIVE_STATES);
      const published = await cancelThread(observation.threadId, "STALE_LOCAL_REPLY", ["PUBLISHED"]);
      return pending + published;
    }
    if (observation.kind === "TURN_STARTED") return 0;
    throw failure("GATE_CONTROL");
  }

  async function observe(observation, { idempotencyKey } = {}) {
    const exact = exactObservation(observation, idempotencyKey);
    if (exact.channel === "final") await observeFinal(exact);
    else await observeControl(exact);
    return { idempotencyKey };
  }

  async function flush({ signal } = {}) {
    let sample = { state: "UNKNOWN", idleMs: null };
    try {
      const observed = await presence.sample({ awayIdleMs });
      if (observed && ["DESK", "AWAY", "UNKNOWN"].includes(observed.state)) sample = observed;
    } catch {}
    let published = 0;
    for (const candidate of await store.list(ACTIVE_STATES)) {
      if (signal?.aborted) break;
      const currentMs = finiteDateMs(now);
      const settled = candidate.kind !== "FINAL_RESPONSE" || currentMs >= candidate.stabilizeUntilMs;
      const due = settled && (sample.state === "AWAY" || currentMs >= candidate.localDeadlineMs);
      if (!due) continue;
      if (candidate.state === "PENDING_PRESENCE") await store.transition(candidate.eventId, "READY");
      const acknowledgment = await publish(candidate.message, { idempotencyKey: candidate.eventId, signal });
      if (acknowledgment?.idempotencyKey !== candidate.eventId) throw failure("GATE_PUBLISH_ACK");
      await store.transition(candidate.eventId, "PUBLISHED");
      published += 1;
    }
    return { published };
  }

  async function isReplyCurrent(event) {
    const eventId = event?.event_id;
    if (typeof eventId !== "string") return false;
    let candidate;
    try { candidate = await store.get(eventId); } catch { return false; }
    return candidate?.state === "PUBLISHED";
  }

  return { observe, flush, isReplyCurrent };
}
