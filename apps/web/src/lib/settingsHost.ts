import { recordSecurityEvent } from "@9router/db/repos/securityLogRepo"
import {
	getSettingsSnapshot,
	getSettingsSnapshotCount,
	listSettingsHistory,
	sanitizeHistorySnapshot,
	snapshotSettings,
} from "@9router/db/repos/settingsHistoryRepo"
import bcrypt from "bcryptjs"
import { resetComboRotation } from "open-sse/services/combo"
import { getSettings, updateSettings } from "@/lib/localDb"
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy"
import { resetProxyHealth } from "@/lib/network/proxyHealth"

/**
 * Hashing and comparison for the settings password.
 *
 * bcrypt at ten rounds, and deliberately nothing cleverer: the stored hashes are
 * bcrypt, so a different algorithm here would read as "wrong password" for every
 * existing install on its first attempt to change one.
 */
export const settingsPassword = {
	comparePassword: (candidate: string, hash: string) => bcrypt.compare(candidate, hash),
	hashPassword: async (plain: string) => bcrypt.hash(plain, await bcrypt.genSalt(10)),
}

/**
 * What a settings write owes the rest of the process.
 *
 * Every one of these is here because leaving it out was a real bug: a proxy change
 * that only took effect after a restart, a combo rotation that kept using the
 * strategy it was told to abandon, a proxy-health pin outliving the strategy that
 * pinned it, and an auto-ping scheduler that never learned about a new account.
 */
export const settingsWriteBack = {
	/**
	 * A before-image, so a bad change can be reverted.
	 *
	 * Called directly rather than through a repository port because it writes its
	 * own table and has no rules of its own — the use-case decides *what* to record.
	 */
	snapshot: async (before: Record<string, unknown>, reason: string) => {
		await snapshotSettings({ before, actor: "Password user", reason })
	},

	effects: {
		applyOutboundProxy: (settings: Record<string, unknown>) =>
			applyOutboundProxyEnv(settings as never),
		// The helper takes a combo name; `undefined` is its documented "all combos".
		resetComboRotation: () => resetComboRotation(undefined as never),
		resetProxyHealth: () => resetProxyHealth(),
		reconfigureAutoPing: (settings: Record<string, unknown>) => {
			// Loaded on demand: with no account opted in, the scheduler and its
			// provider graph must not be in the process at all.
			import("@/shared/services/quotaAutoPing")
				.then(({ configureQuotaAutoPing }) => configureQuotaAutoPing(settings))
				.catch((error: Error) => console.warn("[AutoPing] settings update failed:", error.message))
		},
	},

	environmentFlags: () => ({
		requestLogs: process.env.ENABLE_REQUEST_LOGS === "true",
		translator: process.env.ENABLE_TRANSLATOR === "true",
	}),

	logWarning: (message: string, detail: unknown) => {
		console.warn(message, detail instanceof Error ? detail.message : detail)
	},
}

/** The settings row, as the use-case's store port wants it. */
export const settingsStore = {
	read: async () => (await getSettings()) as Record<string, unknown>,
	update: async (changes: Record<string, unknown>) => {
		await updateSettings(changes)
	},
}

/**
 * The settings audit trail, and the three things a revert needs beyond it.
 *
 * `sanitizeHistorySnapshot` is imported rather than reimplemented: it is the one
 * place that knows which keys must never be restored, and a second copy of that
 * list would drift.
 */
export const settingsHistoryHost = {
	history: {
		list: () => listSettingsHistory(),
		count: () => getSettingsSnapshotCount(),
		/**
		 * Normalised here because the repository's row type is `unknown` per column
		 * (it reads a `SELECT` with no schema). The use-case's contract is typed, so
		 * the loose row stops at this boundary rather than leaking inward.
		 */
		find: async (id: string) => {
			const row = await getSettingsSnapshot(id)
			if (!row) return null
			return {
				id: String(row.id),
				at: row.at == null ? null : String(row.at),
				actor: row.actor == null ? null : String(row.actor),
				reason: row.reason == null ? null : String(row.reason),
				snapshot: row.snapshot,
			}
		},
	},
	sanitize: (patch: Record<string, unknown>) => sanitizeHistorySnapshot(patch),
	recordSecurityEvent: async (event: Parameters<typeof recordSecurityEvent>[0]) => {
		await recordSecurityEvent(event)
	},
	redact: (settings: Record<string, unknown>) => {
		const { password, oidcClientSecret, ...safe } = settings
		return { ...safe, hasPassword: Boolean(password) }
	},
}
