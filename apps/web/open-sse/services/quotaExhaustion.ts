/**
 * Account-level quota exhaustion, remembered so selection can skip a parked account.
 *
 * The dashboard has always known an account was out of quota — the usage panel renders
 * "Gemini (Weekly) 0% · 1,000 / 1,000 · in 6d 2h" — while the request path did not. Selection
 * only learned about exhaustion from the answer itself (409/429), so every rotation window
 * started by spending a request on an account that could not serve it. Antigravity grew a
 * private cache for exactly this reason (`sse/services/antigravityQuota.ts`); this is the same
 * idea, provider-agnostic, for every provider that reports quota.
 *
 * Two rules matter here and nowhere else:
 *
 * 1. A window at 0% whose reset is still in the future parks its connection until that reset.
 *    That is the whole point — what the operator reads on the dashboard is what selection acts
 *    on. A reset in the past (or a missing one) blocks nothing, because "0%" without a refill
 *    time is a reading we cannot act on.
 * 2. A row that names a model only blocks that model. Google and Claude report one row per
 *    model; without this, a single exhausted model would park the whole account for a week.
 *    Rows with no model name in them (Weekly, 5h, Session, Monthly, Credits) are account-wide.
 */

import type { UsageQuotaMap, UsageQuotaRow } from "./usage/shared.ts"

/** A window that is out of quota and the moment it refills. */
export interface QuotaExhaustionBlock {
	/** Row key, kept for the log line. */
	readonly key: string
	/** Row label, kept for the log line and the retry message. */
	readonly label: string
	/** When the window refills, ISO-8601. */
	readonly resetAt: string
	/** `resetAt` in ms, so callers do not re-parse. */
	readonly resetMs: number
}

/** What a usage read told us about one connection. */
export interface QuotaObservation {
	readonly provider: string
	readonly quotas: UsageQuotaMap
	/** ms epoch of the read. */
	readonly observedAt: number
}

/** Model families that appear inside a quota row name. */
const MODEL_TOKENS = new Set([
	"claude",
	"gpt",
	"gemini",
	"qwen",
	"glm",
	"grok",
	"kimi",
	"deepseek",
	"llama",
	"mistral",
	"codex",
	"command",
	"sonnet",
	"opus",
	"haiku",
])

/** Words a shared family pool uses in its label, alongside the family name. */
const WINDOW_TOKENS = new Set([
	"weekly",
	"monthly",
	"daily",
	"week",
	"month",
	"day",
	"days",
	"hours",
	"hour",
	"session",
	"quota",
	"limit",
	"credits",
	"credit",
	"requests",
	"request",
	"tokens",
	"messages",
	"bonus",
	"pack",
	"pool",
	"plan",
	"free",
	"pro",
	"ultra",
	"max",
	"reset",
])

/** Alphanumeric tokens of a label, so `gemini_weekly` and `Gemini (Weekly)` agree. */
function tokensOf(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
}

/** `antigravity/gemini-3.8-flash (high)` → `gemini-3.8-flash`. */
export function normalizeModelToken(model: unknown): string {
	if (typeof model !== "string" || !model.trim()) return ""
	const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model
	return bare
		.replace(/\([^()]*\)\s*$/, "")
		.replace(/-thinking$/i, "")
		.trim()
		.toLowerCase()
}

/**
 * Remaining percentage of a row, or null when the row does not say.
 *
 * `remainingPercentage` is authoritative when present. Otherwise derive it from the absolute
 * numbers, honouring `percentageIsUsed` (a few providers send "used" in that field).
 */
export function rowRemainingPercentage(row: UsageQuotaRow | null | undefined): number | null {
	if (!row || typeof row !== "object") return null
	const pct = row.remainingPercentage
	if (typeof pct === "number" && Number.isFinite(pct)) {
		return row.percentageIsUsed === true ? 100 - pct : pct
	}
	const total = typeof row.total === "number" && Number.isFinite(row.total) ? row.total : 0
	if (total <= 0) return null
	if (typeof row.remaining === "number" && Number.isFinite(row.remaining)) {
		return (row.remaining / total) * 100
	}
	if (typeof row.used === "number" && Number.isFinite(row.used)) {
		return ((total - row.used) / total) * 100
	}
	return null
}

/** Row text (key plus label) lowercased, for the model-matching rules. */
function rowText(key: string, row: UsageQuotaRow): string {
	const name = typeof row.name === "string" ? row.name : ""
	return `${key} ${name}`.toLowerCase()
}

/**
 * Whether an exhausted row applies to this request.
 *
 * A row that names a model blocks only when that model (or its family, for rows labelled by
 * family rather than by id) is the one being asked for. A row with no model name in it applies
 * to the whole account.
 */
export function rowAppliesToModel(text: string, model: string): boolean {
	const rowTokens = tokensOf(text)
	const namesModels = rowTokens.some((token) => MODEL_TOKENS.has(token))
	if (!namesModels) return true
	const modelTokens = [...new Set(tokensOf(normalizeModelToken(model)))]
	if (modelTokens.length === 0) return true
	// Every token of the requested model has to appear in the row ("weekly Claude Sonnet 5 (7d)"
	// covers claude-sonnet-5-5 but not claude-opus-5-5).
	if (modelTokens.every((token) => rowTokens.includes(token))) return true
	// A row that names only the family and a window — "Gemini (Weekly)", "Claude (5h)" — is the
	// family's shared pool, so it applies to every model of that family. A row that carries any
	// other discriminator ("gemini_argon_weekly") names a pool of its own and is left to the
	// provider's mapping.
	const rowFamilies = rowTokens.filter((token) => MODEL_TOKENS.has(token))
	const family = modelTokens[0]
	if (rowFamilies.length === 0 || !rowFamilies.every((token) => token === family)) return false
	return rowTokens.every(
		(token) => MODEL_TOKENS.has(token) || WINDOW_TOKENS.has(token) || /^\d+$/.test(token),
	)
}

/**
 * The window that parks this connection for `model`, or null when it can serve the request.
 *
 * The latest reset among the matching exhausted rows wins: unblocking early is the one error
 * that costs a request, so the answer errs toward waiting.
 */
export function findExhaustedQuotaWindow(
	quotas: UsageQuotaMap | null | undefined,
	model: string | null | undefined,
	now: number = Date.now(),
): QuotaExhaustionBlock | null {
	if (!quotas || typeof quotas !== "object") return null

	let worst: QuotaExhaustionBlock | null = null
	for (const [key, row] of Object.entries(quotas)) {
		if (!row || typeof row !== "object") continue
		if (row.unlimited === true) continue
		const remaining = rowRemainingPercentage(row)
		if (remaining === null || remaining > 0) continue
		const resetAt = typeof row.resetAt === "string" ? row.resetAt : null
		if (!resetAt) continue
		const resetMs = new Date(resetAt).getTime()
		if (!Number.isFinite(resetMs) || resetMs <= now) continue
		if (model && !rowAppliesToModel(rowText(key, row), model)) continue
		if (!worst || resetMs > worst.resetMs) {
			worst = {
				key,
				label: typeof row.name === "string" && row.name ? row.name : key,
				resetAt,
				resetMs,
			}
		}
	}
	return worst
}

// connectionId → what the last usage read said.
const observations = new Map<string, QuotaObservation>()

/** Record a usage read for a connection. A newer read always replaces an older one. */
export function primeQuotaObservation(
	connectionId: string | null | undefined,
	provider: string | null | undefined,
	quotas: UsageQuotaMap | null | undefined,
	now: number = Date.now(),
): void {
	if (!connectionId || !quotas || typeof quotas !== "object") return
	if (Object.keys(quotas).length === 0) return
	observations.set(connectionId, {
		provider: String(provider || ""),
		quotas,
		observedAt: now,
	})
}

/** The last observation for a connection, or null. */
export function getQuotaObservation(
	connectionId: string | null | undefined,
): QuotaObservation | null {
	if (!connectionId) return null
	return observations.get(connectionId) || null
}

/** The block that parks this connection for `model`, from the last observation. */
export function findConnectionQuotaBlock(
	connectionId: string | null | undefined,
	model: string | null | undefined,
	now: number = Date.now(),
): QuotaExhaustionBlock | null {
	const observation = getQuotaObservation(connectionId)
	if (!observation) return null
	return findExhaustedQuotaWindow(observation.quotas, model, now)
}

/** Drop a connection's observation (tests, and a connection that was re-authorized). */
export function forgetQuotaObservation(connectionId: string | null | undefined): void {
	if (connectionId) observations.delete(connectionId)
}

/** Drop every observation (tests only). */
export function clearQuotaObservations(): void {
	observations.clear()
}
