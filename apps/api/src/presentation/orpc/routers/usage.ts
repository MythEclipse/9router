/**
 * Usage-reporting procedures.
 *
 * Read-only, and narrowed to whoever is asking. The period rule, the CSV shaping
 * and the log limit live in `domain/` and the use-case, so the REST routes and this
 * router answer identically — including refusing `?period=90d` instead of quietly
 * returning a week.
 *
 * The scope comes from the session, not from a constant. It used to be
 * `{ apiKeyFilter: null, allowedModels: "*" }`, with a note that a caller here is
 * always a password session — true only of the transport that existed then, and
 * false the moment the dashboard calls this router with an API-key session. A
 * constant that widens a caller's view is the one kind of default that must not be
 * written down; `usageScopeOf` reads the claims and decides.
 */
import { z } from "zod"
import { usageScopeOf } from "../../../application/usage/report-usage.ts"
import { authed } from "../base.ts"

/** Absent means "the endpoint's own default"; the rule decides which. */
const PeriodInput = z.object({ period: z.string().optional() }).optional()

const HistoryInput = z.object({ format: z.string().optional() }).optional()

export const usageRouter = {
	stats: authed
		.input(PeriodInput)
		.handler(async ({ input, context }) =>
			context.useCases.usageReports.stats(input?.period, usageScopeOf(context.session)),
		),

	chart: authed
		.input(PeriodInput)
		.handler(async ({ input, context }) =>
			context.useCases.usageReports.chart(input?.period, usageScopeOf(context.session)),
		),

	sparks: authed
		.input(PeriodInput)
		.handler(async ({ input, context }) =>
			context.useCases.usageReports.sparks(input?.period, usageScopeOf(context.session)),
		),

	logs: authed.handler(async ({ context }) => context.useCases.usageReports.logs()),

	history: authed
		.input(HistoryInput)
		.handler(async ({ input, context }) =>
			context.useCases.usageReports.history(input?.format, usageScopeOf(context.session)),
		),
}
