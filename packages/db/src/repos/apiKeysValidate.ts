/**
 * API-key validation and rate limiting.
 *
 * Extracted verbatim from apiKeysRepo.ts.
 */

import { getAdapter } from "../driver.ts"
import type { ApiKeyRateEvent, ApiKeyRateLimits } from "../globals.d.ts"
import {
	applyModelChangesToAllowList,
	type ModelChanges,
	matchesAnyModelName,
	parseAllowedModels,
} from "./allowedModels.ts"
import { getApiKeys, updateApiKey } from "./apiKeysCrud.ts"
import { type ApiKeyRow, utcDayKey } from "./apiKeysTypes.ts"

const rateLimits: ApiKeyRateLimits = global._apiKeyRateLimits

// Process-wide memo cache for the api-key list, invalidated on writes so the
// next request re-reads from SQLite instead of serving stale rows.
if (!global._apiKeyListCache) global._apiKeyListCache = null
export function invalidateApiKeyCache() {
	global._apiKeyListCache = null
}

/** Why a key was refused, or `true` when it may proceed. */
export type RateLimitVerdict = true | "RPM_EXCEEDED" | "TPM_EXCEEDED"

const RATE_WINDOW_MS = 60000

function checkRateLimits(key: string, rpmLimit: number, tpmLimit: number): RateLimitVerdict {
	if (rpmLimit <= 0 && tpmLimit <= 0) return true
	const now = Date.now()
	if (!rateLimits[key]) {
		rateLimits[key] = []
	}

	// Filter out events older than 60 seconds (1 minute window)
	rateLimits[key] = rateLimits[key].filter((req: ApiKeyRateEvent) => now - req.ts < RATE_WINDOW_MS)
	const recent = rateLimits[key]

	if (rpmLimit > 0 && recent.length >= rpmLimit) {
		return "RPM_EXCEEDED"
	}

	if (tpmLimit > 0) {
		const totalTokensInWindow = recent.reduce(
			(sum: number, r: ApiKeyRateEvent) => sum + (r.tokens || 0),
			0,
		)
		if (totalTokensInWindow >= tpmLimit) {
			return "TPM_EXCEEDED"
		}
	}

	return true
}

export function recordApiKeyUsageInWindow(key: string, tokens = 0): void {
	if (!key) return
	const now = Date.now()
	if (!rateLimits[key]) rateLimits[key] = []
	rateLimits[key].push({ ts: now, tokens: tokens || 0 })
}

/** Patterns of the key used by a request; null when there is no key or it allows all. */
export async function getAllowedModelsOfKey(key: unknown): Promise<string[] | null> {
	const raw = typeof key === "string" ? key.trim() : ""
	if (!raw) return null
	try {
		const db = await getAdapter()
		const row = db.get<{ allowedModels?: string | null }>(
			`SELECT allowedModels FROM apiKeys WHERE key = ?`,
			[raw],
		)
		return row ? parseAllowedModels(row.allowedModels) : null
	} catch {
		return null
	}
}

/** Every reason `validateApiKey` can reject a request, plus `true` when it passes. */
export type ApiKeyVerdict =
	| true
	| false
	| "KEY_DISABLED"
	| "KEY_EXPIRED"
	| "QUOTA_EXCEEDED"
	| "REQUEST_LIMIT_EXCEEDED"
	| "COST_LIMIT_EXCEEDED"
	| "MODEL_NOT_ALLOWED"
	| "RPM_EXCEEDED"
	| "TPM_EXCEEDED"

export async function validateApiKey(
	key: string,
	requestedModel: string | null = null,
	modelNames: readonly string[] | null = null,
): Promise<ApiKeyVerdict> {
	const db = await getAdapter()
	let result: ApiKeyVerdict = false

	db.transaction(() => {
		const row = db.get<ApiKeyRow>(`SELECT * FROM apiKeys WHERE key = ?`, [key])
		if (!row) {
			result = false
			return
		}
		if (row.isActive !== 1 && row.isActive !== true) {
			// Its own reason code: a switched-off key must not be confused with an unknown one.
			result = "KEY_DISABLED"
			return
		}

		// Check expiry (#3)
		if (row.expiresAt) {
			const expMs = new Date(row.expiresAt).getTime()
			if (!Number.isNaN(expMs) && Date.now() > expMs) {
				result = "KEY_EXPIRED"
				return
			}
		}

		const limitKind =
			row.limitKind === "cost" || row.limitKind === "requests" ? row.limitKind : "tokens"
		const tokenLimit = Number(row.tokenLimit) || 0
		const requestLimit = Number(row.requestLimit) || 0
		const dailyCostLimit = Number(row.dailyCostLimit) || 0
		// Exactly one cap is enforced: the one the owner selected. The other numbers may
		// still be stored (switching back must not lose them) but they never block.
		const activeCap =
			limitKind === "cost" ? dailyCostLimit : limitKind === "requests" ? requestLimit : tokenLimit
		let usedTokens = Number(row.usedTokens) || 0
		let usedRequests = Number(row.usedRequests) || 0
		const resetInterval: string = row.resetInterval || "never"
		const allowedModels: string = row.allowedModels || "*"
		const nowMs = Date.now()
		let lastResetMs = row.lastResetAt
			? new Date(row.lastResetAt).getTime()
			: new Date(row.createdAt).getTime()

		if (Number.isNaN(lastResetMs)) lastResetMs = nowMs

		let shouldReset = false
		// Cost carries its own day stamp, so only the token and request windows need the
		// interval arithmetic here; a cost key has nothing to reset in this path.
		if (limitKind !== "cost" && activeCap > 0 && resetInterval && resetInterval !== "never") {
			let intervalMs = 0
			const num = parseInt(resetInterval, 10)
			if (resetInterval.endsWith("m")) {
				intervalMs = num * 60 * 1000
			} else if (resetInterval.endsWith("h")) {
				intervalMs = num * 60 * 60 * 1000
			} else if (resetInterval.endsWith("d")) {
				intervalMs = num * 24 * 60 * 60 * 1000
			}

			if (intervalMs > 0 && nowMs - lastResetMs >= intervalMs) {
				shouldReset = true
				const periodsPassed = Math.floor((nowMs - lastResetMs) / intervalMs)
				lastResetMs = lastResetMs + periodsPassed * intervalMs
			}
		}

		if (shouldReset) {
			usedTokens = 0
			usedRequests = 0
			const newResetIso = new Date(lastResetMs).toISOString()
			db.run(`UPDATE apiKeys SET usedTokens = 0, usedRequests = 0, lastResetAt = ? WHERE id = ?`, [
				newResetIso,
				row.id,
			])
		}

		if (limitKind === "tokens" && tokenLimit > 0 && usedTokens >= tokenLimit) {
			result = "QUOTA_EXCEEDED"
			return
		}

		if (limitKind === "requests" && requestLimit > 0 && usedRequests >= requestLimit) {
			result = "REQUEST_LIMIT_EXCEEDED"
			return
		}

		// Daily money cap. The counter is stamped with the UTC day it belongs to, so a
		// stamp from an earlier day means nothing has been spent today yet; without that
		// check a key would stay blocked until something rewrote the row.
		if (limitKind === "cost" && dailyCostLimit > 0) {
			const spentToday = row.costDay === utcDayKey() ? Number(row.costSpent) || 0 : 0
			if (spentToday >= dailyCostLimit) {
				result = "COST_LIMIT_EXCEEDED"
				return
			}
		}

		// Check allowed models
		const allowedPatterns = parseAllowedModels(allowedModels)
		if (requestedModel && allowedPatterns) {
			const names = modelNames?.length ? modelNames : [requestedModel]
			const isAllowed = matchesAnyModelName(allowedPatterns, names)

			if (!isAllowed) {
				result = "MODEL_NOT_ALLOWED"
				return
			}
		}

		// Check RPM & TPM rate limits
		const rpmLimit = Number(row.rpmLimit) || 0
		const tpmLimit = Number(row.tpmLimit) || 0
		const rateCheck = checkRateLimits(key, rpmLimit, tpmLimit)
		if (rateCheck !== true) {
			result = rateCheck
			return
		}

		result = true
	})

	return result
}

/**
 * Follow a model deletion or rename through every API key's allowlist.
 *
 * Callers name exactly what disappeared; nothing here scans the model catalog, so
 * an unreachable provider cannot shrink anyone's list. Fail-open by construction:
 * a throw anywhere below leaves every key as it was, and the mutation that
 * triggered this has already been committed.
 */
export async function reconcileAllowedModels({
	removed = [],
	renamed = {},
}: ModelChanges = {}): Promise<{ updated: number; emptied: string[] }> {
	if (!removed.length && !Object.keys(renamed).length) {
		return { updated: 0, emptied: [] }
	}
	try {
		const keys = await getApiKeys()
		let updated = 0
		const emptied = []

		for (const key of keys) {
			const result = applyModelChangesToAllowList(key.allowedModels, { removed, renamed })
			if (result.emptied) {
				emptied.push(key.name || key.id)
				continue
			}
			if (!result.changed) continue
			await updateApiKey(key.id, { allowedModels: result.value })
			updated++
		}
		return { updated, emptied }
	} catch (err) {
		console.error("[reconcileAllowedModels] failed to follow model change:", err)
		return { updated: 0, emptied: [] }
	}
}
