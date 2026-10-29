import { textFieldOf, validationStatusOf } from "../../domain/credential-import.ts"

/**
 * Importing a provider's long-lived key.
 *
 * An API key has no refresh token, so the only thing to decide is whether it still works —
 * and both providers answer that with a request that may fail for reasons that are not the
 * key's fault. A key that could not be checked is stored as `untested`, not refused: the
 * operator may be behind a network that blocks the provider, and refusing would leave them
 * with no way to import a key they can see working elsewhere.
 */

/** A year: long enough that the proactive refresh path never fires on a key that has none. */
export const API_KEY_HORIZON_MS = 365 * 24 * 60 * 60 * 1000

/** What a provider's key check answered. */
export interface KeyCheck {
	readonly validated: boolean
	readonly modelCount: number
	readonly accessToken: string
	readonly email?: string | null
	readonly providerSpecificData?: Record<string, unknown>
}

/** An existing connection, as a re-import needs to see it. */
export interface ExistingConnection {
	readonly id: string
	readonly provider?: string
	readonly email?: string | null
}

/** What an API-key import needs from the host. */
export interface ApiKeyImportDeps {
	/** Check the key. Answering `validated: false` is a soft failure; throwing is not used. */
	readonly check: (input: { readonly apiKey: string; readonly region: string }) => Promise<KeyCheck>
	readonly create: (input: Record<string, unknown>) => Promise<ExistingConnection>
	readonly now: () => number
}

/** What an API-key import answers. */
export interface ApiKeyAnswer {
	readonly ok: boolean
	readonly status: number
	readonly error?: string
	readonly validated?: boolean
	readonly modelCount?: number
	readonly updated?: boolean
	readonly connection?: ExistingConnection
}

/**
 * `POST /api/oauth/kiro/api-key` — a bearer key, checked against the inference surface.
 *
 * Kiro keys carry no expiry of their own, so the stored expiry is a long horizon rather than
 * a real date; the refresh path is skipped because there is no refresh token to spend.
 */
export async function importKiroApiKey(
	rawBody: unknown,
	deps: ApiKeyImportDeps,
): Promise<ApiKeyAnswer> {
	const body = bodyOf(rawBody)
	const apiKey = textFieldOf(body.apiKey)
	if (!apiKey) return { ok: false, status: 400, error: "API key is required" }
	const region = textFieldOf(body.region) || "us-east-1"

	const checked = await deps.check({ apiKey, region }).catch(() => null)
	if (!checked) {
		// The upstream body is deliberately not reflected back: it names an endpoint and can
		// leak it, and it is not something the operator can retype their way out of.
		return {
			ok: false,
			status: validationStatusOf({ status: 500 }),
			error: "API key validation failed",
		}
	}

	try {
		const connection = await deps.create({
			provider: "kiro",
			authType: "api_key",
			accessToken: checked.accessToken,
			refreshToken: null,
			expiresAt: new Date(deps.now() + API_KEY_HORIZON_MS).toISOString(),
			email: checked.email ?? null,
			providerSpecificData: {
				...(checked.providerSpecificData ?? {}),
				authMethod: "api_key",
				provider: "API Key",
			},
			testStatus: "active",
		})
		return { ok: true, status: 200, connection }
	} catch (error) {
		return { ok: false, status: 502, error: messageOf(error) }
	}
}

/** What a MiMo import needs: the check, plus a way to find and amend a row it already made. */
export interface MimoImportDeps extends ApiKeyImportDeps {
	readonly findExisting: (identity: {
		readonly key: string
		readonly uid: string
		readonly sessionOnly: boolean
		readonly mimoUserId: string
		readonly region: string
	}) => Promise<ExistingConnection | null>
	readonly update: (id: string, patch: Record<string, unknown>) => Promise<unknown>
}

/**
 * `POST /api/oauth/xiaomi-mimo/api-key` — a key, or a session that has no key at all.
 *
 * MiMo is the one provider that can be imported from a session cookie alone (`mimoPassToken`
 * with no key). That is why a re-import of the same account updates the row instead of
 * adding a second one: the dashboard would otherwise list the same account twice, and
 * rotation would spend both.
 */
export async function importMimoApiKey(
	rawBody: unknown,
	deps: MimoImportDeps,
): Promise<ApiKeyAnswer> {
	const body = bodyOf(rawBody)
	const apiKey = textFieldOf(body.apiKey)
	const passToken = textFieldOf(body.mimoPassToken)
	const sessionOnly = !apiKey && Boolean(passToken)

	if (!apiKey && !passToken) return { ok: false, status: 400, error: "API key is required" }
	if (apiKey && !apiKey.startsWith("sk-")) {
		return { ok: false, status: 400, error: "Invalid key format - expected sk- prefix" }
	}

	const uid = textFieldOf(body.uid)
	const region = textFieldOf(body.region)
	const mimoUserId = textFieldOf(body.mimoUserId)
	const baseUrl = (textFieldOf(body.baseUrl) || "https://api.xiaomimimo.com/v1").replace(/\/+$/, "")

	// A session-only import has nothing to check; a key is checked, and a check that fails
	// for network reasons leaves the row `untested` rather than refusing the import.
	const checked: KeyCheck = apiKey
		? await deps.check({ apiKey, region }).catch(() => ({
				validated: false,
				modelCount: 0,
				accessToken: apiKey,
			}))
		: { validated: true, modelCount: 0, accessToken: "" }

	const existing = await deps.findExisting({ key: apiKey, uid, sessionOnly, mimoUserId, region })

	const providerSpecificData = {
		uid: uid || null,
		baseUrl,
		region: region || "cn",
		authMethod: sessionOnly ? "session" : "api_key",
		provider: sessionOnly ? "Session Login" : "API Key",
		modelCount: checked.modelCount,
		// Per-account session credential — this is what makes multi-account rotation work.
		mimoPassToken: passToken || null,
		mimoUserId: mimoUserId || null,
		mimoCUserId: textFieldOf(body.mimoCUserId) || null,
	}

	try {
		if (existing) {
			await deps.update(existing.id, {
				accessToken: apiKey || undefined,
				providerSpecificData,
				testStatus: checked.validated ? "active" : undefined,
			})
			return {
				ok: true,
				status: 200,
				validated: checked.validated,
				modelCount: checked.modelCount,
				updated: true,
				connection: existing,
			}
		}

		const connection = await deps.create({
			provider: "xiaomi-mimo",
			// "oauth" is the official authType for imported credentials; the dashboard's
			// filters key off it, and inventing "session" once hid the row from the card.
			authType: sessionOnly ? "oauth" : "api_key",
			accessToken: apiKey || null,
			refreshToken: null,
			expiresAt: new Date(deps.now() + API_KEY_HORIZON_MS).toISOString(),
			email: uid ? `${uid}@xiaomi` : null,
			displayName: uid ? `Xiaomi ${uid}${sessionOnly ? " (Session)" : ""}` : "Xiaomi MiMo",
			providerSpecificData,
			testStatus: checked.validated ? "active" : sessionOnly ? "active" : "untested",
		})
		return {
			ok: true,
			status: 200,
			validated: checked.validated,
			modelCount: checked.modelCount,
			connection,
		}
	} catch (error) {
		return { ok: false, status: 502, error: messageOf(error) }
	}
}

function bodyOf(raw: unknown): Record<string, unknown> {
	return raw && typeof raw === "object" && !Array.isArray(raw)
		? (raw as Record<string, unknown>)
		: {}
}

function messageOf(error: unknown): string {
	const message = (error as { message?: unknown } | null | undefined)?.message
	return typeof message === "string" && message ? message : "Import failed"
}
