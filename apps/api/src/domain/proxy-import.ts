/**
 * Rules for a bulk proxy-pool import.
 *
 * The dashboard parses and validates the pasted list before it sends anything, so the job
 * receives trusted entries — but "trusted" describes who sent them, not whether they are
 * correct. The list is still checked here, because the endpoint is reachable without the
 * dashboard and a job that accepted a bad entry would fail once per row, in the
 * background, where nobody is watching.
 */

/** How often the dashboard should ask for progress, in milliseconds. */
export const IMPORT_POLL_MS = 1_000

/** How many row errors are reported before the rest are summarised. */
export const MAX_REPORTED_ENTRY_ERRORS = 10

/** One row of a bulk import, as the pool table stores it. */
export interface ImportEntry {
	readonly name: string
	readonly proxyUrl: string
}

/** The row a caller sent, before it is known to be usable. */
export type RawImportEntry = Record<string, unknown>

/**
 * Split the rows into the ones that can be imported and one error per row that cannot.
 *
 * A proxy URL must be absolute http(s): a bare `host:port` would be accepted by the pool
 * table and then fail on the first request routed through it, which is the worst place to
 * find out. The row number is 1-based in the message because that is what the operator
 * sees in the pasted list.
 */
export function readImportEntries(raw: unknown): {
	entries: ImportEntry[]
	errors: string[]
} {
	const rows: RawImportEntry[] = Array.isArray(raw) ? (raw as RawImportEntry[]) : []
	const entries: ImportEntry[] = []
	const errors: string[] = []

	rows.forEach((row, index) => {
		const name = typeof row?.name === "string" ? row.name.trim() : ""
		const proxyUrl = typeof row?.proxyUrl === "string" ? row.proxyUrl.trim() : ""
		if (!name || !/^https?:\/\//i.test(proxyUrl)) {
			errors.push(`Entry ${index + 1}: missing name or http(s) proxyUrl`)
			return
		}
		entries.push({ name, proxyUrl })
	})

	return { entries, errors }
}

/**
 * The message for a request whose rows did not all pass, or `null` when they did.
 *
 * `Nothing to import`, not a list of zero errors: an empty body is a different mistake
 * from a malformed one, and telling them apart is what lets the screen say which field to
 * look at.
 */
export function importRefusalOf(errors: string[], entries: ImportEntry[]): string | null {
	if (errors.length > 0) {
		return `Invalid entries:\n${errors.slice(0, MAX_REPORTED_ENTRY_ERRORS).join("\n")}`
	}
	if (entries.length === 0) return "Nothing to import"
	return null
}
