/**
 * Test a set of connections, one at a time, surviving failures one at a time.
 *
 * Called from:
 *   - `apps/api/src/application/use-cases.ts` (`makeTestConnections`, registered as
 *     `testConnections`)
 *   - `apps/web/src/app/api/providers/test-batch/route.ts` via
 *     `getUseCases().testConnections.run(...)`
 *   - `tests/unit/use-case-test-connections.test.ts`
 *
 * No existing file serves this purpose: `probe-models.ts` probes every *model* on
 * one connection, while this probes one connection per batch row; the loop and
 * row-building lived inline in `providers/test-batch/route.ts`.
 *
 * Reads: active provider connections (id, provider, name, email, authType) via
 * `ConnectionStore.list({isActive: true})`. Writes nothing — the injected probe
 * owns the connection's own test status.
 *
 * User instruction, verbatim: "lanjut kenapa malah berhenti".
 */

import {
	type BatchResult,
	outcomeFromError,
	type ProbedConnection,
	type ProbeOutcome,
	summarise,
	toBatchResult,
} from "../../domain/batch-result.ts"
import {
	authGroupOf,
	type BatchMode,
	isSupportedMode,
	type ProviderClassifiers,
	selectConnections,
	unsupportedModeMessage,
} from "../../domain/batch-selection.ts"
import { invalid } from "../../domain/errors.ts"
import type { ConnectionStore } from "./ports.ts"

export interface TestConnectionsDependencies {
	readonly connections: ConnectionStore
	/** Answers the free/oauth/apikey/compatible questions grouping asks. */
	readonly classifiers: ProviderClassifiers
	/** Probes one connection and reports what happened. */
	readonly probe: (connectionId: string) => Promise<ProbeOutcome>
	/** Clock, injected so a test can pin `testedAt`. */
	readonly now: () => string
}

/** A batch response. `providerId` is echoed so the panel can name the run. */
export interface BatchReport {
	readonly mode: BatchMode
	readonly providerId: string | null
	readonly results: readonly BatchResult[]
	readonly summary: { readonly total: number; readonly passed: number; readonly failed: number }
	readonly testedAt: string
}

/** A connection as the grouping rule and the result row both read it. */
type BatchConnection = ProbedConnection & { readonly provider: string }

export function makeTestConnections({
	connections,
	classifiers,
	probe,
	now,
}: TestConnectionsDependencies) {
	return {
		/**
		 * Run a batch over the active connections in scope.
		 *
		 * Only active connections are candidates: a disabled one is disabled
		 * precisely because the operator does not want it used, and reporting it
		 * red after every batch would make the summary look worse than the fleet.
		 *
		 * Sequential rather than parallel on purpose — the probe refreshes OAuth
		 * tokens and writes them back to the same row, so two probes of one
		 * provider racing that write can persist a token the other cannot use.
		 */
		async run(request: {
			readonly mode: string
			readonly providerId?: string
		}): Promise<BatchReport> {
			const { mode, providerId } = request
			if (!mode) throw invalid("mode is required")
			if (!isSupportedMode(mode)) throw invalid(unsupportedModeMessage())

			const active = await connections.list({ isActive: true })
			const selected = selectConnections(
				active as readonly BatchConnection[],
				{ mode, providerId },
				classifiers,
			)

			const results: BatchResult[] = []
			for (const connection of selected) {
				const outcome = await probeOne(connection.id, probe)
				results.push(toBatchResult(connection, outcome, authGroupOf(connection, classifiers), now))
			}

			return {
				mode,
				providerId: providerId ?? null,
				results,
				summary: summarise(results),
				testedAt: now(),
			}
		},
	}
}

/**
 * One probe, with a throw converted to an outcome.
 *
 * Kept separate so the loop body never grows a try/catch and the conversion can
 * be read — and tested — on its own.
 */
async function probeOne(
	connectionId: string,
	probe: TestConnectionsDependencies["probe"],
): Promise<ProbeOutcome> {
	try {
		return await probe(connectionId)
	} catch (error) {
		return outcomeFromError(error)
	}
}
