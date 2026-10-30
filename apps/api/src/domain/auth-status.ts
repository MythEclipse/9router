/**
 * What the dashboard is told about the current session.
 *
 * `/api/auth/status` is the first call every page makes, and its answer decides where the browser
 * goes and what it is allowed to draw. Two properties matter more than any individual field:
 *
 * 1. **The shape never varies.** The handler used to answer with one set of fields on success and
 *    a *different* set when reading the settings failed, so `role`, `permissions`, `homePath` and
 *    the key fields were simply absent in the failure case. A dashboard reading
 *    `data.role === "apikey"` saw `undefined` and could not tell "no permission" from "failed to
 *    ask" — two states the login page must never confuse.
 * 2. **Failure means signed out, never signed in.** Whatever goes wrong, the answer says
 *    `authenticated: false` and `requireLogin: true`. Guessing the other way leaks a dashboard to
 *    a caller whose session was never confirmed.
 *
 * Keeping this here — framework-free, no database, no cookies — is what makes both properties
 * testable without standing up a request.
 */

/** A session as the cookie carried it. Every field is untrusted: the cookie is client-held. */
export interface SessionClaims {
	readonly role?: unknown
	readonly permissions?: unknown
	readonly keyName?: unknown
	readonly keyId?: unknown
	readonly apiKey?: unknown
	readonly allowedModels?: unknown
	readonly allowedEndpoints?: unknown
	readonly tokenLimit?: unknown
	readonly oidc?: unknown
	readonly oidcName?: unknown
	readonly oidcEmail?: unknown
	readonly saml?: unknown
	readonly samlName?: unknown
	readonly samlEmail?: unknown
}

/** The settings rows that decide how the login page presents itself. */
export interface AuthStatusSettings {
	readonly requireLogin?: unknown
	readonly authMode?: unknown
	readonly ssoType?: unknown
	readonly oidcLoginLabel?: unknown
	readonly samlLoginLabel?: unknown
	readonly hasPassword?: unknown
}

/** The SSO availability probes, injected so this file never reaches for config or network. */
export interface SsoProbes {
	readonly oidcConfigured: (settings: AuthStatusSettings) => boolean
	readonly samlConfigured: (settings: AuthStatusSettings) => boolean
}

/**
 * A permission grant, as the dashboard stores it: one boolean per capability.
 *
 * Typed `object` rather than a record because this layer must not import the database package that
 * owns the canonical `PermissionSet`, and TypeScript will not accept a closed interface where an
 * open record is expected. The domain never reads an individual key — it only passes the grant to
 * `firstAllowedPage`, which the host owns — so `object` is both sufficient and honest.
 */
export type PermissionGrant = object

/** Permission sets the host already owns; passed in so the domain does not import the DB layer. */
export interface PermissionCatalog {
	readonly full: PermissionGrant
	readonly byDefault: PermissionGrant
	readonly normalize: (raw: unknown) => PermissionGrant
}

export type LoginMethod = "API Key" | "SAML" | "OIDC" | "Password"

export interface AuthStatus {
	readonly requireLogin: boolean
	readonly authMode: string
	readonly ssoType: string
	readonly oidcConfigured: boolean
	readonly oidcLoginLabel: string
	readonly samlConfigured: boolean
	readonly samlLoginLabel: string
	readonly hasPassword: boolean
	readonly displayName: string
	readonly loginMethod: LoginMethod
	readonly authenticated: boolean
	readonly role: string
	readonly permissions: PermissionGrant
	readonly homePath: string | null
	readonly apiKey: string | null
	readonly keyId: string | null
	readonly allowedModels: unknown
	readonly allowedEndpoints: readonly unknown[]
	readonly tokenLimit: number
	readonly oidcName: string | null
	readonly oidcEmail: string | null
	readonly oidcLogin: boolean
	readonly samlName: string | null
	readonly samlEmail: string | null
	readonly samlLogin: boolean
}

export const OIDC_DEFAULT_LABEL = "Sign in with OIDC"
export const SAML_DEFAULT_LABEL = "Sign in with SAML SSO"

/**
 * A label the operator typed, or the default.
 *
 * Trimming then falling back is the whole rule: an empty string saved into settings means "I did
 * not choose", and a button captioned "" is a button nobody can name.
 */
function label(raw: unknown, fallback: string): string {
	return String(raw ?? "").trim() || fallback
}

function trimmed(raw: unknown): string {
	return String(raw ?? "").trim()
}

function text(raw: unknown): string | null {
	return trimmed(raw) || null
}

function nonEmptyString(raw: unknown): string | null {
	return typeof raw === "string" && raw ? raw : null
}

function permissionsFor(
	role: string,
	claims: SessionClaims,
	catalog: PermissionCatalog,
): PermissionGrant {
	if (claims.permissions) return catalog.normalize(claims.permissions)
	// A password session is a full admin. Anything else carries exactly what its key holds, so a
	// key stored before a permission existed lacks it rather than inheriting it.
	return role === "admin" ? catalog.full : catalog.byDefault
}

/**
 * The human name to show in the corner.
 *
 * Precedence follows trustworthiness of the source, not recency: a name the identity provider
 * asserted beats an email, which beats a label derived from how they signed in. Falling back to
 * "Password user" rather than an empty string keeps the avatar menu from rendering a blank line.
 */
function displayNameFor(claims: SessionClaims, isApiKeyLogin: boolean): string {
	return (
		trimmed(claims.samlName) ||
		trimmed(claims.samlEmail) ||
		trimmed(claims.oidcName) ||
		trimmed(claims.oidcEmail) ||
		(isApiKeyLogin
			? trimmed(claims.keyName) || "API Key user"
			: claims.saml
				? "SAML user"
				: claims.oidc
					? "OIDC user"
					: "Password user")
	)
}

function loginMethodFor(claims: SessionClaims, isApiKeyLogin: boolean): LoginMethod {
	if (isApiKeyLogin) return "API Key"
	if (claims.saml) return "SAML"
	if (claims.oidc) return "OIDC"
	return "Password"
}

/**
 * The answer for a caller whose session is confirmed (or who needs no session).
 *
 * `homePath` is `null` only for a key session with no usable permission. The login page reads
 * `null` as "stop here" — redirecting to `/dashboard` instead would bounce straight into a 403 and
 * loop, so the distinction has to survive into the payload.
 */
export function signedInStatus(input: {
	readonly claims: SessionClaims | null
	readonly settings: AuthStatusSettings
	readonly probes: SsoProbes
	readonly catalog: PermissionCatalog
	readonly homePathFor: (role: string, firstAllowed: string | null) => string | null
	readonly firstAllowedPage: (permissions: PermissionGrant) => string | null
}): AuthStatus {
	const { settings, probes, catalog } = input
	// A verified cookie carries claims; no cookie (or one that failed verification) carries none.
	// The two are told apart here rather than by the caller, so `authenticated` can never claim a
	// session that was never established.
	const claims: SessionClaims = input.claims ?? {}
	const signedIn = input.claims !== null
	// A password session carries no `role`, and it is a full admin — but only once signed in. A
	// caller with no session gets "", not "admin": `EndpointPageClient` reads `role` to decide what
	// the key form may offer, and answering "admin" to a visitor hands them the admin form.
	const role = signedIn ? (nonEmptyString(claims.role) ?? "admin") : ""
	const permissions = signedIn ? permissionsFor(role, claims, catalog) : catalog.byDefault
	const isApiKeyLogin = signedIn && role === "apikey"

	return {
		requireLogin: settings.requireLogin !== false,
		authMode:
			typeof settings.authMode === "string" && settings.authMode ? settings.authMode : "password",
		ssoType: typeof settings.ssoType === "string" && settings.ssoType ? settings.ssoType : "oidc",
		oidcConfigured: probes.oidcConfigured(settings),
		oidcLoginLabel: label(settings.oidcLoginLabel, OIDC_DEFAULT_LABEL),
		samlConfigured: probes.samlConfigured(settings),
		samlLoginLabel: label(settings.samlLoginLabel, SAML_DEFAULT_LABEL),
		hasPassword: Boolean(settings.hasPassword),
		displayName: signedIn ? displayNameFor(claims, isApiKeyLogin) : "Password user",
		loginMethod: loginMethodFor(claims, isApiKeyLogin),
		authenticated: signedIn,
		role,
		permissions,
		homePath: signedIn
			? input.homePathFor(role, isApiKeyLogin ? input.firstAllowedPage(permissions) : null)
			: null,
		apiKey: nonEmptyString(claims.apiKey),
		keyId: nonEmptyString(claims.keyId),
		allowedModels: claims.allowedModels || "*",
		allowedEndpoints: Array.isArray(claims.allowedEndpoints) ? claims.allowedEndpoints : [],
		tokenLimit: typeof claims.tokenLimit === "number" ? claims.tokenLimit : 0,
		oidcName: text(claims.oidcName),
		oidcEmail: text(claims.oidcEmail),
		oidcLogin: Boolean(claims.oidc),
		samlName: text(claims.samlName),
		samlEmail: text(claims.samlEmail),
		samlLogin: Boolean(claims.saml),
	}
}

/**
 * The answer when the session cannot be established — settings unreadable, cookie malformed, or
 * any other throw on the way.
 *
 * Deliberately the *same keys* as `signedInStatus`, every field at its closed value. The previous
 * handler answered this case with a shape that omitted nine fields, so a client could not tell a
 * signed-out caller from a broken server — and that difference decides whether a page renders or
 * where it navigates.
 */
export function signedOutStatus(): AuthStatus {
	return {
		requireLogin: true,
		authMode: "password",
		ssoType: "oidc",
		oidcConfigured: false,
		oidcLoginLabel: OIDC_DEFAULT_LABEL,
		samlConfigured: false,
		samlLoginLabel: SAML_DEFAULT_LABEL,
		hasPassword: false,
		displayName: "Password user",
		loginMethod: "Password",
		authenticated: false,
		role: "",
		permissions: {},
		homePath: null,
		apiKey: null,
		keyId: null,
		allowedModels: "*",
		allowedEndpoints: [],
		tokenLimit: 0,
		oidcName: null,
		oidcEmail: null,
		oidcLogin: false,
		samlName: null,
		samlEmail: null,
		samlLogin: false,
	}
}
