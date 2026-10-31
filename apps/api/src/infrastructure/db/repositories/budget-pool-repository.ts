/**
 * The two reads and one write the budget-pool use-case needs.
 *
 * Spend is taken from the key row's own counter (`costSpent` / `usedTokens`), which is what the
 * key table renders and what the per-key cap is enforced against — not from the usage log,
 * which is pruned. A pool that summed the log would report less than the key it groups.
 */
import { getApiKeys } from "@9router/db/repos/apiKeysRepo"
import { getBudgetPools, saveBudgetPools } from "@9router/db/repos/budgetPoolsRepo"
import type { BudgetPoolStore } from "../../../application/usage/budget-pools.ts"

export function budgetPoolStore(): BudgetPoolStore {
	return {
		read: async () => await getBudgetPools(),
		write: async (pools) => await saveBudgetPools(pools),
		spend: async () => {
			const keys = await getApiKeys()
			const spendByKey: Record<string, number> = {}
			for (const key of keys) {
				// `limitKind` decides which counter the key enforces; the pool sums the same one.
				spendByKey[key.id] =
					key.limitKind === "tokens"
						? Number(key.usedTokens) || 0
						: key.limitKind === "requests"
							? Number(key.usedRequests) || 0
							: Number(key.costSpent) || 0
			}
			return { spendByKey, keyIds: keys.map((key) => key.id) }
		},
	}
}
