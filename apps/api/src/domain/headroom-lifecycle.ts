/**
 * Headroom proxy lifecycle: who may start it, on which port, and what a failure means.
 *
 * Five routes drive a child process, and the same three decisions were copy-pasted between `start`
 * and `restart` (including a byte-identical `parsePortFromUrl`). Two of them are load-bearing:
 *
 * - **Only a loopback URL may be started from here.** A remote Headroom belongs to whoever runs
 *   it; starting "it" locally would spawn a proxy the configured URL never reaches, so the
 *   dashboard would report a healthy proxy while every request went somewhere else.
 * - **A missing install is the caller's problem, not a server fault.** `NOT_INSTALLED` is 400 —
 *   the operator needs to install Headroom, and a 500 tells them to retry something that cannot
 *   work until they do something else.
 *
 * The error-code sets differ per operation on purpose: `start` treats only NOT_INSTALLED as the
 * caller's fault. Merging every code into one "client error" set would let a start failure answer
 * 400 for a code that came from the install path.
 */

/** The port a Headroom proxy listens on when the configured URL names none. */
export const DEFAULT_HEADROOM_PORT = 8787

/** Start/restart: the only code that means "install Headroom first". */
export const START_CLIENT_ERROR_CODES: ReadonlySet<string> = new Set(["NOT_INSTALLED"])

/** Install: missing interpreter and a bad extras list are both the caller's problem. */
export const INSTALL_CLIENT_ERROR_CODES: ReadonlySet<string> = new Set([
	"NOT_INSTALLED",
	"NO_PYTHON",
	"INVALID_EXTRAS",
])

/** Uninstall: same two, and notably not NOT_INSTALLED — there is nothing to remove. */
export const UNINSTALL_CLIENT_ERROR_CODES: ReadonlySet<string> = new Set([
	"NO_PYTHON",
	"INVALID_EXTRAS",
])

/**
 * The port named by a URL, or null.
 *
 * A URL with no explicit port returns null rather than 80/443: Headroom's own reads and writes go
 * through this value, and defaulting to a web port would point the proxy somewhere it never was.
 */
export function headroomPortFromUrl(url: unknown): number | null {
	try {
		const port = Number.parseInt(new URL(String(url ?? "")).port, 10)
		return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
	} catch {
		return null
	}
}

/** The port to start on: the configured one, else Headroom's default. */
export function headroomStartPort(url: unknown): number {
	return headroomPortFromUrl(url) ?? DEFAULT_HEADROOM_PORT
}

/**
 * The options passed to the process manager.
 *
 * `kompress` defaults ON and `codeAware` defaults OFF, which is what the settings screen shows.
 * Written as an explicit comparison so a missing key means the documented default rather than
 * whatever `Boolean(undefined)` happens to be.
 */
export function headroomStartOptions(settings: unknown): { codeAware: boolean; kompress: boolean } {
	// Read off an open record: the settings type is closed, so a structural parameter rejects a
	// value that carries exactly these fields.
	const record = settings as
		| { readonly headroomCodeAware?: unknown; readonly headroomKompress?: unknown }
		| null
		| undefined
	return {
		codeAware: record?.headroomCodeAware === true,
		kompress: record?.headroomKompress !== false,
	}
}

/** The configured Headroom URL, or the default when none is set. */
export function headroomUrl(settings: unknown, fallback: string): string {
	const configured = String(
		(settings as { readonly headroomUrl?: unknown } | null)?.headroomUrl ?? "",
	).trim()
	return configured || fallback
}

/** The refusal a non-loopback URL earns, or null when starting locally is allowed. */
export function externalProxyRefusal(
	url: unknown,
	isLoopback: (url: unknown) => boolean,
): { message: string; code: string } | null {
	if (isLoopback(url)) return null
	return {
		message: "External Headroom proxies must be started outside 9Router",
		code: "EXTERNAL_PROXY",
	}
}

/**
 * The HTTP status for a lifecycle failure.
 *
 * `codes` is passed per call so `start` cannot answer 400 for an install-only code. Everything the
 * set does not name is 500: an unrecognised failure is a fault here, not the caller's mistake.
 */
export function headroomFailureStatus(
	error: { readonly code?: unknown } | null | undefined,
	codes: ReadonlySet<string>,
): number {
	const code = String(error?.code ?? "")
	return codes.has(code) ? 400 : 500
}

/** The status for a stop that found nothing to stop. */
export function headroomStopStatus(result: unknown): number {
	return (result as { stopped?: unknown } | null | undefined)?.stopped ? 200 : 409
}
