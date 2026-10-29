/**
 * Stopping the server, from either endpoint.
 *
 * The two callers keep their own transport identity (a cookie for the dashboard,
 * a bearer secret for the hook) but share one shutdown sequence: close the
 * database, stop the managed background processes, answer, then exit. That
 * order is the whole point — answering before exiting gives the caller the 200
 * it is waiting for instead of a connection reset, and closing the database
 * first is what stops SQLite from being killed mid-write.
 *
 * Everything the use-case touches is injected: the exit, the delay, the
 * environment. A test that watches the sequence should not end the test runner.
 */

import { forbidden, unauthorized } from "../../domain/errors.ts"
import {
	mayStopFromDashboard,
	mayStopFromHook,
	type SessionIdentity,
} from "../../domain/shutdown-gate.ts"

export interface ShutdownPorts {
	/** Close the database handle; failures are swallowed, the process is leaving. */
	closeDatabase(): Promise<void>
	/** Stop the background processes this app manages. */
	stopManagedProcesses(): Promise<void>
	/** End the process after `delayMs`, so the response can flush first. */
	exitAfter(delayMs: number, code: number): void
}

export interface ShutdownEnvironment {
	readonly nodeEnv: string | undefined
	readonly secret: string | undefined
}

export interface ShutdownResult {
	readonly success: true
	readonly message: string
}

/** How long to let the response flush before the process goes away. */
const EXIT_DELAY_MS = 500

export function makeShutdownFromDashboard(ports: ShutdownPorts) {
	return async (session: SessionIdentity | null): Promise<ShutdownResult> => {
		// A session that could not be read arrives as null and is refused the same
		// way as an anonymous caller; the route no longer needs a try/catch for it.
		const verdict = mayStopFromDashboard(session)
		if (!verdict.allowed) throw forbidden(verdict.message)

		return scheduleExit(ports)
	}
}

export function makeShutdownFromHook(ports: ShutdownPorts, env: ShutdownEnvironment) {
	return async (authorization: string | null): Promise<ShutdownResult> => {
		const verdict = mayStopFromHook({
			nodeEnv: env.nodeEnv,
			secret: env.secret,
			authorization,
		})
		if (!verdict.allowed) {
			// Production is a 403 (this deployment may never stop this way); a bad or
			// missing secret is a 401 (you may, with the right credential).
			if (env.nodeEnv === "production") throw forbidden(verdict.message)
			throw unauthorized(verdict.message)
		}

		return scheduleExit(ports)
	}
}

async function scheduleExit(ports: ShutdownPorts): Promise<ShutdownResult> {
	await bestEffort(() => ports.closeDatabase())
	await bestEffort(() => ports.stopManagedProcesses())

	ports.exitAfter(EXIT_DELAY_MS, 0)

	return { success: true, message: "Shutting down..." }
}

async function bestEffort(step: () => Promise<void>): Promise<void> {
	try {
		await step()
	} catch {
		// The process is going away; a failed cleanup must not turn the answer into a 500.
	}
}
