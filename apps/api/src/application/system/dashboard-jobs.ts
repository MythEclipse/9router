/**
 * Server-side dashboard operations: start, poll, cancel.
 *
 * The route holds no rules of its own any more. Three were hiding in it:
 *
 *  - `kind` was checked for being a non-empty string but never against the
 *    registered operations. `createDashboardJob` therefore threw for an unknown
 *    kind, and the handler's `catch` turned *any* throw into 400 with the raw
 *    error message — so a storage failure and a typo were reported identically,
 *    and the message was whatever the internals happened to say.
 *  - The "live jobs" list filtered `queued | running` inline, in the route,
 *    while the job model's own vocabulary lives in the db package. A new status
 *    would have needed a route change to appear in the bell.
 *  - `body?.payload || {}` let a truthy non-object payload through, so
 *    `payload: "x"` reached the job and failed later, out of sight of the caller.
 *
 * The ports are split into commands and queries because the two live in
 * different places: jobs are an in-process registry, while knowing which kinds
 * exist is a property of the handler module.
 */

import { invalid, notFound } from "../../domain/errors.ts"

/** One job as the dashboard renders it. */
export interface DashboardJob {
	readonly id: string
	readonly kind: string
	readonly title: string
	readonly status: string
	readonly [field: string]: unknown
}

export interface DashboardJobRegistry {
	create(kind: string, payload: Record<string, unknown>, title: string): { readonly jobId: string }
	get(id: string): DashboardJob | null
	list(): readonly DashboardJob[]
	cancel(id: string): boolean
}

export interface DashboardJobEnvironment {
	/** The statuses the bell counts as live, owned by the job model. */
	readonly liveStatuses: readonly string[]
	/** How often the dashboard should poll. */
	readonly pollMs: number
	/** The kinds that have a registered handler. */
	readonly knownKinds: readonly string[]
}

export type JobStart =
	| { readonly started: true; readonly jobId: string; readonly pollMs: number }
	| { readonly started: false; readonly reason: "unknown-kind"; readonly message: string }

export function makeDashboardJobs(registry: DashboardJobRegistry, env: DashboardJobEnvironment) {
	const known = new Set(env.knownKinds)

	return {
		/** 202 with the id and the poll interval the dashboard should use. */
		async start(body: unknown): Promise<{ jobId: string; pollMs: number }> {
			const request = asStartRequest(body)
			// Checked here rather than letting the registry throw: the caller gets a
			// message naming the kind, and an unrelated failure inside the registry
			// keeps its own error instead of being reported as "bad request".
			if (!known.has(request.kind)) {
				throw invalid(
					`Unknown operation: ${request.kind || "(empty)"}`,
					`known: ${env.knownKinds.join(", ")}`,
				)
			}
			const { jobId } = registry.create(request.kind, request.payload, request.title)
			return { jobId, pollMs: env.pollMs }
		},

		/** One job's progress, or a 404. */
		async read(id: string): Promise<{ job: DashboardJob }> {
			const job = registry.get(id)
			if (job === null) throw notFound("Job")
			return { job }
		},

		/** Every live job, for the notification bell. */
		async live(): Promise<{ jobs: readonly DashboardJob[]; pollMs: number }> {
			const live = new Set(env.liveStatuses)
			return { jobs: registry.list().filter((job) => live.has(job.status)), pollMs: env.pollMs }
		},

		async cancel(id: string): Promise<{ ok: true }> {
			if (!registry.cancel(id)) throw notFound("Job")
			return { ok: true }
		},
	}
}

interface StartRequest {
	readonly kind: string
	readonly title: string
	readonly payload: Record<string, unknown>
}

/**
 * Read a start request, or refuse it.
 *
 * An absent payload means "none"; a present-but-wrong payload is a mistake worth
 * reporting, because the job would otherwise fail once it started and the caller
 * would have no way to connect that to the body it sent.
 */
function asStartRequest(body: unknown): StartRequest {
	const source = isPlainObject(body) ? body : {}
	const kind = typeof source.kind === "string" ? source.kind : ""
	const title = typeof source.title === "string" ? source.title : ""

	if (source.payload === undefined || source.payload === null) {
		return { kind, title, payload: {} }
	}
	if (!isPlainObject(source.payload)) {
		throw invalid("payload must be an object")
	}
	return { kind, title, payload: source.payload }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}
