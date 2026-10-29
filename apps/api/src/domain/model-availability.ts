/**
 * Model-availability rules: which models are cooling down, and what clearing a
 * cooldown means.
 *
 * A connection stores its cooldowns as `modelLock_<model>` keys whose value is
 * the expiry timestamp. The handler for `?clearCooldown` and the handler that
 * lists availability each parsed that convention on their own, so the list could
 * show a lock the clear could not find.
 *
 * `__all` is the sentinel for "the whole connection", used both by the lock
 * convention (an empty model in the key) and by the `unavailable` row.
 */

export const MODEL_LOCK_PREFIX = "modelLock_"
export const ALL_MODELS = "__all"

export type AvailabilityStatus = "cooldown" | "unavailable"

export interface ActiveLock {
	key: string
	/** The model the lock applies to, or `__all` for the whole connection. */
	model: string
	until: string
}

export interface AvailabilityRow {
	provider: string
	model: string
	status: AvailabilityStatus
	until?: string
	connectionId: string
	connectionName: string
	lastError: string | null
}

/** A connection row, as far as availability cares. */
export interface AvailabilityConnection {
	id: string
	provider: string
	name?: string | null
	email?: string | null
	lastError?: string | null
	testStatus?: string | null
	[key: string]: unknown
}

/**
 * Locks on one connection that have not expired yet.
 *
 * An expiry in the past is not a lock: the router has already retried the
 * model, and listing it as unavailable is what made the dashboard show a model
 * as stuck days after it had recovered.
 */
export function activeModelLocks(
	connection: AvailabilityConnection | null | undefined,
	now: number,
): ActiveLock[] {
	if (!connection) return []
	const locks: ActiveLock[] = []
	for (const [key, value] of Object.entries(connection)) {
		if (!key.startsWith(MODEL_LOCK_PREFIX) || !value) continue
		const until = String(value)
		if (!(new Date(until).getTime() > now)) continue
		locks.push({ key, model: key.slice(MODEL_LOCK_PREFIX.length) || ALL_MODELS, until })
	}
	return locks
}

/** One row per lock, plus one `unavailable` row for a connection with no locks. */
export function availabilityRows(
	connections: AvailabilityConnection[],
	now: number,
): AvailabilityRow[] {
	const rows: AvailabilityRow[] = []
	for (const connection of connections) {
		const locks = activeModelLocks(connection, now)
		const connectionName = connection.name || connection.email || connection.id
		for (const lock of locks) {
			rows.push({
				provider: connection.provider,
				model: lock.model,
				status: "cooldown",
				until: lock.until,
				connectionId: connection.id,
				connectionName,
				lastError: connection.lastError || null,
			})
		}
		// Only when nothing is cooling down: a connection whose test failed but
		// which is still retrying per-model is not wholly unavailable.
		if (locks.length === 0 && connection.testStatus === "unavailable") {
			rows.push({
				provider: connection.provider,
				model: ALL_MODELS,
				status: "unavailable",
				connectionId: connection.id,
				connectionName,
				lastError: connection.lastError || null,
			})
		}
	}
	return rows
}

/**
 * The patch that clears one lock.
 *
 * Clearing the last lock on a connection that had been marked unavailable also
 * has to clear the failure state, otherwise the connection stays out of rotation
 * with nothing left to explain why.
 */
export function clearLockPatch(
	connection: AvailabilityConnection,
	model: string,
): Record<string, unknown> {
	const patch: Record<string, unknown> = { [`${MODEL_LOCK_PREFIX}${model}`]: null }
	if (connection.testStatus === "unavailable") {
		Object.assign(patch, {
			testStatus: "active",
			lastError: null,
			lastErrorAt: null,
			backoffLevel: 0,
		})
	}
	return patch
}

/** Connections holding a lock for this model, which are the ones to patch. */
export function connectionsWithLock(
	connections: AvailabilityConnection[],
	model: string,
): AvailabilityConnection[] {
	const key = `${MODEL_LOCK_PREFIX}${model}`
	return connections.filter((connection) => Boolean(connection[key]))
}
