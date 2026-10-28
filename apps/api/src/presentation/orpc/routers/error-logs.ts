/**
 * Error-log procedures.
 *
 * Validate, delegate, return. The page-size rule is in `domain/error-log.ts`
 * and the ordering in the use-case, so the REST route and this router cannot
 * disagree about what a limit means.
 */
import { z } from "zod"
import { authed } from "../base.ts"

/** Absent means "default"; the use-case decides what that is. */
const ListErrorLogsInput = z
	.object({ limit: z.union([z.string(), z.number()]).optional() })
	.optional()

export const errorLogsRouter = {
	list: authed.input(ListErrorLogsInput).handler(async ({ input, context }) => {
		return context.useCases.listErrorLogs(input?.limit)
	}),

	clear: authed.handler(async ({ context }) => context.useCases.clearErrorLogs()),
}
