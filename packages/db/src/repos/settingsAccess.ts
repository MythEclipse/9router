/**
 * Settings accessors.
 *
 * Extracted verbatim from settingsRepo.ts.
 */

import { getAdapter } from "../driver.ts"
import { parseJson, stringifyJson } from "../helpers/jsonCol.ts"

import {
	type CacheEntry,
	DEFAULT_SETTINGS,
	type Settings,
	type SettingsUpdate,
} from "./settingsTypes.ts"

async function readRaw() {
	const db = await getAdapter()
	const row = db.get(`SELECT data FROM settings WHERE id = 1`)
	return row ? parseJson(row.data, {}) : {}
}

/**
 * Raw settings row, memoised.
 *
 * `getSettings()` is called ~6 times per chat request (handler auth gate, combo
 * expansion, per-account dispatch, sibling handlers) and each call re-reads and
 * re-parses the row from SQLite — 17-26us apiece, on the request path, in a
 * process where every DB call blocks the event loop. Nothing about the row
 * changes between those calls.
 *
 * The cache holds the RAW row (not the merged object): `mergeWithDefaults`
 * mutates the nested `capacityAdapter` entries it walks, so handing every caller
 * one shared merged object would let one caller's write through to the next
 * request. Merging is ~5us and stays per-call; this only removes the query.
 *
 * Invalidation: `updateSettings` and `importDb` clear it (single-process gateway,
 * and this is the only writer), and the TTL bounds anything that writes the row
 * behind our back.
 */
const RAW_CACHE_TTL_MS = 2000
let rawCache: CacheEntry<SettingsUpdate> = { value: null, expiresAt: 0 }

function invalidateRawCache() {
	rawCache = { value: null, expiresAt: 0 }
}

async function readRawCached(): Promise<SettingsUpdate> {
	const now = Date.now()
	if (rawCache.value && rawCache.expiresAt > now) return rawCache.value
	const value = await readRaw()
	rawCache = { value, expiresAt: now + RAW_CACHE_TTL_MS }
	return value
}

// Merge raw settings with defaults; backward-compat for missing keys
export function mergeWithDefaults(raw: unknown): Settings {
	const merged = { ...DEFAULT_SETTINGS, ...(raw as SettingsUpdate | null | undefined) } as Settings
	for (const [key, defVal] of Object.entries(DEFAULT_SETTINGS)) {
		if (merged[key] === undefined) {
			if (
				key === "outboundProxyEnabled" &&
				typeof merged.outboundProxyUrl === "string" &&
				merged.outboundProxyUrl.trim()
			) {
				merged[key] = true
			} else {
				merged[key] = defVal
			}
		}
	}
	if (merged.capacityAdapter && typeof merged.capacityAdapter === "object") {
		for (const capKey of Object.keys(merged.capacityAdapter)) {
			const entry = merged.capacityAdapter[capKey]
			if (Array.isArray(entry?.models)) {
				entry.models = entry.models.map((m) =>
					m === "oc/mimo-v2.5-free" ? "oc/mimo-v2.6-flash-free" : m,
				)
			}
		}
	}
	return merged
}

export async function getSettings(): Promise<Settings> {
	const raw = await readRawCached()
	return mergeWithDefaults(raw)
}

// Atomic read-merge-write inside transaction (prevents losing concurrent updates)
export async function updateSettings(updates: SettingsUpdate): Promise<Settings> {
	const db = await getAdapter()
	let next: SettingsUpdate = {}
	db.transaction(() => {
		const row = db.get<{ data?: string | null }>(`SELECT data FROM settings WHERE id = 1`)
		const current = (row ? parseJson(row.data, {}) : {}) as SettingsUpdate
		next = { ...current, ...updates }
		db.run(
			`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
			[stringifyJson(next)],
		)
	})
	// The memoised raw row is now stale — clear it before returning so the very
	// next getSettings() (including one inside this same request) sees the write.
	invalidateRawCache()
	return mergeWithDefaults(next)
}

/**
 * Drop the memoised settings row. Called by every writer of the settings table
 * (`updateSettings`, `importDb`) so a settings change is visible immediately
 * rather than after the TTL.
 */
export function invalidateSettingsCache() {
	invalidateRawCache()
}

export async function isCloudEnabled() {
	const settings = await getSettings()
	return settings.cloudEnabled === true
}

export async function getCloudUrl() {
	const settings = await getSettings()
	return settings.cloudUrl || process.env.CLOUD_URL || process.env.NEXT_PUBLIC_CLOUD_URL || ""
}

export async function exportSettings() {
	return await readRaw()
}
