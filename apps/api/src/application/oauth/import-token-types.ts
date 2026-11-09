/** Import-token: shared types. */
/** What a provider's verification answered, in the shape the connection needs. */
export interface VerifiedToken {
	readonly accessToken: string
	readonly refreshToken?: string
	readonly expiresIn?: number
	readonly email?: string | null
	readonly providerSpecificData?: Record<string, unknown>
}

/** What an import needs from the host. */
export interface ImportTokenDeps {
	/** Prove the token works; throws when it does not. */
	readonly verify: (input: {
		readonly accessToken: string
		readonly identity?: string
		readonly refreshToken?: string
		readonly providerSpecificData: Record<string, unknown>
	}) => Promise<VerifiedToken>
	/** Write the connection the verification justified. */
	readonly create: (input: Record<string, unknown>) => Promise<{
		readonly id: string
		readonly provider?: string
		readonly email?: string | null
	}>
	readonly now: () => number
}

/** What an import answers. */
export interface ImportedConnection {
	readonly id: string
	readonly provider?: string
	readonly email?: string | null
}

/**
 * Two outcomes, told apart by `ok`.
 *
 * The success arm carries no `error` and the failure arm no `connection`, so a caller that
 * checks `ok` gets the other arm's fields without a cast.
 */
export type ImportOutcome =
	| { readonly ok: true; readonly connection: ImportedConnection }
	| { readonly ok: false; readonly status: 400 | 401 | 502; readonly error: string }

/** The request body, as far as any import can trust it. */
export function bodyOf(raw: unknown): Record<string, unknown> {
	return raw && typeof raw === "object" && !Array.isArray(raw)
		? (raw as Record<string, unknown>)
		: {}
}

export function messageOf(error: unknown): string {
	const message = (error as { message?: unknown } | null | undefined)?.message
	return typeof message === "string" && message ? message : "Import failed"
}
