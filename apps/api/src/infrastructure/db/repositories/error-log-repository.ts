/**
 * Adapter for {@link ErrorLogPort}.
 *
 * Thin by design: `packages/db` already owns the SQL and swallows its own
 * errors, so the only translation here is narrowing the untyped row shape to
 * the port's contract.
 */
import { clearErrorLogs, getErrorLogs } from "@9router/db/repos/errorLogRepo"
import type { ErrorLogEntry, ErrorLogPort } from "../../../application/dependencies.ts"

/** The repo returns `DbRow[]`; the port promises an `id` on every entry. */
function toEntry(row: Record<string, unknown>): ErrorLogEntry {
	const id = Number(row.id)
	return { ...row, id: Number.isFinite(id) ? id : 0 }
}

export function createErrorLogRepository(): ErrorLogPort {
	return {
		async list(limit) {
			const rows = await getErrorLogs(limit)
			return rows.map((row) => toEntry(row as Record<string, unknown>))
		},
		clear: () => clearErrorLogs(),
	}
}
