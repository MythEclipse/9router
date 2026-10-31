/**
 * Budget pools: read them with their verdicts, replace them with a validated list.
 *
 * `save` replaces the whole list, which is the only write that cannot leave two pools claiming
 * one key. It refuses three lists rather than repairing them:
 *
 * - a key in two pools (the shared cap would be enforced twice, and the page would say a key is
 *   covered when it is covered by two contradictory numbers);
 * - a duplicate pool id (the second would silently overwrite the first);
 * - a pool without a usable cap (see `domain/budget-pool.ts`: an unenforceable cap protects
 *   nothing while looking like protection).
 *
 * The spend comes from the per-key counter the key table already reads, so a pool and the row
 * beside it cannot disagree about what a key has spent.
 */
import {
	type BudgetPool,
	capOf,
	overlappingMembers,
	type PoolVerdict,
	parsePools,
	poolVerdict,
} from "../../domain/budget-pool.ts"
import { AppError } from "../../domain/errors.ts"

export interface BudgetPoolSpend {
	readonly spendByKey: Readonly<Record<string, number>>
	readonly keyIds: readonly string[]
}

export interface BudgetPoolStore {
	readonly read: () => Promise<unknown>
	readonly write: (pools: readonly BudgetPool[]) => Promise<void>
	readonly spend: () => Promise<BudgetPoolSpend>
}

export interface BudgetPoolUseCase {
	readonly list: () => Promise<{ readonly pools: readonly PoolVerdict[] }>
	readonly save: (body: unknown) => Promise<{ readonly pools: readonly PoolVerdict[] }>
}

/** The `pools` array from a request body, or a refusal. */
function poolsFrom(body: unknown): unknown {
	if (body === null || typeof body !== "object") return body
	const record = body as Record<string, unknown>
	return "pools" in record ? record.pools : body
}

export function makeBudgetPools(store: BudgetPoolStore): BudgetPoolUseCase {
	async function verdictsOf(pools: readonly BudgetPool[]): Promise<PoolVerdict[]> {
		const { spendByKey, keyIds } = await store.spend()
		const present = new Set(keyIds)
		return pools.map((pool) => poolVerdict(pool, spendByKey, present))
	}

	return {
		async list() {
			return { pools: await verdictsOf(parsePools(await store.read())) }
		},

		async save(body: unknown) {
			const pools = parsePools(poolsFrom(body))
			const ids = new Set<string>()
			for (const pool of pools) {
				if (ids.has(pool.id)) {
					throw new AppError("CONFLICT", `Two pools share the id "${pool.id}"`, {
						status: 409,
						data: { poolId: pool.id },
					})
				}
				ids.add(pool.id)
			}
			const shared = overlappingMembers(pools)
			if (shared.length > 0) {
				throw new AppError("CONFLICT", "A key can belong to only one budget pool", {
					status: 409,
					data: { keyIds: shared },
				})
			}
			const unusable = (poolsFrom(body) as unknown[])
				?.filter?.((entry) => capOf((entry as Record<string, unknown>)?.cap) === null)
				.map((entry) => (entry as Record<string, unknown>)?.id)
			if (Array.isArray(unusable) && unusable.length > 0) {
				throw new AppError("VALIDATION", "A budget pool needs a positive cap", {
					status: 400,
					data: { poolIds: unusable },
				})
			}
			await store.write(pools)
			return { pools: await verdictsOf(pools) }
		},
	}
}
