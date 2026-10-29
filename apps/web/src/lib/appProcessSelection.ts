/**
 * Which processes this app is allowed to stop.
 *
 * `collectAppPids` used to scan the whole `ps aux` line for the string
 * "9router" and kill whatever matched. On Linux that line includes the process's
 * arguments, so *every* shell, editor, agent or log tail whose command happened
 * to mention the project directory was killed — a `kill -9` aimed at the app hit
 * unrelated work. That is not hypothetical: it killed the shell running the
 * smoke test that exercised this endpoint.
 *
 * The rule is now: match the executable, not the argument list. A process is ours
 * when it runs one of a known set of binaries.
 */

/**
 * Command names that belong to this app.
 *
 * Bare names, no paths: `ps` reports the executable's basename, so a path in an
 * argument cannot make an unrelated process look like ours.
 */
const APP_COMMANDS = ["9router", "next-server", "cloudflared", "tray_darwin", "tray_linux"]

/** A row from `ps`, reduced to the two fields that can be trusted. */
export interface ProcessRow {
	readonly pid: number
	/** The executable's basename, as `ps -o comm=` reports it. */
	readonly command: string
}

/**
 * The PIDs to stop, excluding this process.
 *
 * `selfPid` is passed rather than read from `process` so the filter is testable
 * without the test runner killing itself.
 */
export function selectAppPids(rows: readonly ProcessRow[], selfPid: number): number[] {
	const wanted = new Set(APP_COMMANDS)
	const selected: number[] = []

	for (const row of rows) {
		if (row.pid === selfPid) continue
		// `comm` may arrive as a full path on some platforms; only the basename counts.
		const name = row.command.split("/").pop() ?? row.command
		if (wanted.has(name)) selected.push(row.pid)
	}

	return selected
}

/**
 * Parse `ps -eo pid=,comm=` output.
 *
 * Columns are pid then the rest of the line, because a command name may contain
 * spaces on some platforms. Rows that are not numeric PIDs are skipped rather
 * than coerced: a header line or a truncated read must not become PID 0.
 */
export function parseProcessRows(output: string): ProcessRow[] {
	const rows: ProcessRow[] = []
	for (const line of output.split("\n")) {
		const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
		if (!match) continue
		rows.push({ pid: Number(match[1]), command: match[2] })
	}
	return rows
}
