// In-memory proxy-import job store.
//
// Why a server-side job at all: the batch import used to be a loop of client
// POSTs driven by the page component. That loop died with the tab - closing the
// browser, refreshing, or navigating away mid-import stopped it halfway and
// left the operator with pools half-written and no way to resume. "Run in
// background" only ever meant "keep running while this tab stays open".
//
// The job now runs here, on the server, kicked off with setImmediate. The
// browser polls for progress and can leave. That is the same shape as
// importJobs.js (the database restore job), which is why this lives beside it
// rather than in a new subsystem.
//
// Process-local on purpose, same as importJobs: progress is polled by the same
// server that accepted the POST, and a 9router restart legitimately abandons
// an in-flight import. Records are kept for RESULT_TTL_MS after completion so
// the dashboard can show the outcome of a run the operator stopped watching.
import { randomUUID } from "node:crypto"
import { createJobStore, touchJob } from "@9router/db/jobStore"

const RESULT_TTL_MS = 15 * 60 * 1000

const { getStore, scheduleResultCleanup } = createJobStore({
	globalKey: "proxyImportJobs",
	resultTtlMs: RESULT_TTL_MS,
})
// How often the client is told to poll. Fast enough to feel live, slow enough
// that a forgotten tab costs almost nothing.
export const PROXY_IMPORT_POLL_MS = 1000

/**
 * Claim a queued job and run it to completion. One job runs at a time per
 * process: two concurrent bulk inserts of proxy pools race on the same
 * uniqueness check and report a confusing mix of created and skipped rows.
 */
let running = false

async function drainQueue() {
	if (running) return
	const store = getStore()
	const next = [...store.values()].find((j) => j.status === "queued")
	if (!next) return

	running = true
	next.status = "running"
	next.message = "Import started"
	touchJob(next)

	try {
		const { createProxyPool, getProxyPools } = await import("@/models")

		const total = Array.isArray(next.entries) ? next.entries.length : 0
		let created = 0
		let failed = 0
		let processed = 0

		// Names already taken: the table has no uniqueness constraint, so a
		// duplicate import would otherwise create a second pool with the same name
		// and leave the operator with two rows to tell apart. Skip those instead.
		const existingNames = new Set(
			(await getProxyPools()).map((p: { name?: string }) => String(p.name || "").trim()),
		)
		let skipped = 0

		for (const entry of next.entries || []) {
			if (next.cancelRequested) {
				next.status = "cancelled"
				next.message = `Stopped after ${processed}/${total}`
				next.counts = { created, skipped, failed, processed, total }
				next.entries = null
				touchJob(next)
				return
			}

			const name = String(entry.name || "").trim()
			if (existingNames.has(name)) {
				skipped += 1
			} else {
				try {
					await createProxyPool({
						name,
						proxyUrl: entry.proxyUrl,
						noProxy: "",
						type: "http",
						isActive: true,
					})
					existingNames.add(name)
					created += 1
				} catch (err) {
					failed += 1
					if (failed === 1) next.error = err?.message || "Failed to create a proxy pool"
				}
			}

			processed += 1
			next.progress = total > 0 ? Math.round((processed / total) * 100) : 100
			next.message = `${processed}/${total} proxies`
			next.counts = { created, skipped, failed, processed, total }
			touchJob(next)
		}

		next.progress = 100
		next.status = "done"
		next.message =
			`Imported ${created}` +
			(skipped ? `, skipped ${skipped} existing` : "") +
			(failed ? `, failed ${failed}` : "")
		next.counts = { created, skipped, failed, processed, total }
		// The entries are the bulk of the record; drop them once counted.
		next.entries = null
		touchJob(next)
	} catch (err) {
		next.status = "error"
		next.message = "Import failed"
		next.error = err?.message || "Failed to import proxies"
		next.entries = null
		touchJob(next)
	} finally {
		running = false
		scheduleResultCleanup(next.id)
	}

	// A job queued behind this one starts now.
	setImmediate(drainQueue)
}

/**
 * Queue a batch import. `entries` is the already-parsed and validated list:
 * parsing stays on the client so the operator still sees a per-line format
 * error before anything is queued.
 */
export function createProxyImportJob(entries) {
	const list = Array.isArray(entries) ? entries : []
	if (list.length === 0) throw new Error("Nothing to import")

	const now = new Date().toISOString()
	const jobId = randomUUID()
	getStore().set(jobId, {
		id: jobId,
		status: "queued",
		progress: 0,
		message: `0/${list.length} proxies`,
		counts: { created: 0, skipped: 0, failed: 0, processed: 0, total: list.length },
		error: null,
		entries: list,
		cancelRequested: false,
		createdAt: now,
		updatedAt: now,
	})

	if (typeof setImmediate === "function") setImmediate(drainQueue)
	else setTimeout(drainQueue, 0)

	return { jobId, status: "queued", total: list.length }
}

export function getProxyImportJob(jobId) {
	if (!jobId) return null
	const job = getStore().get(jobId)
	if (!job) return null
	// `entries` never leaves the server: it is the pasted proxy list, and a poll
	// response is not the place to echo credentials back.
	const { entries, ...rest } = job
	return rest
}

export function cancelProxyImportJob(jobId) {
	const job = getStore().get(jobId)
	if (!job) return false
	if (job.status === "queued" || job.status === "running") {
		job.cancelRequested = true
		touchJob(job)
	}
	return true
}

/** Every job the dashboard may want to reattach to after a reload. */
export function listProxyImportJobs() {
	return [...getStore().values()]
		.map(({ entries, ...rest }) => rest)
		.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}
