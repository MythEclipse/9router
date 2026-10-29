/**
 * Per-connection quota reads: the usage panel for one provider connection.
 *
 * What lives here is the *order* of five steps, and the order is the whole point:
 *
 * 1. **Read the live token before deciding to refresh.** OpenAI rotates the refresh token on
 *    every refresh, so refreshing from a snapshot taken a moment earlier revokes the session and
 *    logs the account out. The host's `refresh` port re-reads by id before it does anything; the
 *    ordering is stated here so a second caller cannot skip it.
 * 2. **Eligibility before the network.** A connection that cannot report usage (an API key for a
 *    provider that has no quota endpoint) answers "not available" without a doomed upstream call.
 * 3. **Refresh only OAuth connections.** An API key has no token to renew, and treating it as
 *    though it might is what turned a working key into a 401.
 * 4. **A retry after refresh only when a refresh token exists.** Retrying without one repeats the
 *    same expired credential and doubles the latency of every failed read.
 * 5. **Some providers answer "expired" in a 200 body.** `authExpiryVerdict` reads that; without
 *    it the panel shows zeros for an account that merely needs a refresh.
 *
 * The `message`-shaped refusals are deliberate and kept: "not available for this provider" is a
 * 200 with a message, because the panel renders it as an explanation, not an error state.
 */
import { AppError } from "../../domain/errors.ts"

/** A refusal the route turns into its own status; `message` is shown to the user. */
export interface ConnectionRefusal {
	readonly message: string
	readonly status: number
}

export interface ConnectionUsageDeps {
	/** The stored connection, or null when the id names nothing. */
	readonly connectionOf: (connectionId: string) => Promise<ConnectionRecord | null>
	/** Provider node config, for connections that opt in to a custom quota endpoint. */
	readonly nodeOf: (provider: string) => Promise<CustomQuotaNode | null>
	/** Whether this provider reports usage through the plain API-key path. */
	readonly usageApiKeyProviders: readonly string[]
	/** Existing pure rules, supplied by the host that owns the open-sse runtime. */
	readonly isCustomQuotaProvider: (provider: string) => boolean
	readonly isOAuthConnection: (connection: ConnectionRecord) => boolean
	readonly canReadConnectionUsage: (input: {
		readonly connection: ConnectionRecord
		readonly customQuotaEnabled: boolean
		readonly usageApiKeyProviders: readonly string[]
	}) => boolean
	readonly customQuotaConnection: (
		connection: ConnectionRecord,
		node: CustomQuotaNode,
	) => ConnectionRecord
	readonly quotaProxyOptions: (config: unknown) => Record<string, unknown>
	readonly proxyConfigOf: (providerSpecificData: unknown) => Promise<unknown>
	readonly authExpiryVerdict: (input: {
		readonly usage: unknown
		readonly isOAuth: boolean
		readonly hasRefreshToken: boolean
	}) => { readonly kind: string; readonly message?: string }
	readonly refreshFailureMessage: (provider: unknown, error: unknown) => string
	/** Refreshes and persists; re-reads the row by id first (see step 1). */
	readonly refresh: (
		connection: ConnectionRecord,
		force: boolean,
		proxyOptions: Record<string, unknown>,
	) => Promise<{ readonly connection: ConnectionRecord }>
	readonly usageOf: (
		connection: ConnectionRecord,
		proxyOptions: Record<string, unknown>,
		options: { readonly force: boolean },
	) => Promise<unknown>
}

/** The fields of a stored connection this layer reads. */
export interface ConnectionRecord {
	readonly id?: string
	readonly provider: string
	readonly authType?: string
	readonly accessToken?: string
	readonly refreshToken?: string
	readonly idToken?: string
	readonly expiresAt?: string | number | null
	readonly tokenExpiresAt?: string | number | null
	readonly lastRefreshAt?: string | number | null
	readonly providerSpecificData?: unknown
}

export interface CustomQuotaNode {
	readonly quotaEnabled?: boolean
	readonly baseUrl?: string
	readonly quotaPath?: string
}

/** The provider's own answer, or a message explaining why there is none. */
export type ConnectionUsageAnswer =
	| { readonly kind: "usage"; readonly usage: unknown }
	| { readonly kind: "refusal"; readonly refusal: ConnectionRefusal }

const NOT_AVAILABLE = "Usage not available for this provider"

export function makeConnectionUsage(deps: ConnectionUsageDeps) {
	/** Resolve, gate, refresh, read — in that order, for the reasons in the file header. */
	async function readUsage(connectionId: string, force: boolean): Promise<ConnectionUsageAnswer> {
		const found = await deps.connectionOf(connectionId)
		if (!found) {
			throw new AppError("NOT_FOUND", "Connection not found", { status: 404 })
		}
		let connection = found

		let customQuotaNode: CustomQuotaNode | null = null
		if (deps.isCustomQuotaProvider(connection.provider)) {
			customQuotaNode = await deps.nodeOf(connection.provider)
			// A provider with a custom quota endpoint that the operator has not enabled reports
			// nothing rather than calling a URL it was never given.
			if (!customQuotaNode?.quotaEnabled) {
				return { kind: "refusal", refusal: { message: NOT_AVAILABLE, status: 200 } }
			}
			connection = deps.customQuotaConnection(connection, customQuotaNode)
		}

		const isOAuth = deps.isOAuthConnection(connection)
		if (
			!deps.canReadConnectionUsage({
				connection,
				customQuotaEnabled: customQuotaNode?.quotaEnabled === true,
				usageApiKeyProviders: deps.usageApiKeyProviders,
			})
		) {
			return { kind: "refusal", refusal: { message: NOT_AVAILABLE, status: 200 } }
		}

		const proxyOptions = deps.quotaProxyOptions(
			await deps.proxyConfigOf(connection.providerSpecificData),
		)

		// Only OAuth connections can be refreshed; an API key has no token to renew.
		if (isOAuth) {
			try {
				connection = (await deps.refresh(connection, false, proxyOptions)).connection
			} catch (refreshError) {
				return {
					kind: "refusal",
					refusal: {
						message: `Credential refresh failed: ${messageOf(refreshError)}`,
						status: 401,
					},
				}
			}
		}

		let usage = await deps.usageOf(connection, proxyOptions, { force })

		// Some providers answer the quota call with an "expired" body instead of a 401.
		const verdict = deps.authExpiryVerdict({
			usage,
			isOAuth,
			hasRefreshToken: Boolean(connection.refreshToken),
		})

		if (verdict.kind === "retry-after-refresh") {
			try {
				connection = (await deps.refresh(connection, true, proxyOptions)).connection
				usage = await deps.usageOf(connection, proxyOptions, { force })
			} catch (retryError) {
				// The first answer stands: a failed retry does not invalidate it.
				const warn = deps.refreshFailureMessage(connection.provider, retryError)
				if (warn) console.warn(warn)
			}
		} else if (verdict.kind === "reauthorize") {
			return {
				kind: "refusal",
				refusal: { message: verdict.message ?? "Re-authorize this connection", status: 401 },
			}
		}

		return { kind: "usage", usage }
	}

	return {
		/** GET /api/usage/[connectionId] — the provider's own quota answer. */
		readUsage,
	}
}

export type ConnectionUsage = ReturnType<typeof makeConnectionUsage>

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
