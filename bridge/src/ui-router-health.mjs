const PENDING_THRESHOLD_MS = 180_000;
const HEARTBEAT_FRESH_MS = 150_000;

function timestamp(value, current) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= current ? parsed : Number.NaN;
}

export function createUiRouterHealth({ now = () => new Date() } = {}) {
  if (typeof now !== "function") throw new Error("UI_ROUTER_HEALTH_INPUT");
  let warnedKey = null;

  return {
    observe(snapshot) {
      const current = now().getTime();
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !Number.isFinite(current)) return { action: "NONE" };
      const oldest = timestamp(snapshot.oldestReadyAt, current);
      const heartbeat = snapshot.heartbeatAt === null ? null : timestamp(snapshot.heartbeatAt, current);
      if (Number.isNaN(oldest) || Number.isNaN(heartbeat)) return { action: "NONE" };

      const pendingIsOld = oldest !== null && current - oldest > PENDING_THRESHOLD_MS;
      const heartbeatIsFresh = heartbeat !== null && current - heartbeat <= HEARTBEAT_FRESH_MS;
      if (pendingIsOld && !heartbeatIsFresh) {
        const key = `ui-router-stale:${snapshot.oldestReadyAt}`;
        if (warnedKey === key) return { action: "NONE" };
        warnedKey = key;
        return { action: "WARN", key };
      }
      if (warnedKey !== null) {
        warnedKey = null;
        return { action: "RECOVERED" };
      }
      return { action: "NONE" };
    },
  };
}
