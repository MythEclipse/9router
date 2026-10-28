/**
 * Shared scaffolding for the process-local job stores (importJobs,
 * proxyImportJobs, dashboardJobs).
 *
 * All three keep a Map of jobs on `globalThis` so a Next.js dev hot-reload does
 * not lose work in flight, and all three need the same two behaviours: stamp
 * `updatedAt` on mutation, and delete a finished record after a TTL without
 * keeping the process alive. Only the global key and the TTL differ, so the
 * mechanics live here once.
 */

/**
 * The one field the store itself owns.
 *
 * A job record is whatever its own store needs; this is the only shape the
 * shared layer touches, so the store is generic over the job instead of pinned
 * to one caller's record.
 */
export interface TouchableJob {
	updatedAt: string
}

/** Stamp `job.updatedAt` in place. */
export function touchJob(job: TouchableJob): void {
	job.updatedAt = new Date().toISOString()
}

/** What one caller must supply: the global key and the TTL. */
interface JobStoreOptions {
	/** unique `globalThis` key prefix for this store */
	globalKey: string
	/** how long a finished job stays readable */
	resultTtlMs: number
}

/** The accessors one store gets back. */
export interface JobStore<TJob extends TouchableJob> {
	getStore(): Map<string, TJob>
	getTimers(): Map<string, ReturnType<typeof setTimeout>>
	clearResultTimer(jobId: string): void
	scheduleResultCleanup(jobId: string): void
}

/**
 * Build the accessors for one job store.
 *
 * `globalThis` carries no index signature, so the two maps are asserted once
 * here — at the point that owns the key — rather than at every read in every
 * caller.
 */
export function createJobStore<TJob extends TouchableJob>(
	options: JobStoreOptions,
): JobStore<TJob> {
	const { globalKey, resultTtlMs } = options
	const storeKey = `_${globalKey}`
	const timersKey = `_${globalKey}Timers`

	function getStore(): Map<string, TJob> {
		const holder = globalThis as Record<string, unknown>
		if (!holder[storeKey]) holder[storeKey] = new Map<string, TJob>()
		return holder[storeKey] as Map<string, TJob>
	}

	function getTimers(): Map<string, ReturnType<typeof setTimeout>> {
		const holder = globalThis as Record<string, unknown>
		if (!holder[timersKey]) holder[timersKey] = new Map<string, ReturnType<typeof setTimeout>>()
		return holder[timersKey] as Map<string, ReturnType<typeof setTimeout>>
	}

	/** Cancel a pending cleanup so an updated job keeps its record. */
	function clearResultTimer(jobId: string): void {
		const timers = getTimers()
		const timer = timers.get(jobId)
		if (timer) {
			clearTimeout(timer)
			timers.delete(jobId)
		}
	}

	/**
	 * Delete a finished job after the TTL. `unref` keeps a pending TTL from
	 * holding the process open — the record is a convenience, not a reason to
	 * stay alive.
	 */
	function scheduleResultCleanup(jobId: string): void {
		const timers = getTimers()
		if (timers.has(jobId)) return
		const timer = setTimeout(() => {
			timers.delete(jobId)
			getStore().delete(jobId)
		}, resultTtlMs)
		if (typeof timer.unref === "function") timer.unref()
		timers.set(jobId, timer)
	}

	return { getStore, getTimers, clearResultTimer, scheduleResultCleanup }
}
