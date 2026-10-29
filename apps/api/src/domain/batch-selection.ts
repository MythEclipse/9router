/**
 * Which connections a batch test covers.
 *
 * Called from:
 *   - `apps/api/src/application/providers/test-connections.ts` (`selectConnections`,
 *     `isSupportedMode`, `unsupportedModeMessage`, `authGroupOf`)
 *   - `apps/api/src/application/providers/list-client-connections.ts` (nothing — the
 *     client listing does not group)
 *   - `tests/unit/domain-batch-selection.test.ts`
 *
 * No existing file serves this purpose: `providers/test-batch/route.ts` held the
 * grouping as an inline `if/else` chain of filters, and `domain/model-probe.ts`
 * decides *how* to probe, not *which* connections are in scope.
 *
 * Reads: a connection's `provider` and `authType` (no writes). Writes nothing.
 *
 * User instruction, verbatim: "lanjut kenapa malah berhenti".
 */

/** The groups a batch test can select. `provider` narrows to one id instead. */
export type AuthGroup = "oauth" | "free" | "apikey" | "compatible"

/** Every mode the endpoint accepts, in the order it is documented. */
export const BATCH_MODES = ["provider", "oauth", "free", "apikey", "compatible", "all"] as const

export type BatchMode = (typeof BATCH_MODES)[number]

/** True when the request names a mode this endpoint can serve. */
export function isSupportedMode(mode: string): mode is BatchMode {
	return (BATCH_MODES as readonly string[]).includes(mode)
}

/**
 * The message a rejected mode produces.
 *
 * Built from `BATCH_MODES` so the list in the error cannot drift from the list
 * the endpoint accepts — the route spelled the six modes out by hand, and a
 * seventh would have been accepted while the error still named six.
 */
export function unsupportedModeMessage(): string {
	return `Invalid mode. Use: ${BATCH_MODES.join(", ")}`
}

/** What the catalogue has to answer before a group can be assigned. */
export interface ProviderClassifiers {
	readonly isFree: (provider: string) => boolean
	readonly isOAuth: (provider: string) => boolean
	readonly isApiKey: (provider: string) => boolean
	readonly isCompatible: (provider: string) => boolean
}

/** The only connection fields the grouping rule reads. */
export interface GroupableConnection {
	readonly id: string
	readonly provider: string
	readonly authType?: string | null
}

/**
 * A stored `authType` squeezed into a group.
 *
 * Providers store more auth types than the four groups name — `cookie` is a real
 * value — and the route returned them verbatim, so `authType: "cookie"` filed a
 * connection under a group no mode selects and it silently never got tested.
 * Anything that is not OAuth is keyed: the probe's own split is "OAuth or not",
 * so a cookie connection is probed as an api-key connection and belongs beside
 * them.
 */
function asAuthGroup(authType: string): AuthGroup {
	return authType === "oauth" ? "oauth" : "apikey"
}

/**
 * The group one connection belongs to.
 *
 * A stored `authType` wins over the registry, with one twist the route already
 * had and which is easy to lose in a rewrite: an OAuth account belonging to a
 * free provider is `free`, not `oauth`. The two groups are separate buttons in
 * the dashboard, and a free-tier OAuth account belongs to the free one.
 */
export function authGroupOf(
	connection: GroupableConnection,
	classifiers: ProviderClassifiers,
): AuthGroup {
	const { provider } = connection
	if (connection.authType === "oauth") {
		return classifiers.isFree(provider) ? "free" : "oauth"
	}
	if (connection.authType) return asAuthGroup(connection.authType)
	if (classifiers.isFree(provider)) return "free"
	if (classifiers.isOAuth(provider)) return "oauth"
	if (classifiers.isApiKey(provider)) return "apikey"
	if (classifiers.isCompatible(provider)) return "compatible"
	return "apikey"
}

/** Whether one connection is in scope for the requested mode. */
export function matchesMode(
	connection: GroupableConnection,
	mode: BatchMode,
	classifiers: ProviderClassifiers,
	providerId?: string,
): boolean {
	if (mode === "all") return true
	if (mode === "provider") return providerId !== undefined && connection.provider === providerId
	if (mode === "compatible") return classifiers.isCompatible(connection.provider)
	return authGroupOf(connection, classifiers) === mode
}

/**
 * The connections a batch run should test.
 *
 * `provider` mode without a provider id selects nothing, which is what the
 * route did: `mode: "provider"` with no `providerId` fell through every branch
 * and returned an empty run rather than an error. That is a client bug, not an
 * operator mistake, so an empty result is the honest answer.
 */
export function selectConnections<T extends GroupableConnection>(
	connections: readonly T[],
	request: { readonly mode: BatchMode; readonly providerId?: string },
	classifiers: ProviderClassifiers,
): T[] {
	return connections.filter((connection) =>
		matchesMode(connection, request.mode, classifiers, request.providerId),
	)
}
