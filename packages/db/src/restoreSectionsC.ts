/**
 * Restore sections: custom models, pricing, auto-backup.
 *
 * Extracted verbatim from restoreSections.ts.
 */

import { asArray, json, restoreKvScope, type SectionRestore } from "./restoreTypes.ts"

export const customModelsSection: SectionRestore = {
	name: "customModels",
	sectionKeys: ["modelAliases", "customModels", "mitmAlias"],
	restore(db, payload) {
		if (payload.modelAliases !== undefined) {
			restoreKvScope(
				db,
				"modelAliases",
				Object.entries((payload.modelAliases as Record<string, unknown>) || {}),
			)
		}
		if (payload.customModels !== undefined) {
			restoreKvScope(
				db,
				"customModels",
				asArray<Record<string, unknown>>(payload.customModels).map((m) => [
					`${m.providerAlias}|${m.id}|${m.type || "llm"}`,
					m,
				]),
			)
		}
		if (payload.mitmAlias !== undefined) {
			restoreKvScope(
				db,
				"mitmAlias",
				Object.entries((payload.mitmAlias as Record<string, unknown>) || {}).map(([tool, mappings]) => [
					tool,
					mappings || {},
				]),
			)
		}
	},
}

export const pricingSection: SectionRestore = {
	name: "pricing",
	sectionKeys: ["pricing", "modelOverrides", "disabledModels"],
	restore(db, payload) {
		if (payload.pricing !== undefined) {
			restoreKvScope(
				db,
				"pricing",
				Object.entries((payload.pricing as Record<string, unknown>) || {}).map(([provider, models]) => [
					provider,
					models || {},
				]),
			)
		}
		if (payload.modelOverrides !== undefined) {
			restoreKvScope(
				db,
				"modelOverrides",
				Object.entries((payload.modelOverrides as Record<string, unknown>) || {}),
			)
		}
		if (payload.disabledModels !== undefined) {
			// Upsert rather than replace: this scope is written one provider at a time and a
			// missing provider means "nothing disabled", not "forget the others".
			db.run(`DELETE FROM kv WHERE scope = 'disabledModels'`)
			for (const [provider, ids] of Object.entries(
				(payload.disabledModels as Record<string, unknown>) || {},
			)) {
				db.run(
					`INSERT INTO kv(scope, key, value) VALUES('disabledModels', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
					[provider, json(ids || [])],
				)
			}
		}
	},
}

export const autoBackupSection: SectionRestore = {
	// autoBackup rides in its own KV scope. Only touch it when the backup actually
	// carries the section: an old or partial backup must not reset the schedule.
	name: "autoBackup",
	sectionKeys: ["autoBackup"],
	restore(db, payload) {
		if (payload.autoBackup === undefined) return
		restoreKvScope(
			db,
			"autoBackup",
			Object.entries((payload.autoBackup as Record<string, unknown>) || {}),
		)
	},
}
