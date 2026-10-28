/**
 * Restoring a database backup, one section at a time.
 *
 * A backup carries up to fourteen independent sections, and restoring one means
 * "delete the table, insert the rows, leave every other section alone" — a partial or
 * old backup must not wipe what it does not carry. That delete-then-insert pair was
 * written out twice per section: once inside importDb's single transaction and once
 * inside importDbProgressive's per-section transaction. Both copies had to stay in
 * step by hand, and an api-key column added to one but not the other would lose data
 * on the path the operator happened to use.
 *
 * Each entry here owns one table. `sectionKeys` are the payload fields that select it,
 * so a caller can tell whether a backup carries it, and `restore` takes the adapter and
 * the payload. Nothing here decides transaction boundaries or progress; that is the
 * caller's job, because that is the only thing the two import paths actually disagree
 * about.
 */

import { keyAccessToColumns, validateKeyAccessInput } from "@9router/db/shared/keyAccess"
import { KEY_ACCESS_UNRESTRICTED } from "@9router/db/shared/keyAccessConstants"
import { normalizeAllowedEndpoints } from "@9router/db/shared/keyEndpoints"
import type { ResolvedDbAdapter } from "./types.ts"

/** The narrow slice of the adapter a restore needs. */
export type RestoreDb = Pick<ResolvedDbAdapter, "all" | "run">

export interface SectionRestore {
	/** The stage name used for progress reporting. */
	name: string
	/** Payload fields that select this section; at least one must be present. */
	sectionKeys: readonly string[]
	/**
	 * Delete the table's current contents and insert the payload's.
	 *
	 * Only the fields present in `payload` are touched, so a backup written before a
	 * feature existed still restores cleanly.
	 */
	restore(db: RestoreDb, payload: Record<string, unknown>, context: RestoreContext): void
}

/**
 * What a restore needs from the caller beyond the payload.
 *
 * `existingApiKeys` is snapshotted before the wipe: a key row in an old backup carries
 * no limit columns, and restoring it must keep the live counters rather than zero them.
 */
export interface RestoreContext {
	existingApiKeys: Record<string, Record<string, unknown>>
}

const now = () => new Date().toISOString()
const json = (v: unknown) => JSON.stringify(v ?? null)
const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

/** Delete a KV scope, then write the entries the payload carries for it. */
function restoreKvScope(db: RestoreDb, scope: string, entries: Array<[string, unknown]>): void {
	db.run(`DELETE FROM kv WHERE scope = '${scope}'`)
	for (const [key, value] of entries) {
		db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('${scope}', ?, ?)`, [
			key,
			json(value),
		])
	}
}

export const SECTION_RESTORES: readonly SectionRestore[] = [
	{
		name: "settings",
		sectionKeys: ["settings"],
		restore(db, payload) {
			if (payload.settings === undefined) return
			db.run(`DELETE FROM settings`)
			db.run(
				`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
				[json(payload.settings)],
			)
		},
	},

	{
		// Providers, nodes and proxy pools restore together: a connection points at a
		// node by id, so restoring one without the others leaves dangling references.
		name: "providers",
		sectionKeys: ["providerConnections", "providerNodes", "proxyPools"],
		restore(db, payload) {
			if (payload.providerConnections !== undefined) {
				db.run(`DELETE FROM providerConnections`)
				for (const c of asArray<Record<string, unknown>>(payload.providerConnections)) {
					const {
						id,
						provider,
						authType,
						name,
						email,
						priority,
						isActive,
						createdAt,
						updatedAt,
						...rest
					} = c
					db.run(
						`INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						[
							id,
							provider,
							authType || "oauth",
							name || null,
							email || null,
							priority || null,
							isActive === false ? 0 : 1,
							json(rest),
							createdAt || now(),
							updatedAt || now(),
						],
					)
				}
			}

			if (payload.providerNodes !== undefined) {
				db.run(`DELETE FROM providerNodes`)
				for (const n of asArray<Record<string, unknown>>(payload.providerNodes)) {
					const { id, type, name, createdAt, updatedAt, ...rest } = n
					db.run(
						`INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
						[id, type || null, name || null, json(rest), createdAt || now(), updatedAt || now()],
					)
				}
			}

			if (payload.proxyPools !== undefined) {
				db.run(`DELETE FROM proxyPools`)
				for (const p of asArray<Record<string, unknown>>(payload.proxyPools)) {
					const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p
					db.run(
						`INSERT OR REPLACE INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
						[
							id,
							isActive === false ? 0 : 1,
							testStatus || "unknown",
							json(rest),
							createdAt || now(),
							updatedAt || now(),
						],
					)
				}
			}
		},
	},

	{
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
	},

	{
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
	},

	{
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
	},

	{
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
					Object.entries((payload.mitmAlias as Record<string, unknown>) || {}).map(
						([tool, mappings]) => [tool, mappings || {}],
					),
				)
			}
		},
	},

	{
		name: "pricing",
		sectionKeys: ["pricing", "modelOverrides", "disabledModels"],
		restore(db, payload) {
			if (payload.pricing !== undefined) {
				restoreKvScope(
					db,
					"pricing",
					Object.entries((payload.pricing as Record<string, unknown>) || {}).map(
						([provider, models]) => [provider, models || {}],
					),
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
	},

	{
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
	},
]

/** Whether this backup carries at least one field of the section. */
export function payloadHasSection(
	payload: Record<string, unknown>,
	section: SectionRestore,
): boolean {
	return section.sectionKeys.some((key) => payload[key] !== undefined)
}

/** The sections a payload actually carries, in restore order. */
export function sectionsPresent(payload: Record<string, unknown>): SectionRestore[] {
	return SECTION_RESTORES.filter((section) => payloadHasSection(payload, section))
}

/** Reject anything that is not a backup object before it reaches the writers. */
export function assertValidPayload(payload: unknown): asserts payload is Record<string, unknown> {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("Invalid database payload")
	}
}
