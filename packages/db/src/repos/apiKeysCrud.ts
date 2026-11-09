/**
 * API-key CRUD.
 *
 * Extracted verbatim from apiKeysRepo.ts.
 */

import { keyAccessToColumns } from "@9router/db/shared/keyAccess"
import { normalizeAllowedEndpoints } from "@9router/db/shared/keyEndpoints"
import { v4 as uuidv4 } from "uuid"
import { getAdapter } from "../driver.ts"

import {
	type ApiKeyRecord,
	type ApiKeyRow,
	normalizeAccess,
	parsePermissions,
	rowToKey,
} from "./apiKeysTypes.ts"
import { invalidateApiKeyCache } from "./apiKeysValidate.ts"

export async function getApiKeys(): Promise<ApiKeyRecord[]> {
	const db = await getAdapter()
	const rows = db.all<ApiKeyRow>(`SELECT * FROM apiKeys ORDER BY createdAt ASC`)
	return rows.map((row) => rowToKey(row)).filter((key): key is ApiKeyRecord => key !== null)
}

export async function getApiKeyById(id: string): Promise<ApiKeyRecord | null> {
	const db = await getAdapter()
	const row = db.get<ApiKeyRow>(`SELECT * FROM apiKeys WHERE id = ?`, [id])
	return rowToKey(row)
}

export async function getApiKeyByKey(key: string): Promise<ApiKeyRecord | null> {
	const db = await getAdapter()
	const row = db.get<ApiKeyRow>(`SELECT * FROM apiKeys WHERE key = ?`, [key])
	return rowToKey(row)
}

export async function createApiKey(
	name: string,
	machineId: string,
	options: Partial<ApiKeyRecord> & { permissions?: unknown } = {},
): Promise<ApiKeyRecord> {
	if (!machineId) throw new Error("machineId is required")
	const db = await getAdapter()
	const { generateApiKeyWithMachine } = await import("./../shared/apiKey.ts")
	const result = generateApiKeyWithMachine(machineId)
	const now = new Date().toISOString()
	const apiKey = {
		id: uuidv4(),
		name,
		key: result.key,
		machineId,
		isActive: true,
		createdAt: now,
		tokenLimit: Number(options.tokenLimit) || 0,
		usedTokens: Number(options.usedTokens) || 0,
		limitKind:
			options.limitKind === "cost" || options.limitKind === "requests"
				? (options.limitKind as "cost" | "requests")
				: ("tokens" as const),
		requestLimit: Number(options.requestLimit) || 0,
		usedRequests: Number(options.usedRequests) || 0,
		resetInterval: options.resetInterval || "never",
		lastResetAt: options.lastResetAt || now,
		allowedModels: options.allowedModels || "*",
		allowedEndpoints: normalizeAllowedEndpoints(options.allowedEndpoints),
		rpmLimit: Number(options.rpmLimit) || 0,
		tpmLimit: Number(options.tpmLimit) || 0,
		dailyCostLimit: Number(options.dailyCostLimit) || 0,
		costSpent: Number(options.costSpent) || 0,
		costDay: options.costDay || "",
		expiresAt: options.expiresAt || null,
		systemPrompt: options.systemPrompt || "",
		permissions:
			typeof options.permissions === "object"
				? options.permissions
				: parsePermissions(options.permissions),
		// The caller resolves who is creating the key. It is never inferred here:
		// this module has no session, and reaching for one turned every create into
		// a ReferenceError, which the route reported as a bare 500.
		createdBy: options.createdBy || "",
		access: normalizeAccess(options.access ?? { restricted: false, allow: [] }),
	}
	const permStr =
		typeof options.permissions === "string" ? options.permissions : JSON.stringify(apiKey.permissions)
	const accessColumns = keyAccessToColumns(apiKey.access)
	db.run(
		`INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, tokenLimit, usedTokens, limitKind, requestLimit, usedRequests, resetInterval, lastResetAt, allowedModels, allowedEndpoints, rpmLimit, tpmLimit, dailyCostLimit, costSpent, costDay, ipWhitelist, expiresAt, systemPrompt, permissions, createdBy, accessRestricted, accessAllow) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			apiKey.id,
			apiKey.key,
			apiKey.name,
			apiKey.machineId,
			1,
			apiKey.createdAt,
			apiKey.tokenLimit,
			apiKey.usedTokens,
			apiKey.limitKind,
			apiKey.requestLimit,
			apiKey.usedRequests,
			apiKey.resetInterval,
			apiKey.lastResetAt,
			apiKey.allowedModels,
			JSON.stringify(apiKey.allowedEndpoints),
			apiKey.rpmLimit,
			apiKey.tpmLimit,
			apiKey.dailyCostLimit,
			apiKey.costSpent,
			apiKey.costDay,
			"",
			apiKey.expiresAt,
			apiKey.systemPrompt,
			permStr,
			apiKey.createdBy,
			accessColumns.accessRestricted,
			accessColumns.accessAllow,
		],
	)
	invalidateApiKeyCache()
	return apiKey
}

export async function updateApiKey(
	id: string,
	data: Partial<ApiKeyRecord> & { permissions?: unknown },
): Promise<ApiKeyRecord | null> {
	const db = await getAdapter()
	let result: ApiKeyRecord | null = null
	db.transaction(() => {
		const row = db.get<ApiKeyRow>(`SELECT * FROM apiKeys WHERE id = ?`, [id])
		if (!row) return
		// Mapped once: rowToKey returns null for a row it cannot read, and calling
		// it twice both wasted work and hid that case behind a possible-null.
		const current = rowToKey(row)
		if (!current) return
		const merged = { ...current, ...data }
		merged.access = normalizeAccess(data.access === undefined ? current.access : data.access)
		const permStr =
			typeof merged.permissions === "string"
				? merged.permissions
				: JSON.stringify(merged.permissions || {})
		const accessColumns = keyAccessToColumns(merged.access)
		db.run(
			`UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, tokenLimit = ?, usedTokens = ?, limitKind = ?, requestLimit = ?, usedRequests = ?, resetInterval = ?, lastResetAt = ?, allowedModels = ?, allowedEndpoints = ?, rpmLimit = ?, tpmLimit = ?, dailyCostLimit = ?, costSpent = ?, costDay = ?, ipWhitelist = ?, expiresAt = ?, systemPrompt = ?, permissions = ?, createdBy = ?, accessRestricted = ?, accessAllow = ? WHERE id = ?`,
			[
				merged.key,
				merged.name,
				merged.machineId,
				merged.isActive ? 1 : 0,
				Number(merged.tokenLimit) || 0,
				Number(merged.usedTokens) || 0,
				merged.limitKind === "cost" || merged.limitKind === "requests" ? merged.limitKind : "tokens",
				Number(merged.requestLimit) || 0,
				Number(merged.usedRequests) || 0,
				merged.resetInterval || "never",
				merged.lastResetAt || null,
				merged.allowedModels || "*",
				JSON.stringify(normalizeAllowedEndpoints(merged.allowedEndpoints)),
				Number(merged.rpmLimit) || 0,
				Number(merged.tpmLimit) || 0,
				Number(merged.dailyCostLimit) || 0,
				Number(merged.costSpent) || 0,
				merged.costDay || "",
				"",
				merged.expiresAt || null,
				merged.systemPrompt || "",
				permStr,
				merged.createdBy || "",
				accessColumns.accessRestricted,
				accessColumns.accessAllow,
				id,
			],
		)
		result = rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]))
	})
	// The key string may have changed and a deactivated key must stop
	// authenticating at once, so clear rather than evict by id.
	invalidateApiKeyCache()
	return result
}

export async function deleteApiKey(id: string): Promise<boolean> {
	const db = await getAdapter()
	const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id])
	invalidateApiKeyCache()
	return (res?.changes ?? 0) > 0
}

// In-memory sliding window rate limiter state for RPM/TPM per API key
if (!global._apiKeyRateLimits) global._apiKeyRateLimits = {}
