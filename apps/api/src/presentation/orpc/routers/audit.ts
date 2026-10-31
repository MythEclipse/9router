/**
 * The audit trail, as the dashboard reads it.
 *
 * One procedure: the log is append-only, so there is nothing to write here. `limit` arrives as a
 * string because it comes from a query parameter; the rule that turns it into a page size (and
 * refuses `?limit=abc`) lives in `domain/audit-log.ts`.
 */
import { z } from "zod"
import { authed } from "../base.ts"

const LimitInput = z.object({ limit: z.string().optional() }).optional()

export const auditRouter = {
	list: authed
		.input(LimitInput)
		.handler(async ({ input, context }) => context.useCases.auditLog.list(input?.limit)),
}
