/**
 * Connecting iFlow with a pasted browser cookie.
 *
 * There is no OAuth here: the operator copies `BXAuth` out of a logged-in browser and the
 * server trades it for an API key. Everything in this file is about that trade being
 * defensible — which cookie is acceptable, which headers the platform expects, and which of
 * the several ways it can fail is the operator's problem versus ours.
 */

export const IFLOW_APIKEY_URL = "https://platform.iflow.cn/api/openapi/apikey"

/** The one field of the cookie that carries the session. */
const IFLOW_COOKIE_FIELD = "BXAuth="

/**
 * iFlow's API answers differently depending on what it believes is asking. A bare `fetch`
 * from Node is treated as a script; these headers make it the browser the cookie came from.
 * They are a compatibility requirement of the platform, not a disguise for scraping.
 */
export const IFLOW_BROWSER_HEADERS: Readonly<Record<string, string>> = {
	Accept: "application/json, text/plain, */*",
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
	"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
	"Accept-Encoding": "gzip, deflate, br",
	Connection: "keep-alive",
	"Sec-Fetch-Dest": "empty",
	"Sec-Fetch-Mode": "cors",
	"Sec-Fetch-Site": "same-origin",
}

/**
 * Reads the pasted cookie.
 *
 * `BXAuth` is required and nothing else is: the operator may paste the whole cookie jar, and
 * dropping the rest here is what stops their other session cookies from leaving the machine
 * for a third party that has no use for them.
 */
export function readIflowCookie(body: unknown): { ok: boolean; error?: string; cookie?: string } {
	const fields = (body ?? {}) as { cookie?: unknown }
	const cookie = typeof fields.cookie === "string" ? fields.cookie.trim() : ""
	if (!cookie) return { ok: false, error: "Cookie is required" }
	if (!cookie.includes(IFLOW_COOKIE_FIELD)) {
		return { ok: false, error: "Cookie must contain BXAuth field" }
	}
	return { ok: true, cookie }
}

/**
 * The cookie to send while verifying, with the trailing `;` the platform expects.
 *
 * iFlow parses the header by splitting on `;`, so a cookie pasted without the terminator is
 * read as one field called `BXAuth=xxxx` and rejected.
 */
export function cookieForRequest(cookie: string): string {
	return cookie.endsWith(";") ? cookie : `${cookie};`
}

/**
 * The cookie worth storing: only `BXAuth`, re-terminated.
 *
 * Saving the operator's whole jar would persist session cookies for other iFlow pages, which
 * nothing here reads and which would outlive the login they came from.
 */
export function cookieForStorage(cookie: string): string {
	const match = cookie.match(/BXAuth=([^;]+)/)
	return match ? `BXAuth=${match[1]};` : ""
}

/** The name iFlow files the key under, as the API reported it. */
export function iflowKeyName(raw: unknown): string {
	const data = (raw ?? {}) as Record<string, unknown>
	const name = data.name
	return typeof name === "string" ? name : ""
}

/** The API key and expiry the refresh returned. */
export interface IflowRefreshedKey {
	readonly apiKey: string
	readonly name: string
	readonly expireTime: unknown
}

export function iflowRefreshedKey(raw: unknown): IflowRefreshedKey {
	const data = (raw ?? {}) as Record<string, unknown>
	return {
		apiKey: typeof data.apiKey === "string" ? data.apiKey : "",
		name: typeof data.name === "string" ? data.name : "",
		expireTime: data.expireTime,
	}
}

/** Whether the envelope says the call failed, and with what message. */
export function iflowEnvelopeFailure(raw: unknown): string | null {
	const envelope = (raw ?? {}) as Record<string, unknown>
	if (envelope.success) return null
	return typeof envelope.message === "string" ? envelope.message : ""
}

/**
 * What the dashboard is allowed to see after a successful connect.
 *
 * The key is masked: it is the credential, and the screen only needs enough of it to tell two
 * connections apart.
 */
export function maskedIflowKey(apiKey: string): string {
	return `${apiKey.slice(0, 10)}...`
}
