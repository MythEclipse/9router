/**
 * Rules for reading and writing the settings row.
 *
 * The settings endpoint looks like a plain read-modify-write and is not: several
 * separate things about a write decide whether it is allowed and what else has to
 * happen afterwards, and each of them used to live inline in a 184-line handler.
 */

/**
 * Keys the request body may never set.
 *
 * A mass-assignment guard, not a preference: `password` is written only through
 * the `newPassword` flow where the old one is verified and the new one is hashed,
 * and `mitmSudoEncrypted` is written only by the code that encrypts it. Letting a
 * body through with either would let a caller set a password hash directly.
 */
export const PROTECTED_SETTING_KEYS = ["password", "mitmSudoEncrypted"] as const

/**
 * Keys only an administrator may write.
 *
 * `theme` is site-wide, so an API-key session — a key the operator handed to a
 * client — must not repaint the dashboard for everyone. The theme route checks the
 * role too; this is the second lock on the same door, deliberately.
 */
export const ADMIN_ONLY_SETTING_KEYS = ["theme"] as const

/** Remove keys the body is never allowed to carry. Returns a new object. */
export function stripProtectedKeys(body: Record<string, unknown>): Record<string, unknown> {
	const copy = { ...body }
	for (const key of PROTECTED_SETTING_KEYS) delete copy[key]
	return copy
}

/**
 * The admin-only key this body tried to write, if any.
 *
 * A key present with value `undefined` is not an attempt: the dashboard sends its
 * whole form and an untouched field arrives that way, so refusing it would reject
 * every ordinary save.
 */
export function adminOnlyAttempt(body: Record<string, unknown>): string | null {
	const attempted = ADMIN_ONLY_SETTING_KEYS.find((key) => key in body && body[key] !== undefined)
	return attempted ?? null
}

/**
 * Whether the write must be refused rather than silently stripped.
 *
 * Refused, not stripped: answering 403 tells the caller the truth, whereas
 * dropping the field lets them believe the site-wide theme changed when it did
 * not.
 */
export function refusesAdminOnlyWrite(role: string | null | undefined): boolean {
	return role === "apikey"
}

/**
 * The settings that are safe to send to a browser.
 *
 * `oidcConfigured` is derived rather than stored: the client secret never leaves
 * the server, so the form cannot tell whether OIDC is set up by looking at it.
 */
export function publicSettings(settings: Record<string, unknown>): Record<string, unknown> {
	const { password, oidcClientSecret, ...safe } = settings
	return {
		...safe,
		oidcConfigured: Boolean(safe.oidcIssuerUrl && safe.oidcClientId && oidcClientSecret),
		hasPassword: Boolean(password),
	}
}

/** What a password change needs, and what it refuses. */
export type PasswordChange =
	| { readonly kind: "none" }
	| { readonly kind: "refuse"; readonly message: string; readonly status: number }
	| { readonly kind: "verify"; readonly current: string; readonly newPassword: string }
	| { readonly kind: "set"; readonly newPassword: string }

/**
 * Decide what a submitted password change still needs.
 *
 * With a password already set, the current one must be supplied and must match —
 * but matching is a hash comparison, which is the caller's job, so this answers
 * `verify` and lets the caller come back with a verdict. With none set, this is the
 * first password: an empty current password is accepted, and so is the install's
 * documented default, because a fresh install has no password to confirm and the
 * setup wizard sends that placeholder.
 */
export function passwordChangeOf(
	body: Record<string, unknown>,
	hasStoredPassword: boolean,
): PasswordChange {
	const newPassword = body.newPassword
	if (!newPassword) return { kind: "none" }
	if (typeof newPassword !== "string") {
		return { kind: "refuse", message: "New password must be text", status: 400 }
	}

	const current = body.currentPassword
	if (!hasStoredPassword) {
		if (current && current !== "123456") {
			return { kind: "refuse", message: "Invalid current password", status: 401 }
		}
		return { kind: "set", newPassword }
	}

	if (!current) {
		return { kind: "refuse", message: "Current password required", status: 400 }
	}
	if (typeof current !== "string") {
		return { kind: "refuse", message: "Invalid current password", status: 401 }
	}
	return { kind: "verify", current, newPassword }
}

/**
 * An OIDC client secret sent as blank means "leave it alone", not "clear it".
 *
 * The form cannot read the secret back, so a blank field is the normal state of an
 * operator who did not touch it. Dropping the key keeps the stored value; clearing
 * it is a separate, explicit action.
 */
export function dropBlankOidcSecret(body: Record<string, unknown>): Record<string, unknown> {
	if (!Object.hasOwn(body, "oidcClientSecret")) return body
	const value = body.oidcClientSecret
	if (typeof value === "string" && value.trim()) return body
	const copy = { ...body }
	delete copy.oidcClientSecret
	return copy
}

/**
 * The side effects a settings write owes the rest of the process.
 *
 * Each one exists because leaving stale state behind was a real bug: an outbound
 * proxy change that only took effect after a restart, a combo rotation that kept
 * round-robining on the old strategy, a proxy-health pin surviving the strategy
 * that pinned it, and an auto-ping scheduler that never learned about a new
 * account.
 */
export interface SettingsSideEffects {
	readonly applyOutboundProxy: boolean
	readonly resetComboRotation: boolean
	readonly resetProxyHealth: boolean
	readonly reconfigureAutoPing: boolean
}

export function sideEffectsOf(body: Record<string, unknown>): SettingsSideEffects {
	const has = (key: string) => Object.hasOwn(body, key)
	return {
		applyOutboundProxy:
			has("outboundProxyEnabled") || has("outboundProxyUrl") || has("outboundNoProxy"),
		resetComboRotation:
			has("comboStrategy") || has("comboStickyRoundRobinLimit") || has("comboStrategies"),
		resetProxyHealth: has("providerStrategies"),
		reconfigureAutoPing: has("claudeAutoPing") || has("codexAutoPing"),
	}
}

/**
 * The settings the dashboard needs before it can render a login form.
 *
 * Both booleans default to *true when the stored value is anything but an explicit
 * `false`. That is the safe direction: a row written before the field existed, or
 * a row that failed to parse, must not silently switch the login gate off.
 */
export function loginGateView(settings: Record<string, unknown>): {
	requireLogin: boolean
	tunnelDashboardAccess: boolean
	tunnelUrl: string
	tailscaleUrl: string
} {
	return {
		requireLogin: settings.requireLogin !== false,
		tunnelDashboardAccess: settings.tunnelDashboardAccess !== false,
		tunnelUrl: typeof settings.tunnelUrl === "string" ? settings.tunnelUrl : "",
		tailscaleUrl: typeof settings.tailscaleUrl === "string" ? settings.tailscaleUrl : "",
	}
}

/**
 * Whether this session may read history and revert a change.
 *
 * Only a password sign-in may: history contains the install's configuration, and a
 * revert rewrites it. Answering `false` without a session means an unauthenticated
 * caller gets the same 401 as a key-signed one, which is what the routes did.
 */
export function mayRevertSettings(role: string | null | undefined): boolean {
	if (!role) return false
	return role !== "apikey"
}

/**
 * Narrow a stored snapshot to the keys the caller asked to restore.
 *
 * With no `keys`, every key is restored. With `keys`, only those present in the
 * snapshot are kept — asking for a key the snapshot does not carry restores
 * nothing for it rather than writing `undefined`, which would delete the setting.
 */
export function revertPatchOf(
	snapshot: Record<string, unknown>,
	keys: unknown,
): Record<string, unknown> {
	if (!Array.isArray(keys) || keys.length === 0) return { ...snapshot }
	const allowed = new Set(keys.map(String))
	const patch: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(snapshot)) {
		if (allowed.has(key)) patch[key] = value
	}
	return patch
}

/**
 * A revert with nothing to apply is refused rather than reported as success.
 *
 * This happens when every key in the snapshot is a secret, or when the caller asked
 * only for keys the snapshot does not have. Saying "ok, nothing restored" would
 * leave the operator believing the change was undone.
 */
export function revertIsEmpty(patch: Record<string, unknown>): boolean {
	return Object.keys(patch).length === 0
}
