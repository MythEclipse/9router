/**
 * What a failed probe reports about itself.
 *
 * `test-batch` wrote the same seven-field row twice — once in the success path
 * and once in the `catch`, differing only in the values. That duplication is
 * where the two paths had already drifted apart: the catch branch reported
 * `diagnosis` as a structured object where the success path passed along a
 * string, so one batch response carried two shapes of the same field.
 *
 * Here a probe outcome is turned into a row once, and a throw is turned into an
 * outcome rather than a second code path.
 */

/** A probe's verdict, as the connection tester reports it. */
export interface ProbeOutcome {
	readonly valid: boolean
	readonly latencyMs?: number | null
	readonly error?: string | null
	readonly diagnosis?: unknown
	readonly statusCode?: number | null
	readonly testedAt?: string | null
	/** True when the probe refreshed the stored tokens and wrote them back. */
	readonly refreshed?: boolean
}

/** The connection fields a result row echoes back. */
export interface ProbedConnection {
	readonly id: string
	readonly provider: string
	readonly name?: string | null
	readonly email?: string | null
	readonly authType?: string | null
}

/** One row of a batch response. */
export interface BatchResult {
	readonly provider: string
	readonly connectionId: string
	readonly connectionName: string
	readonly authType: string | null
	readonly valid: boolean
	readonly latencyMs: number
	readonly error: string | null
	readonly diagnosis: unknown
	readonly statusCode: number | null
	readonly testedAt: string
}

/**
 * The label a row shows for a connection.
 *
 * Three fallbacks deep because a connection may carry none of them: a name, an
 * email for OAuth accounts, and finally the provider id so the row is never
 * blank.
 */
export function connectionLabel(connection: ProbedConnection): string {
	return connection.name || connection.email || connection.provider
}

/**
 * A thrown probe, as an outcome.
 *
 * A probe that throws has told us something real — usually that the network
 * refused before any HTTP status existed — so it is reported as a network
 * failure with the thrown message, not swallowed and not allowed to abort the
 * batch. That is the whole reason a batch survives one broken connection.
 */
export function outcomeFromError(error: unknown): ProbeOutcome {
	const message = error instanceof Error ? error.message : String(error)
	return {
		valid: false,
		latencyMs: 0,
		error: message,
		diagnosis: { type: "network_error", source: "local", code: null, message },
		statusCode: null,
	}
}

/** One batch row, from a connection and its outcome. */
export function toBatchResult(
	connection: ProbedConnection,
	outcome: ProbeOutcome,
	authType: string | null,
	now: () => string,
): BatchResult {
	return {
		provider: connection.provider,
		connectionId: connection.id,
		connectionName: connectionLabel(connection),
		authType: connection.authType ?? authType,
		valid: outcome.valid,
		latencyMs: outcome.latencyMs ?? 0,
		error: outcome.error ?? null,
		diagnosis: outcome.diagnosis ?? null,
		statusCode: outcome.statusCode ?? null,
		testedAt: outcome.testedAt ?? now(),
	}
}

/** The counts a batch response carries beside its rows. */
export function summarise(results: readonly BatchResult[]): {
	readonly total: number
	readonly passed: number
	readonly failed: number
} {
	const passed = results.filter((result) => result.valid).length
	return { total: results.length, passed, failed: results.length - passed }
}
