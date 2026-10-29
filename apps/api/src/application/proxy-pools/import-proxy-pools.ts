import { invalid, notFound } from "../../domain/errors.ts"
import {
	IMPORT_POLL_MS,
	type ImportEntry,
	importRefusalOf,
	readImportEntries,
} from "../../domain/proxy-import.ts"

/**
 * Starting, watching, and stopping a bulk proxy-pool import.
 *
 * The job runs on the server so it survives the browser closing, and the dashboard polls
 * for progress. This use-case owns the three decisions the screen depends on: which rows
 * are importable, what a poll for an unknown job means, and whether a cancel found
 * anything — because each of those is reported as a different status.
 */

/** How far one import got, as the progress banner reads it. */
export interface ImportCounts {
	readonly created: number
	readonly skipped: number
	readonly failed: number
	readonly processed: number
	readonly total: number
}

/** A job row, as the dashboard reads it back while polling. */
export interface ImportJobView {
	readonly id: string
	readonly status: "queued" | "running" | "done" | "error" | "cancelled"
	readonly progress: number
	readonly message: string
	readonly counts: ImportCounts
	readonly error: string | null
	readonly cancelRequested: boolean
	readonly createdAt: string
	readonly updatedAt: string
}

/** What starting a job answers: enough to poll it, not the whole row. */
export interface StartedImportJob {
	readonly jobId: string
	readonly status: string
	readonly total: number
}

export interface ImportJobDeps {
	/** Start a job over the rows that passed validation. */
	readonly create: (entries: readonly ImportEntry[]) => StartedImportJob
	readonly find: (id: string) => ImportJobView | null
	/** Recent jobs, newest first; the screen keeps only a page of them. */
	readonly list: () => readonly ImportJobView[]
	/** Ask a running job to stop. Returns false when there is no such job. */
	readonly cancel: (id: string) => boolean
}

/** How many recent jobs the dashboard reattaches to. */
const RECENT_JOBS = 10

/**
 * `POST /api/proxy-pools/import-jobs` — { entries: [{ name, proxyUrl }] }.
 *
 * Answers 202 with the job and the interval to poll at: the import has been accepted, not
 * finished, and a 200 would invite the screen to read a partial job as the final result.
 */
export function startProxyImport(
	body: Record<string, unknown>,
	deps: ImportJobDeps,
): { jobId: string; status: string; total: number; pollMs: number } {
	const { entries, errors } = readImportEntries(body.entries)
	const refusal = importRefusalOf(errors, entries)
	if (refusal) throw invalid(refusal)

	const job = deps.create(entries)
	return { jobId: job.jobId, status: job.status, total: job.total, pollMs: IMPORT_POLL_MS }
}

/**
 * `GET /api/proxy-pools/import-jobs` — one job by `?id=`, else the recent page.
 *
 * An id that matches nothing is a 404 rather than an empty page: the dashboard polls this
 * while a job is running, and "gone" must not read as "nothing to report yet".
 */
export function readProxyImportJobs(
	query: URLSearchParams,
	deps: ImportJobDeps,
): { job: ImportJobView } | { jobs: readonly ImportJobView[] } {
	const id = query.get("id")
	if (!id) return { jobs: deps.list().slice(0, RECENT_JOBS) }

	const job = deps.find(id)
	if (!job) throw notFound("Job not found")
	return { job }
}

/** `DELETE /api/proxy-pools/import-jobs?id=` — ask a running job to stop. */
export function cancelProxyImport(query: URLSearchParams, deps: ImportJobDeps): { ok: true } {
	const id = query.get("id")
	if (!id) throw invalid("Missing job id")
	if (!deps.cancel(id)) throw notFound("Job not found")
	return { ok: true }
}
