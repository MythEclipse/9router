/**
 * Provider-connection types.
 *
 * Extracted verbatim from connectionsRepo.ts.
 */

import type { DbRow } from "../types.ts"

export interface ProviderConnectionRecord {
	id: string
	provider: string
	authType: string | null
	name: string | null
	email: string | null
	priority: number | null
	isActive: boolean
	createdAt: string
	updatedAt: string
	/** Provider-specific OAuth/API details, stored as JSON in the `data` column. */
	providerSpecificData?: Record<string, unknown> | null
	[key: string]: unknown
}

/** Raw providerConnections row. */
export interface ProviderConnectionRow extends DbRow {
	id: string
	provider: string
	authType?: string | null
	name?: string | null
	email?: string | null
	priority?: number | null
	isActive?: number | boolean | null
	data?: string | null
	createdAt: string
	updatedAt: string
}

/**
 * A column that may be absent reads as null.
 *
 * The row type marks these optional and the record wants `T | null`; a missing
 * column and a null one are the same fact here, so they are reconciled in one
 * place rather than at each of the eight reads below.
 */

export type CreateConnectionInput = Partial<ProviderConnectionRecord> & {
	allowOverwrite?: boolean
} & Record<string, unknown>
