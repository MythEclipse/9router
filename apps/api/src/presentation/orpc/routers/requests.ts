import { z } from "zod"
import { authed } from "../base.ts"

/**
 * What the observability log can tell you about a request after the fact.
 *
 * `explain` reads the stored row and reports the pipeline, the field-level diff between the
 * client body and the provider body, and the cost — never a cause the row does not record.
 * `export` turns a selection of rows into a translator test file, so a real failure becomes a
 * regression case instead of a screenshot in a chat.
 */
export const requestsRouter = {
	explain: authed
		.input(z.object({ id: z.string().min(1) }))
		.handler(async ({ input, context }) => context.useCases.explain.explain(input.id)),

	export: authed
		.input(
			z.object({
				ids: z.array(z.string()).max(50).optional(),
				recent: z.number().int().min(1).max(50).optional(),
			}),
		)
		.handler(async ({ input, context }) => {
			const ids = input.ids ?? []
			if (ids.length > 0) return context.useCases.replay.fromIds(ids)
			return context.useCases.replay.fromRecent(input.recent ?? 10)
		}),
}
