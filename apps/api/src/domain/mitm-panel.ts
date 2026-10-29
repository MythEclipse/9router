/**
 * The MITM control panel's decisions.
 *
 * The route that drives this panel does nothing but call `apps/web/src/mitm/manager.ts` — a
 * process manager that spawns a privileged proxy, installs a root CA and rewrites the hosts
 * file. That is a host concern and stays where it is. What is *not* a host concern is the
 * order in which the panel asks for things, and that ordering is where the bugs live:
 *
 * - Raising a certificate needs root *on Linux and macOS* and needs an elevated console on
 *   Windows, but on Windows a sudo password is not a thing. Asking for one there is a prompt
 *   the operator can never satisfy.
 * - A password the operator typed once is cached, so the second click must not re-prompt.
 *   The check that decides "prompt or not" therefore has to consult three sources in a fixed
 *   order: the request, the cache, the encrypted store.
 * - Anything that writes the hosts file is privilege-gated, but reading status is not. A
 *   status read that demanded a password would make the panel unusable before it is configured.
 *
 * Every rule below is a pure function of its inputs so the panel's ordering can be tested
 * without a proxy, a certificate, or a privileged console.
 */

/** Where the proxy's clients should send traffic when the operator has set nothing. */
export const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128"

/**
 * The highest level of access this process itself has.
 *
 * `"windows-admin"` is separate from `"root"` because the two are obtained differently and
 * fail differently: one cannot be gained mid-request at all.
 */
export type MitmPrivilege = "root" | "windows-admin" | "user"

export interface MitmPlatform {
	readonly isWindows: boolean
	readonly privilege: MitmPrivilege
	/** Whether this host's hosts-file writes and certificate installs need a sudo password. */
	readonly sudoPasswordRequired: boolean
}

export type MitmFailure = { readonly ok: false; readonly status: number; readonly error: string }
export type MitmSuccess<T> = { readonly ok: true; readonly value: T }
/** Narrowed by `if (!answer.ok)`; `ok` must be a literal for that to work. */
export type MitmAnswer<T> = MitmSuccess<T> | MitmFailure

/** Built here, not inline, so `ok` keeps its literal type and `if (!answer.ok)` narrows. */
function refuse(status: number, error: string): MitmFailure {
	return { ok: false, status, error }
}

function allow<T>(value: T): MitmSuccess<T> {
	return { ok: true, value }
}

/**
 * Narrows an answer to its failure branch.
 *
 * Written as a type predicate rather than leaning on `if (!answer.ok)`, because `apps/web`
 * compiles without `strictNullChecks` — under that setting a discriminated union does not
 * narrow through a boolean discriminant, and every `.error` access on the failure branch
 * becomes a type error in the caller. The predicate says what is meant either way.
 */
export function isMitmFailure<T>(answer: MitmAnswer<T>): answer is MitmFailure {
	return !answer.ok
}

/**
 * Decides the password a privileged action will use.
 *
 * Order matters and is not interchangeable. A password in the request is what the operator
 * just typed and must win; the cache holds a password that already worked this session; the
 * encrypted store holds one that worked in an earlier one. Reading the store before the cache
 * would hit disk on every click for no gain, and preferring either over the request would
 * ignore a corrected password.
 */
export function resolveMitmPassword(input: {
	readonly provided?: string | null
	readonly cached?: string | null
	readonly stored?: string | null
}): string {
	const provided = input.provided?.trim()
	if (provided) return provided
	const cached = input.cached?.trim()
	if (cached) return cached
	return input.stored ?? ""
}

/**
 * Whether the password in hand is enough for a privileged action.
 *
 * The distinction this enforces: having a *cached* password is not the same as having the
 * privilege it buys. The UI renders two separate things — "does it need a prompt" and "what
 * can it do right now" — and collapsing them would show a Start button that fails.
 */
export function mitmHasPrivilege(platform: MitmPlatform, password: string): boolean {
	// Already privileged: no password can improve on root, and none is needed.
	if (platform.privilege !== "user") return true
	// Windows cannot escalate from inside the request; the console must be restarted elevated.
	if (platform.isWindows) return false
	// A host whose hosts file is writable without sudo needs nothing more.
	if (!platform.sudoPasswordRequired) return true
	return password.trim() !== ""
}

/**
 * Whether the panel should show a password field before a privileged action.
 *
 * Deliberately *not* `!hasPrivilege`: on Windows the answer is always false, because the
 * prompt cannot help — the fix is to restart the app elevated, and the message says so.
 */
export function mitmNeedsPasswordPrompt(platform: MitmPlatform, hasPassword: boolean): boolean {
	if (platform.isWindows) return false
	if (platform.privilege !== "user") return false
	return platform.sudoPasswordRequired && !hasPassword
}

/** The refusal text for an action the process cannot perform, per platform. */
export function mitmPrivilegeRefusal(platform: MitmPlatform, action: string): string {
	return platform.isWindows
		? `Administrator required - restart 9Router as Administrator to ${action}`
		: `Root or sudo password required to ${action}`
}

/**
 * Validates and normalises the router base URL the operator typed.
 *
 * Blank means "unset" and resolves to the default rather than an error: clearing the field is
 * how the operator asks for the default back. A trailing slash is trimmed because every
 * consumer concatenates a path onto it, and `http://host//v1` is a 404 on some upstreams.
 */
export function normaliseMitmRouterBaseUrl(input: unknown): MitmAnswer<string> {
	const trimmed = input == null ? "" : String(input).trim()
	if (trimmed === "") return allow(DEFAULT_MITM_ROUTER_BASE)

	const withoutTrailingSlashes = trimmed.replace(/\/+$/, "")
	let parsed: URL
	try {
		parsed = new URL(withoutTrailingSlashes)
	} catch {
		return refuse(400, "Invalid MITM router URL")
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return refuse(400, "MITM router URL must use http or https")
	}
	return allow(withoutTrailingSlashes)
}

/**
 * The base URL to report, given whatever is stored.
 *
 * Stored values are re-validated rather than echoed: a value written by an older build (or by
 * hand) could carry a trailing slash or a scheme the proxy cannot use, and echoing it would
 * make the status endpoint the thing that serves the bad URL back to the UI.
 */
export function storedMitmRouterBaseUrl(stored: unknown): string {
	const normalised = normaliseMitmRouterBaseUrl(stored)
	return normalised.ok ? normalised.value : DEFAULT_MITM_ROUTER_BASE
}

/** The three actions `PATCH` accepts for a single tool. */
export const MITM_TOOL_ACTIONS = ["enable", "disable", "trust-cert"] as const
export type MitmToolAction = (typeof MITM_TOOL_ACTIONS)[number]

export function isMitmToolAction(value: unknown): value is MitmToolAction {
	return typeof value === "string" && (MITM_TOOL_ACTIONS as readonly string[]).includes(value)
}

/**
 * Checks a `PATCH` body before any privileged work starts.
 *
 * Ordering is the request's contract: a malformed body is a 400 whoever the caller is, and
 * only a well-formed request gets as far as 403. Answering 403 to a request missing `tool`
 * would tell an operator with no privilege that their body was fine.
 */
export function readMitmToolToggle(body: unknown): MitmAnswer<{
	readonly tool: string
	readonly action: MitmToolAction
	readonly sudoPassword: string
}> {
	const raw = (body ?? {}) as Record<string, unknown>
	const tool = typeof raw.tool === "string" ? raw.tool.trim() : ""
	const action = raw.action

	if (!tool || action == null || action === "") {
		return refuse(400, "tool and action required")
	}
	if (!isMitmToolAction(action)) {
		return refuse(400, "action must be enable, disable, or trust-cert")
	}
	const sudoPassword = typeof raw.sudoPassword === "string" ? raw.sudoPassword : ""
	return allow({ tool, action, sudoPassword })
}

/**
 * Checks a start request.
 *
 * `PORT_443_BUSY` is deliberately *not* handled here. It is raised by the process manager
 * *after* the password check has passed and the proxy has tried to bind, and it carries the
 * owning process so the panel can offer to stop it. Folding it into this pre-flight check
 * would mean trying to bind before knowing whether we are allowed to.
 */
export function readMitmStartRequest(body: unknown): MitmAnswer<{
	readonly apiKey: string
	readonly sudoPassword: string
	readonly forceKillPort443: boolean
	/** `undefined` when the caller did not mention the URL — different from blank, which resets it. */
	readonly mitmRouterBaseUrl: unknown
}> {
	const raw = (body ?? {}) as Record<string, unknown>
	const apiKey = typeof raw.apiKey === "string" ? raw.apiKey : ""
	if (!apiKey) return refuse(400, "Missing apiKey")

	return allow({
		apiKey,
		sudoPassword: typeof raw.sudoPassword === "string" ? raw.sudoPassword : "",
		forceKillPort443: raw.forceKillPort443 === true,
		mitmRouterBaseUrl: raw.mitmRouterBaseUrl,
	})
}

/** The status the panel renders. Field names are the UI's contract, so they are spelled here. */
export interface MitmStatusView {
	readonly running: boolean
	readonly pid: number | null
	readonly certExists: boolean
	readonly certTrusted: boolean
	readonly dnsStatus: Record<string, boolean>
	readonly hasCachedPassword: boolean
	readonly isWin: boolean
	readonly needsSudoPassword: boolean
	readonly isAdmin: boolean
	readonly mitmRouterBaseUrl: string
}

export function presentMitmStatus(input: {
	readonly platform: MitmPlatform
	readonly status: {
		readonly running?: boolean
		readonly pid?: number | string | null
		readonly certExists?: boolean
		readonly certTrusted?: unknown
		readonly dnsStatus?: Record<string, boolean>
	}
	readonly hasCachedPassword: boolean
	readonly storedRouterBaseUrl: unknown
}): MitmStatusView {
	const status = input.status
	return {
		running: status.running === true,
		pid: typeof status.pid === "number" ? status.pid : null,
		certExists: status.certExists === true,
		certTrusted: status.certTrusted === true,
		dnsStatus: status.dnsStatus ?? {},
		hasCachedPassword: input.hasCachedPassword,
		isWin: input.platform.isWindows,
		needsSudoPassword: mitmNeedsPasswordPrompt(input.platform, input.hasCachedPassword),
		// A process that is not already privileged is not an administrator, whatever its
		// credentials: `isAdmin` describes this process, and the panel uses it to explain why
		// the Start button will ask for a password.
		isAdmin: input.platform.privilege !== "user",
		mitmRouterBaseUrl: storedMitmRouterBaseUrl(input.storedRouterBaseUrl),
	}
}

/**
 * Whether an action touches one tool's DNS or the whole machine.
 *
 * `trust-cert` is not per-tool — the certificate is machine-wide — but it arrives through the
 * same `PATCH`. A route that treated every action as per-tool would write a hosts entry for a
 * "tool" literally named `trust-cert`.
 */
export function isPerToolDnsAction(action: MitmToolAction): action is "enable" | "disable" {
	return action === "enable" || action === "disable"
}
