import { ERROR_RULES, BACKOFF_CONFIG, TRANSIENT_COOLDOWN_MS } from "../config/errorConfig";

/**
 * Calculate exponential backoff cooldown for rate limits (429)
 * Level 1: 1s, Level 2: 2s, Level 3: 4s... → max 4 min
 * @param {number} backoffLevel - Current backoff level
 * @returns {number} Cooldown in milliseconds
 */
export function getQuotaCooldown(backoffLevel = 0) {
  const level = Math.max(0, backoffLevel - 1);
  const cooldown = BACKOFF_CONFIG.base * Math.pow(2, level);
  return Math.min(cooldown, BACKOFF_CONFIG.max);
}

// Statuses that make the *IP* the suspect rather than the request: a limit, a
// deny, or the upstream (or the proxy itself) failing. 400/404/422 are about
// the body or the model id — nothing a different address would fix.
const PROXY_FAILURE_STATUSES = new Set([401, 402, 403, 429]);

/**
 * Should a PROXY be rotated after this response?
 *
 * Separate from checkFallbackError on purpose: that one decides whether to cool
 * an *account* down (and locks 404, because a dead credential answering 404 is
 * still a dead credential). Rotating a proxy is a different axis — burning a
 * clean IP because a client asked for a model that does not exist would exhaust
 * the pool over a typo. So: limits, IP-level denies, upstream/proxy failures and
 * the limit wording in ERROR_RULES' backoff rules; nothing else.
 *
 * @param {number} status - HTTP status (0 / undefined = connect-level failure)
 * @param {string} errorText
 * @returns {boolean}
 */
export function shouldRotateProxy(status, errorText) {
  const code = Number(status) || 0;
  if (code === 0) return true;                 // DNS/connect/TLS/timeout via the proxy
  if (code >= 500) return true;                // upstream blew up, or the proxy 502/504'd
  if (PROXY_FAILURE_STATUSES.has(code)) return true;

  const lower = typeof errorText === "string" ? errorText.toLowerCase()
    : errorText ? JSON.stringify(errorText).toLowerCase() : "";
  if (!lower) return false;
  // Config-driven: the same limit wording that drives account backoff.
  return ERROR_RULES.some((rule) => rule.backoff && rule.text && lower.includes(rule.text));
}

/**
 * Check if error should trigger account fallback (switch to next account)
 * Config-driven: matches ERROR_RULES top-to-bottom (text rules first, then status)
 * A rule with `lock: false` is a client mistake (bad request, unsupported model):
 * the combo chain still moves on, but no account is penalised or cooled down.
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message text
 * @param {number} backoffLevel - Current backoff level for exponential backoff
 * @returns {{ shouldFallback: boolean, cooldownMs: number, shouldLock?: boolean, newBackoffLevel?: number }}
 */
export function checkFallbackError(status, errorText, backoffLevel = 0, provider = null) {
  const lowerError = errorText
    ? (typeof errorText === "string" ? errorText : JSON.stringify(errorText)).toLowerCase()
    : "";

  for (const rule of ERROR_RULES) {
    // Per-provider rules only apply to their own provider.
    if (rule.provider && rule.provider !== provider) continue;
    // A rule hits on message text (substring) or on the HTTP status code.
    const textHit = rule.text && lowerError && lowerError.includes(rule.text);
    const statusHit = rule.status && rule.status === status;
    if (!textHit && !statusHit) continue;

    // `lock: false` = the caller's request was wrong, not the account's.
    // Keep the combo chain rotating but never penalise the account.
    // Text-based rules (transport quirks) advance to the next model;
    // generic status-only 400 means the request itself is invalid — stop.
    if (rule.lock === false) {
      return {
        shouldFallback: false,
        cooldownMs: 0,
        requestScoped: Boolean(rule.text),
      };
    }

    if (rule.backoff) {
      const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
      return { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel), newBackoffLevel: newLevel };
    }
    return { shouldFallback: true, cooldownMs: rule.cooldownMs };
  }

  // Request-scoped client errors that matched no rule above: a 400 caused by the
  // request itself (context overflow, malformed body, unsupported parameter) says
  // nothing about the credential, so cooling the account down only removes a
  // healthy connection from rotation. With a single connection it is worse: every
  // later request in the window fails with a copy of this very error
  // ("all 1 accounts locked for <model> | lastError=[400]: ..."), which hides the
  // real cause from the caller and makes unrelated sessions look like they hit the
  // same limit. Hand the upstream error back for this request instead.
  // Account-scoped statuses keep their rules above (401/402/403/404/429), and the
  // text rules still win for rate-limit / quota / capacity wording.
  if (status >= 400 && status < 500 && status !== 401 && status !== 402 && status !== 403 && status !== 429) {
    return { shouldFallback: false, cooldownMs: 0, requestScoped: true };
  }

  // Default: transient cooldown for any unmatched error
  return { shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS };
}

/**
 * Check if account is currently unavailable (cooldown not expired)
 * @deprecated Reads the legacy `unavailableUntil` field, which the live path
 * never writes — locks are flat `modelLock_*` fields now. Use
 * `isModelLockActive(connection, model)` instead.
 */
export function isAccountUnavailable(unavailableUntil) {
  if (!unavailableUntil) return false;
  return new Date(unavailableUntil).getTime() > Date.now();
}

/**
 * Calculate unavailable until timestamp
 */
export function getUnavailableUntil(cooldownMs) {
  return new Date(Date.now() + cooldownMs).toISOString();
}

/**
 * Get the earliest rateLimitedUntil from a list of accounts
 * @deprecated Reads the legacy `rateLimitedUntil` field, which the live path
 * never writes — locks are flat `modelLock_*` fields now. Use
 * `getEarliestModelLockUntil(connection)` per connection instead.
 * @param {Array} accounts - Array of account objects with rateLimitedUntil
 * @returns {string|null} Earliest rateLimitedUntil ISO string, or null
 */
export function getEarliestRateLimitedUntil(accounts) {
  let earliest = null;
  const now = Date.now();
  for (const acc of accounts) {
    if (!acc.rateLimitedUntil) continue;
    const until = new Date(acc.rateLimitedUntil).getTime();
    if (until <= now) continue;
    if (!earliest || until < earliest) earliest = until;
  }
  if (!earliest) return null;
  return new Date(earliest).toISOString();
}

/**
 * Format rateLimitedUntil to human-readable "reset after Xm Ys"
 * @param {string} rateLimitedUntil - ISO timestamp
 * @returns {string} e.g. "reset after 2m 30s"
 */
export function formatRetryAfter(rateLimitedUntil) {
  if (!rateLimitedUntil) return "";
  const diffMs = new Date(rateLimitedUntil).getTime() - Date.now();
  if (diffMs <= 0) return "reset after 0s";
  const totalSec = Math.ceil(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return `reset after ${parts.join(" ")}`;
}

/** Prefix for model lock flat fields on connection record */
export const MODEL_LOCK_PREFIX = "modelLock_";

/** Special key used when no model is known (account-level lock) */
export const MODEL_LOCK_ALL = `${MODEL_LOCK_PREFIX}__all`;

/** Build the flat field key for a model lock */
export function getModelLockKey(model) {
  return model ? `${MODEL_LOCK_PREFIX}${model}` : MODEL_LOCK_ALL;
}

/**
 * Check if a model lock on a connection is still active.
 * Reads flat field `modelLock_${model}` (or `modelLock___all` when model=null).
 */
export function isModelLockActive(connection, model) {
  const key = getModelLockKey(model);
  const expiry = connection[key] || connection[MODEL_LOCK_ALL];
  if (!expiry) return false;
  return new Date(expiry).getTime() > Date.now();
}

/**
 * Get earliest active model lock expiry across all modelLock_* fields.
 * Used for UI cooldown display.
 */
export function getEarliestModelLockUntil(connection: Record<string, any>) {
  if (!connection) return null;
  let earliest: number | null = null;
  const now = Date.now();
  for (const [key, val] of Object.entries(connection)) {
    if (!key.startsWith(MODEL_LOCK_PREFIX) || !val) continue;
    const t = new Date(val as string | number).getTime();
    if (t <= now) continue;
    if (!earliest || t < earliest) earliest = t;
  }
  return earliest ? new Date(earliest).toISOString() : null;
}

/**
 * Build update object to set a model lock on a connection.
 */
export function buildModelLockUpdate(model, cooldownMs) {
  const key = getModelLockKey(model);
  return { [key]: new Date(Date.now() + cooldownMs).toISOString() };
}

/**
 * Build update object to clear all model locks on a connection.
 */
export function buildClearModelLocksUpdate(connection) {
  const cleared = {};
  for (const key of Object.keys(connection)) {
    if (key.startsWith(MODEL_LOCK_PREFIX)) cleared[key] = null;
  }
  return cleared;
}

/**
 * Reset account state when request succeeds
 * Clears cooldown and resets backoff level to 0
 * @param {object} account - Account object
 * @returns {object} Updated account with reset state
 */
export function resetAccountState(account) {
  if (!account) return account;
  return {
    ...account,
    rateLimitedUntil: null,
    backoffLevel: 0,
    lastError: null,
    status: "active"
  };
}

