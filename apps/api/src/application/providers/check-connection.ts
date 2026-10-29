/**
 * Probe one connection and report a short verdict.
 *
 * Called from:
 *   - `apps/api/src/application/use-cases.ts` (`makeCheckConnection`, registered as
 *     `checkConnection`)
 *   - `apps/web/src/app/api/providers/[id]/test/route.ts` via
 *     `getUseCases().checkConnection.run(id)`
 *   - `tests/unit/use-case-check-connection.test.ts`
 *
 * No existing file serves this purpose: `probe-models.ts` probes every model on a
 * connection and answers with per-model rows; this probes the connection itself
 * and answers with three fields. `test-connections.ts` runs this same probe over
 * many connections and reports full rows.
 *
 * Reads: nothing directly — the injected `probe` owns the read and the write-back
 * of test status and any refreshed tokens.
 *
 * User instruction, verbatim: "lanjut kenapa malah berhenti".
 */

import type { ProbeOutcome } from "../../domain/batch-result.ts"
import { notFound } from "../../domain/errors.ts"

export interface CheckConnectionDependencies {
	/**
	 * Probes one connection.
	 *
	 * Reports a missing connection as `error: "Connection not found"` rather than
	 * throwing: that is how the tester has always signalled it, and the batch path
	 * depends on it agreeing — a batch row for a connection deleted mid-run should
	 * read as a failed row, not abort the run.
	 */
	readonly probe: (connectionId: string) => Promise<ProbeOutcome>
}

/** The short verdict the dashboard's test button shows. */
export interface CheckVerdict {
	readonly valid: boolean
	readonly error: string | null
	readonly refreshed: boolean
}

/**
 * The message the tester uses for a missing connection.
 *
 * Shared as a constant so this module, the tester and the batch path cannot drift
 * apart on a string that decides between a 404 and a 500.
 */
export const CONNECTION_NOT_FOUND = "Connection not found"

export function makeCheckConnection({ probe }: CheckConnectionDependencies) {
	return {
		/**
		 * Run the probe and translate its outcome.
		 *
		 * A missing connection is a 404, not a failed probe — the distinction
		 * matters to the panel, which offers "test again" on a failure and refreshes
		 * the list on a 404. Everything else is reported as it came, including a
		 * `refreshed` flag the panel uses to know the stored tokens changed under it.
		 */
		async run(connectionId: string): Promise<CheckVerdict> {
			const outcome = await probe(connectionId)
			if (outcome.error === CONNECTION_NOT_FOUND) throw notFound("Connection")
			return {
				valid: outcome.valid,
				error: outcome.error ?? null,
				refreshed: outcome.refreshed === true,
			}
		},
	}
}
