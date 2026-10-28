// In-memory background import job store.
//
// Survives Next.js dev hot-reload via globalThis (same pattern as the db
// driver). Jobs are process-local on purpose: the dashboard polls the same
// server process that accepted the POST.
//
// Each job carries a poll credential issued at creation (see importJobAuth.js):
// the import rewrites the settings row that holds the dashboard password
// hash, so a progress poll must not re-derive trust from the database.
import { randomUUID } from "node:crypto"
import { issuePollToken } from "./importJobAuth.ts"
import { createJobStore, touchJob } from "./jobStore.ts"

const RESULT_TTL_MS = 10 * 60 * 1000

/**
 * Post-import refresh hooks.
 *
 * These used to be dynamic imports straight into `apps/web`, which made the
 * shared package depend on one of its consumers. The consumer registers them
 * instead; an app that has no such hooks (the oRPC API) simply leaves them
 * unset and the calls become no-ops that log nothing.
 */
export interface PostImportHooks {
	reapplyOutboundProxy?: () => Promise<void>
	rescheduleAutoBackup?: () => Promise<void>
}

let postImportHooks: PostImportHooks = {}

/** Progress a running import reports, as the dashboard polls it. */
export interface ImportProgress {
	done: number
	total: number
	percent: number
	currentSection: string
}

/** One background import job. Process-local; see the header comment. */
export interface ImportJob {
	id: string
	status: "queued" | "running" | "done" | "error"
	progress: ImportProgress | null
	message: string
	error: string | null
	payload: Record<string, unknown> | null
	pollTokenHash: string | null
	createdAt: string
	updatedAt: string
}

export function registerPostImportHooks(hooks: PostImportHooks): void {
	postImportHooks = { ...postImportHooks, ...hooks }
}

const { getStore, scheduleResultCleanup } = createJobStore<ImportJob>({
	globalKey: "importJobs",
	resultTtlMs: RESULT_TTL_MS,
})

async function runImportJob(jobId: string): Promise<void> {
	const store = getStore()
	const job = store.get(jobId)
	if (!job || job.status !== "queued") return

	job.status = "running"
	job.message = "Import started"
	touchJob(job)

	try {
		const { importDbProgressive } = await import("./index.ts")
		await importDbProgressive(job.payload, (progress) => {
			const current = store.get(jobId)
			if (!current) return
			current.progress = progress
			current.message = `Importing ${progress.currentSection} (${progress.done}/${progress.total})`
			touchJob(current)
		})

		const current = store.get(jobId)
		if (!current) return
		current.progress = {
			done: current.progress?.total ?? 0,
			total: current.progress?.total ?? 0,
			percent: 100,
			currentSection: "done",
		}
		current.payload = null
		// The poll digest stays until the job record itself expires: nulling it
		// here made the completion polls fall back to the password header - which
		// the token-based client no longer sends - so the last poll answered
		// 401 "Invalid password" over a restore that had just reported done.
		// RESULT_TTL cleanup removes the record (and this digest) shortly after.

		try {
			await postImportHooks.reapplyOutboundProxy?.()
		} catch (err) {
			console.warn("[Settings][DatabaseImport] Failed to re-apply outbound proxy env:", err)
		}

		try {
			await postImportHooks.rescheduleAutoBackup?.()
		} catch (err) {
			console.warn("[Settings][DatabaseImport] Failed to reschedule auto backup:", err?.message || err)
		}

		current.status = "done"
		current.message = "Import completed"
		touchJob(current)
	} catch (err) {
		const current = store.get(jobId)
		if (!current) return
		current.status = "error"
		current.error = err?.message || "Failed to import database"
		current.message = "Import failed"
		current.payload = null
		touchJob(current)
	} finally {
		scheduleResultCleanup(jobId)
	}
}

export function createImportJob(payload: Record<string, unknown>): {
	jobId: string
	status: string
	pollToken: string
} {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("Invalid database payload")
	}
	const jobId = randomUUID()
	const now = new Date().toISOString()
	// The client's poll credential for this job: issued here, once, so polling
	// never has to ask the database for a password hash the import is busy
	// overwriting. Only the digest stays on the job; the token itself leaves
	// with the POST response.
	const { token, hash } = issuePollToken()
	getStore().set(jobId, {
		id: jobId,
		status: "queued",
		progress: { done: 0, total: 0, percent: 0, currentSection: "queued" },
		message: "Import queued",
		error: null,
		payload,
		pollTokenHash: hash,
		createdAt: now,
		updatedAt: now,
	})
	if (typeof setImmediate === "function") setImmediate(() => runImportJob(jobId))
	else setTimeout(() => runImportJob(jobId), 0)
	return { jobId, status: "queued", pollToken: token }
}

export function getImportJob(jobId: string | null | undefined): ImportJob | null {
	if (!jobId) return null
	return getStore().get(jobId) || null
}
