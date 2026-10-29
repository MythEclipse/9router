/**
 * Which connection a finished web login belongs to.
 *
 * Called from:
 *   - `apps/api/src/application/providers/web-login.ts` (all exports)
 *   - `tests/unit/domain-web-login.test.ts`
 *
 * No existing file serves this purpose: the matching rule lived inline in
 * `apps/web/src/app/api/providers/web-login/route.ts`, spread across an `if/else`
 * and a duplicate-cleanup loop. `domain/provider-connection.ts` decides how a
 * connection is written, not which one a login belongs to.
 *
 * Reads: a connection's `id`, `email`, `updatedAt`, `providerSpecificData`; and an
 * identity probe's `status`/`email`/`error`. Writes nothing.
 *
 * User instruction, verbatim: "lanjut kenapa malah berhenti".
 *
 * A web login harvests a cookie from a real browser session and stores it as a
 * connection. The hard part is not the harvest, it is the *matching*: the same
 * person logging in twice must refresh one row, and a second account must not
 * overwrite the first.
 *
 * The rules were each defensible but none was written down:
 *
 *   - match by email when the provider reveals one, so a second Google account
 *     keeps its own row;
 *   - when it reveals none, adopt the single web-login row this button created —
 *     but only if there is exactly one, because with two candidates there is no
 *     way to know which was meant;
 *   - delete the *other* rows carrying the same email, since a repeated login
 *     used to leave a stale duplicate;
 *   - never delete a row when no email was revealed, because every row without
 *     an email looks identical.
 */

/** The fields the matching rule reads from a stored connection. */
export interface WebLoginCandidate {
	readonly id: string
	readonly email?: string | null
	readonly updatedAt?: string | null
	readonly providerSpecificData?: Record<string, unknown> | null
}

/** The marker a connection created by a web login carries. */
export const WEB_LOGIN_AUTH_METHOD = "web-login"

/** Whether this connection was created by the web-login button. */
export function isWebLoginConnection(connection: WebLoginCandidate): boolean {
	return connection.providerSpecificData?.authMethod === WEB_LOGIN_AUTH_METHOD
}

/**
 * The web-login connections for one provider, newest first.
 *
 * Newest first because the row a re-login should refresh is the one the operator
 * used most recently; sorting by `updatedAt` rather than `createdAt` means a row
 * already refreshed once stays the preferred target.
 */
export function webLoginRowsOf(connections: readonly WebLoginCandidate[]): WebLoginCandidate[] {
	return connections
		.filter(isWebLoginConnection)
		.sort((a, b) => Number(new Date(b.updatedAt || 0)) - Number(new Date(a.updatedAt || 0)))
}

/**
 * The row a finished login should refresh, or null when it should create one.
 *
 * `email` is what the provider's own identity endpoint revealed, empty when it
 * revealed none. The single-candidate rule exists so a re-login on a provider
 * without emails does not pile up duplicates, while two such rows are left alone:
 * guessing there would silently overwrite somebody else's account.
 */
export function findRefreshTarget(
	rows: readonly WebLoginCandidate[],
	email: string,
): WebLoginCandidate | null {
	if (email) return rows.find((row) => row.email === email) ?? null
	return rows.length === 1 ? rows[0] : null
}

/**
 * The rows to delete once `kept` has been refreshed.
 *
 * Only duplicates of the same account: same email, a different row. With no email
 * nothing is a duplicate, because every row would compare equal.
 */
export function duplicatesOf(
	rows: readonly WebLoginCandidate[],
	kept: WebLoginCandidate,
	email: string,
): WebLoginCandidate[] {
	if (!email) return []
	return rows.filter((row) => row.id !== kept.id && row.email === email)
}

/**
 * The label a harvested connection is stored under.
 *
 * The account's email when the provider reveals one — that is what the operator
 * recognises — otherwise the provider's display name.
 */
export function connectionNameFor(email: string, providerName: string): string {
	return email || providerName
}

/** What the client is shown of the harvested credential: never the credential. */
export function credentialPreview(credential: string | null | undefined): string | null {
	if (!credential) return null
	return `${credential.slice(0, 10)}…`
}

/**
 * The `providerSpecificData` a web-login connection is stored with.
 *
 * `tokenSource` distinguishes a credential harvested from localStorage from one
 * harvested from cookies: the two are replayed differently, and a connection that
 * lost that distinction fails at request time rather than at login time.
 */
export function webLoginProviderData(fromLocalStorage: boolean): Record<string, unknown> {
	return {
		authMethod: WEB_LOGIN_AUTH_METHOD,
		...(fromLocalStorage ? { tokenSource: "localStorage" } : {}),
	}
}

/** What an identity probe said, as the session cares about it. */
export type IdentityVerdict =
	| { readonly rejected: true; readonly error: string }
	| { readonly rejected: false }

/**
 * How a finished login's identity probe should be read.
 *
 * A login that just finished in the browser is authoritative. An `invalid` verdict
 * here means the probe *endpoint* rejected the request shape, not that the
 * operator's session is stale — so the session is failed rather than the account
 * being reported as expired while the browser sits there logged in.
 */
export function readIdentityVerdict(identity: {
	readonly status: string
	readonly email?: string | null
	readonly error?: string | null
}): IdentityVerdict {
	if (identity.status !== "invalid") return { rejected: false }
	return { rejected: true, error: identity.error || "The captured session was rejected" }
}

/**
 * The message a name conflict produces.
 *
 * The store refuses a duplicate connection name; without naming the taken name the
 * operator has to guess which row to delete.
 */
export function conflictMessage(existingName: string): string {
	return `A connection named "${existingName}" already exists — edit or delete it first`
}
