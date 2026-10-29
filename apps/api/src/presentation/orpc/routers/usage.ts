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
import { ORPCError } from "@orpc/server"
import { z } from "zod"
import { usageScopeOf } from "../../../application/usage/report-usage.ts"
import { canReadFullRequestPayload } from "../../../domain/observability.ts"
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

	/** One row per API key: quota state plus request/token/cost aggregates. */
	apiKeys: authed.handler(async ({ context }) => {
		const scope = usageScopeOf(context.session)
		return context.useCases.keyUsage.report(context.session, scope.apiKeyFilter)
	}),

	/** Error counts folded by class, inside the caller's scope. */
	errors: authed
		.input(PeriodInput)
		.handler(async ({ input, context }) =>
			context.useCases.usagePanels.errors(input?.period, usageScopeOf(context.session)),
		),

	/** Per-model totals, best first. */
	leaderboard: authed
		.input(PeriodInput)
		.handler(async ({ input, context }) =>
			context.useCases.usagePanels.leaderboard(input?.period, usageScopeOf(context.session)),
		),

	/** The providers the usage filter may offer this session. */
	providers: authed.handler(async ({ context }) =>
		context.useCases.usagePanels.providers(usageScopeOf(context.session)),
	),

	/** What Token Saver avoided over the period. */
	tokenSavings: authed
		.input(PeriodInput)
		.handler(async ({ input, context }) => context.useCases.usagePanels.tokenSavings(input?.period)),

	/** The model catalogue narrowed to what the signing-in key may call. */
	availableModels: authed.handler(async ({ context }) =>
		context.useCases.usagePanels.availableModels(context.session, usageScopeOf(context.session)),
	),

	/** One page of stored request details, payloads redacted per the settings rule. */
	requestDetails: authed
		.input(
			z
				.object({
					page: z.string().optional(),
					pageSize: z.string().optional(),
					provider: z.string().optional(),
					model: z.string().optional(),
					connectionId: z.string().optional(),
					status: z.string().optional(),
					startDate: z.string().optional(),
					endDate: z.string().optional(),
				})
				.optional(),
		)
		.handler(async ({ input, context }) =>
			context.useCases.usagePanels.requestDetails(
				input ?? {},
				usageScopeOf(context.session),
				// A key session is never "request authenticated" for payload purposes; the
				// use-case consults this only when the gateway runs with login disabled.
				Boolean(context.session),
			),
		),

	/** One connection's own quota answer, from the provider. */
	connection: authed
		.input(z.object({ connectionId: z.string(), force: z.boolean().optional() }))
		.handler(async ({ input, context }) =>
			context.useCases.connectionUsage.readUsage(input.connectionId, input.force === true),
		),

	/** A single stored request with its full payload — password sessions only. */
	requestDetail: authed.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
		if (!canReadFullRequestPayload(context.session?.role ?? null)) {
			throw new ORPCError("FORBIDDEN", {
				message: "Only a password sign-in can read a full request payload",
			})
		}
		return context.useCases.usagePanels.requestDetailById(input.id)
	}),
}
