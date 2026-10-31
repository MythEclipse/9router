/**
 * The cost-comparison panel: per-model rates, derived from the leaderboard the page already
 * renders.
 *
 * Same port as `usage.leaderboard`, deliberately. Two reads of the same aggregates with two
 * sets of scope rules is how a "cheapest model" badge ends up contradicting the table it sits
 * on, and the leaderboard is already narrowed by the session's allow-list before it gets here.
 */
import { compareModelCosts, type ModelCostComparison } from "../../domain/model-cost-comparison.ts"
import type { LeaderboardEntry } from "../../domain/usage-derivations.ts"
import type { UsageScope } from "./report-usage.ts"
import type { UsagePanels } from "./usage-panels.ts"

export interface ModelCostResult {
	readonly period: string
	readonly comparison: ModelCostComparison
}

export interface ModelCostUseCase {
	readonly comparison: (period: unknown, scope: UsageScope) => Promise<ModelCostResult>
}

export function makeModelCostComparison(deps: {
	readonly panels: Pick<UsagePanels, "leaderboard">
}): ModelCostUseCase {
	return {
		async comparison(requestedPeriod: unknown, scope: UsageScope): Promise<ModelCostResult> {
			const { period, leaderboard } = (await deps.panels.leaderboard(requestedPeriod, scope)) as {
				readonly period: string
				readonly leaderboard: readonly LeaderboardEntry[]
			}
			return { period, comparison: compareModelCosts(leaderboard) }
		},
	}
}
