/**
 * Read and write the settings row.
 *
 * Called from:
 *   - `apps/api/src/application/use-cases.ts` (`makeManageSettings`, registered as
 *     `settings`)
 *   - `apps/web/src/app/api/settings/route.ts` via
 *     `getUseCases().settings.read()` and `.write({ body, role })`
 *   - `tests/unit/use-case-manage-settings.test.ts`
 *
 * No existing file serves this purpose: `application/settings/theme.ts`,
 * `locale.ts` and `login-gate.ts` each own one field of the row; this owns the
 * general read and write. The rules deciding what a write may contain live in
 * `domain/settings.ts`; this file is the order they are applied in, plus the
 * write-back the rest of the process depends on.
 *
 * Reads: the settings row (`Record<string, unknown>`, including the `password`
 * hash and `oidcClientSecret`). Writes: the row, a before-image via `snapshot`, and
 * hashed passwords via `hashPassword`. Owed side effects are delegated to
 * `effects` — the process state they touch belongs to the host, not here.
 *
 * User instruction, verbatim: "lanjut kenapa malah berhenti".
 */

import { invalid, unauthorized } from "../../domain/errors.ts"
import {
	adminOnlyAttempt,
	dropBlankOidcSecret,
	loginGateView,
	passwordChangeOf,
	publicSettings,
	refusesAdminOnlyWrite,
	sideEffectsOf,
	stripProtectedKeys,
} from "../../domain/settings.ts"

export interface SettingsDependencies {
	/**
	 * The settings row. `update` merges into the stored row; the caller re-reads it,
	 * because a merge may normalise or ignore what was sent and the answer must be
	 * what was stored, not what was asked for.
	 */
	readonly store: {
		read(): Promise<Record<string, unknown>>
		update(changes: Record<string, unknown>): Promise<void>
	}
	/** Compare a submitted password against the stored hash. */
	readonly comparePassword: (candidate: string, hash: string) => Promise<boolean>
	/** Hash a new password before it is stored. */
	readonly hashPassword: (plain: string) => Promise<string>
	/**
	 * Keep a before-image of the row. A failure here is logged and ignored: history
	 * is a convenience, and a convenience must never fail the change itself.
	 */
	readonly snapshot: (before: Record<string, unknown>, reason: string) => Promise<void>
	/** Run whatever the write owes the rest of the process. */
	readonly effects: {
		applyOutboundProxy(settings: Record<string, unknown>): void
		resetComboRotation(): void
		resetProxyHealth(): void
		reconfigureAutoPing(settings: Record<string, unknown>): void
	}
	/** Whether the request log and translator features are switched on. */
	readonly environmentFlags: () => { requestLogs: boolean; translator: boolean }
	readonly logWarning: (message: string, detail: unknown) => void
}

/** The body of a settings write, as the boundary received it. */
export interface SettingsWrite {
	readonly body: Record<string, unknown>
	/** The role on the session that made the request, when there is one. */
	readonly role?: string | null
}

export function makeManageSettings({
	store,
	comparePassword,
	hashPassword,
	snapshot,
	effects,
	environmentFlags,
	logWarning,
}: SettingsDependencies) {
	return {
		/**
		 * The settings the dashboard may see.
		 *
		 * The password hash and the OIDC client secret never leave the process; the
		 * booleans that describe them are derived instead, because the form cannot read
		 * either value back to work them out for itself.
		 */
		async read(): Promise<Record<string, unknown>> {
			const settings = await store.read()
			const flags = environmentFlags()
			return {
				...publicSettings(settings),
				enableRequestLogs: flags.requestLogs,
				enableTranslator: flags.translator,
			}
		},

		/**
		 * The login gate, and the two URLs the dashboard needs before it renders.
		 *
		 * A read failure answers the safe default rather than an error: this is what
		 * the login page asks for, and a 500 there locks the operator out of the very
		 * screen they would use to fix it.
		 */
		async loginGate(): Promise<{
			requireLogin: boolean
			tunnelDashboardAccess: boolean
			tunnelUrl: string
			tailscaleUrl: string
		}> {
			try {
				return loginGateView(await store.read())
			} catch (error) {
				logWarning("[settings] login gate read failed", error)
				return { requireLogin: true, tunnelDashboardAccess: true, tunnelUrl: "", tailscaleUrl: "" }
			}
		},

		/**
		 * Apply a settings change.
		 *
		 * The order is deliberate and each step depends on the one before: secrets are
		 * stripped first, so a protected key never reaches the before-image or the
		 * write; the admin-only check comes before hashing, so a refused theme write
		 * costs no CPU; the password is hashed before the snapshot, so the hash is what
		 * gets recorded; and the effects run after the write, because they read the
		 * new values.
		 */
		async write({ body, role }: SettingsWrite): Promise<Record<string, unknown>> {
			let fields = stripProtectedKeys(body)

			const adminOnly = adminOnlyAttempt(fields)
			if (adminOnly) {
				if (refusesAdminOnlyWrite(role)) {
					throw invalid(
						`"${adminOnly}" is an administrator setting and cannot be changed by an API key session`,
					)
				}
				// An administrator may write it; nothing to strip.
			}

			fields = await withHashedPassword(fields)
			fields = dropBlankOidcSecret(fields)

			await recordBeforeImage(fields)
			await store.update(fields)
			const settings = await store.read()
			applyEffects(fields, settings)
			return publicSettings(settings)
		},
	}

	/**
	 * Replace a submitted plain password with its hash.
	 *
	 * The rule decides what the change still needs; the hash comparison that decides
	 * a `verify` happens here, because only this layer has the stored hash.
	 */
	async function withHashedPassword(
		fields: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		if (!fields.newPassword) return fields

		const current = await store.read()
		const storedHash = typeof current.password === "string" ? current.password : ""
		const change = passwordChangeOf(fields, Boolean(storedHash))

		if (change.kind === "refuse") {
			throw change.status === 401 ? unauthorized(change.message) : invalid(change.message)
		}
		if (change.kind === "none") return fields
		if (change.kind === "verify") {
			const matches = await comparePassword(change.current, storedHash)
			if (!matches) throw unauthorized("Invalid current password")
		}

		const next: Record<string, unknown> = {
			...fields,
			password: await hashPassword(change.newPassword),
		}
		delete next.newPassword
		delete next.currentPassword
		return next
	}

	async function recordBeforeImage(fields: Record<string, unknown>): Promise<void> {
		try {
			await snapshot(await store.read(), Object.keys(fields).join(", "))
		} catch (error) {
			logWarning("[settings-history] snapshot failed", error)
		}
	}

	function applyEffects(fields: Record<string, unknown>, settings: Record<string, unknown>): void {
		const owed = sideEffectsOf(fields)
		if (owed.applyOutboundProxy) effects.applyOutboundProxy(settings)
		if (owed.resetComboRotation) effects.resetComboRotation()
		if (owed.resetProxyHealth) effects.resetProxyHealth()
		if (owed.reconfigureAutoPing) effects.reconfigureAutoPing(settings)
	}
}
