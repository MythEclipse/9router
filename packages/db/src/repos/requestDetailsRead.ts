/**
 * Request-detail readers.
 *
 * Extracted verbatim from requestDetailsRepo.ts.
 */

import { getAdapter } from "../driver.ts"
import { parseJson } from "../helpers/jsonCol.ts"
import type { DbRow } from "../types.ts"
import { buildAllowedModelsSql, isAllowedModelPatterns } from "./allowedModels.ts"

/** Filters accepted by getRequestDetails (all optional). */
export interface RequestDetailsFilter {
	provider?: string
	model?: string
	connectionId?: string
	status?: string
	startDate?: string | number | Date
	endDate?: string | number | Date
	/** `null`/`undefined` (or a pattern list containing `*`) means every model. */
	allowedModelPatterns?: unknown
	page?: number
	pageSize?: number
}

/** One page of request details, plus the counts the dashboard paginates with. */
export interface RequestDetailsPage {
	details: unknown[]
	pagination: {
		page: number
		pageSize: number
		totalItems: number
		totalPages: number
		hasNext: boolean
		hasPrev: boolean
	}
}

export async function getRequestDetails(
	filter: RequestDetailsFilter = {},
): Promise<RequestDetailsPage> {
	const db = await getAdapter()
	const conds: string[] = []
	const params: unknown[] = []

	if (filter.provider) {
		conds.push("provider = ?")
		params.push(filter.provider)
	}
	if (filter.model) {
		conds.push("model = ?")
		params.push(filter.model)
	}
	if (filter.connectionId) {
		conds.push("connectionId = ?")
		params.push(filter.connectionId)
	}
	if (filter.status) {
		conds.push("status = ?")
		params.push(filter.status)
	}
	if (filter.startDate) {
		conds.push("timestamp >= ?")
		params.push(new Date(filter.startDate).toISOString())
	}
	if (filter.endDate) {
		conds.push("timestamp <= ?")
		params.push(new Date(filter.endDate).toISOString())
	}
	// Scoped sessions narrow the listing to the models their key may actually use.
	const allowedPatterns = isAllowedModelPatterns(filter.allowedModelPatterns)
		? filter.allowedModelPatterns
		: null
	const allowed = buildAllowedModelsSql(allowedPatterns)
	if (allowed) {
		conds.push(allowed.sql)
		params.push(...allowed.params)
	}

	const where = conds.length ? `WHERE ${conds.join(" AND ")}` : ""
	const cntRow = db.get<{ c: number }>(`SELECT COUNT(*) as c FROM requestDetails ${where}`, params)
	const totalItems = cntRow ? cntRow.c : 0

	const page = filter.page || 1
	const pageSize = filter.pageSize || 50
	const totalPages = Math.ceil(totalItems / pageSize)
	const offset = (page - 1) * pageSize

	const rows = db.all<DbRow>(
		`SELECT data FROM requestDetails ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
		[...params, pageSize, offset],
	)
	const details = rows.map((r) => parseJson(r.data, {}))

	return {
		details,
		pagination: {
			page,
			pageSize,
			totalItems,
			totalPages,
			hasNext: page < totalPages,
			hasPrev: page > 1,
		},
	}
}

export async function getDistinctProviders(
	allowedModelPatterns: unknown = null,
): Promise<unknown[]> {
	const db = await getAdapter()
	// The dashboard passes a session value it cannot vouch for, so narrow it here.
	const patterns = isAllowedModelPatterns(allowedModelPatterns) ? allowedModelPatterns : null
	const allowed = buildAllowedModelsSql(patterns)
	const where = allowed ? `provider IS NOT NULL AND ${allowed.sql}` : "provider IS NOT NULL"
	const rows = db.all<DbRow>(
		`SELECT DISTINCT provider FROM requestDetails WHERE ${where} ORDER BY provider ASC`,
		allowed ? allowed.params : [],
	)
	return rows.map((r) => r.provider)
}

export async function getRequestDetailById(id: string): Promise<unknown> {
	const db = await getAdapter()
	const row = db.get<DbRow>(`SELECT data FROM requestDetails WHERE id = ?`, [id])
	return row ? parseJson(row.data, null) : null
}
