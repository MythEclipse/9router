/**
 * Shared budget pools: what a group of keys may spend together.
 *
 * The arithmetic is small and the ways to get it wrong are not:
 *
 * 1. **A member of two pools is counted twice.** Two pools each reporting the same spend is
 *    not a display bug — it is two caps silently protecting one key, which is worse than no
 *    pool at all because the page says it is covered. `overlappingMembers` reports them and
 *    `save` refuses the list.
 * 2. **A member that no longer exists still counts.** Keys are deleted while pools are not;
 *    dropping the unknown id would quietly free its share of the cap. The member is kept in
 *    the verdict with a spend of zero and reported as `missing`.
 * 3. **A zero or negative cap reads as "unlimited".** `used / cap` is `Infinity` and the bar
 *    renders full; `exhausted` would then be true for every pool the moment it is created. A
 *    cap that is not a positive finite number is refused at the boundary instead.
 */

export interface BudgetPool {
	readonly id: string
	readonly name: string
	readonly cap: number
	readonly members: readonly string[]
}

/** One member's contribution to its pool. */
export interface PoolMemberSpend {
	readonly keyId: string
	readonly spent: number
	/** False when the key id is no longer in the key table. */
	readonly present: boolean
}

export interface PoolVerdict {
	readonly id: string
	readonly name: string
	readonly cap: number
	readonly used: number
	readonly remaining: number
	/** Progress in `[0, 1]`; clamped so an overspent pool does not render past its bar. */
	readonly fraction: number
	readonly exhausted: boolean
	readonly members: readonly PoolMemberSpend[]
}

/** A finite, non-negative amount, or zero. */
function amountOf(value: unknown): number {
	const amount = typeof value === "number" ? value : Number(value)
	return Number.isFinite(amount) && amount > 0 ? amount : 0
}

/** A cap that can be enforced, or `null`. */
export function capOf(value: unknown): number | null {
	const cap = typeof value === "number" ? value : Number(value)
	return Number.isFinite(cap) && cap > 0 ? cap : null
}

/**
 * The pools a stored blob actually contains.
 *
 * Unusable rows are dropped rather than repaired: a pool with no cap or no id cannot be
 * enforced, and inventing a default cap would protect nothing while claiming to.
 */
export function parsePools(raw: unknown): BudgetPool[] {
	if (!Array.isArray(raw)) return []
	const pools: BudgetPool[] = []
	for (const entry of raw) {
		if (entry === null || typeof entry !== "object") continue
		const record = entry as Record<string, unknown>
		const id = typeof record.id === "string" ? record.id.trim() : ""
		const cap = capOf(record.cap)
		if (!id || cap === null) continue
		const members = Array.isArray(record.members)
			? record.members.filter((member): member is string => typeof member === "string" && !!member)
			: []
		pools.push({
			id,
			name: typeof record.name === "string" && record.name.trim() ? record.name : id,
			cap,
			members: [...new Set(members)],
		})
	}
	return pools
}

/** Key ids that appear in more than one pool. */
export function overlappingMembers(pools: readonly BudgetPool[]): string[] {
	const seen = new Set<string>()
	const twice = new Set<string>()
	for (const pool of pools) {
		for (const member of pool.members) {
			if (seen.has(member)) twice.add(member)
			seen.add(member)
		}
	}
	return [...twice].sort()
}

/**
 * One pool's verdict against the spend of its members.
 *
 * `spendByKey` is the per-key counter the key table already reads, so a pool and the key row
 * cannot disagree about how much a key has spent.
 */
export function poolVerdict(
	pool: BudgetPool,
	spendByKey: Readonly<Record<string, number>>,
	presentKeys: ReadonlySet<string>,
): PoolVerdict {
	const members = pool.members.map((keyId) => ({
		keyId,
		spent: amountOf(spendByKey[keyId]),
		present: presentKeys.has(keyId),
	}))
	const used = members.reduce((sum, member) => sum + member.spent, 0)
	return {
		id: pool.id,
		name: pool.name,
		cap: pool.cap,
		used,
		remaining: pool.cap - used,
		fraction: Math.min(1, used / pool.cap),
		exhausted: used >= pool.cap,
		members,
	}
}
