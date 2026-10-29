/**
 * Rules for admitting a caller to the database export/import endpoints.
 *
 * Four ways in exist, and each exists for a reason that was not obvious from the
 * three handlers that used to repeat it:
 *
 * 1. **A CLI token** — the operator running 9router on their own machine already
 *    has the database; re-asking for a password proves nothing.
 * 2. **A password** — the dashboard's way in.
 * 3. **A poll token** — issued when an import job was created, and the *only*
 *    reliable credential during a restore: the import replaces the settings row
 *    that stores the password hash, so a password check mid-import compares against
 *    the wrong row and 401s a caller who is already authenticated. That failure was
 *    reported to the operator as "Invalid password" over a restore that had in fact
 *    committed.
 * 4. **The summary exemption** — `?summary=true` needs nothing.
 *
 * A summary is what the login screen shows before anyone has proved anything, so
 * requiring the password would make it useless.
 */

/** The header a local CLI presents instead of a password. */
export const CLI_TOKEN_HEADER = "x-9r-cli-token"

/** The header the dashboard presents a password in (not a body, not a query). */
export const PASSWORD_HEADER = "x-9r-password"

/** The header an import-job poll presents the token it was issued. */
export const POLL_TOKEN_HEADER = "x-9r-poll-token"

/**
 * The largest import body accepted, in bytes.
 *
 * 50 MiB: a full export of a heavily used install is data, not blobs, and a body
 * larger than this is far more likely a mistake than a real backup.
 */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024

/**
 * A local CLI is trusted.
 *
 * The check is only that the header is present: the value is never compared,
 * because the header is not a secret — its presence means "this request came from
 * the machine that holds the database", which the server's bind address is what
 * actually guarantees.
 */
export function isCliRequest(cliToken: string | null | undefined): boolean {
	return Boolean(cliToken)
}

/** What proof an export/import request must present. */
export type DatabaseAccess =
	| { readonly kind: "cli" }
	| { readonly kind: "summary" }
	| { readonly kind: "password"; readonly password: string | null }
	| {
			readonly kind: "poll"
			readonly pollToken: string | null
			readonly password: string | null
	  }

/**
 * Which proof an export request must present.
 *
 * The order matters: a summary needs nothing, a CLI request needs nothing further,
 * everything else needs a password.
 */
export function exportAccessOf(input: {
	summary: boolean
	cli: boolean
	password: string | null
}): DatabaseAccess {
	if (input.summary) return { kind: "summary" }
	if (input.cli) return { kind: "cli" }
	return { kind: "password", password: input.password }
}

export function importAccessOf(input: { cli: boolean; password: string | null }): DatabaseAccess {
	if (input.cli) return { kind: "cli" }
	return { kind: "password", password: input.password }
}

/**
 * Which proof an import-job poll must present.
 *
 * The poll token is checked first and the password only as a fallback: the import
 * replaces the row the password is checked against, so preferring the password
 * would 401 an already-authenticated poll mid-restore.
 */
export function pollAccessOf(input: {
	cli: boolean
	pollToken: string | null
	password: string | null
}): DatabaseAccess {
	if (input.cli) return { kind: "cli" }
	return { kind: "poll", pollToken: input.pollToken, password: input.password }
}

/** Read the credentials a request presents. */
export function presentedBy(headers: { get(name: string): string | null }): {
	cli: boolean
	password: string | null
	pollToken: string | null
} {
	return {
		cli: isCliRequest(headers.get(CLI_TOKEN_HEADER)),
		password: headers.get(PASSWORD_HEADER),
		pollToken: headers.get(POLL_TOKEN_HEADER),
	}
}

/**
 * The sections an export should carry.
 *
 * `sections=a,b` exports those; no parameter exports everything. Blank entries are
 * dropped rather than passed on, so `sections=a,,b` means two sections and not
 * three with an empty name — and `sections=,,` means everything, not nothing.
 */
export function exportSectionsOf(raw: string | null): string[] | null {
	if (!raw) return null
	const sections = raw
		.split(",")
		.map((section) => section.trim())
		.filter(Boolean)
	return sections.length > 0 ? sections : null
}

/**
 * Whether a declared body size is too large to accept.
 *
 * A missing `content-length` is not refused: the transport enforces its own limit,
 * and refusing an unstated size would reject chunked uploads that are within it.
 */
export function bodyTooLarge(contentLength: string | null): boolean {
	const declared = Number(contentLength ?? 0)
	return Number.isFinite(declared) && declared > MAX_IMPORT_BYTES
}

/**
 * The progress shape of an import job.
 *
 * `error` is present only on a failed job, and stays optional rather than
 * defaulting to an empty string: the dashboard tells "failed, here is why" from
 * "still running" by its presence.
 */
export interface ImportJobProgress {
	readonly status: string
	readonly progress: number
	readonly section: string | null
	readonly message: string | null
	readonly error?: string
}

export function importJobProgress(job: {
	status: string
	progress?: { percent?: number | null; currentSection?: string | null } | null
	message?: string | null
	error?: string | null
}): ImportJobProgress {
	const progress: ImportJobProgress = {
		status: job.status,
		progress: job.progress?.percent ?? 0,
		section: job.progress?.currentSection || null,
		message: job.message || null,
	}
	return job.status === "error"
		? { ...progress, error: job.error || "Failed to import database" }
		: progress
}
