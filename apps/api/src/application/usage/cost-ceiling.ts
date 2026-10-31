/**
 * Preflight for a per-key spending ceiling.
 *
 * The budget is read through the same `budgetOf` port the key list renders, so the number this
 * answers with and the number on the dashboard cannot disagree. A budget denominated in tokens
 * is refused rather than converted: there is no exchange rate between tokens and dollars, and
 * inventing one would answer a question about money with a number about tokens.
 */
import {
	type CeilingAnswer,
	ceilingAnswer,
	type RequestEstimate,
	type TokenRates,
} from "../../domain/cost-ceiling.ts"

export interface CeilingPorts {
	/** The key's budget, as the key list reports it. */
	readonly budgetOf: (keyId: string) => Promise<{ kind: string; cap: number; used: number } | null>
	/** Rates for a provider/model pair, or `null` when the model is unpriced. */
	readonly ratesOf: (provider: string, model: string) => TokenRates | null
}

export interface CeilingQuestion {
	readonly keyId: string
	readonly provider: string
	readonly model: string
	readonly estimate: RequestEstimate
}

export interface CostCeilingUseCase {
	readonly check: (question: CeilingQuestion) => Promise<CeilingAnswer>
}

export function makeCostCeiling(ports: CeilingPorts): CostCeilingUseCase {
	return {
		async check(question) {
			const rates = ports.ratesOf(question.provider, question.model)
			const budget = await ports.budgetOf(question.keyId)

			if (budget && budget.kind !== "usd") {
				return {
					verdict: "unknown",
					reason: `this key's budget is measured in ${budget.kind}, not dollars`,
					estimateUsd: null,
					capUsd: null,
					usedUsd: 0,
					headroomUsd: null,
					afterUsd: null,
				}
			}

			return ceilingAnswer({
				estimate: question.estimate,
				rates,
				capUsd: budget?.cap,
				usedUsd: budget?.used,
			})
		},
	}
}
