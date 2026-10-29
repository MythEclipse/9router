/**
 * Usage-reporting procedures.
 *
 * Read-only, and scoped to the caller. The period rule, the CSV shaping and the
 * log limit are all in `domain/` and the use-case, so the REST routes and this
 * router answer identically — including refusing `?period=90d` instead of
 * quietly returning a week.
 *
 * This transport authenticates with better-auth, so a caller here is a password
 * session and sees every key; the per-key filter exists on the REST route, where
 * an API key can be the caller.
 */
import { z } from "zod"

import { authed } from "../base.ts"

/** Absent means "the endpoint's own default"; the rule decides which. */
const PeriodInput = z.object({ period: z.string().optional() }).optional()

const HistoryInput = z.object({ format: z.string().optional() }).optional()

const scope = { apiKeyFilter: null, allowedModels: "*" } as const

export const usageRouter = {
	stats: authed
		.input(PeriodInput)
		.handler(async ({ input, context }) => context.useCases.usageReports.stats(input?.period, scope)),

	chart: authed
		.input(PeriodInput)
		.handler(async ({ input, context }) => context.useCases.usageReports.chart(input?.period, scope)),

	sparks: authed
		.input(PeriodInput)
		.handler(async ({ input, context }) =>
			context.useCases.usageReports.sparks(input?.period, scope),
		),

	logs: authed.handler(async ({ context }) => context.useCases.usageReports.logs()),

	history: authed
		.input(HistoryInput)
		.handler(async ({ input, context }) =>
			context.useCases.usageReports.history(input?.format, scope),
		),
}
