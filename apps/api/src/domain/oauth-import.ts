/**
 * Rules for importing provider credentials the operator already has.
 *
 * Three families of route: pasting token JSON (`bulk-import`, `import-token`), reading a
 * provider's own credential file from disk (`auto-import`, the CLI importers), and the
 * interactive OAuth handshake. What they share is that a credential arrives from outside
 * 9router and has to be made safe before it reaches a table.
 */

/** Fields the server owns. A body that carries them is not offering input, it is asserting state. */
export const SERVER_CONTROLLED_FIELDS = [
	"id",
	"provider",
	"authType",
	"createdAt",
	"updatedAt",
] as const

/**
 * The accounts in a bulk-import body.
 *
 * Three shapes are accepted because three callers send them: an exported array, a single
 * object pasted from a token file, and `{ accounts: [...] }` from the dashboard's own
 * export. Anything else is *no accounts* rather than an error with a guess attached — the
 * route cannot tell an empty `{ accounts: [] }` from a malformed body, and both answer the
 * same way to the operator.
 */
export function accountsOf(body: unknown): Record<string, unknown>[] | null {
	if (Array.isArray(body)) return body as Record<string, unknown>[]
	if (body && typeof body === "object") {
		const wrapped = (body as { accounts?: unknown }).accounts
		if (Array.isArray(wrapped)) return wrapped as Record<string, unknown>[]
		return [body as Record<string, unknown>]
	}
	return null
}

/** An account with the server's fields removed, or why it cannot be imported. */
export type StrippedAccount =
	| { readonly account: Record<string, unknown>; readonly error?: undefined }
	| { readonly error: string; readonly account?: undefined }

/**
 * One account, with the server's fields removed.
 *
 * The result is tagged rather than a bare record-or-error union: a caller checking
 * `"error" in value` on `Record<string, unknown> | { error: string }` gets no narrowing,
 * because every record might have had an `error` key all along.
 */
export function strippedAccount(raw: unknown): StrippedAccount {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { error: "Item is not an object" }
	}

	const kept: Record<string, unknown> = { ...(raw as Record<string, unknown>) }
	for (const field of SERVER_CONTROLLED_FIELDS) delete kept[field]

	if (typeof kept.accessToken !== "string" || !kept.accessToken) {
		return { error: "Missing accessToken" }
	}
	return { account: kept }
}

/**
 * `expiresAt` from `expiresIn` when only the latter was given.
 *
 * An import that carried `expiresIn` and no `expiresAt` would otherwise be stored with no
 * expiry at all, and the refresh scheduler would treat the credential as valid forever.
 */
export function expiresAtOf(item: Record<string, unknown>, now: number): string | null | undefined {
	if (item.expiresAt) return item.expiresAt as string
	const expiresIn = item.expiresIn
	if (typeof expiresIn !== "number" || expiresIn <= 0) return undefined
	return new Date(now + expiresIn * 1000).toISOString()
}

/**
 * The defaults an OAuth-completed connection would have had.
 *
 * An imported credential that skipped these would sit in the table untested and inactive —
 * present in the dashboard, absent from routing — which reads as a broken import.
 */
export function withImportDefaults(
	item: Record<string, unknown>,
	now: number,
): Record<string, unknown> {
	const withExpiry = { ...item }
	const expiresAt = expiresAtOf(item, now)
	if (expiresAt !== undefined) withExpiry.expiresAt = expiresAt

	if (withExpiry.testStatus === undefined) withExpiry.testStatus = "active"
	if (withExpiry.isActive === undefined) withExpiry.isActive = true
	if (!withExpiry.lastRefreshAt) withExpiry.lastRefreshAt = new Date(now).toISOString()
	return withExpiry
}

/** The answer of a bulk import: what went in, and why the rest did not. */
export interface BulkImportAnswer {
	readonly success: number
	readonly failed: number
	readonly results: readonly (
		| { readonly index: number; readonly ok: true; readonly id: string }
		| { readonly index: number; readonly ok: false; readonly error: string }
	)[]
}

/**
 * Whether a bulk import may run in parallel.
 *
 * Never: `createProviderConnection` reads the highest priority and reorders inside a
 * transaction, so two concurrent inserts claim the same slot and one connection silently
 * lands in the wrong position. Stated here because "it is only an import" is exactly the
 * reasoning that would make someone reach for `Promise.all`.
 */
export const BULK_IMPORT_IS_SERIAL = true
