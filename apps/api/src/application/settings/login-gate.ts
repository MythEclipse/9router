/**
 * Settings use-cases.
 *
 * Two rules shape this file:
 *
 *  - The stored settings row is the source of truth, and it is read through an
 *    injected port. Nothing here imports the database or a framework, so the
 *    same logic serves the oRPC router and any future CLI.
 *  - A read must never make the dashboard unusable. When the row cannot be
 *    read, `requireLogin` still answers `true`: failing closed on a login gate
 *    is the only safe default, and the alternative is a dashboard that silently
 *    opens up because the database hiccuped.
 */

/** The subset of the settings row these use-cases depend on. */
export interface LoginGateSettings {
	readonly requireLogin?: boolean
	readonly tunnelDashboardAccess?: boolean
	readonly tunnelUrl?: string
	readonly tailscaleUrl?: string
	/** Unvalidated on read: `domain/theme.ts` decides what an unknown value means. */
	readonly theme?: string
}

export interface LoginGate {
	readonly requireLogin: boolean
	readonly tunnelDashboardAccess: boolean
	readonly tunnelUrl: string
	readonly tailscaleUrl: string
}

export interface SettingsPort {
	/** Rejects when the row cannot be read; the caller decides what that means. */
	read(): Promise<LoginGateSettings>
	/**
	 * Merge the given fields into the stored row.
	 *
	 * The theme is the only setting written through the API so far, but it goes
	 * through the same port as the login gate because they are one row: two
	 * ports over one table would let a concurrent write discard the other's.
	 */
	update(changes: Record<string, unknown>): Promise<void>
}

/** Absent means "enabled": an older row predates the flag and keeps the gate on. */
function enabled(value: boolean | undefined): boolean {
	return value !== false
}

function text(value: string | undefined): string {
	return value ?? ""
}

/**
 * The login gate as the dashboard needs it.
 *
 * A failed read is not an error the caller has to handle: it resolves to the
 * locked-down default, and `degraded` tells a curious operator why.
 */
export async function readLoginGate(
	port: SettingsPort,
): Promise<{ gate: LoginGate; degraded: boolean }> {
	try {
		const stored = await port.read()
		return {
			gate: {
				requireLogin: enabled(stored.requireLogin),
				tunnelDashboardAccess: enabled(stored.tunnelDashboardAccess),
				tunnelUrl: text(stored.tunnelUrl),
				tailscaleUrl: text(stored.tailscaleUrl),
			},
			degraded: false,
		}
	} catch {
		// Fail closed: an unreadable row must not unlock the dashboard.
		return {
			gate: {
				requireLogin: true,
				tunnelDashboardAccess: true,
				tunnelUrl: "",
				tailscaleUrl: "",
			},
			degraded: true,
		}
	}
}
