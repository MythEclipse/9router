import { invalid, notFound } from "../../domain/errors.ts"
import {
	activeFilterOf,
	boundConnectionCount,
	boundCountAcross,
	bulkDeleteIdsOf,
	bulkDeletionRefusal,
	deletionOutcome,
	poolDeletionRefusal,
	poolInputOf,
	poolTestView,
	poolUpdateOf,
	testResultPatch,
} from "../../domain/proxy-pool.ts"
import type { ProxyPoolRow, ProxyPoolStore } from "../providers/ports.ts"

/**
 * Proxy pools: list, create, read, update, delete, bulk delete, and test.
 *
 * The rules — what a pool must look like, and why a bound pool may not be deleted — live
 * in `domain/proxy-pool.ts`. What is here is the order the checks run in and the answers
 * each one produces.
 */

/**
 * A stored pool.
 *
 * The same row the provider create-path asks `ProxyPoolStore.exists` about — one type, two
 * readers, declared beside the port that owns it.
 */
export type StoredPool = ProxyPoolRow

/** Everything these handlers need, which the pool store already answers. */
export type ProxyPoolDeps = ProxyPoolStore

/**
 * A refusal that answers 409 with the number of connections in the way.
 *
 * A plain `conflict()` cannot carry that count, and the dashboard needs it to name what
 * has to be unbound first.
 */
export class PoolInUseError extends Error {
	readonly code = "CONFLICT"
	readonly boundConnectionCount: number

	constructor(message: string, boundConnectionCount: number) {
		super(message)
		this.name = "PoolInUseError"
		this.boundConnectionCount = boundConnectionCount
	}
}

/**
 * `GET /api/proxy-pools` — the list, optionally filtered and with usage counts.
 *
 * `includeUsage=true` counts the connections bound to each pool. It is opt-in because it
 * is a second query over every connection, and a screen that only renders names should
 * not pay for it.
 */
export async function listProxyPools(
	query: URLSearchParams,
	deps: ProxyPoolDeps,
): Promise<{ proxyPools: unknown[] }> {
	const filter: { isActive?: boolean } = {}
	const isActive = activeFilterOf(query.get("isActive"))
	if (isActive !== undefined) filter.isActive = isActive

	const pools = await deps.list(filter)
	if (query.get("includeUsage") !== "true") return { proxyPools: pools }

	const connections = await deps.boundConnections()
	return {
		proxyPools: pools.map((pool) => ({
			...pool,
			boundConnectionCount: boundConnectionCount(connections, pool.id),
		})),
	}
}

/** `POST /api/proxy-pools` — create one. */
export async function createProxyPool(
	body: Record<string, unknown>,
	deps: ProxyPoolDeps,
): Promise<{ proxyPool: StoredPool }> {
	const input = poolInputOf(body ?? {}, deps.supportedScheme)
	if ("error" in input) throw invalid(input.error)
	return { proxyPool: await deps.create({ ...input }) }
}

/** The pool with this id, or a 404. */
async function existingPool(id: string, deps: ProxyPoolDeps): Promise<StoredPool> {
	const pool = await deps.findById(id)
	if (!pool) throw notFound("Proxy pool")
	return pool
}

/** `GET /api/proxy-pools/[id]` — read one. */
export async function readProxyPool(
	id: string,
	deps: ProxyPoolDeps,
): Promise<{ proxyPool: StoredPool }> {
	return { proxyPool: await existingPool(id, deps) }
}

/**
 * `PUT /api/proxy-pools/[id]` — update the fields that were sent.
 *
 * Existence is checked before the body is validated, so a request against a deleted pool
 * answers 404 rather than complaining about its own fields — the likelier mistake is the
 * id, not the body.
 */
export async function updateProxyPool(
	id: string,
	body: Record<string, unknown>,
	deps: ProxyPoolDeps,
): Promise<{ proxyPool: StoredPool }> {
	await existingPool(id, deps)
	const { patch, refusal } = poolUpdateOf(body ?? {}, deps.supportedScheme)
	if (refusal) throw invalid(refusal)
	return { proxyPool: await deps.update(id, patch) }
}

/**
 * `DELETE /api/proxy-pools/[id]` — remove one, unless a connection still needs it.
 */
export async function deleteProxyPool(id: string, deps: ProxyPoolDeps): Promise<{ success: true }> {
	await existingPool(id, deps)
	const refusal = poolDeletionRefusal(boundConnectionCount(await deps.boundConnections(), id))
	if (refusal) throw new PoolInUseError(refusal.error, 1)
	await deps.remove(id)
	return { success: true }
}

/**
 * `DELETE /api/proxy-pools/bulk` — remove many, or every one, in a single statement.
 *
 * The id list is resolved on the server for `{ all: true }`, so "delete all" does not
 * depend on the browser having paged through the whole list first. If *any* selected pool
 * is bound, nothing is deleted: a partial delete would leave the dashboard reporting
 * success over pools that are still there, and the operator diffing the list to find out
 * which.
 */
export async function bulkDeleteProxyPools(
	body: Record<string, unknown>,
	deps: ProxyPoolDeps,
): Promise<{ deleted: string[]; deletedCount: number; missing: string[] }> {
	const allIds: string[] = body.all === true ? (await deps.list({})).map((pool) => pool.id) : []
	const ids = bulkDeleteIdsOf(body, allIds)
	if (ids.length === 0) return { deleted: [], deletedCount: 0, missing: [] }

	const bound = boundCountAcross(await deps.boundConnections(), ids)
	const refusal = bulkDeletionRefusal(bound)
	if (refusal) throw new PoolInUseError(refusal.error, bound)

	return deletionOutcome(ids, await deps.removeMany(ids))
}

/**
 * `POST /api/proxy-pools/[id]/test` — prove the egress path works, and record it.
 *
 * The test writes back: a failing pool becomes inactive so the router stops retrying a
 * path that is known broken, and `lastError` is cleared on success so the screen cannot
 * show a stale failure beside an active status.
 */
export async function testProxyPool(
	id: string,
	deps: ProxyPoolDeps,
	now: () => string = () => new Date().toISOString(),
): Promise<Record<string, unknown>> {
	const pool = await existingPool(id, deps)
	const outcome = await deps.probe(pool)
	const testedAt = now()
	await deps.update(id, testResultPatch(outcome, testedAt))
	return poolTestView(outcome, testedAt)
}
