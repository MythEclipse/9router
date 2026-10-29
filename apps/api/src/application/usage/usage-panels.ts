/**
 * The remaining usage panels: error classification, model leaderboard, the provider filter,
 * token savings, the available-model catalogue, and request details.
 *
 * Six routes, six different payloads, one shared defect between the first two: **the period was
 * validated in a way that could not fail.** `errors` and `leaderboard` carried their own copy of
 * `resolvePeriod` + `periodCutoff` + the two-condition WHERE clause, and `leaderboard` labelled a
 * refused period `garbage` while cutting off at seven days — a wrong answer presented as a valid
 * one. Sharing the sequence makes the refusal reach the caller as a 400 with the rule's wording.
 *
 * The scope rule (`apiKeyFilter` + `allowedModels`) is applied to the SQL *and* to the rows,
 * because `usageHistory` stores a provider's spelling of a model and the allow-list is written in
 * the caller's. Narrowing only in SQL lets a model through when the two disagree; narrowing only
 * in memory reads every row to discard most. The ports take both.
 */
import { AppError } from "../../domain/errors.ts"
import {
	DEFAULT_PERIOD,
	isPeriodRefused,
	type ReportingPeriod,
	resolvePeriod,
} from "../../domain/reporting-period.ts"
import { buildLeaderboard, classifyErrors } from "../../domain/usage-derivations.ts"
import type { UsageScope } from "./report-usage.ts"

/** A period the caller asked for, or the refusal its rule already worded. */
function requirePeriod(
	requested: unknown,
	fallback: ReportingPeriod = DEFAULT_PERIOD,
): ReportingPeriod {
	const resolved = resolvePeriod(requested, fallback)
	if (isPeriodRefused(resolved)) {
		throw new AppError("VALIDATION", resolved.message, { status: 400 })
	}
	return resolved.period
}

/** One page of stored request details, and whether its payloads were included. */
export interface RequestDetailsQuery {
	readonly page?: string | null
	readonly pageSize?: string | null
	readonly provider?: string | null
	readonly model?: string | null
	readonly connectionId?: string | null
	readonly status?: string | null
	readonly startDate?: string | null
	readonly endDate?: string | null
}

export interface UsagePanelDeps {
	/**
	 * The raw aggregate rows, already narrowed in SQL by the caller's scope.
	 *
	 * Supplied by the infrastructure factory rather than the host: they read the shared
	 * database. Optional so the host's object states only what the host knows.
	 */
	readonly errorRows?: (input: {
		readonly period: ReportingPeriod
		readonly now: Date
		readonly scope: UsageScope
	}) => Promise<readonly unknown[]>
	readonly leaderboardRows?: (input: {
		readonly period: ReportingPeriod
		readonly now: Date
		readonly scope: UsageScope
	}) => Promise<readonly unknown[]>
	/** Models the session's allow-list admits, for the in-memory half of the scope rule. */
	readonly admitsModel: (allowedModels: string, model: string) => boolean
	/** The distinct providers that served this scope's traffic. */
	readonly distinctProviders: (allowedModels: string) => Promise<readonly unknown[]>
	/** Provider labels: stored nodes plus the static catalogue. */
	readonly providerLabels: () => Promise<{
		readonly nodes: Readonly<Record<string, { name: string; logo?: string }>> | null | undefined
		readonly catalogueOf: (id: string) => unknown
	}>
	readonly tokenSavings: (period: string) => Promise<unknown>
	/** The full model catalogue before narrowing, and the two narrowing steps. */
	readonly availableModels: (scope: {
		readonly allowedModels: string
		readonly isApiKey: boolean
	}) => Promise<unknown>
	readonly requestDetails: (input: {
		readonly query: RequestDetailsQuery
		readonly scope: UsageScope
		readonly requestAuthenticated: boolean
	}) => Promise<unknown>
	/** One stored request with its full payload. The caller has already checked the role. */
	readonly requestDetailById: (id: string) => Promise<unknown>
}

export interface UsagePanels {
	readonly errors: (period: unknown, scope: UsageScope) => Promise<unknown>
	readonly leaderboard: (period: unknown, scope: UsageScope) => Promise<unknown>
	readonly providers: (scope: UsageScope) => Promise<unknown>
	readonly tokenSavings: (period: unknown) => Promise<unknown>
	readonly availableModels: (
		session: { readonly role?: unknown } | null,
		scope: UsageScope,
	) => Promise<unknown>
	readonly requestDetails: (
		query: RequestDetailsQuery,
		scope: UsageScope,
		requestAuthenticated: boolean,
	) => Promise<unknown>
	readonly requestDetailById: (id: string) => Promise<unknown>
}

export function makeUsagePanels(deps: UsagePanelDeps): UsagePanels {
	// A missing query port is a wiring fault, not an empty panel: see the note on the key report.
	const errorRows = deps.errorRows
	const leaderboardRows = deps.leaderboardRows

	return {
		/** Error counts folded by class, over the period, inside the caller's scope. */
		async errors(requestedPeriod: unknown, scope: UsageScope) {
			const period = requirePeriod(requestedPeriod)
			if (!errorRows) throw new AppError("INTERNAL", "usagePanels.errorRows was not supplied")
			const rows = await errorRows({ period, now: new Date(), scope })
			const classified = classifyErrors(rows as Parameters<typeof classifyErrors>[0], (model) =>
				deps.admitsModel(scope.allowedModels, model),
			)
			return { period, ...classified }
		},

		/** Per-model request/token/cost totals, best first. */
		async leaderboard(requestedPeriod: unknown, scope: UsageScope) {
			const period = requirePeriod(requestedPeriod)
			if (!leaderboardRows) {
				throw new AppError("INTERNAL", "usagePanels.leaderboardRows was not supplied")
			}
			const rows = await leaderboardRows({ period, now: new Date(), scope })
			const leaderboard = buildLeaderboard(rows as Parameters<typeof buildLeaderboard>[0], (model) =>
				deps.admitsModel(scope.allowedModels, model),
			)
			return { period, leaderboard }
		},

		/**
		 * The providers the filter may offer.
		 *
		 * An API-key session sees only providers that served one of its allowed models, so the
		 * filter cannot be used to enumerate unrelated providers. The narrowing happens in SQL —
		 * parsing each row's JSON blob is what used to exhaust memory here.
		 */
		async providers(scope: UsageScope) {
			const ids = await deps.distinctProviders(scope.allowedModels)
			const labels = await deps.providerLabels()
			const { providerOptions } = await import("../../domain/provider-options.ts")
			return { providers: providerOptions(ids, labels.nodes, labels.catalogueOf) }
		},

		async tokenSavings(requestedPeriod: unknown) {
			const period =
				typeof requestedPeriod === "string" && requestedPeriod ? requestedPeriod : DEFAULT_PERIOD
			// Token savings keeps its own default and does not refuse an unknown period: the table
			// it reads is a rollup, not a per-period query, so a typo costs a wider window and not
			// a wrong answer presented as a right one.
			return deps.tokenSavings(period)
		},

		/** The catalogue, narrowed to what the signing-in key may actually call. */
		async availableModels(session: { readonly role?: unknown } | null, scope: UsageScope) {
			return deps.availableModels({
				allowedModels: scope.allowedModels,
				isApiKey: session?.role === "apikey",
			})
		},

		/** One page of request details, payloads redacted unless the rule allows otherwise. */
		async requestDetails(
			query: RequestDetailsQuery,
			scope: UsageScope,
			requestAuthenticated: boolean,
		) {
			return deps.requestDetails({ query, scope, requestAuthenticated })
		},

		/**
		 * One record, in full.
		 *
		 * The listing redacts every conversation payload; this exists for the administrator
		 * asking "what did this request actually send". The role check is
		 * `canReadFullRequestPayload` in the router, which owns the same rule the listing's
		 * redaction consults — so the two cannot disagree about who may read a conversation.
		 */
		async requestDetailById(id: string) {
			const detail = await deps.requestDetailById(id)
			if (!detail) throw new AppError("NOT_FOUND", "Request not found", { status: 404 })
			return { detail }
		},
	}
}

export type UsagePanelUseCases = UsagePanels
