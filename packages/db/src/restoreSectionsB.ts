/**
 * Restore sections: api keys, combos, usage.
 *
 * Extracted verbatim from restoreSections.ts.
 */

import { keyAccessToColumns, validateKeyAccessInput } from "@9router/db/shared/keyAccess"
import { KEY_ACCESS_UNRESTRICTED } from "@9router/db/shared/keyAccessConstants"
import { normalizeAllowedEndpoints } from "@9router/db/shared/keyEndpoints"
import { asArray, json, now, type SectionRestore } from "./restoreTypes.ts"

export const apiKeysSection: SectionRestore = {
	name: "apiKeys",
	sectionKeys: ["apiKeys"],
	restore(db, payload, { existingApiKeys }) {
		if (payload.apiKeys === undefined) return
		db.run(`DELETE FROM apiKeys`)
		for (const k of asArray<Record<string, unknown>>(payload.apiKeys)) {
			const row = k as Record<string, unknown> & { id?: string }
			const prev = (row.id && existingApiKeys[row.id]) || {}
			// Every limit column falls back to the live row when the backup predates it,
			// so restoring an old backup does not reset a key's usage counters mid-period.
			const pick = <T>(field: string, fallback: T): T =>
				row[field] !== undefined
					? (row[field] as T)
					: prev[field] !== undefined
						? (prev[field] as T)
						: fallback
			const num = (field: string, fallback: number) => Number(pick(field, fallback))
			const str = (field: string, fallback: string) => pick(field, fallback)

			// A backup from before key access existed carries no `access` field; those keys
			// were unrestricted, so that is what they restore as. A field that is present
			// but malformed is refused outright rather than silently widened.
			const accessResult = validateKeyAccessInput(
				row.access === undefined ? KEY_ACCESS_UNRESTRICTED : row.access,
			)
			if (accessResult.ok === false) throw new Error(accessResult.error)
			const accessColumns = keyAccessToColumns(accessResult.value)

			db.run(
				`INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, createdAt, tokenLimit, usedTokens, limitKind, requestLimit, usedRequests, resetInterval, lastResetAt, allowedModels, allowedEndpoints, rpmLimit, tpmLimit, dailyCostLimit, costSpent, costDay, ipWhitelist, expiresAt, systemPrompt, permissions, createdBy, accessRestricted, accessAllow) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					row.id,
					row.key,
					row.name || null,
					row.machineId || null,
					row.isActive === false ? 0 : 1,
					row.createdAt || now(),
					num("tokenLimit", 0),
					num("usedTokens", 0),
					str("limitKind", "tokens"),
					num("requestLimit", 0),
					num("usedRequests", 0),
					str("resetInterval", "never"),
					pick("lastResetAt", null),
					str("allowedModels", "*"),
					JSON.stringify(normalizeAllowedEndpoints(pick("allowedEndpoints", undefined))),
					num("rpmLimit", 0),
					num("tpmLimit", 0),
					num("dailyCostLimit", 0),
					num("costSpent", 0),
					str("costDay", ""),
					// The whitelist feature is gone; the column survives, so a restore must
					// still pass a value for it.
					"",
					pick("expiresAt", null),
					str("systemPrompt", ""),
					str("permissions", ""),
					str("createdBy", ""),
					accessColumns.accessRestricted,
					accessColumns.accessAllow,
				],
			)
		}
	},
}

export const combosSection: SectionRestore = {
	name: "combos",
	sectionKeys: ["combos"],
	restore(db, payload) {
		if (payload.combos === undefined) return
		db.run(`DELETE FROM combos`)
		for (const c of asArray<Record<string, unknown>>(payload.combos)) {
			db.run(
				`INSERT OR REPLACE INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
				[
					c.id,
					c.name,
					c.kind || null,
					json(c.models || []),
					c.createdAt || now(),
					c.updatedAt || now(),
				],
			)
		}
	},
}

export const usageSection: SectionRestore = {
	name: "usage",
	sectionKeys: ["usageHistory", "usageDaily"],
	restore(db, payload) {
		if (payload.usageHistory !== undefined) {
			db.run(`DELETE FROM usageHistory`)
			for (const h of asArray<Record<string, unknown>>(payload.usageHistory)) {
				db.run(
					`INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						h.timestamp || now(),
						h.provider || null,
						h.model || null,
						h.connectionId || null,
						h.apiKey || null,
						h.endpoint || null,
						h.promptTokens || 0,
						h.completionTokens || 0,
						h.cost || 0,
						h.status || null,
						h.tokens || null,
						h.meta || null,
					],
				)
			}
		}

		if (payload.usageDaily !== undefined) {
			db.run(`DELETE FROM usageDaily`)
			for (const d of asArray<Record<string, unknown>>(payload.usageDaily)) {
				db.run(`INSERT OR REPLACE INTO usageDaily(dateKey, data) VALUES(?, ?)`, [
					d.dateKey,
					typeof d.data === "string" ? d.data : json(d.data),
				])
			}
		}
	},
}
