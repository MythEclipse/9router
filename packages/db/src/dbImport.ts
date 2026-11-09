/**
 * Database import.
 *
 * Extracted verbatim from index.ts.
 */

import { exportDb } from "./dbExport.ts"
import type { ApiKeyRow, DbExportPayload, ImportProgress } from "./dbTypes.ts"
import { getAdapter } from "./driver.ts"
import { invalidateApiKeyCache } from "./repos/apiKeysRepo.ts"
import { invalidateNodeCache } from "./repos/nodesRepo.ts"
import { invalidatePricingCache } from "./repos/pricingRepo.ts"
import { invalidateSettingsCache } from "./repos/settingsRepo.ts"
import { sectionsPresent } from "./restoreSections.ts"

export async function importDb(payload: DbExportPayload): Promise<DbExportPayload> {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("Invalid database payload")
	}
	const db = await getAdapter()

	// Snapshot existing apiKeys BEFORE wiping, so we can fill in missing fields from backup
	const existingApiKeys: Record<string, ApiKeyRow> = {}
	for (const r of db.all<ApiKeyRow>(`SELECT * FROM apiKeys`)) {
		existingApiKeys[r.id] = r
	}

	const context = { existingApiKeys }
	db.transaction(() => {
		// Only sections the backup carries are touched, so a partial or older backup
		// restores what it holds and leaves everything else alone.
		for (const section of sectionsPresent(payload)) {
			section.restore(db, payload, context)
		}
	})

	// Settings, pricing and api-key caches are process-wide memos over rows this
	// call just rewrote. Without clearing them, a restore returns the freshly
	// imported data in its OWN response while the next request keeps serving
	// pre-import values — for api keys that means a key the import just deleted
	// still authenticating.
	invalidateSettingsCache()
	invalidatePricingCache()
	invalidateApiKeyCache()
	invalidateNodeCache()

	return await exportDb()
}

// Progressive variant of importDb used by background import jobs. Same restore
// logic split into one transaction per section, with a progress callback and a
// macrotask yield between sections so the event loop stays responsive.
// importDb and exportDb above are intentionally left unchanged.
export async function importDbProgressive(
	payload: DbExportPayload,
	onProgress?: (progress: ImportProgress) => void,
) {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("Invalid database payload")
	}
	const db = await getAdapter()

	// Snapshot existing apiKeys BEFORE wiping, so we can fill in missing fields from backup
	const existingApiKeys: Record<string, ApiKeyRow> = {}
	for (const r of db.all<ApiKeyRow>(`SELECT * FROM apiKeys`)) {
		existingApiKeys[r.id] = r
	}

	const context = { existingApiKeys }
	const stages = sectionsPresent(payload)
	const total = stages.length
	let done = 0

	const emit = (currentSection: string) => {
		if (typeof onProgress === "function") {
			onProgress({
				done,
				total,
				percent: total === 0 ? 100 : Math.round((done / total) * 100),
				currentSection,
			})
		}
	}

	const yieldToEventLoop = () =>
		new Promise<void>((resolve) => {
			if (typeof setImmediate === "function") setImmediate(resolve)
			else setTimeout(resolve, 0)
		})

	if (total === 0) {
		emit("done")
		return await exportDb()
	}
	emit(stages[0].name)

	// One transaction per section, not one for the whole restore: a large backup would
	// otherwise hold the write lock for its entire duration and block every request.
	for (const [index, section] of stages.entries()) {
		db.transaction(() => {
			section.restore(db, payload, context)
		})
		done += 1
		emit(index + 1 < stages.length ? stages[index + 1].name : "done")
		await yieldToEventLoop()
	}

	// Same reasoning as importDb: the caches memo rows this call just rewrote.
	invalidateSettingsCache()
	invalidatePricingCache()
	invalidateApiKeyCache()
	invalidateNodeCache()

	return await exportDb()
}

// Eager init helper (optional)
export async function initDb() {
	await getAdapter()
}
