/**
 * Read and clear the stored diagnostics.
 *
 * The rules that matter — what a requested page size becomes — live in
 * `domain/error-log.ts`. What is left is ordering and, for clear, refusing to
 * report success when the port says nothing was deleted.
 */

import { resolveErrorLogLimit } from "../../domain/error-log.ts"
import { internal } from "../../domain/errors.ts"
import type { ErrorLogEntry, ErrorLogPort } from "../dependencies.ts"

export interface ErrorLogPage {
	readonly logs: ErrorLogEntry[]
	/** The size actually used, after clamping. */
	readonly limit: number
	/**
	 * True when the caller's requested size was replaced. Without it a dashboard
	 * asking for 5000 cannot tell a clamp from a short result set.
	 */
	readonly adjusted: boolean
}

export function makeListErrorLogs(port: ErrorLogPort) {
	return async (requestedLimit: unknown): Promise<ErrorLogPage> => {
		const { limit, adjusted } = resolveErrorLogLimit(requestedLimit)
		const logs = await port.list(limit)
		return { logs, limit, adjusted }
	}
}

export function makeClearErrorLogs(port: ErrorLogPort) {
	return async (): Promise<{ cleared: true }> => {
		const cleared = await port.clear()
		if (!cleared) {
			// Previously this answered `{ success: true }` regardless, so a failed
			// delete left the dashboard showing stale rows with no hint that the
			// clear had not taken effect.
			throw internal("Could not clear error logs")
		}
		return { cleared: true }
	}
}
