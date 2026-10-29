/**
 * The two SSO "test this configuration" endpoints, and the gate in front of both.
 *
 * They exist so an operator can find out their IdP settings are wrong *before* saving them and
 * locking themselves out. That purpose is what makes the rules non-obvious:
 *
 * - **The gate is open only on a fully public dashboard.** `requireLogin === false` means the
 *   operator deliberately runs without authentication, so a settings probe is no more sensitive
 *   than the settings page itself. Once login is required, the probe is a session-only tool. The
 *   two routes had this copied verbatim, which is how one of them would eventually have been fixed
 *   and the other forgotten.
 * - **A field left out falls back to the saved value; a field explicitly blanked does not.** The
 *   form sends the whole settings object, so `samlCert: ""` means "I cleared this" while a body
 *   with no `samlCert` key means "I did not touch it". After a naive `||` both look like `""`,
 *   which is how clearing a certificate silently resurrected the old one.
 * - **A rejected `clientSecret` is not a broken discovery document, and the OIDC probe says so.**
 *   The probe exists to separate "discovery works, secret is wrong" from "discovery is broken",
 *   because those have completely different fixes. One generic failure sends the operator to debug
 *   their network over a typo.
 * - **A test endpoint never persists.** It reports; saving is a separate deliberate action.
 */

/** Why a probe refused to run. */
export interface ProbeRefusal {
	readonly status: number
	readonly message: string
}

/** What a probe could answer: a refusal, or the report to send back. */
export type ProbeAnswer<T> = { readonly refusal: ProbeRefusal } | { readonly body: T }

/** Narrowing for `ProbeAnswer` (works under `strict: false`, which is how `apps/web` builds). */
export function isProbeRefusal<T>(
	answer: ProbeAnswer<T>,
): answer is { readonly refusal: ProbeRefusal } {
	return "refusal" in answer
}

/**
 * Whether a test endpoint may be called.
 *
 * Open when the dashboard is public by the operator's own choice; otherwise a valid session is
 * required. Passing the session verdict in keeps this module free of cookies and JWTs.
 */
export function probeAccess(requireLogin: boolean, hasValidSession: boolean): ProbeRefusal | null {
	if (!requireLogin) return null
	if (hasValidSession) return null
	return { status: 401, message: "Unauthorized" }
}

/**
 * A submitted field, or the saved one when the body did not mention it.
 *
 * `Object.hasOwn` is the distinction that matters: an absent key means untouched, an empty string
 * means cleared. Folding both with `||` makes clearing impossible to express.
 */
export function submittedOrSaved(
	body: Record<string, unknown> | null | undefined,
	key: string,
	saved: unknown,
): string {
	const submitted = body !== null && body !== undefined && Object.hasOwn(body, key)
	const value = submitted ? body?.[key] : saved
	return String(value ?? "").trim()
}

/** The SAML fields a probe needs, after the blank-vs-cleared rule has been applied. */
export interface SamlProbeInput {
	readonly entryPoint: string
	readonly issuer: string
	readonly certificate: string
}

/** The SP entity id SAML uses when the operator did not give one. */
export const DEFAULT_SAML_ISSUER = "urn:9router:sp"

/**
 * The SAML fields a probe was given, or the refusal for the first missing one.
 *
 * Ordered deliberately: a missing entry point is the most common mistake and is reported before the
 * certificate, because fixing one field at a time is less work than fixing three at once.
 */
export function samlProbeInput(
	body: Record<string, unknown> | null | undefined,
	saved: { samlEntryPoint?: unknown; samlIssuer?: unknown; samlCert?: unknown } | null,
): ProbeAnswer<SamlProbeInput> {
	const entryPoint = submittedOrSaved(body, "samlEntryPoint", saved?.samlEntryPoint)
	if (entryPoint === "") {
		return {
			refusal: { status: 400, message: "Single Sign-On Service URL (samlEntryPoint) is required" },
		}
	}
	if (!isHttpUrl(entryPoint)) {
		return {
			refusal: { status: 400, message: "Single Sign-On Service URL must be a valid URL" },
		}
	}

	const issuer = submittedOrSaved(body, "samlIssuer", saved?.samlIssuer) || DEFAULT_SAML_ISSUER
	const certificate = submittedOrSaved(body, "samlCert", saved?.samlCert)
	if (certificate === "") {
		return { refusal: { status: 400, message: "IdP X.509 Certificate (samlCert) is required" } }
	}

	return { body: { entryPoint, issuer, certificate } }
}

/**
 * Whether a string is a URL this app can redirect to.
 *
 * `new URL("example.com")` throws, but `new URL("javascript:alert(1)")` does not — the entry point
 * is handed to a redirect, so checking the scheme is load-bearing rather than pedantic.
 */
export function isHttpUrl(value: string): boolean {
	try {
		const { protocol } = new URL(value)
		return protocol === "http:" || protocol === "https:"
	} catch {
		return false
	}
}

/** The two URLs a SAML test reports, so the operator can paste them into their IdP. */
export function samlEndpoints(origin: string) {
	return {
		acsUrl: `${origin}/api/auth/saml/acs`,
		metadataUrl: `${origin}/api/auth/saml/metadata`,
	}
}

/** The OIDC fields a probe needs. */
export interface OidcProbeInput {
	readonly issuerUrl: string
	readonly clientId: string
	readonly scopes: string
	readonly clientSecret: string
}

/** The scopes OIDC gets when the operator did not name any. */
export const DEFAULT_OIDC_SCOPES = "openid profile email"

/** The OIDC fields a probe was given, or the refusal for the first missing one. */
export function oidcProbeInput(
	body: Record<string, unknown> | null | undefined,
	saved: {
		oidcIssuerUrl?: unknown
		oidcClientId?: unknown
		oidcScopes?: unknown
		oidcClientSecret?: unknown
	} | null,
): ProbeAnswer<OidcProbeInput> {
	const issuerUrl = submittedOrSaved(body, "issuerUrl", saved?.oidcIssuerUrl)
	if (issuerUrl === "") {
		return { refusal: { status: 400, message: "Issuer URL is required" } }
	}
	const clientId = submittedOrSaved(body, "clientId", saved?.oidcClientId)
	if (clientId === "") {
		return { refusal: { status: 400, message: "Client ID is required" } }
	}
	return {
		body: {
			issuerUrl,
			clientId,
			scopes: submittedOrSaved(body, "scopes", saved?.oidcScopes) || DEFAULT_OIDC_SCOPES,
			clientSecret: submittedOrSaved(body, "clientSecret", saved?.oidcClientSecret),
		},
	}
}

/** The shapes an OIDC probe can end in. */
export type OidcProbeOutcome =
	| { readonly kind: "secret-rejected"; readonly message: string }
	| {
			readonly kind: "ok"
			readonly tested: boolean
			readonly valid?: boolean
			readonly message: string
	  }

/**
 * The verdict for a finished probe.
 *
 * A rejected secret is its own outcome, not a generic failure: discovery *worked*, and the operator
 * has to be told that, or they will debug their network instead of their client secret.
 */
export function oidcProbeOutcome(probe: {
	readonly tested: boolean
	readonly valid?: boolean
	readonly message?: string
}): OidcProbeOutcome {
	const message = probe.message ?? ""
	if (probe.tested && probe.valid === false) return { kind: "secret-rejected", message }
	return { kind: "ok", tested: probe.tested, valid: probe.valid, message }
}

/**
 * Whether an OIDC probe reported success.
 *
 * `ok: false` in the *response body* does **not** mean the request failed — it means discovery
 * loaded and the secret did not work. The HTTP status stays 200, because the probe did its job;
 * only the body says `ok: false`.
 */
export function oidcProbeSucceeded(outcome: OidcProbeOutcome): boolean {
	return outcome.kind === "ok"
}

/** The sentence a rejected client secret earns. */
export function oidcSecretRejection(message: string): string {
	return `Discovery loaded, but the client secret is not valid: ${message}`
}

/** The redirect URI an OIDC probe reports, so the operator can register it with the IdP. */
export function oidcRedirectUri(origin: string): string {
	return `${origin}/api/auth/oidc/callback`
}

/** Escape the five characters that cannot appear raw in XML text or an attribute. */
export function escapeXml(value: unknown): string {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;")
}

/**
 * The XML document returned when metadata generation fails.
 *
 * It is XML, not JSON, because the operator is pasting the response into an IdP: a JSON error where
 * XML was expected reads as "this URL is broken" instead of "this certificate is malformed". The
 * message is escaped, or one `&` in a certificate path breaks the document and hides the reason.
 */
export function samlMetadataErrorBody(message: unknown): string {
	const text = escapeXml(String(message ?? "") || "Failed to generate metadata")
	return `<?xml version="1.0"?><Error>${text}</Error>`
}

/**
 * The settings patch that resets the dashboard password.
 *
 * `null`, not `""` and not the default hash: `settings.password` absent is what makes the login
 * fall back to `INITIAL_PASSWORD` or the published default, and that fallback is the only place
 * the default is ever named.
 */
export function passwordResetPatch(): { password: null } {
	return { password: null }
}

/**
 * What a password reset answers.
 *
 * Deliberately silent about the value. Echoing the default back would turn a local-only recovery
 * route into an unauthenticated way to *read* the credential, and this response may be logged.
 */
export function passwordResetResponse(): { success: true } {
	return { success: true }
}
