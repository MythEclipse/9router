/**
 * Database export.
 *
 * Extracted verbatim from index.ts.
 */

import { keyAccessFromColumns } from "@9router/db/shared/keyAccess"
import { normalizeAllowedEndpoints } from "@9router/db/shared/keyEndpoints"
import type {
	ApiKeyBackupRow,
	ApiKeyRow,
	ComboBackup,
	CustomModelBackup,
	DbExportPayload,
	ExportScope,
	ProviderConnectionBackup,
	ProviderConnectionRow,
	ProviderNodeBackup,
	ProviderNodeRow,
	ProxyPoolBackup,
	ProxyPoolRow,
	UsageDailyBackupRow,
	UsageHistoryBackupRow,
} from "./dbTypes.ts"
import { getAdapter } from "./driver.ts"
import { parseJson } from "./helpers/jsonCol.ts"

// Export/import full DB
export async function exportDb(options: ExportScope = null): Promise<DbExportPayload> {
	const db = await getAdapter()
	const { exportSettings } = await import("./repos/settingsRepo.ts")

	const isIncluded = (key: string): boolean => {
		if (!options) return true
		if (Array.isArray(options)) return options.length === 0 || options.includes(key)
		if (typeof options === "object") return options[key] !== false
		return true
	}

	const out: DbExportPayload = {}

	if (isIncluded("settings")) {
		out.settings = await exportSettings()
	}
	if (isIncluded("providers")) {
		out.providerConnections = db
			.all<ProviderConnectionRow>(`SELECT * FROM providerConnections`)
			.map((r) => ({
				...parseJson<Record<string, unknown>>(r.data, {}),
				id: r.id,
				provider: r.provider,
				authType: r.authType,
				name: r.name,
				email: r.email,
				priority: r.priority,
				isActive: r.isActive === 1,
				createdAt: r.createdAt,
				updatedAt: r.updatedAt,
			}))
		out.providerNodes = db.all<ProviderNodeRow>(`SELECT * FROM providerNodes`).map((r) => ({
			...parseJson<Record<string, unknown>>(r.data, {}),
			id: r.id,
			type: r.type,
			name: r.name,
			createdAt: r.createdAt,
			updatedAt: r.updatedAt,
		}))
		out.proxyPools = db.all<ProxyPoolRow>(`SELECT * FROM proxyPools`).map((r) => ({
			...parseJson<Record<string, unknown>>(r.data, {}),
			id: r.id,
			isActive: r.isActive === 1,
			testStatus: r.testStatus,
			createdAt: r.createdAt,
			updatedAt: r.updatedAt,
		}))
	}
	if (isIncluded("apiKeys")) {
		out.apiKeys = db.all<ApiKeyRow>(`SELECT * FROM apiKeys`).map((r) => ({
			id: r.id,
			key: r.key,
			name: r.name,
			machineId: r.machineId,
			isActive: r.isActive === 1,
			createdAt: r.createdAt,
			tokenLimit: r.tokenLimit,
			usedTokens: r.usedTokens,
			limitKind: r.limitKind || "tokens",
			requestLimit: Number(r.requestLimit) || 0,
			usedRequests: Number(r.usedRequests) || 0,
			resetInterval: r.resetInterval,
			lastResetAt: r.lastResetAt,
			allowedModels: r.allowedModels,
			allowedEndpoints: normalizeAllowedEndpoints(r.allowedEndpoints),
			rpmLimit: r.rpmLimit,
			tpmLimit: r.tpmLimit,
			// The cap is configuration and belongs in a backup; the counter beside it is
			// runtime state, carried along so a restore does not silently reset spend.
			dailyCostLimit: Number(r.dailyCostLimit) || 0,
			costSpent: Number(r.costSpent) || 0,
			costDay: r.costDay || "",
			expiresAt: r.expiresAt || null,
			systemPrompt: r.systemPrompt || "",
			permissions: r.permissions || "",
			createdBy: r.createdBy || "",
			access: keyAccessFromColumns(r.accessRestricted, r.accessAllow),
		}))
	}
	if (isIncluded("combos")) {
		out.combos = db
			.all<{
				id: string
				name: string
				kind?: string
				models?: string | null
				createdAt?: string
				updatedAt?: string
			}>(`SELECT * FROM combos`)
			.map((r) => ({
				id: r.id,
				name: r.name,
				kind: r.kind,
				models: parseJson<unknown[]>(r.models, []),
				createdAt: r.createdAt,
				updatedAt: r.updatedAt,
			}))
	}
	if (isIncluded("usage")) {
		out.usageHistory = db.all(`SELECT * FROM usageHistory ORDER BY id`)
		out.usageDaily = db.all(`SELECT * FROM usageDaily`)
	}
	if (isIncluded("customModels")) {
		out.modelAliases = {}
		out.customModels = []
		out.mitmAlias = {}
		for (const r of db.all<{ key: string; value: string }>(
			`SELECT key, value FROM kv WHERE scope = 'modelAliases'`,
		))
			out.modelAliases[r.key] = parseJson(r.value)
		for (const r of db.all<{ key: string; value: string }>(
			`SELECT key, value FROM kv WHERE scope = 'customModels'`,
		)) {
			// An unreadable row used to be pushed as null, which then travelled into
			// the restored backup as a row with no fields. Skipping it keeps the list
			// homogeneous.
			const row = parseJson<CustomModelBackup>(r.value)
			if (row) out.customModels.push(row)
		}
		for (const r of db.all<{ key: string; value: string }>(
			`SELECT key, value FROM kv WHERE scope = 'mitmAlias'`,
		))
			out.mitmAlias[r.key] = parseJson(r.value)
	}
	if (isIncluded("pricing")) {
		out.modelOverrides = {}
		out.pricing = {}
		out.disabledModels = {}
		for (const r of db.all<{ key: string; value: string }>(
			`SELECT key, value FROM kv WHERE scope = 'pricing'`,
		))
			out.pricing[r.key] = parseJson(r.value)
		for (const r of db.all<{ key: string; value: string }>(
			`SELECT key, value FROM kv WHERE scope = 'modelOverrides'`,
		))
			out.modelOverrides[r.key] = parseJson(r.value)
		for (const r of db.all<{ key: string; value: string }>(
			`SELECT key, value FROM kv WHERE scope = 'disabledModels'`,
		))
			out.disabledModels[r.key] = parseJson(r.value, [])
	}
	if (isIncluded("autoBackup")) {
		out.autoBackup = {}
		for (const r of db.all<{ key: string; value: string }>(
			`SELECT key, value FROM kv WHERE scope = 'autoBackup'`,
		))
			out.autoBackup[r.key] = parseJson(r.value)
	}

	return out
}
