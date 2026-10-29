/**
 * Pricing procedures.
 *
 * `get` is `authed`, matching the route. This docstring used to say "public at the
 * REST layer", which is not true and is worth correcting rather than deleting:
 * `dashboardGuard` denies every `/api/*` path by default, and the allow-list is short
 * — `/api/health`, `/api/init`, `/api/locale`, the `/api/auth/*` entries, `/api/theme`
 * and `/api/settings/require-login`. `/api/pricing` is not on it.
 *
 * A GET handler that never reads the session is not a public route; the guard answers
 * reachability before the handler runs. So a procedure for it must be `authed`, or the
 * oRPC channel would be weaker than the REST path it mirrors.
 *
 * `update` and `reset` are authenticated too; validation is `domain/pricing.ts`'s job.
 */
import { z } from "zod"
import { authed } from "../base.ts"

const UpdatePricingInput = z.unknown()

const ResetPricingInput = z
	.object({
		provider: z.string().nullish(),
		model: z.string().nullish(),
	})
	.optional()

export const pricingRouter = {
	get: authed.handler(async ({ context }) => context.useCases.getPricing()),

	update: authed
		.input(UpdatePricingInput)
		.handler(async ({ input, context }) => context.useCases.updatePricing(input)),

	reset: authed
		.input(ResetPricingInput)
		.handler(async ({ input, context }) =>
			context.useCases.resetPricing(input?.provider, input?.model),
		),
}
