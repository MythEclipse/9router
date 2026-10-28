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

/** Stamp `job.updatedAt` in place. */
export function touchJob(job) {
	job.updatedAt = new Date().toISOString()
}

/**
 * Build the accessors for one job store.
 *
 * @param globalKey   unique `globalThis` key prefix for this store
 * @param resultTtlMs how long a finished job stays readable
 */
export function createJobStore({ globalKey, resultTtlMs }) {
	const storeKey = `_${globalKey}`
	const timersKey = `_${globalKey}Timers`

	function getStore() {
		if (!globalThis[storeKey]) globalThis[storeKey] = new Map()
		return globalThis[storeKey]
	}

	function getTimers() {
		if (!globalThis[timersKey]) globalThis[timersKey] = new Map()
		return globalThis[timersKey]
	}

	/** Cancel a pending cleanup so an updated job keeps its record. */
	function clearResultTimer(jobId) {
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
	function scheduleResultCleanup(jobId) {
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
