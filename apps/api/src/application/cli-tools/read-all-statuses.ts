/**
 * Every CLI tool's status in one answer.
 *
 * The dashboard asks this once on load instead of nineteen times, so the shape of the *answer*
 * matters as much as the contents: a tool whose status cannot be read is reported as `null`
 * rather than omitted. The screen renders a row per tool either way, and a missing key would
 * read as "this tool does not exist" instead of "this one could not be read".
 *
 * The readers arrive as a map, because each tool needs different host access — a config port,
 * an `env` block, a profile directory — and none of that can cross the boundary.
 */

/** One tool's status, or null when reading it failed. */
export type ToolStatus = Record<string, unknown> | null

/** A flat answer, matching the other CLI-tool answers. */
export interface AllStatusesAnswer {
	readonly status: number
	readonly body: Record<string, ToolStatus>
}

/**
 * Reads every tool's status concurrently.
 *
 * The readers are run through `Promise.all` over the *entries*, not over a list of names, so the
 * keys of the answer are exactly the keys of the map — a reader added to the map appears in the
 * answer with no second list to update.
 *
 * A reader that throws yields `null` for its own tool and does not fail the batch. One broken
 * tool must not blank the whole screen: the operator is here to see the other eighteen.
 */
export async function readAllToolStatuses(
	readers: Readonly<Record<string, () => Promise<Record<string, unknown>>>>,
): Promise<AllStatusesAnswer> {
	const entries = await Promise.all(
		Object.entries(readers).map(async ([toolId, read]) => {
			try {
				return [toolId, await read()] as const
			} catch {
				return [toolId, null] as const
			}
		}),
	)
	return { status: 200, body: Object.fromEntries(entries) }
}
