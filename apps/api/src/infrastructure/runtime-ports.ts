/**
 * Adapters for the three process-level use-cases.
 *
 * These sit at the edge on purpose: the engine counters, the job registry and
 * the process itself are runtime state, not data, so there is no repository to
 * put them behind. Each one is a thin translation and nothing else — every rule
 * lives in `domain/shutdown-gate.ts` or the use-case.
 */
import {
	cancelDashboardJob,
	createDashboardJob,
	DASHBOARD_JOB_POLL_MS,
	getDashboardJob,
	hasDashboardJobHandler,
	listDashboardJobs,
} from "@9router/db/dashboardJobs"
import type { SemanticCachePort, SemanticCacheStats } from "../application/system/cache-stats.ts"
import type {
	DashboardJob,
	DashboardJobEnvironment,
	DashboardJobRegistry,
} from "../application/system/dashboard-jobs.ts"
import type { ShutdownPorts } from "../application/system/shutdown.ts"

/**
 * The statuses a job is still working through. Named here as data so the bell
 * does not need a route change when the model grows a status.
 */
const LIVE_JOB_STATUSES = ["queued", "running"] as const

export function createDashboardJobRegistry(): DashboardJobRegistry {
	return {
		create(kind, payload, title) {
			return createDashboardJob(kind, payload, title)
		},
		get(id): DashboardJob | null {
			// The db view already strips the payload; the assertion only admits the
			// progress fields it carries under an index signature.
			return (getDashboardJob(id) as DashboardJob | null) ?? null
		},
		list(): readonly DashboardJob[] {
			return listDashboardJobs() as readonly DashboardJob[]
		},
		cancel(id) {
			return cancelDashboardJob(id)
		},
	}
}

/**
 * `knownKinds` is a predicate over the live handler map, not a second copy of
 * the list: the set of kinds is whatever the host registered at import time, so
 * a literal here would go stale the day someone adds a handler.
 */
export function createDashboardJobEnvironment(
	knownKinds: readonly string[],
): DashboardJobEnvironment {
	return {
		liveStatuses: LIVE_JOB_STATUSES,
		pollMs: DASHBOARD_JOB_POLL_MS,
		knownKinds: knownKinds.filter((kind) => hasDashboardJobHandler(kind)),
	}
}

/** Every operation this app registers a handler for. */
export const DASHBOARD_JOB_KINDS = ["proxy-test", "relay-deploy"] as const

/**
 * The counters live in `open-sse`, which `apps/api` does not bundle. The host
 * that owns the engine installs it; without it the port reports zeroed counters
 * rather than throwing, because a dashboard panel failing to render its numbers
 * is worse than a panel showing zeros.
 */
export function createSemanticCachePort(): SemanticCachePort {
	return {
		read(): SemanticCacheStats {
			return cacheModule?.getSemanticCacheStats() ?? ZERO_STATS
		},
		resetCounters() {
			cacheModule?.resetSemanticCacheStats()
		},
	}
}

/** The shape `open-sse/rtk/semanticCache` exposes, narrowed to what is used. */
export interface SemanticCacheModule {
	getSemanticCacheStats(): SemanticCacheStats
	resetSemanticCacheStats(): void
}

let cacheModule: SemanticCacheModule | null = null

export function installSemanticCacheModule(module: SemanticCacheModule): void {
	cacheModule = module
}

const ZERO_STATS: SemanticCacheStats = {
	hits: 0,
	misses: 0,
	saves: 0,
	evictions: 0,
	entries: 0,
	ttlMs: 0,
}

export interface ShutdownHost {
	/** Close the SQLite handle. */
	closeDatabase(): Promise<void>
	/** Stop the background processes this app manages. */
	stopManagedProcesses(): Promise<void>
}

export function createShutdownPorts(host: ShutdownHost): ShutdownPorts {
	return {
		closeDatabase: () => host.closeDatabase(),
		stopManagedProcesses: () => host.stopManagedProcesses(),
		exitAfter(delayMs, code) {
			// Not `unref`: the timer must keep the process alive long enough to fire.
			setTimeout(() => process.exit(code), delayMs)
		},
	}
}

export function createShutdownEnvironment(): {
	nodeEnv: string | undefined
	secret: string | undefined
} {
	return { nodeEnv: process.env.NODE_ENV, secret: process.env.SHUTDOWN_SECRET }
}
