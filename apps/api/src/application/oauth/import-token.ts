import {
	codexClaimsOf,
	codexConnectionName,
	type ImportRefusal,
	identityFieldOf,
	isIdcToken,
	kiroAuthMethodOf,
	kiroProviderLabelOf,
	kiroRegionOf,
	missingImportField,
	textFieldOf,
	tokenExpiryOf,
	validationStatusOf,
} from "../../domain/credential-import.ts"

/**
 * Importing a single credential: prove it works, then save it.
 *
 * The order is the point. Validating before writing means a bad token never becomes a row
 * the dashboard then has to explain; writing only what the provider confirmed means the
 * fields the refresh path reads back later are the ones the provider actually honoured.
 */

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
function bodyOf(raw: unknown): Record<string, unknown> {
	return raw && typeof raw === "object" && !Array.isArray(raw)
		? (raw as Record<string, unknown>)
		: {}
}

function messageOf(error: unknown): string {
	const message = (error as { message?: unknown } | null | undefined)?.message
	return typeof message === "string" && message ? message : "Import failed"
}

/**
 * `POST /api/oauth/zed/import` — a token plus the user it belongs to.
 *
 * `systemId` identifies this install to Zed; a session imported without one has to be given
 * a stable id anyway, or every request looks like a new client.
 */
export async function importZedToken(
	rawBody: unknown,
	deps: ImportTokenDeps & { readonly newSystemId: () => string },
): Promise<ImportOutcome> {
	const body = bodyOf(rawBody)
	const accessToken = textFieldOf(body.accessToken)
	const userId = identityFieldOf(body.userId)
	const systemId = textFieldOf(body.systemId) || deps.newSystemId()

	const refusal = missingImportField({ accessToken, identity: userId })
	if (refusal) return { ok: false, status: 400, error: refusal.message }

	// `systemId` is this install's identity to Zed, so it belongs in the provider data the
	// connection keeps — dropping it would make the verified session look like a new client.
	return saveVerified(
		{ accessToken, identity: userId, providerSpecificData: { userId, systemId } },
		"zed",
		deps,
	)
}

/**
 * `POST /api/oauth/kiro/import` — a refresh token, exchanged for an access token.
 *
 * The token is refreshed rather than used directly: a refresh token from the IDE is the only
 * thing the operator can copy, and the access token it yields is what every later request
 * needs. Whether it is an IDC token decides the endpoint and the fields that must be kept.
 */
export async function importKiroToken(
	rawBody: unknown,
	deps: ImportTokenDeps,
): Promise<ImportOutcome> {
	const body = bodyOf(rawBody)
	const refreshToken = textFieldOf(body.refreshToken)
	if (!refreshToken) return { ok: false, status: 400, error: "Refresh token is required" }

	const clientId = textFieldOf(body.clientId)
	const clientSecret = textFieldOf(body.clientSecret)
	const region = kiroRegionOf(textFieldOf(body.region))
	const idc = isIdcToken(clientId, clientSecret)

	const providerSpecificData: Record<string, unknown> = idc
		? { clientId, clientSecret, region, authMethod: kiroAuthMethodOf(true) }
		: {}

	let verified: VerifiedToken
	try {
		verified = await deps.verify({ accessToken: refreshToken, providerSpecificData })
	} catch (error) {
		return { ok: false, status: validationStatusOf(error), error: messageOf(error) }
	}

	try {
		const connection = await deps.create({
			provider: "kiro",
			authType: "oauth",
			accessToken: verified.accessToken,
			refreshToken: verified.refreshToken || refreshToken,
			expiresAt: tokenExpiryOf(verified.expiresIn, deps.now()),
			email: verified.email ?? null,
			providerSpecificData: {
				profileArn: textFieldOf(body.profileArn) || verified.providerSpecificData?.profileArn || null,
				authMethod: kiroAuthMethodOf(idc),
				provider: kiroProviderLabelOf(idc),
				...(idc ? { clientId, clientSecret, region } : {}),
			},
			testStatus: "active",
		})
		return { ok: true, connection }
	} catch (error) {
		return { ok: false, status: 502, error: messageOf(error) }
	}
}

/**
 * Verify, then write — the shape every single-token import shares.
 *
 * The only difference between these providers is what `verify` does. The expiry, the active
 * status and the failure mapping are the same rules for all of them.
 */
export async function saveVerified(
	input: {
		readonly accessToken: string
		readonly identity?: string
		readonly providerSpecificData?: Record<string, unknown>
	},
	provider: string,
	deps: ImportTokenDeps,
): Promise<ImportOutcome> {
	const refusal = missingImportField({ accessToken: input.accessToken })
	if (refusal) return { ok: false, status: 400, error: refusal.message }

	let verified: VerifiedToken
	try {
		verified = await deps.verify({
			accessToken: input.accessToken,
			identity: input.identity,
			providerSpecificData: { ...input.providerSpecificData },
		})
	} catch (error) {
		return { ok: false, status: validationStatusOf(error), error: messageOf(error) }
	}

	try {
		const connection = await deps.create({
			provider,
			authType: "oauth",
			accessToken: verified.accessToken,
			refreshToken: verified.refreshToken,
			expiresAt: tokenExpiryOf(verified.expiresIn, deps.now()),
			email: verified.email ?? null,
			providerSpecificData: { ...input.providerSpecificData, ...verified.providerSpecificData },
			testStatus: "active",
		})
		return { ok: true, connection }
	} catch (error) {
		return { ok: false, status: 502, error: messageOf(error) }
	}
}

export type { ImportRefusal }

/**
 * Dispatch an import to the provider's own shape.
 *
 * Kiro takes a refresh token and exchanges it; every other provider takes an access token
 * and validates it. The split lives here so the graph stays an assembly list, and so a new
 * provider is added by naming the shape it uses rather than by growing a conditional.
 */
export function importToken(
	provider: string,
	body: unknown,
	deps: ImportTokenDeps & { readonly newSystemId: () => string },
): Promise<ImportOutcome> {
	if (provider === "kiro") return importKiroToken(body, deps)
	if (provider === "zed") return importZedToken(body, deps)
	if (provider === "codex") return importCodexToken(body, deps)

	const payload = bodyOf(body)
	return saveVerified(
		{
			accessToken: textFieldOf(payload.accessToken),
			identity: payload.userId === undefined ? undefined : identityFieldOf(payload.userId),
			providerSpecificData: { ...payload },
		},
		provider,
		deps,
	)
}

/**
 * The answer in a form a caller without `strictNullChecks` can read.
 *
 * `apps/web` compiles with `strict: false`, and TypeScript will not narrow a union there —
 * so `if (result.ok) result.connection` fails to compile even though the union is correct.
 * Flattening to always-present fields keeps the decision in one place instead of pushing a
 * cast into every route.
 */
export interface ImportAnswer {
	readonly ok: boolean
	readonly status: number
	readonly error?: string
	readonly connection?: ImportedConnection
}

export function importAnswerOf(outcome: ImportOutcome): ImportAnswer {
	// Read through a widened alias rather than relying on narrowing: this function is also
	// compiled by `apps/web` (strict: false), where `outcome.ok` does not narrow.
	const answer = outcome as ImportAnswer
	return { ...answer, status: answer.status ?? 200 }
}

/**
 * `POST /api/oauth/codex/import-token` — a ChatGPT access token, read but not verified.
 *
 * There is no verification call here on purpose: the token was created in ChatGPT's own
 * settings and carries its claims inside itself. The claims are read locally so the row is
 * named and filterable, and the token is stored as `access_token` — it has no refresh token,
 * so recording it as `oauth` would make the refresh path try to renew something it cannot.
 */
export async function importCodexToken(
	rawBody: unknown,
	deps: ImportTokenDeps,
): Promise<ImportOutcome> {
	const body = bodyOf(rawBody)
	const token = textFieldOf(body.accessToken)
	if (!token) return { ok: false, status: 400, error: "Access token is required" }

	const claims = codexClaimsOf(token)
	try {
		const connection = await deps.create({
			provider: "codex",
			authType: "access_token",
			accessToken: token,
			name: codexConnectionName(textFieldOf(body.name), claims),
			email: claims.email,
			providerSpecificData: {
				authMethod: "access_token",
				...(claims.chatgptAccountId ? { chatgptAccountId: claims.chatgptAccountId } : {}),
				...(claims.chatgptPlanType ? { chatgptPlanType: claims.chatgptPlanType } : {}),
				...(claims.expiresAtEpoch ? { jwtExp: claims.expiresAtEpoch } : {}),
			},
			testStatus: "active",
		})
		return { ok: true, connection }
	} catch (error) {
		return { ok: false, status: 502, error: messageOf(error) }
	}
}

/** The providers this gateway knows how to import a single token for. */
export const IMPORT_PROVIDERS = ["kiro", "zed", "codex", "cursor"] as const

/** Whether a provider needs a remote verification call before its token can be saved. */
export function needsRemoteVerification(provider: string): boolean {
	return provider !== "codex"
}
