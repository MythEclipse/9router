/**
 * Reading and redeeming a Codex account's rate-limit reset credits.
 *
 * The route used to hold this, and it held it twice: `GET` and `POST` repeated the same
 * resolve → prepare → call sequence, differing only in which upstream call they made. The
 * repetition was not the real problem — the real problem was that a reader had to diff two
 * forty-line handlers to be sure they agreed about when to refresh.
 *
 * The shape rule is that **every step that can refuse returns the answer, not a throw**. The
 * eligibility check, the OAuth refresh and the upstream call all speak the same union, so a
 * refusal can never be mistaken for a result and a `catch` never has to guess which layer failed.
 *
 * Both retry paths are one-shot on purpose: an expired credential is worth exactly one refresh,
 * and a second attempt after a failed refresh spends the same dead token again.
 */
import {
	canRetryAfterExpiry,
	codexEligibility,
	codexProxyOptions,
	consumeOutcome,
	isAuthExpired,
	isCodexRefusal,
} from "../../domain/codex-reset-credits.ts"

/** A connection row as the flow reads it. The domain decides what makes it eligible. */
export type CodexConnection = Record<string, unknown>

export type ProxyOptions = Record<string, unknown>

/** A connection ready to call upstream. */
interface Ready {
	readonly ok: true
	readonly connection: CodexConnection
	readonly isOAuth: boolean
	readonly proxyOptions: ProxyOptions
}

/** The answer that already settles the request. */
interface Refused {
	readonly ok: false
	readonly status: number
	readonly body: Record<string, unknown>
}

type Prepared = Ready | Refused

/** Everything this flow does to the outside world, supplied by the host. */
export interface CodexResetPort {
	readonly connection: (id: string) => Promise<CodexConnection | null | undefined>
	readonly proxyOptions: (connection: CodexConnection) => Promise<ProxyOptions>
	readonly refresh: (
		connection: CodexConnection,
		force: boolean,
		proxyOptions: ProxyOptions,
	) => Promise<{ readonly connection: CodexConnection }>
	readonly readCredits: (
		accessToken: unknown,
		proxyOptions: ProxyOptions,
		providerSpecificData: unknown,
	) => Promise<unknown>
	readonly redeemCredit: (
		accessToken: unknown,
		requestId: string,
		proxyOptions: ProxyOptions,
	) => Promise<unknown>
	/** The redeem id is server-generated so a client cannot replay one. */
	readonly newRequestId: () => string
}

export interface CodexAnswer {
	readonly status: number
	readonly body: unknown
}

const refused = (status: number, message: string): Refused => ({
	ok: false,
	status,
	body: { error: message },
})

const isRefused = (step: Prepared): step is Refused => !step.ok

const messageOf = (error: unknown): string =>
	(error as { message?: string })?.message ?? String(error)

/**
 * Resolve the row, apply the eligibility rule, and compute the proxy options.
 *
 * The eligibility rule is the domain's; this only does the reads around it.
 */
async function resolve(connectionId: unknown, port: CodexResetPort): Promise<Prepared> {
	const connection = await port.connection(String(connectionId ?? ""))
	const verdict = codexEligibility(connection)
	if (isCodexRefusal(verdict)) return refused(verdict.status, verdict.message)

	const proxyOptions = codexProxyOptions(await port.proxyOptions(connection as CodexConnection))
	return {
		ok: true,
		connection: connection as CodexConnection,
		isOAuth: verdict.isOAuth,
		proxyOptions,
	}
}

/**
 * Refresh first when the connection is OAuth, so upstream sees a live credential.
 *
 * A failed refresh is a 401 with the reason: the caller's credential is what is wrong, so telling
 * them the server broke would send them looking in the wrong place.
 */
async function prepare(ready: Ready, port: CodexResetPort): Promise<Prepared> {
	if (!ready.isOAuth) return ready
	try {
		const result = await port.refresh(ready.connection, false, ready.proxyOptions)
		return { ...ready, connection: result.connection, isOAuth: true }
	} catch (error) {
		return refused(401, `Credential refresh failed: ${messageOf(error)}`)
	}
}

/** Everything above, or the answer that settles it. */
async function prepareConnection(connectionId: unknown, port: CodexResetPort): Promise<Prepared> {
	const resolved = await resolve(connectionId, port)
	if (isRefused(resolved)) return resolved
	return prepare(resolved, port)
}

/**
 * Read the credits.
 *
 * One retry, and only when a refresh token exists to make the retry worth anything — the rule is
 * `canRetryAfterExpiry`, because "expired" is not always recoverable.
 */
export async function readResetCredits(
	connectionId: unknown,
	port: CodexResetPort,
): Promise<CodexAnswer> {
	let connection: CodexConnection | undefined
	try {
		const prepared = await prepareConnection(connectionId, port)
		if (isRefused(prepared)) return { status: prepared.status, body: prepared.body }
		connection = prepared.connection

		const { isOAuth, proxyOptions } = prepared
		try {
			const result = await port.readCredits(
				connection.accessToken,
				proxyOptions,
				connection.providerSpecificData,
			)
			return { status: 200, body: result }
		} catch (fetchError) {
			const retryable = canRetryAfterExpiry(
				isOAuth,
				Boolean(connection.refreshToken),
				isAuthExpired(fetchError),
			)
			if (!retryable) throw fetchError
			const retryResult = await port.refresh(connection, true, proxyOptions)
			connection = retryResult.connection
			const result = await port.readCredits(
				connection.accessToken,
				proxyOptions,
				connection.providerSpecificData,
			)
			return { status: 200, body: result }
		}
	} catch (error) {
		console.warn(`[Codex Reset Credits] ${connection?.provider ?? "unknown"}: ${messageOf(error)}`)
		return { status: 500, body: { error: messageOf(error) } }
	}
}

/**
 * Redeem one credit.
 *
 * The redeem id is minted here rather than accepted from the body: a client-chosen id would let a
 * caller replay a redemption. If the retry itself fails, the first upstream answer stands — it is
 * still the truthful answer, and replacing it with the refresh's failure would report the wrong
 * problem.
 */
export async function redeemResetCredit(
	connectionId: unknown,
	port: CodexResetPort,
): Promise<CodexAnswer> {
	let connection: CodexConnection | undefined
	try {
		const prepared = await prepareConnection(connectionId, port)
		if (isRefused(prepared)) return { status: prepared.status, body: prepared.body }
		connection = prepared.connection

		const { isOAuth, proxyOptions } = prepared
		const requestId = port.newRequestId()
		let result = await port.redeemCredit(connection.accessToken, requestId, proxyOptions)

		const retryable = canRetryAfterExpiry(
			isOAuth,
			Boolean(connection.refreshToken),
			isAuthExpired(result),
		)
		if (retryable) {
			try {
				const retryResult = await port.refresh(connection, true, proxyOptions)
				connection = retryResult.connection
				result = await port.redeemCredit(connection.accessToken, requestId, proxyOptions)
			} catch (retryError) {
				console.warn(`[Codex Reset Credits] force refresh failed: ${messageOf(retryError)}`)
			}
		}

		const outcome = consumeOutcome(result, requestId)
		return { status: outcome.status, body: outcome.body }
	} catch (error) {
		console.warn(`[Codex Reset Credits] ${connection?.provider ?? "unknown"}: ${messageOf(error)}`)
		return { status: 500, body: { error: messageOf(error) } }
	}
}
