/**
 * Provider-connection row helpers.
 *
 * Extracted verbatim from connectionsRepo.ts.
 */

import { parseJson, stringifyJson } from "../helpers/jsonCol.ts"
import type { ResolvedDbAdapter } from "../types.ts"

import type { ProviderConnectionRecord, ProviderConnectionRow } from "./connectionsTypes.ts"

export const OPTIONAL_FIELDS = [
	"displayName",
	"email",
	"globalPriority",
	"defaultModel",
	"accessToken",
	"refreshToken",
	"expiresAt",
	"tokenType",
	"scope",
	"projectId",
	"apiKey",
	"testStatus",
	"lastTested",
	"lastError",
	"lastErrorAt",
	"rateLimitedUntil",
	"expiresIn",
	"errorCode",
	"consecutiveUseCount",
	"idToken",
	"lastRefreshAt",
]

export const MODEL_LOCK_PREFIX = "modelLock_"

export function resetHealthStateOnActivation(
	existing: ProviderConnectionRecord | null,
	patch: Record<string, unknown>,
) {
	if (patch?.testStatus !== "active") return patch

	const normalized: Record<string, unknown> = {
		...patch,
		testStatus: "active",
		lastError: Object.hasOwn(patch, "lastError") ? patch.lastError : null,
		lastErrorAt: Object.hasOwn(patch, "lastErrorAt") ? patch.lastErrorAt : null,
		errorCode: null,
		rateLimitedUntil: null,
		backoffLevel: 0,
	}

	for (const key of Object.keys(existing || {})) {
		if (key.startsWith(MODEL_LOCK_PREFIX)) normalized[key] = null
	}

	return normalized
}

/** A provider connection as the app sees it (data columns spread over the row). */

const nullish = <T>(value: T | null | undefined): T | null => value ?? null

export function rowToConn(row: ProviderConnectionRow): ProviderConnectionRecord {
	const extra = parseJson<Record<string, unknown>>(row.data, {})
	return {
		...extra,
		id: row.id,
		provider: row.provider,
		authType: nullish(row.authType),
		name: nullish(row.name),
		email: nullish(row.email),
		priority: nullish(row.priority),
		isActive: row.isActive === 1 || row.isActive === true,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	}
}

export function connToRow(c: ProviderConnectionRecord) {
	const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } =
		c
	return {
		id,
		provider,
		authType,
		name: name ?? null,
		email: email ?? null,
		priority: priority ?? null,
		isActive: isActive === false ? 0 : 1,
		data: stringifyJson(rest),
		createdAt,
		updatedAt,
	}
}

export function upsert(db: ResolvedDbAdapter, c: ProviderConnectionRecord): void {
	const r = connToRow(c)
	db.run(
		`INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       provider=excluded.provider, authType=excluded.authType, name=excluded.name,
       email=excluded.email, priority=excluded.priority, isActive=excluded.isActive,
       data=excluded.data, updatedAt=excluded.updatedAt`,
		[
			r.id,
			r.provider,
			r.authType,
			r.name,
			r.email,
			r.priority,
			r.isActive,
			r.data,
			r.createdAt,
			r.updatedAt,
		],
	)
}

export function deriveConnectionName(
	data: Record<string, unknown>,
	fallbackName: string | null | undefined,
): string | null {
	if (data.provider === "github") {
		return (
			((data.providerSpecificData as Record<string, unknown> | undefined)?.githubLogin as
				| string
				| undefined) ||
			((data.providerSpecificData as Record<string, unknown> | undefined)?.githubEmail as
				| string
				| undefined) ||
			(data.email as string | undefined) ||
			((data.providerSpecificData as Record<string, unknown> | undefined)?.githubName as
				| string
				| undefined) ||
			fallbackName ||
			null
		)
	}
	return nullish(fallbackName)
}

export function reorderInTx(db: ResolvedDbAdapter, providerId: string): void {
	const list = db
		.all<ProviderConnectionRow>(`SELECT * FROM providerConnections WHERE provider = ?`, [providerId])
		.map(rowToConn)
	list.sort((a, b) => {
		const pDiff = (a.priority || 0) - (b.priority || 0)
		if (pDiff !== 0) return pDiff
		return Number(new Date(b.updatedAt || 0)) - Number(new Date(a.updatedAt || 0))
	})
	list.forEach((c, i) => {
		const want = i + 1
		if ((c.priority || 0) !== want) {
			db.run(`UPDATE providerConnections SET priority = ? WHERE id = ?`, [want, c.id])
		}
	})
}

/** Input accepted by createProviderConnection: a partial connection plus flags. */

export function getModelInfoCoreSync(modelStr: string): { provider: string | null } | null {
	if (!modelStr || typeof modelStr !== "string") return null
	const separator = modelStr.includes("/") ? "/" : modelStr.includes(":") ? ":" : null
	if (!separator) return null
	return { provider: modelStr.split(separator)[0] || null }
}
