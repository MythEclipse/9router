import {
	bodyTooLarge,
	type DatabaseAccess,
	exportAccessOf,
	exportSectionsOf,
	importAccessOf,
	importJobProgress,
	presentedBy,
} from "../../domain/database-access.ts"
import { AppError, invalid, tooLarge, unauthorized } from "../../domain/errors.ts"

/**
 * Exporting and importing the whole install.
 *
 * Three endpoints answer this: a synchronous export, a synchronous import, and an
 * import that runs as a job the client polls. The rules that decide *who may* do any
 * of it live in `domain/database-access.ts`; what is here is the order the checks run
 * in and what each answer means.
 */

/** A job as the store keeps it. */
export interface StoredImportJob {
	readonly status: string
	readonly progress?: { percent?: number | null; currentSection?: string | null } | null
	readonly message?: string | null
	readonly error?: string | null
}

export interface DatabaseDeps {
	/** Compare a password against the stored hash. */
	readonly verifyPassword: (password: string | null) => Promise<boolean>
	/** Read the summary the login screen shows before anyone has signed in. */
	readonly summary: () => Promise<unknown>
	/** Serialise the requested sections, or everything when `sections` is null. */
	readonly exportSections: (sections: string[] | null) => Promise<unknown>
	/** Replace the install with a payload. */
	readonly importPayload: (payload: Record<string, unknown>) => Promise<void>
	/** Re-apply the effects an import invalidated (proxy env, backup schedule). */
	readonly afterImport: () => Promise<void>
	/** Start a background import and answer its handle. */
	readonly startJob: (payload: Record<string, unknown>) => {
		jobId: string
		status: string
		pollToken: string
	}
	/** Read a background import, or null when no such job is known. */
	readonly findJob: (jobId: string) => StoredImportJob | null
	/** Whether a poll token is the one this job was issued. */
	readonly verifyPollToken: (job: StoredImportJob, token: string) => boolean
}

export interface DatabaseInput {
	readonly searchParams: URLSearchParams
	readonly credentials: DatabaseCredentials
	readonly contentLength: string | null
}

export interface DatabaseCredentials {
	readonly cli: boolean
	readonly password: string | null
	readonly pollToken: string | null
}

/** Turn the headers off a request into the credentials the rules expect. */
export function credentialsFrom(headers: {
	get(name: string): string | null
}): DatabaseCredentials {
	return presentedBy(headers)
}

/**
 * Refuse unless the presented proof satisfies what the rule demanded.
 *
 * A missing password is refused without hashing it. That is not an optimisation:
 * comparing against a hash cannot succeed, and leaving the decision to the host
 * invites a host that treats "no password" as "the empty password" — which would let
 * an install with no password set be exported by anyone who asks.
 */
async function admit(access: DatabaseAccess, deps: DatabaseDeps): Promise<void> {
	if (access.kind === "cli" || access.kind === "summary") return
	if (await deps.verifyPassword(access.password)) return
	throw unauthorized("Invalid password")
}

/**
 * `GET /api/settings/database` — the whole install, or one summary of it.
 *
 * `?summary=true` is answered before any credential is looked at, because it is what
 * the login screen shows to someone who has not signed in yet.
 */
export async function readDatabase(input: DatabaseInput, deps: DatabaseDeps): Promise<unknown> {
	const summary = input.searchParams.get("summary") === "true"
	const access = exportAccessOf({
		summary,
		cli: input.credentials.cli,
		password: input.credentials.password,
	})
	await admit(access, deps)
	if (access.kind === "summary") return deps.summary()
	return deps.exportSections(exportSectionsOf(input.searchParams.get("sections")))
}

/**
 * The password and the payload, separated.
 *
 * The synchronous import took its password in the body while every other endpoint
 * takes it in a header, and the body carries the database itself — so a `password`
 * key must be removed before the payload is handed to the writer, or it becomes a
 * row.
 */
function bodySplit(body: Record<string, unknown>): {
	payload: Record<string, unknown>
	password: string | null
} {
	const { password, ...payload } = body
	const text = typeof password === "string" ? password : ""
	return { payload, password: text || null }
}

/**
 * `POST /api/settings/database` — replace the install, synchronously.
 */
export async function writeDatabase(
	input: { readonly body: Record<string, unknown>; readonly credentials: DatabaseCredentials },
	deps: DatabaseDeps,
): Promise<{ success: true }> {
	const { payload, password } = bodySplit(input.body)
	await admit(importAccessOf({ cli: input.credentials.cli, password }), deps)
	await deps.importPayload(payload)
	await deps.afterImport()
	return { success: true }
}

export interface StartedJob {
	readonly jobId: string
	readonly status: string
	readonly pollToken: string
}

/**
 * `POST /api/settings/database/jobs` — replace the install in the background.
 *
 * Answers 202 with a poll token. The token is not a convenience: the import replaces
 * the settings row that stores the password hash, so a client polling with the
 * password would be compared against the row it just overwrote and told its password
 * was wrong — while the restore in fact committed. That is the failure this token
 * exists to prevent.
 */
export async function startDatabaseJob(
	input: {
		readonly body: Record<string, unknown>
		readonly credentials: DatabaseCredentials
		readonly contentLength: string | null
	},
	deps: DatabaseDeps,
): Promise<StartedJob> {
	if (bodyTooLarge(input.contentLength)) throw tooLarge()
	const { payload, password } = bodySplit(input.body)
	await admit(importAccessOf({ cli: input.credentials.cli, password }), deps)
	const job = deps.startJob(payload)
	return { jobId: job.jobId, status: job.status, pollToken: job.pollToken }
}

/**
 * `GET /api/settings/database/jobs/[jobId]` — how far the restore has got.
 *
 * The poll token is checked first, the password only as a fallback for jobs created
 * before the token existed and for CLI callers.
 */
export async function readDatabaseJob(
	input: { readonly jobId: string; readonly credentials: DatabaseCredentials },
	deps: DatabaseDeps,
): Promise<ReturnType<typeof importJobProgress>> {
	if (!input.jobId) throw invalid("Missing job id")
	const job = deps.findJob(input.jobId)
	if (!job) throw new AppError("NOT_FOUND", "Job not found")
	if (!input.credentials.cli) {
		const byToken =
			Boolean(input.credentials.pollToken) &&
			deps.verifyPollToken(job, input.credentials.pollToken ?? "")
		if (!byToken && !(await deps.verifyPassword(input.credentials.password))) {
			throw unauthorized("Invalid password")
		}
	}
	return importJobProgress(job)
}
