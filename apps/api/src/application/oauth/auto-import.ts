import {
	type CredentialSearch,
	type CursorMiss,
	candidatePaths,
	cursorMissMessage,
	cursorTokensComplete,
	firstUsable,
	notFoundMessage,
} from "../../domain/oauth-local-credential.ts"

/**
 * Reading a provider's own credential file off this machine.
 *
 * Six routes differ only in where they look and what shape they expect; the search itself —
 * ordered candidates, first usable wins, unreadable is not fatal — is one rule. What each
 * provider extracts from the file it finds stays in the host, injected as `read`.
 */

/** What the search needs: candidate paths, and how to read one. */
export interface LocalCredentialDeps<Found> {
	/** Where this provider keeps its credential, for the "log in first" message. */
	readonly where?: string
	/** Paths in priority order; null/empty entries are dropped. */
	readonly paths: readonly (string | null | undefined)[]
	/** Read one path, answering null when the file is there but is not a credential. */
	readonly read: (path: string) => Promise<Found | null>
}

/**
 * `GET /api/oauth/<provider>/auto-import`.
 *
 * A miss is `found: false`, not a 404: the screen shows it as "log in to <provider> first",
 * and an error status would send it down the failure path where it has no advice to give.
 */
export async function autoImportLocalCredential<Found>(
	input: { readonly provider: string },
	deps: LocalCredentialDeps<Found>,
): Promise<CredentialSearch<Found>> {
	const paths = candidatePaths(deps.paths)
	const hit = await firstUsable(paths, deps.read)
	if (!hit)
		return { found: false, error: notFoundMessage(input.provider, deps.where ?? "this machine") }

	return { found: true, source: hit.source, credential: hit.credential }
}

/** What a Cursor read needs: does the file exist, is the IDE installed, read it two ways. */
export interface CursorImportDeps {
	/** Paths in platform priority order. */
	readonly candidates: readonly string[]
	/** Whether the file is readable; the search takes the first one that is. */
	readonly readable: (path: string) => Promise<boolean>
	/** Linux only: a readable config with no IDE behind it is a leftover, not a login. */
	readonly installed?: () => Promise<boolean>
	/** The bundled SQLite binding, which needs no external tool. */
	readonly readViaBinding: (
		path: string,
	) => Promise<{ accessToken?: string | null; machineId?: string | null }>
	/** The `sqlite3` binary, for installs where the native binding will not load. */
	readonly readViaCli: (
		path: string,
	) => Promise<{ accessToken?: string | null; machineId?: string | null }>
}

/** What a Cursor import answers. */
export type CursorImport =
	| { readonly found: true; readonly accessToken: string; readonly machineId: string }
	| {
			readonly found: false
			readonly error?: string
			readonly windowsManual?: true
			readonly dbPath?: string
	  }

/**
 * `GET /api/oauth/cursor/auto-import` — three strategies, in order.
 *
 * The binding is tried before the CLI because it needs nothing installed; the CLI is tried
 * before the manual paste box because a tool the operator happens to have is still better
 * than asking them to copy a token by hand. Each failure is silent and the next one runs —
 * a strategy that cannot answer is not an error the screen can act on.
 */
export async function autoImportCursor(deps: CursorImportDeps): Promise<CursorImport> {
	let dbPath: string | null = null
	for (const candidate of deps.candidates) {
		if (await deps.readable(candidate).catch(() => false)) {
			dbPath = candidate
			break
		}
	}

	if (!dbPath) {
		const miss: CursorMiss = { reason: "not-found", tried: deps.candidates }
		return { found: false, error: cursorMissMessage(miss) }
	}

	// A leftover config from an uninstalled IDE holds a stale token; importing it would
	// create a connection that fails on its first real request.
	if (deps.installed && !(await deps.installed())) {
		const miss: CursorMiss = { reason: "not-installed" }
		return { found: false, error: cursorMissMessage(miss) }
	}

	const path: string = dbPath
	for (const read of [deps.readViaBinding, deps.readViaCli]) {
		const tokens = await read(path).catch(() => null)
		if (tokens && cursorTokensComplete(tokens)) {
			return {
				found: true,
				accessToken: tokens.accessToken as string,
				machineId: tokens.machineId as string,
			}
		}
	}

	return { found: false, windowsManual: true, dbPath: path }
}
