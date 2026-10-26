/**
 * Health state for the "smart" proxy-rotation strategy.
 *
 * The other strategies (round-robin, random) hand out a new pool on EVERY
 * request. "smart" does the opposite: it pins a provider to one pool and only
 * moves when that pool actually reports a limit/error — a healthy proxy keeps
 * serving, because rotating away from a working IP just wastes the clean ones
 * and spreads the ban across the whole pool.
 *
 * Two independent mechanisms:
 *   • sticky pick  — `current` is returned for as long as it stays usable
 *                    (not excluded by the in-flight retry, not cooling down).
 *   • cooldown     — a limit/error parks that pool for `cooldownMs`, so the
 *                    NEXT request also lands on another pool instead of
 *                    rediscovering the wall.
 *
 * In-memory and process-local, same as `rotateState` in connectionProxy.js:
 * it resets with the server. Kept on `globalThis` because this module gets
 * bundled into more than one route chunk and each copy must see one state.
 */

const HEALTH_KEY = "__9r_proxy_health__";

function healthStore() {
  if (!globalThis[HEALTH_KEY]) globalThis[HEALTH_KEY] = new Map();
  return globalThis[HEALTH_KEY];
}

function stateFor(providerId) {
  const store = healthStore();
  let state = store.get(providerId);
  if (!state) {
    state = { current: null, blocked: new Map() };
    store.set(providerId, state);
  }
  return state;
}

function pruneBlocked(state, now) {
  for (const [poolId, expiresAt] of state.blocked) {
    if (expiresAt <= now) state.blocked.delete(poolId);
  }
}

/**
 * Pick a pool for a provider, keeping the last working one while it is healthy.
 *
 * @param {string[]} poolIds - Active pool ids (order = preference order)
 * @param {string} providerId
 * @param {Set<string>} [excludePoolIds] - Pools already tried in THIS request
 * @returns {string|null} Pool id, or null when nothing is usable
 */
export function pickSmartProxyPoolId(poolIds, providerId, excludePoolIds = null) {
  if (!Array.isArray(poolIds) || poolIds.length === 0) return null;

  const now = Date.now();
  const state = stateFor(providerId);
  pruneBlocked(state, now);

  const excluded = excludePoolIds instanceof Set ? excludePoolIds : null;
  const isUsable = (poolId) =>
    (!excluded || !excluded.has(poolId)) && !(state.blocked.has(poolId) && state.blocked.get(poolId) > now);

  // Stick with the current proxy: this is the whole point of the strategy.
  if (state.current && poolIds.includes(state.current) && isUsable(state.current)) return state.current;

  const usable = poolIds.filter(isUsable);
  if (usable.length > 0) {
    state.current = usable[0];
    return state.current;
  }

  // Everything is cooling down or already tried: fall back to the pool whose
  // cooldown ends first so requests keep flowing instead of failing on the wall.
  const fallback = poolIds
    .filter((id) => !excluded || !excluded.has(id))
    .sort((a, b) => (state.blocked.get(a) ?? 0) - (state.blocked.get(b) ?? 0))[0];
  const picked = fallback ?? poolIds[0];
  state.current = picked;
  return picked;
}

/**
 * Park a pool after a limit/error so the next request does not reuse it.
 * @param {string} providerId
 * @param {string} poolId
 * @param {number} cooldownMs - How long to avoid this pool (0 = clear)
 */
export function markProxyUnhealthy(providerId, poolId, cooldownMs) {
  if (!providerId || !poolId) return;
  const state = stateFor(providerId);
  if (!cooldownMs || cooldownMs <= 0) {
    state.blocked.delete(poolId);
    return;
  }
  state.blocked.set(poolId, Date.now() + cooldownMs);
  if (state.current === poolId) state.current = null;
}

/**
 * A pool answered fine — keep it pinned and clear any stale cooldown.
 */
export function markProxyHealthy(providerId, poolId) {
  if (!providerId || !poolId) return;
  const state = stateFor(providerId);
  state.blocked.delete(poolId);
  state.current = poolId;
}

/** Reset state (settings change / tests). Omit providerId to clear everything. */
export function resetProxyHealth(providerId = null) {
  const store = healthStore();
  if (providerId) store.delete(providerId);
  else store.clear();
}

/** Introspection for tests and logs. */
export function getProxyHealth(providerId) {
  const state = healthStore().get(providerId);
  if (!state) return { current: null, blocked: [] };
  return { current: state.current, blocked: [...state.blocked.keys()] };
}
