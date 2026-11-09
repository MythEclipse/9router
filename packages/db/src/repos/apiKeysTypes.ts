/**
 * API-key types and row mapping.
 *
 * Extracted verbatim from apiKeysRepo.ts.
 */

import {
	type KeyAccess,
	keyAccessFromColumns,
	validateKeyAccessInput,
} from "@9router/db/shared/keyAccess"
import { normalizeAllowedEndpoints } from "@9router/db/shared/keyEndpoints"
import { DEFAULT_PERMISSIONS } from "@9router/db/shared/permissionPaths"
import type { DbRow } from "../types.ts"

export function parsePermissions(permStr: unknown): Record<string, unknown> {
	if (!permStr) return { ...DEFAULT_PERMISSIONS }
	if (typeof permStr === "object") return permStr as Record<string, unknown>
	try {
		return JSON.parse(permStr as string) as Record<string, unknown>
	} catch {
		return { ...DEFAULT_PERMISSIONS }
	}
}

/** UTC calendar day (`YYYY-MM-DD`) — the same bucket SQLite's date('now') produces. */
export function utcDayKey(date: Date = new Date()): string {
	return date.toISOString().slice(0, 10)
}

/** An API key as the app sees it (booleans resolved, JSON columns parsed). */
export interface ApiKeyRecord {
	id: string
	key: string
	name: string
	machineId: string
	isActive: boolean
	createdAt: string
	tokenLimit: number
	usedTokens: number
	limitKind: "tokens" | "requests" | "cost"
	requestLimit: number
	usedRequests: number
	resetInterval: string
	lastResetAt: string | null
	allowedModels: string
	allowedEndpoints: string[]
	rpmLimit: number
	tpmLimit: number
	dailyCostLimit: number
	costSpent: number
	costDay: string
	expiresAt: string | null
	systemPrompt: string
	permissions: Record<string, unknown>
	createdBy: string
	access: KeyAccess
}

/** Raw apiKeys row: SQLite has no booleans, so flags arrive as 0/1. */
export interface ApiKeyRow extends DbRow {
	id: string
	key: string
	name: string
	machineId: string
	isActive?: number | boolean | null
	createdAt: string
	tokenLimit?: number | null
	usedTokens?: number | null
	limitKind?: string | null
	requestLimit?: number | string | null
	usedRequests?: number | string | null
	resetInterval?: string | null
	lastResetAt?: string | null
	allowedModels?: string | null
	allowedEndpoints?: string | null
	rpmLimit?: number | null
	tpmLimit?: number | null
	dailyCostLimit?: number | string | null
	costSpent?: number | string | null
	costDay?: string | null
	expiresAt?: string | null
	systemPrompt?: string | null
	permissions?: string | null
	createdBy?: string | null
	accessRestricted?: number | boolean | null
	accessAllow?: string | null
}

export function rowToKey(row: ApiKeyRow | null | undefined): ApiKeyRecord | null {
	if (!row) return null
	return {
		id: row.id,
		key: row.key,
		name: row.name,
		machineId: row.machineId,
		isActive: row.isActive === 1 || row.isActive === true,
		createdAt: row.createdAt,
		tokenLimit: row.tokenLimit || 0,
		usedTokens: row.usedTokens || 0,
		limitKind: row.limitKind === "cost" || row.limitKind === "requests" ? row.limitKind : "tokens",
		requestLimit: Number(row.requestLimit) || 0,
		usedRequests: Number(row.usedRequests) || 0,
		resetInterval: row.resetInterval || "never",
		lastResetAt: row.lastResetAt || null,
		allowedModels: row.allowedModels || "*",
		allowedEndpoints: normalizeAllowedEndpoints(row.allowedEndpoints),
		rpmLimit: row.rpmLimit || 0,
		tpmLimit: row.tpmLimit || 0,
		dailyCostLimit: Number(row.dailyCostLimit) || 0,
		costSpent: Number(row.costSpent) || 0,
		costDay: row.costDay || "",
		expiresAt: row.expiresAt || null,
		systemPrompt: row.systemPrompt || "",
		permissions: parsePermissions(row.permissions),
		createdBy: row.createdBy || "",
		access: keyAccessFromColumns(row.accessRestricted, row.accessAllow),
	}
}

export function normalizeAccess(access: unknown): KeyAccess {
	const result = validateKeyAccessInput(access)
	if (result.ok === false) throw new Error(result.error)
	return result.value
}
