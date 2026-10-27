// OpenAI-compatible error types mapping (client-facing)
export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "insufficient_quota" },
  404: { type: "invalid_request_error", code: "model_not_found" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "server_error", code: "internal_server_error" },
  502: { type: "server_error", code: "bad_gateway" },
  503: { type: "server_error", code: "service_unavailable" },
  504: { type: "server_error", code: "gateway_timeout" }
};

// Default error messages per status code (client-facing)
export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "You exceeded your current quota",
  404: "Model not found",
  406: "Model not supported",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout"
};

// Exponential backoff config for rate limits
export const BACKOFF_CONFIG = {
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15
};

// Default cooldown for transient/unknown errors
export const TRANSIENT_COOLDOWN_MS = 30 * 1000;

// Hard cap for provider-reported rate limit cooldown (e.g. codex resets_at can be 5-6h)
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Fallback-loop budgets: how long the account loop in chat.js may keep
 * rotating before it hands the last error back. The session-rotation fix for
 * spent free-tier quota (upstream #5107) re-enters the proxy loop per 429, so
 * an exhausted evening walks hundreds of proxies that all answer the same
 * 429. The probe that triggered the loop carries its own AbortSignal
 * (120s for opencode in probeBudget.js), but the loop holds no reference to
 * it — without its own deadline it answers into a void long after the caller
 * gave up, reading as "The operation was aborted due to timeout" with no
 * usable error. Keep the loop inside the caller's budget instead.
 */
export const OPENCODE_FALLBACK_BUDGET_MS = 45 * 1000;

/** Other providers never rotate sessions, so the generic loop stays short. */
export const GENERIC_FALLBACK_BUDGET_MS = 25 * 1000;

// Cooldown durations (ms)
const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
};

/**
 * Unified error classification rules.
 * Checked top-to-bottom: text rules first (by order), then status rules.
 * Each rule: { text?, status?, cooldownMs?, backoff?, lock? }
 *   - text: substring match (case-insensitive) on error message
 *   - status: HTTP status code match
 *   - cooldownMs: fixed cooldown duration
 *   - backoff: true = use exponential backoff (rate limit)
 * - lock: false = never cool down or lock the account (caller-side bad request)
 */
export const ERROR_RULES = [
  // --- Text-based rules (checked first, order = priority) ---
  { provider: "codex", text: "model is not supported when using codex with a chatgpt account", cooldownMs: MAX_RATE_LIMIT_COOLDOWN_MS },
  { text: "no credentials",           cooldownMs: COOLDOWN.long },
  { text: "request not allowed",      cooldownMs: COOLDOWN.short },
  { text: "improperly formed request", cooldownMs: COOLDOWN.long },
  { text: "rate limit",               backoff: true },
  { text: "too many requests",        backoff: true },
  { text: "quota exceeded",           backoff: true },
  { text: "insufficient credit",      backoff: true },
  { text: "credit balance is too low", backoff: true },
  // NEVER add the bare word "capacity" as a rule. It appears in benign
  // client-side 4xx bodies ("max_tokens exceeds the model's maximum output
  // capacity of 8192", "context capacity"), and a text rule outranks the
  // client-mistake rules at the bottom of this list. Matching it therefore
  // cooled a healthy account down AND burned a proxy IP over the caller's own
  // bad parameter. Only phrases that name upstream saturation may match.
  { text: "at capacity",              backoff: true },
  { text: "over capacity",            backoff: true },
  { text: "no capacity",              backoff: true },
  { text: "out of capacity",          backoff: true },
  { text: "capacity limit reached",   backoff: true },
  { text: "overloaded",               backoff: true },

  // Upstream shape mismatch (wrong content-type, unreadable stream): the transport
  // is quirky, the credential is not. Locking here puts a working account behind a
  // cooldown while the client retries blindly, so keep the chain rotating but never
  // penalise the account.
  { text: "invalid sse response", lock: false },
  { text: "invalid json response", lock: false },
  { text: "returned non-sse", lock: false },
  { text: "failed to convert streaming response", lock: false },

  // --- Status-based rules (fallback when text doesn't match) ---
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: COOLDOWN.long },
  { status: 403, cooldownMs: COOLDOWN.long },
  { status: 404, cooldownMs: COOLDOWN.long },
  { status: 429, backoff: true },

  // CodeBuddy Intl block codes (request blocked, conversation id missing,
  // "request illegal"). These are account-level blocks, not client mistakes.
  // Only specific block reasons count; "11128" alone (e.g. "first message is
  // not system prompt") is a request-scoped validation error.
  { provider: "codebuddy-intl", text: "request illegal", backoff: true },
  { provider: "codebuddy-intl", text: "conversation id missing", backoff: true },

  // --- Client mistakes, checked last so any signal above still wins ---
  // A rejected request says nothing about account health: locking here hides a
  // working credential behind a cooldown and makes the client retry blindly.
  // `lock: false` keeps the combo chain rotating while skipping account penalty.
  // Text-based rules (transport quirks / specific validation errors) advance to
  // the next model; generic status-only 400 means the request itself is invalid
  // and the combo should stop with that member's own response.
  { text: "request validation failed", lock: false },
  { text: "unsupported parameter", lock: false },
  { status: 406, lock: false },
  { status: 422, lock: false },
];

// Backward compat: COOLDOWN_MS object (used by index.js re-export)
export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
};
