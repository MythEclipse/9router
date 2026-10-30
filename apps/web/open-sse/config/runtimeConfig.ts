// HTTP status codes
export const HTTP_STATUS = {
	BAD_REQUEST: 400,
	UNAUTHORIZED: 401,
	PAYMENT_REQUIRED: 402,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	NOT_ACCEPTABLE: 406,
	REQUEST_TIMEOUT: 408,
	RATE_LIMITED: 429,
	SERVER_ERROR: 500,
	BAD_GATEWAY: 502,
	SERVICE_UNAVAILABLE: 503,
	GATEWAY_TIMEOUT: 504,
}

// Re-export error config (backward compat)
export { BACKOFF_CONFIG, COOLDOWN_MS, DEFAULT_ERROR_MESSAGES, ERROR_TYPES } from "./errorConfig.ts"

// Cache TTLs (seconds)
export const CACHE_TTL = {
	userInfo: 300, // 5 minutes
	modelAlias: 3600, // 1 hour
}

// Memory management config
export const MEMORY_CONFIG = {
	sessionTtlMs: 2 * 60 * 60 * 1000,
	sessionCleanupIntervalMs: 30 * 60 * 1000,
	dnsCacheTtlMs: 5 * 60 * 1000,
	proxyDispatchersMaxSize: 20,
}

// Parse a positive integer env override, falling back to a default.
function envMs(name, def) {
	const raw = process.env[name]
	if (raw == null || raw === "") return def
	const n = parseInt(raw, 10)
	return Number.isFinite(n) && n > 0 ? n : def
}

function envUrl(name, def) {
	const raw = process.env[name]?.trim()
	return raw || def
}

// SearXNG endpoint used by the unauthenticated web-search provider.
// Configure this for a separate Docker service or remote SearXNG instance.
export const SEARXNG_URL = envUrl("SEARXNG_URL", "http://localhost:8888/search")

// Inter-chunk stall timeout (once tokens are flowing). Generous headroom so
// slow reasoning models aren't aborted mid-stream. Env: STREAM_STALL_TIMEOUT_MS.
export const STREAM_STALL_TIMEOUT_MS = envMs("STREAM_STALL_TIMEOUT_MS", 360 * 1000)

// Time-to-first-token timeout (prompt prefill). Env: STREAM_FIRST_CHUNK_TIMEOUT_MS.
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = envMs("STREAM_FIRST_CHUNK_TIMEOUT_MS", 200 * 1000)

// Combo empty-content failover: how long a 2xx stream may be held while waiting for its first
// content-bearing frame before committing to that model (fail-open on expiry).
// Env: EMPTY_PEEK_DEADLINE_MS.
export const EMPTY_PEEK_DEADLINE_MS = envMs("EMPTY_PEEK_DEADLINE_MS", 45 * 1000)

// Fetch connect timeout: abort if upstream doesn't return response headers within this duration
export const FETCH_CONNECT_TIMEOUT_MS = envMs("FETCH_CONNECT_TIMEOUT_MS", 60 * 1000)

// Gemini native TTS fetch timeout: abort if Google does not return response headers in time.
export const GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS = envMs(
	"GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS",
	45 * 1000,
)

// Default token limits
export const DEFAULT_MAX_TOKENS = 64000
export const DEFAULT_MIN_TOKENS = 32000

export const TOKEN_SAVER_HEADER = "x-9router-token-saver"

// Retry config for 429 responses (legacy - kept for backward compatibility)
export const RETRY_CONFIG = {
	maxAttempts: 2,
	delayMs: 2000,
}

// A successful upstream can still return an empty or malformed document. Retry
// once before exposing a parser error, but never retry after a valid stream has
// started reaching the caller.
export const RESPONSE_PARSE_RETRY_ATTEMPTS = 1

/** One retry slot: attempts plus the wait between them. */
export interface RetryEntry {
	attempts: number
	delayMs: number
}

/** A retry slot may also be written as a bare attempt count (legacy form). */
export type RetryEntryInput = RetryEntry | number

// Default retry config by status code: { attempts, delayMs }
// Backward compat: if value is a number, treated as attempts with RETRY_CONFIG.delayMs
export const DEFAULT_RETRY_CONFIG: Record<number, RetryEntry> = {
	429: { attempts: 0, delayMs: 0 },
	502: { attempts: 3, delayMs: 3000 },
	503: { attempts: 3, delayMs: 2000 },
	504: { attempts: 2, delayMs: 3000 },
}

// Normalize a retry entry to { attempts, delayMs }
export function resolveRetryEntry(entry?: RetryEntryInput | null): RetryEntry {
	if (entry == null) return { attempts: 0, delayMs: RETRY_CONFIG.delayMs }
	if (typeof entry === "number") return { attempts: entry, delayMs: RETRY_CONFIG.delayMs }
	return {
		attempts: entry.attempts || 0,
		delayMs: entry.delayMs != null ? entry.delayMs : RETRY_CONFIG.delayMs,
	}
}

// Requests containing these texts will bypass provider
export const SKIP_PATTERNS = ["Please write a 5-10 word title for the following conversation:"]

// Stream size limits (bytes)
function envBytes(name, def) {
	const raw = process.env[name]
	if (raw == null || raw === "") return def
	const n = parseInt(raw, 10)
	return Number.isFinite(n) && n > 0 ? n : def
}

// Maximum total bytes per stream request (prevent DoS)
export const MAX_STREAM_BYTES_PER_REQUEST = envBytes(
	"MAX_STREAM_BYTES_PER_REQUEST",
	100 * 1024 * 1024,
) // 100MB default

// Maximum JSON body size for non-streaming responses
export const MAX_JSON_BODY_SIZE = envBytes("MAX_JSON_BODY_SIZE", 5 * 1024 * 1024) // 5MB default

// Longest tool name accepted by Responses-style backends (OpenAI caps at 64;
// these accept 128). Shared by the opencode-family executors and the translator.
export const MAX_TOOL_NAME_LEN = 128
