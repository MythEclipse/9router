/**
 * Reading the audit trail.
 *
 * The writer lives beside each mutation (and, for the dashboard's admin procedures, in the
 * `audited` middleware). This file is the reader: it resolves the page size, asks the store for
 * the newest rows, and shapes them so the list can group by resource without re-parsing strings
 * in the browser.
 *
 * Two details worth naming:
 *
 *  - **The payload is summarised on read, not trusted from the row.** Rows written before this
 *    module existed carry whatever the writer put there, and a reader that renders them as-is
 *    would show a credential the old writer did not strip. `summarisePayload` runs over every
 *    row, old or new.
 *  - **An empty log is not an error.** A fresh install has changed nothing yet, and the page
 *    must say so rather than report a failed read.
 */
import {
	AUDIT_LOG_MAX_LIMIT,
	type AuditEntry,
	describeAction,
	isAuditLimitRefused,
	resolveAuditLimit,
	summarisePayload,
} from "../../domain/audit-log.ts"
import { AppError } from "../../domain/errors.ts"

/** One stored row, as the repository returns it. */
export interface AuditRow {
	readonly id: string
	readonly action: string
	readonly subject: string
	readonly at: Date | string
	readonly payload: unknown
}

export interface AuditLogPort {
	list(limit: number): Promise<readonly AuditRow[]>
	record(entry: {
		readonly action: string
		readonly subject: string
		readonly payload?: Record<string, unknown>
		readonly at: Date
	}): Promise<void>
}

export interface AuditLogResult {
	readonly entries: readonly AuditEntry[]
	readonly limit: number
	readonly maxLimit: number
}

export interface AuditLogUseCase {
	readonly list: (rawLimit: unknown) => Promise<AuditLogResult>
	/**
	 * Record a mutation.
	 *
	 * The payload is summarised *before* it is stored, so the table never holds a credential
	 * even briefly. A failed write is logged and swallowed: an audit entry that could not be
	 * written must not turn a completed change into a 500 the caller would retry.
	 */
	readonly record: (entry: {
		readonly action: string
		readonly subject: string
		readonly payload?: unknown
	}) => Promise<void>
}

function atOf(value: Date | string): string {
	const date = value instanceof Date ? value : new Date(value)
	return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString()
}

export function makeAuditLog(deps: { readonly port: AuditLogPort }): AuditLogUseCase {
	return {
		async list(rawLimit) {
			const resolved = resolveAuditLimit(rawLimit)
			if (isAuditLimitRefused(resolved)) {
				throw new AppError("VALIDATION", resolved.message, { status: 400 })
			}
			const rows = await deps.port.list(resolved.limit)
			const entries = rows.map((row) => {
				const { resource, verb } = describeAction(row.action)
				return {
					id: row.id,
					action: row.action,
					subject: row.subject,
					at: atOf(row.at),
					detail: summarisePayload(row.payload),
					resource,
					verb,
				}
			})
			return { entries, limit: resolved.limit, maxLimit: AUDIT_LOG_MAX_LIMIT }
		},

		async record(entry) {
			const action = entry.action.trim()
			if (!action) return
			try {
				await deps.port.record({
					action,
					subject: entry.subject || "-",
					payload: summarisePayload(entry.payload),
					at: new Date(),
				})
			} catch (error) {
				// The change already happened. Failing the request now would invite a retry that
				// performs it twice, which is worse than a missing audit line.
				console.error(
					"[audit] failed to record",
					action,
					error instanceof Error ? error.message : error,
				)
			}
		},
	}
}
