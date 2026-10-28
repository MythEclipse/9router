/**
 * Pricing procedures.
 *
 * `get` is public at the REST layer (the dashboard reads the table before it
 * can render costs). `update` and `reset` are authenticated; validation is
 * `domain/pricing.ts`'s job.
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
