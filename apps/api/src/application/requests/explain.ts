/**
 * Explain a captured request.
 *
 * The cost is computed from the recorded token counts and the model's rates, through the same
 * pricing table the usage pages read. When either is missing the answer is `null` — a `0` here
 * would read as "this request was free", which is a different claim from "it was not priced".
 */
import { calculateCostFromTokens } from "@9router/pricing"
import type { TokenRates } from "../../domain/cost-ceiling.ts"
import { notFound } from "../../domain/errors.ts"
import type { ExplainedDetail, RequestExplanation } from "../../domain/request-explanation.ts"
import { explainRequest, tokensOf } from "../../domain/request-explanation.ts"

export interface ExplainPorts {
	readonly byId: (id: string) => Promise<ExplainedDetail | null>
	readonly ratesOf: (provider: string, model: string) => TokenRates | null
}

export interface ExplainUseCase {
	readonly explain: (id: string) => Promise<RequestExplanation>
}

export function makeExplain(ports: ExplainPorts): ExplainUseCase {
	return {
		async explain(id) {
			const detail = await ports.byId(id)
			if (!detail) throw notFound(`Request ${id}`)

			const tokens = tokensOf(detail)
			const rates = ports.ratesOf(detail.provider ?? "", detail.resolvedModel ?? detail.model ?? "")

			const cost =
				rates && Object.keys(tokens).length > 0 ? calculateCostFromTokens(tokens, rates as never) : null

			return explainRequest(detail, cost)
		},
	}
}
