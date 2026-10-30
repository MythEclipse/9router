/**
 * Importing a Kiro CLI proxy auth blob as a provider connection.
 *
 * Every decision here was already in `domain/kiro-import` — which envelopes to look in, what a
 * refusal says, what the summary shows. What was left in the route was the *assembly*: normalise
 * the token, then ask the store to create the connection. That assembly is the use-case, and it is
 * here so a test can drive it without a Next request or a database.
 *
 * The answer carries `ok` because that is what the OAuth procedures speak: `orRefuse` reads it and
 * turns a non-ok answer into an error carrying the provider's own status, so a refused paste
 * reaches the panel with its reason instead of "internal error".
 */
import {
	KIRO_IMPORT_REFUSAL_STATUS,
	kiroImportPayload,
	kiroImportRefusalMessage,
	kiroImportSummary,
} from "../../domain/kiro-import.ts"

/** What a Kiro auth blob carries, after normalisation. */
export interface KiroToken {
	readonly accessToken: string
	readonly refreshToken: string
	readonly expiresAt: string | null
	readonly email?: string | null
	readonly providerSpecificData?: Record<string, unknown>
}

export interface KiroImportDependencies {
	/** Turns a raw auth blob into a token, or throws with a message worth showing. */
	readonly normalise: (raw: unknown) => KiroToken
	/** The store's create, which answers with the new row's id and nothing else. */
	readonly createConnection: (input: Record<string, unknown>) => Promise<{ id: string }>
}

/** What the host supplies once, at wiring time; the store call is added by the use-cases. */
export type KiroNormaliseDeps = Pick<KiroImportDependencies, "normalise">

/**
 * What the store wrote, on success.
 *
 * There is no failure variant: a refusal is thrown by the caller through `orRefuse`, which reads
 * `ok`/`status`/`error`. Spelling the union here as well would give two ways to say "refused" and
 * a route that had to check for a case its own procedure had already turned into an exception.
 */
export type KiroImportAnswer = ReturnType<typeof kiroImportSummary>

/**
 * The row this import writes.
 *
 * `testStatus: "active"` is not optimism: the CLI minted this token and validated it when it
 * wrote it, so a live probe here would add a failure mode without adding information.
 */
const connectionRow = (token: KiroToken): Record<string, unknown> => ({
	provider: "kiro",
	authType: "oauth",
	accessToken: token.accessToken,
	refreshToken: token.refreshToken,
	expiresAt: token.expiresAt,
	email: token.email || null,
	providerSpecificData: token.providerSpecificData,
	testStatus: "active",
})

/**
 * Import the blob, or refuse with a status the panel can show.
 *
 * The refusal is a *value*, not an exception, at this layer: `orRefuse` in the procedure is what
 * turns it into an `AppError`, and doing it here would hide the status from every other caller.
 */
export async function importKiroCliAuth(
	body: unknown,
	deps: KiroImportDependencies,
): Promise<KiroImportOutcome> {
	try {
		const token = deps.normalise(kiroImportPayload(body))
		const connection = await deps.createConnection(connectionRow(token))
		return kiroImportSummary({ provider: "kiro", ...connection })
	} catch (error) {
		// One refusal status for both "this is not a Kiro auth blob" and "the store refused it",
		// because both are the same fix for the operator: paste it again.
		return {
			ok: false,
			status: KIRO_IMPORT_REFUSAL_STATUS,
			error: kiroImportRefusalMessage(error),
		}
	}
}

/** The full outcome, before `orRefuse` decides which half matters. */
/**
 * Success is the summary alone — the shape the route has always answered, so nothing downstream
 * changes. A refusal is a separate variant carrying the status the provider gave.
 */
export type KiroImportOutcome =
	| KiroImportAnswer
	| { readonly ok: false; readonly status: number; readonly error: string }
