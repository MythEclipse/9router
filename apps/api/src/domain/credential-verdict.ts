/**
 * What a validation probe's HTTP status means about an API key.
 *
 * Called from `apps/api/src/application/providers/validate-credential.ts` and
 * `tests/unit/domain-credential-verdict.test.ts`.
 *
 * No existing file serves this purpose. `providers/validate/route.ts` carried a
 * 700-line `switch` in which each provider branch ended in its own status test,
 * and `domain/api-key-verdict.ts` answers a different question — that one reads a
 * *probe result the router already made* for the provider switch; this one decides
 * what a *validation request the panel just fired* proved.
 *
 * Reads: an HTTP status and, where it matters, the key's own shape. Writes nothing.
 *
 * User instruction, verbatim: "lanjut kenapa malah berhenti".
 *
 * The reason these need naming: "401 means bad key" is true for most providers and
 * wrong for four of them, and the exceptions are not guessable from the status
 * alone. They are the whole content of this file.
 */

/** A status reading: `true` when the key is proven good, `false` when proven bad. */
export type Verdict = boolean

/** The common reading: the request was accepted. */
export function statusOk(status: number): Verdict {
	return status >= 200 && status < 300
}

/** Anything not a refusal: 400s about models and parameters still prove the key. */
export function notRefused(status: number): Verdict {
	return status !== 401 && status !== 403
}

/**
 * xAI answers 400 for a *bad key* and 403 for a valid key with no credit.
 *
 * So the usual "not 401/403" reading would call a bad key valid (400 is not in the
 * refusal list) and a good key invalid (403 is). Only 200 and 403 mean the key
 * itself was accepted.
 */
export function xaiVerdict(status: number): Verdict {
	return status === 200 || status === 403
}

/**
 * xiaomi-tokenplan answers 403 for a valid key that merely lacks list permission.
 *
 * Its `/models` endpoint therefore proves validity only through the negative: 401
 * is the one status that means the key is bad. Everything else — including 5xx —
 * leaves the key unrefuted, which is the honest reading for a probe that cannot
 * confirm.
 */
export function tokenplanVerdict(status: number): Verdict {
	return status !== 401
}

/** blackbox answers 400 for a malformed request and 401 for a bad key. */
export function blackboxVerdict(status: number): Verdict {
	return status === 200 || status === 400
}

/**
 * Cloudflare also answers 404 when the account id is unknown.
 *
 * A 404 there means the *account* is wrong, so reporting the key as valid would
 * hide a configuration mistake the operator can fix.
 */
export function cloudflareVerdict(status: number): Verdict {
	return status !== 401 && status !== 403 && status !== 404
}

/**
 * Anthropic answers 400/529 for things that are not authentication.
 *
 * 529 is "overloaded"; a key is still proven good when the service says it is too
 * busy to use it.
 */
export function anthropicVerdict(status: number): Verdict {
	return status !== 401
}

/**
 * An Anthropic-compatible *node*, which the operator points at their own host.
 *
 * Same reading as Anthropic's own endpoint — 400 about the model and 529 about
 * capacity both prove the key — kept as a name so the node path cannot drift from
 * the built-in one.
 */
export function anthropicCompatibleVerdict(status: number): Verdict {
	return anthropicVerdict(status)
}

/**
 * A search provider probed through its own `searchConfig`.
 *
 * Same refusal rule as media, kept as its own name because the two read different
 * config blocks and conflating them once made a web-only provider fall through to
 * the LLM probe.
 */
export function webProbeVerdict(status: number): Verdict {
	return status !== 401 && status !== 403
}

/** A media provider (tts/embedding/stt/image) probed through its own config block. */
export function mediaProbeVerdict(status: number): Verdict {
	return status !== 401 && status !== 403
}

/** The providers whose reading is not the default one, by provider id. */
export type StatusReader = (status: number) => Verdict

const READERS: Readonly<Record<string, StatusReader>> = {
	xai: xaiVerdict,
	"xiaomi-tokenplan": tokenplanVerdict,
	blackbox: blackboxVerdict,
	"cloudflare-ai": cloudflareVerdict,
	anthropic: anthropicVerdict,
}

/**
 * How this provider's validation status should be read.
 *
 * Unknown providers get `notRefused`, which is what the route's generic branch
 * used and what almost every OpenAI-compatible endpoint behaves like.
 */
export function readerFor(provider: string): StatusReader {
	return READERS[provider] ?? notRefused
}

/** The message a refused key produces, when the provider has a more useful one. */
export function refusalMessage(provider: string): string {
	if (provider === "cloudflare-ai") return "Invalid API token or Account ID"
	if (provider === "azure") return "Invalid API key or Azure configuration"
	return "Invalid API key"
}

/**
 * Whether a Vertex credential is acceptable without any network call.
 *
 * A service-account JSON is judged by its own fields: minting a token to find out
 * would spend a real request on a question the file answers. A raw key has to be
 * probed, which the caller does.
 */
export function readServiceAccount(
	raw: string,
):
	| { readonly isServiceAccount: true; readonly valid: boolean }
	| { readonly isServiceAccount: false } {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return { isServiceAccount: false }
	}
	if (parsed === null || typeof parsed !== "object") return { isServiceAccount: false }
	const record = parsed as Record<string, unknown>
	if (record.type !== "service_account") return { isServiceAccount: false }
	return {
		isServiceAccount: true,
		valid: !!(record.client_email && record.private_key && record.project_id),
	}
}

/**
 * The token inside a pasted credential blob.
 *
 * Web-login providers let the operator paste either the bare token or whatever
 * their DevTools copied — a JSON envelope, a cookie string, a `Bearer` prefix,
 * quotes around it. The route repeated this unpacking per provider with slightly
 * different rules; here the three shapes are handled once and a provider adds only
 * what is genuinely its own.
 */
export function unwrapCredential(raw: string): string {
	let token = raw.trim()
	if (token.startsWith("{")) {
		try {
			const parsed = JSON.parse(token) as Record<string, unknown>
			const inner = parsed.value ?? parsed.access_token ?? parsed.token
			if (typeof inner === "string" && inner.trim()) token = inner.trim()
		} catch {
			/* not JSON after all: keep the raw text */
		}
	}
	const cookieMatch = token.match(/(?:^|[;\s])userToken=([^;]+)/)
	if (cookieMatch) token = cookieMatch[1]
	const bearerMatch = token.match(/^(?:authorization:\s*)?bearer\s+(.+)$/i)
	if (bearerMatch) token = bearerMatch[1]
	return token.replace(/^["']|["']$/g, "").trim()
}

/**
 * A pasted cookie blob turned into a `Cookie` header value.
 *
 * gemini-web accepts either a full cookie map as JSON or the bare `__Secure-1PSID`
 * value; the bare value needs its name put back before the header means anything.
 */
export function toCookieHeader(raw: string): string {
	let cookie = raw.trim()
	if (cookie.startsWith("{")) {
		try {
			const parsed = JSON.parse(cookie) as Record<string, unknown>
			const map =
				parsed.cookies && typeof parsed.cookies === "object" && !Array.isArray(parsed.cookies)
					? (parsed.cookies as Record<string, unknown>)
					: parsed
			const pairs = Object.entries(map)
				.filter(([, value]) => typeof value === "string" && (value as string).trim().length > 0)
				.map(([key, value]) => `${key}=${String(value).trim()}`)
			if (pairs.length > 0) cookie = pairs.join("; ")
		} catch {
			/* not JSON after all: keep the raw text */
		}
	}
	if (cookie && !cookie.includes("=")) cookie = `__Secure-1PSID=${cookie}`
	return cookie
}
