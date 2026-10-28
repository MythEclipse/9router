/**
 * Pure helpers behind the profile/settings page.
 *
 * The component is a 2,000-line form with 42 pieces of state, so none of these
 * rules had a test: the countdown format, and the "required unless already
 * configured" validation that decides whether SSO can be switched on.
 */

/** Read the locale cookie, falling back to English outside the browser. */
export function getLocaleFromCookie(
	cookieString: string | undefined,
	cookieName: string,
	normalize: (value: string) => string,
): string {
	if (cookieString === undefined) return "en"
	const match = cookieString
		.split(";")
		.map((c) => c.trim())
		.find((c) => c.startsWith(`${cookieName}=`))
	const value = match ? decodeURIComponent(match.split("=")[1] ?? "") : "en"
	return normalize(value || "en")
}

/**
 * A countdown clock, `HH:MM:SS` or `Nd HH:MM:SS` once it passes a day.
 *
 * Rounds down to whole seconds and clamps at zero, so a deadline in the past reads
 * `00:00:00` rather than a negative time. A non-finite duration is treated as zero
 * instead of producing `NaN:NaN:NaN`.
 */
export function formatCountdown(ms: number): string {
	const total = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000)
	const days = Math.floor(total / 86400)
	const hours = Math.floor((total % 86400) / 3600)
	const minutes = Math.floor((total % 3600) / 60)
	const seconds = total % 60
	const pad = (n: number) => String(n).padStart(2, "0")
	const clock = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
	return days > 0 ? `${days}d ${clock}` : clock
}

export interface OidcFormLike {
	oidcIssuerUrl?: string
	oidcClientId?: string
	oidcScopes?: string
	oidcLoginLabel?: string
}

export interface OidcPayload {
	authMode: string
	ssoType: "oidc"
	oidcIssuerUrl: string
	oidcClientId: string
	oidcScopes: string
	oidcLoginLabel: string
	oidcClientSecret?: string
}

export const DEFAULT_OIDC_SCOPES = "openid profile email"
export const DEFAULT_OIDC_LOGIN_LABEL = "Sign in with OIDC"

/**
 * Whether saving an OIDC config is allowed.
 *
 * The rule is "required unless already configured": once a secret is stored, the
 * form is left blank on purpose (the secret is never sent to the client), so
 * demanding it again would make every unrelated settings change fail.
 */
export function isOidcSaveAllowed(input: {
	authMode: string
	issuerUrl: string
	clientId: string
	secret: string
	alreadyConfigured: boolean
}): boolean {
	if (input.authMode === "password") return true
	const complete = Boolean(input.issuerUrl && input.clientId && input.secret)
	return complete || input.alreadyConfigured
}

/** The PATCH payload, with blanks filled by the documented defaults. */
export function buildOidcPayload(
	form: OidcFormLike,
	secret: string,
	authMode: string,
): OidcPayload {
	const payload: OidcPayload = {
		authMode,
		ssoType: "oidc",
		oidcIssuerUrl: (form.oidcIssuerUrl || "").trim(),
		oidcClientId: (form.oidcClientId || "").trim(),
		oidcScopes: (form.oidcScopes || "").trim() || DEFAULT_OIDC_SCOPES,
		oidcLoginLabel: (form.oidcLoginLabel || "").trim() || DEFAULT_OIDC_LOGIN_LABEL,
	}
	// An empty secret means "keep the stored one" — omit the field rather than
	// sending "" and overwriting it.
	const trimmed = (secret || "").trim()
	if (trimmed) payload.oidcClientSecret = trimmed
	return payload
}

/** The form state to show after a successful save, preferring the server's echo. */
export function oidcFormFromResponse(
	data: Partial<OidcPayload> | null | undefined,
	fallback: { authMode: string; form: OidcFormLike },
): Required<
	Pick<OidcFormLike, "oidcIssuerUrl" | "oidcClientId" | "oidcScopes" | "oidcLoginLabel">
> & {
	authMode: string
} {
	const form = fallback.form
	return {
		authMode: data?.authMode || fallback.authMode,
		oidcIssuerUrl: data?.oidcIssuerUrl || (form.oidcIssuerUrl || "").trim(),
		oidcClientId: data?.oidcClientId || (form.oidcClientId || "").trim(),
		oidcScopes: data?.oidcScopes || (form.oidcScopes || "").trim() || DEFAULT_OIDC_SCOPES,
		oidcLoginLabel:
			data?.oidcLoginLabel || (form.oidcLoginLabel || "").trim() || DEFAULT_OIDC_LOGIN_LABEL,
	}
}

/** The confirmation copy for a save, which differs per mode. */
export function oidcSaveMessage(authMode: string): string {
	if (authMode === "oidc") return "OIDC login enabled"
	if (authMode === "both") return "Password and OIDC login enabled"
	return "OIDC settings saved"
}

/** Whether the "test connection" button has enough to run. */
export function canTestOidc(issuerUrl: string, clientId: string): boolean {
	return Boolean((issuerUrl || "").trim() && (clientId || "").trim())
}

/**
 * The message after a successful OIDC connection test.
 *
 * Three outcomes, because the test can succeed without having checked the secret —
 * the secret is only sent when the operator typed one. Reporting a plain "OK" in that
 * case would claim a check that never ran, and the next login is when it shows.
 */
export function oidcTestSuccessMessage(result: {
	issuerUrl?: string
	clientSecretTested?: boolean
	clientSecretValid?: boolean
}): string {
	const discovery = `Discovery loaded from ${result.issuerUrl}.`
	if (!result.clientSecretTested) return `Connection OK. ${discovery}`
	if (result.clientSecretValid === true)
		return `Connection OK. ${discovery} Client secret validated too.`
	return `Connection OK. ${discovery} Client secret was not checked.`
}
