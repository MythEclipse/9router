/**
 * Rules for finding a provider's own credential file on this machine.
 *
 * Six routes do the same thing with different file names: look for the credential the
 * provider's own tool left behind, take the first usable one, and report "not found" — not
 * an error — when there is none. Nobody has logged in to Kiro yet is a normal state, not a
 * failure, and the screen renders it as an instruction.
 */

/** What an auto-import answers. */
export type CredentialSearch<Found> =
	| { readonly found: true; readonly source: string; readonly credential: Found }
	| { readonly found: false; readonly error: string }

/**
 * The paths to try, in order.
 *
 * Order is the whole rule: a vendor's own file (`kiro-auth-token.json`) outranks a shared
 * cache, and the platform's native directory outranks the XDG one. A search that tried them
 * in directory order would pick up whichever file happened to sort first.
 */
export function candidatePaths(paths: readonly (string | null | undefined)[]): string[] {
	return paths.filter((path): path is string => typeof path === "string" && path.length > 0)
}

/**
 * Find the first path that answers.
 *
 * `read` returning `null` means "this file exists but is not a credential" — different from
 * a missing file, and both mean "try the next one". An error from `read` is swallowed for
 * the same reason: a file the process may not read is not a reason to fail a search that
 * has other candidates.
 */
export async function firstUsable<Found>(
	paths: readonly string[],
	read: (path: string) => Promise<Found | null>,
): Promise<{ source: string; credential: Found } | null> {
	for (const path of paths) {
		let found: Found | null = null
		try {
			found = await read(path)
		} catch {
			continue
		}
		if (found !== null) return { source: path, credential: found }
	}
	return null
}

/**
 * The provider's name as a person writes it.
 *
 * Routes are addressed by slug (`xiaomi-mimo`, `grok-cli`), and a message built from a slug
 * reads like a bug: "log in to xiaomi-mimo first". The ones whose display name is not their
 * slug are listed; the rest are capitalised, which is right for the single-word ones.
 */
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
	kiro: "Kiro",
	"xiaomi-mimo": "MiMoCode",
	zed: "Zed",
	cursor: "Cursor",
	codex: "Codex",
	"grok-cli": "Grok CLI",
}

export function providerNameOf(slug: string): string {
	return PROVIDER_NAMES[slug] ?? slug.charAt(0).toUpperCase() + slug.slice(1)
}

/**
 * The message when nothing was found, naming what the operator has to do.
 *
 * "Token not found" tells them nothing they did not already know; "log in to Kiro first"
 * is the action.
 */
export function notFoundMessage(provider: string, where: string): string {
	const name = providerNameOf(provider)
	return `${name} token not found in ${where}. Please log in to ${name} first.`
}

/**
 * The region a Kiro ARN must carry for this gateway.
 *
 * The runtime only accepts `us-east-1` in a CodeWhisperer ARN, whatever region the IDE was
 * configured for. Rewriting it here keeps a token minted in another region usable, instead
 * of failing at the upstream with an ARN the operator cannot inspect.
 */
export const KIRO_ARN_REGION = "us-east-1"

export function normalizeKiroArn(arn: string): string {
	return arn.replace(/arn:aws:codewhisperer:[^:]+:/, `arn:aws:codewhisperer:${KIRO_ARN_REGION}:`)
}

/**
 * Whether a Kiro refresh token is the kind this gateway can use.
 *
 * The IDE writes more than one token shape into the same cache; only the `aorAAAAAG…` ones
 * are organisation/IDC tokens. Checking the prefix is what stops the search from stopping on
 * a file that looked right by name.
 */
export function isKiroRefreshToken(value: unknown): value is string {
	return typeof value === "string" && value.startsWith("aorAAAAAG")
}

/**
 * Why an auto-import fell back to asking the operator to paste a credential.
 *
 * Cursor's database is readable in principle and yet may be unreadable in practice: the
 * native binding may be missing, or the `sqlite3` binary absent. Both are `manual` — the
 * screen shows a paste box — while a file that is simply not there is `not-found`, which
 * carries the paths that were tried. Collapsing the two would either hide the tried paths
 * or offer a paste box for a database the operator never created.
 */
export type CursorMiss =
	| { readonly reason: "not-found"; readonly tried: readonly string[] }
	| { readonly reason: "not-installed" }
	| { readonly reason: "manual"; readonly dbPath: string }

/** The screen's wording for each miss. */
export function cursorMissMessage(miss: CursorMiss): string {
	switch (miss.reason) {
		case "not-found":
			return `Cursor database not found. Checked locations:\n${miss.tried.join("\n")}\n\nMake sure Cursor IDE is installed and opened at least once.`
		case "not-installed":
			return "Cursor config files found but Cursor IDE does not appear to be installed. Skipping auto-import."
		case "manual":
			return ""
	}
}

/**
 * Whether the tokens a strategy returned are enough to import.
 *
 * Both halves are required: an access token without a machine id authenticates the first
 * request and then fails the one that identifies the client, so a half-read database has to
 * fall through to the next strategy rather than answer "found".
 */
export function cursorTokensComplete(tokens: {
	readonly accessToken?: string | null
	readonly machineId?: string | null
}): boolean {
	return Boolean(tokens.accessToken) && Boolean(tokens.machineId)
}
