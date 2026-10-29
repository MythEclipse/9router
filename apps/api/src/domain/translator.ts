/**
 * The translator inspector is a debug tool, and debug tools fail in ways that cost trust.
 *
 * It exposes five things: which formats a model speaks (`translate`, steps 1-3), the captured
 * request/response dumps on disk (`load`, `save`), a live send to the real provider (`send`), and
 * the console buffer the dashboard streams (`console-logs`). Each has a rule that is invisible in
 * the route, and each one, mistaken, either leaks the filesystem or makes the tool lie.
 *
 * - **`save` writes a file the caller names.** The allowed list is the whole defence: without it,
 *   `file: "../../.env"` is a write primitive reachable from the dashboard. It lives here so
 *   `load` and `save` cannot drift apart — one of them forgetting an entry means a dump that saves
 *   and then cannot be reopened.
 * - **A transport failure is not a verdict about the provider.** `send` crosses the network; when
 *   the connection drops mid-request the operator needs to know nothing was learned about the
 *   provider, which is 502. A 500 says the dashboard broke, and it did not.
 * - **Step 3 needs the caller to say which provider.** Steps 1-2 can infer it from the model id
 *   because the client body carries one. Step 3 is handed an already-translated OpenAI body where
 *   the model id may belong to any provider, so guessing produces headers for the wrong API.
 * - **An empty console buffer drains to empty, not to "no data".** The dashboard polls it, and a
 *   missing field is not the same answer as an empty list.
 */

/** The captured dumps the inspector may read and write, in pipeline order. */
export const TRANSLATOR_DUMP_FILES = [
	"1_req_client.json",
	"2_req_source.json",
	"3_req_openai.json",
	"4_req_target.json",
	"5_res_provider.txt",
	"6_res_openai.txt",
	"7_res_client.txt",
	"7_res_client.json",
] as const

export type TranslatorDumpFile = (typeof TRANSLATOR_DUMP_FILES)[number]

/**
 * The dump file a caller asked for, or null.
 *
 * `null` means "reject": the request named a path this inspector does not own. The check is an
 * exact match against the list — a prefix or extension test would still admit `../` traversal,
 * because the traversal happens later in `path.join`, after any pattern match has passed.
 */
export function translatorDumpFile(file: unknown): TranslatorDumpFile | null {
	if (typeof file !== "string") return null
	return TRANSLATOR_DUMP_FILES.find((allowed) => allowed === file) ?? null
}

/**
 * The step a request asked for, or null when it is not one the inspector knows.
 *
 * JSON bodies carry the step as `number`, `string`, or `1.0` depending on the caller, so `"2"`
 * must work; `null` is the only rejection.
 */
export function translatorStep(step: unknown): 1 | 2 | 3 | null {
	const value = typeof step === "string" ? Number(step) : step
	if (value === 1) return 1
	if (value === 2) return 2
	if (value === 3) return 3
	return null
}

/** What step 3 must be given, and what steps 1-2 can infer on their own. */
export interface TranslatorTarget {
	readonly provider: string
	readonly model: string
}

/**
 * The provider and model step 3 was asked about, or null when either is missing.
 *
 * Both are required here because the body it is handed has already been translated: the model id
 * no longer identifies which provider's URL and headers to build, and a guess silently targets the
 * wrong API.
 */
export function translatorTarget(provider: unknown, model: unknown): TranslatorTarget | null {
	if (typeof provider !== "string" || provider === "") return null
	if (typeof model !== "string" || model === "") return null
	return { provider, model }
}

/**
 * The HTTP status for a failed send.
 *
 * Two different failures wear the same shape: the provider answered with an error, or the request
 * never reached it. The provider's own status is passed through — a 429 must stay a 429 so the
 * operator sees rate limiting rather than a dashboard fault. Anything that is not an HTTP status
 * (a thrown network error) is 502: the gateway could not get an answer, which is a different fact
 * from "the provider said no".
 */
export function translatorSendStatus(providerStatus: number | null): number {
	if (providerStatus === null) return 502
	if (!Number.isInteger(providerStatus) || providerStatus < 400) return 502
	return providerStatus
}

/**
 * A refresh is only worth retrying with when it actually produced a credential.
 *
 * `refreshCredentials` can resolve with a partial object after a failed refresh. Retrying with it
 * sends the same rejected token and doubles the latency of every expiry, so the retry hinges on
 * there being a new access token or a new Copilot token.
 */
export function translatorRefreshUsable(
	refreshed: { accessToken?: unknown; copilotToken?: unknown } | null,
): boolean {
	if (refreshed === null) return false
	const hasAccessToken = typeof refreshed.accessToken === "string" && refreshed.accessToken !== ""
	const hasCopilotToken = typeof refreshed.copilotToken === "string" && refreshed.copilotToken !== ""
	return hasAccessToken || hasCopilotToken
}

/** The console buffer as the dashboard reads it, empty rather than absent. */
export function consoleLogsPayload(logs: readonly unknown[] | null | undefined) {
	return { success: true, logs: Array.isArray(logs) ? logs : [] }
}
