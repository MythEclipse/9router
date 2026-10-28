import type { ModelPricing as CatalogModelPricing } from "@9router/pricing"
import { getAdapter } from "../driver.ts"
import { parseJson, stringifyJson } from "../helpers/jsonCol.ts"
import { makeKv } from "../helpers/kvStore.ts"

/**
 * One model's rates, re-exported from the catalog so the two packages cannot
 * drift: `calculateCostFromTokens` takes exactly this shape.
 */
export type ModelPricing = CatalogModelPricing

/** The store's view: provider id to model id to rates. */
export type PricingMap = Record<string, Record<string, ModelPricing>>

/** The override shape `updatePricing` accepts: provider to model to rates. */
export type PricingUpdate = Record<string, Record<string, ModelPricing>>

/** A memoised value with the instant it goes stale. */
interface CacheEntry<T> {
	value: T | null
	expiresAt: number
}

const pricingKv = makeKv("pricing")
const CACHE_TTL_MS = 5000

let cache: CacheEntry<PricingMap> = { value: null, expiresAt: 0 }
/**
 * User pricing overrides, memoised for the same window as the merged map.
 *
 * `getPricingForModel` runs on EVERY usage write (calculateCost) and used to
 * re-read the whole `pricing` scope each time — 18us of SQLite + JSON per
 * completed request, purely to price a row. Invalidated together with the merged
 * map, so an edit is visible on the next call.
 */
let userCache: CacheEntry<PricingMap> = { value: null, expiresAt: 0 }

function invalidate() {
	cache = { value: null, expiresAt: 0 }
	userCache = { value: null, expiresAt: 0 }
}

/**
 * Drop the merged pricing map. Exported so a caller that rewrote the `pricing`
 * scope OUTSIDE this module (importDb) can clear it, instead of waiting out the
 * TTL and serving pre-import prices.
 */
export function invalidatePricingCache() {
	invalidate()
}

async function getUserPricing(): Promise<PricingMap> {
	return await pricingKv.getAll<Record<string, ModelPricing>>()
}

async function getUserPricingCached(): Promise<PricingMap> {
	const now = Date.now()
	if (userCache.value && userCache.expiresAt > now) return userCache.value
	const value = await getUserPricing()
	userCache = { value, expiresAt: now + CACHE_TTL_MS }
	return value
}

/** Overlay the operator's overrides for one provider onto the catalog's. */
function mergeProvider(
	catalogModels: Record<string, ModelPricing>,
	userModels: Record<string, ModelPricing> | undefined,
): Record<string, ModelPricing> {
	const merged: Record<string, ModelPricing> = {}
	for (const [model, pricing] of Object.entries(catalogModels)) {
		merged[model] = { ...pricing, ...userModels?.[model] }
	}
	for (const [model, pricing] of Object.entries(userModels ?? {})) {
		if (!merged[model]) merged[model] = pricing
	}
	return merged
}

export async function getPricing(): Promise<PricingMap> {
	const now = Date.now()
	if (cache.value && cache.expiresAt > now) return cache.value

	const userPricing = await getUserPricing()
	const { PROVIDER_PRICING } = await import("@9router/pricing")
	const merged: PricingMap = {}

	for (const [provider, models] of Object.entries(
		PROVIDER_PRICING as unknown as Record<string, Record<string, ModelPricing>>,
	)) {
		merged[provider] = mergeProvider(models, userPricing[provider])
	}

	// mergeProvider only folds user pricing into a provider the catalog already
	// lists. A provider the user priced themselves — a custom endpoint, or a
	// local model never shipped in PROVIDER_PRICING — was silently dropped from
	// the result, so callers saw no pricing for it at all.
	for (const [provider, models] of Object.entries(userPricing)) {
		if (merged[provider]) continue
		merged[provider] = { ...models }
	}

	cache = { value: merged, expiresAt: now + CACHE_TTL_MS }
	return merged
}

export async function getPricingForModel(
	provider: string | null | undefined,
	model: string | null | undefined,
): Promise<ModelPricing | null> {
	if (!model) return null
	const userPricing = await getUserPricingCached()
	if (provider && userPricing[provider]?.[model]) return userPricing[provider][model]
	const { getPricingForModel: resolveConst } = await import("@9router/pricing")
	return resolveConst(provider, model) as ModelPricing | null
}

// Atomic merge inside transaction (per-provider read-modify-write)
export async function updatePricing(pricingData: PricingUpdate): Promise<PricingMap> {
	const db = await getAdapter()
	db.transaction(() => {
		for (const [provider, models] of Object.entries(pricingData)) {
			const row = db.get<{ value?: string | null }>(
				`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`,
				[provider],
			)
			const current = (row ? parseJson(row.value, {}) || {} : {}) as Record<string, ModelPricing>
			const merged: Record<string, ModelPricing> = { ...current }
			for (const [model, pricing] of Object.entries(models)) {
				merged[model] = pricing
			}
			db.run(
				`INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
				[provider, stringifyJson(merged)],
			)
		}
	})
	invalidate()
	return await getUserPricing()
}

export async function resetPricing(provider: string, model?: string): Promise<PricingMap> {
	if (!provider) return await getUserPricing()
	const db = await getAdapter()
	db.transaction(() => {
		if (!model) {
			db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider])
			return
		}
		const row = db.get<{ value?: string | null }>(
			`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`,
			[provider],
		)
		const current = (row ? parseJson(row.value, {}) || {} : {}) as Record<string, ModelPricing>
		delete current[model]
		if (Object.keys(current).length === 0) {
			db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider])
		} else {
			db.run(
				`INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
				[provider, stringifyJson(current)],
			)
		}
	})
	invalidate()
	return await getUserPricing()
}

export async function resetAllPricing(): Promise<Record<string, never>> {
	await pricingKv.clear()
	invalidate()
	return {}
}
