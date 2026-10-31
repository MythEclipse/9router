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

	/**
	 * What the current daily rate projects for the period, and when a cap runs out.
	 *
	 * `cap` is optional because projecting spend and projecting exhaustion are two questions:
	 * the overview card asks the first, the key table asks the second. A cap that is absent is
	 * passed as `null`, never as `0` — `0` is a cap that is already spent, which would report
	 * every key as exhausted the moment the caller forgot the parameter.
	 */
	forecast: authed
		.input(
			z.object({ period: z.string().optional(), cap: z.number().positive().optional() }).optional(),
		)
		.handler(async ({ input, context }) =>
			context.useCases.spendForecast.forecast(
				input?.period,
				usageScopeOf(context.session),
				input?.cap ?? null,
			),
		),

	/** Cost per request and per million tokens, per model: what it costs to *run*, not to have run. */
	modelComparison: authed
		.input(PeriodInput)
		.handler(async ({ input, context }) =>
			context.useCases.modelCost.comparison(input?.period, usageScopeOf(context.session)),
		),

	/** Shared caps across several API keys. Replaces the whole list on write. */
	pools: {
		list: authed.handler(async ({ context }) => context.useCases.budgetPools.list()),
		save: authed
			.input(z.object({ pools: z.array(z.unknown()) }))
			.handler(async ({ input, context }) => context.useCases.budgetPools.save(input)),
	},

	/** The Prometheus scrape, under the same scope rules as every other usage read. */
	metrics: authed
		.input(PeriodInput)
		.handler(async ({ input, context }) =>
			context.useCases.metrics.exposition(input?.period, usageScopeOf(context.session)),
		),

	/**
	 * Preflight: would this request fit under the key's spending ceiling?
	 *
	 * Advisory, and deliberately so: the gateway cannot price a request it has not received
	 * tokens for. A client that asks first can shrink its own request instead of collecting a
	 * refusal halfway through a stream.
	 */
	ceiling: authed
		.input(
			z.object({
				keyId: z.string().min(1),
				provider: z.string().min(1),
				model: z.string().min(1),
				promptTokens: z.number().nullish(),
				completionTokens: z.number().nullish(),
				cachedTokens: z.number().nullish(),
			}),
		)
		.handler(async ({ input, context }) =>
			context.useCases.costCeiling.check({
				keyId: input.keyId,
				provider: input.provider,
				model: input.model,
				estimate: {
					promptTokens: input.promptTokens,
					completionTokens: input.completionTokens,
					cachedTokens: input.cachedTokens,
				},
			}),
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
					// `nullish`, not `optional`: `searchParams.get()` answers `null` for an absent
					// query parameter, and a route that forwards it must not fail validation for
					// the ordinary case of "the operator did not filter".
					page: z.string().nullish(),
					pageSize: z.string().nullish(),
					provider: z.string().nullish(),
					model: z.string().nullish(),
					connectionId: z.string().nullish(),
					status: z.string().nullish(),
					startDate: z.string().nullish(),
					endDate: z.string().nullish(),
				})
				.nullish(),
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
