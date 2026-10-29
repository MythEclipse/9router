/**
 * pxpipe port adapter.
 *
 * The engine lives in `apps/web/src/lib/pxpipe`, which `apps/api` does not
 * bundle. `installPxpipeEngine` lets the host that owns those modules hand them
 * over once at startup; without it the port refuses instead of reporting a
 * healthy-looking empty status, because a panel that silently shows "stopped"
 * is worse than one that says the control is unavailable.
 */
import type {
	PxpipeHealth,
	PxpipeInstallInfo,
	PxpipePort,
	PxpipeSettings,
	PxpipeStatus,
} from "../application/pxpipe/manage-pxpipe.ts"

export interface PxpipeEngine {
	getPxpipeStatus(): PxpipeStatus
	getInstallInfo(): PxpipeInstallInfo
	installPxpipe(): Promise<PxpipeInstallInfo>
	loadPxpipe(): Promise<void>
	unloadPxpipe(): boolean
	runHealthCheck(): Promise<PxpipeHealth>
	getPxpipeStats(input: { recentLimit: number }): unknown
	readPxpipeEvents(input: { limit: number }): readonly unknown[]
	getInstallLogTail(maxLines?: number): string
}

let engine: PxpipeEngine | null = null

/** Called once by the host that bundles `apps/web/src/lib/pxpipe`. */
export function installPxpipeEngine(modules: PxpipeEngine): void {
	engine = modules
}

export function createPxpipePort(): PxpipePort {
	return {
		status() {
			return requireEngine().getPxpipeStatus()
		},
		installInfo() {
			return requireEngine().getInstallInfo()
		},
		install() {
			return requireEngine().installPxpipe()
		},
		load() {
			return requireEngine().loadPxpipe()
		},
		unload() {
			return requireEngine().unloadPxpipe()
		},
		health() {
			return requireEngine().runHealthCheck()
		},
		stats(input) {
			return requireEngine().getPxpipeStats(input)
		},
		readEvents(input) {
			return requireEngine().readPxpipeEvents(input)
		},
		installLogTail() {
			return requireEngine().getInstallLogTail()
		},
	}
}

/**
 * The settings slice the panel mirrors onto the status payload.
 *
 * Passed in rather than read through `settingsRepo` here: the pxpipe flags are
 * the dashboard's own settings shape, and importing that repo would drag the
 * whole settings row through this adapter.
 */
export function createPxpipeSettings(read: PxpipeSettings["read"]): PxpipeSettings {
	return { read }
}

function requireEngine(): PxpipeEngine {
	if (engine === null) {
		throw new Error("pxpipe engine is not available in this process")
	}
	return engine
}
