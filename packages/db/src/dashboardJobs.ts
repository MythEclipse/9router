// In-memory job runner for dashboard operations that must outlive the tab.
//
// The proxy-import job (lib/db/proxyImportJobs) proved the shape: a long
// operation started by a click used to be a loop of fetches inside the page
// component, so closing the tab, refreshing, or navigating away killed it
// halfway. Two more operations still had that problem:
//
//   - Test all: one POST per proxy pool, up to 6 407 of them, fanned out ten at
//     a time from the browser. On a slow pool set this runs for minutes, and any
//     tab close left the health status half-written.
//   - Deploy relay: the Vercel/Cloudflare/Deno deploy each spend tens of
//     seconds inside a single POST. Closing the tab during it left the operator
//     with no deploy and no result, because the answer was being read by the
//     page component that had just gone away.
//
// So this is the same pattern with the operation behind a handler instead of a
// hardcoded import: the browser posts a request once, the server runs it, and
// every reader (banner, bell, page after a reload) polls a record it can
// reattach to.
//
// Process-local on purpose, same as importJobs and proxyImportJobs: progress is
// polled by the same server that accepted the POST, and a restart legitimately
// abandons work in flight. Completed records live RESULT_TTL_MS so the dashboard
// can still show the outcome of a run the operator stopped watching.
import { randomUUID } from "node:crypto"
import { createJobStore, touchJob } from "./jobStore.ts"

const RESULT_TTL_MS = 15 * 60 * 1000

/** How one job stands. `cancelled` is set by the handler, not by the store. */
export type DashboardJobStatus = "queued" | "running" | "done" | "error" | "cancelled"

/** Progress report a running handler publishes. */
export interface DashboardJobReport {
	progress?: number
	message?: string
	section?: string
}

/**
 * What a handler receives: its own job plus the reporter. A handler is expected
 * to check `cancelRequested` between units of work and to end by setting
 * `status`, or by throwing (which becomes an error status).
 */
export interface DashboardJobContext {
	report(update: DashboardJobReport): void
}

/** One dashboard operation running (or finished) server-side. */
export interface DashboardJob {
	id: string
	kind: string
	title: string
	status: DashboardJobStatus
	progress: number
	message: string
	section: string
	error: string | null
	result: unknown
	/** Server-side only: may carry proxy URLs or provider tokens. */
	payload: Record<string, unknown>
	cancelRequested: boolean
	createdAt: string
	updatedAt: string
}

/** A handler runs one job of its kind. Fail by throwing; that becomes `error`. */
export type DashboardJobHandler = (job: DashboardJob, ctx: DashboardJobContext) => Promise<void>

/** A job as a reader gets it: everything but the payload. */
export type DashboardJobView = Omit<DashboardJob, "payload">

/** Strip the payload, which must never leave the server. */
function toView(job: DashboardJob): DashboardJobView {
	const { payload: _payload, ...rest } = job
	return rest
}

const { getStore, scheduleResultCleanup } = createJobStore<DashboardJob>({
	globalKey: "dashboardJobs",
	resultTtlMs: RESULT_TTL_MS,
})
export const DASHBOARD_JOB_POLL_MS = 1000

/**
 * Handlers by operation kind. Each receives a job and a `report` callback; it
 * is expected to check `job.cancelRequested` between units of work and to end
 * by setting job.status itself, or by throwing (which becomes an error status).
 */
const handlers = new Map<string, DashboardJobHandler>()

export function registerDashboardJobHandler(kind: string, handler: DashboardJobHandler): void {
	handlers.set(kind, handler)
}

/**
 * One job of one kind runs at a time. Test all hammers the proxy tester and the
 * relay deploys share the same provider rate limits, so running two of either
 * side by side produced confusing partial results.
 */
const perKindRunning = new Map<string, boolean>()

async function runJob(job: DashboardJob): Promise<void> {
	const handler = handlers.get(job.kind)
	if (!handler) {
		job.status = "error"
		job.message = "Unknown operation"
		touchJob(job)
		return
	}

	job.status = "running"
	touchJob(job)

	try {
		await handler(job, {
			/** Publish progress; the banner and the bell both render from this. */
			report({ progress, message, section }) {
				if (typeof progress === "number") job.progress = progress
				if (typeof message === "string") job.message = message
				if (typeof section === "string") job.section = section
				touchJob(job)
			},
		})
	} catch (err) {
		job.status = "error"
		job.message = job.message || "Failed"
		job.error = err instanceof Error ? err.message : String(err)
		touchJob(job)
	} finally {
		if (typeof job.progress !== "number") job.progress = 100
		if (!job.status || job.status === "running") {
			job.status = "done"
			touchJob(job)
		}
		scheduleResultCleanup(job.id)
		perKindRunning.set(job.kind, false)
		// Anything queued behind this one starts now.
		setImmediate(drainQueue)
	}
}

async function drainQueue(): Promise<void> {
	for (const [kind, _handler] of handlers) {
		if (perKindRunning.get(kind)) continue
		const next = [...getStore().values()].find((j) => j.kind === kind && j.status === "queued")
		if (!next) continue
		perKindRunning.set(kind, true)
		runJob(next)
		return
	}
}

/**
 * Queue an operation. `payload` is handed back to the registered handler; like
 * the import job's `entries`, it never appears in a status response.
 */
export function createDashboardJob(
	kind: string,
	payload: Record<string, unknown> = {},
	title = "",
): { jobId: string; status: DashboardJobStatus } {
	if (!handlers.has(kind)) throw new Error(`Unknown operation: ${kind}`)

	const now = new Date().toISOString()
	const jobId = randomUUID()
	getStore().set(jobId, {
		id: jobId,
		kind,
		// A human label for the bell; the kind name is a key, not a sentence.
		title: String(title || "").trim() || kind,
		status: "queued",
		progress: 0,
		message: "Queued",
		section: "",
		error: null,
		result: null,
		payload,
		cancelRequested: false,
		createdAt: now,
		updatedAt: now,
	})

	if (typeof setImmediate === "function") setImmediate(drainQueue)
	else setTimeout(drainQueue, 0)

	return { jobId, status: "queued" }
}

/** One job, payload stripped. `null` when the record expired or never existed. */
export function getDashboardJob(jobId: string | null | undefined): DashboardJobView | null {
	if (!jobId) return null
	const job = getStore().get(jobId)
	if (!job) return null
	return toView(job)
}

export function cancelDashboardJob(jobId: string): boolean {
	const job = getStore().get(jobId)
	if (!job) return false
	if (job.status === "queued" || job.status === "running") {
		job.cancelRequested = true
		touchJob(job)
	}
	return true
}

/** Every job the bell may want to list, newest first. */
export function listDashboardJobs(): DashboardJobView[] {
	return [...getStore().values()].map(toView).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}
