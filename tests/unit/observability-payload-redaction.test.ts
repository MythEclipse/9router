// GET /api/usage/request-details returns request/response bodies by default.
//
// The tab exists to answer "what did this request actually contain". A
// redacted-by-default view showed a request that spent 244k input tokens with
// output 0 and no content — indistinguishable from a broken recorder, and no help
// at all in diagnosing whether the payload was missing, truncated, or merely
// hidden. So payloads are returned by default, and the withholding switch is for
// shared/internet-facing instances.
//
// What still has to hold:
//   - a withheld field identifies itself (never a bare {redacted:true}),
//   - turning the switch off withholds every payload field,
//   - an unreadable settings row fails closed,
//   - a gateway with requireLogin disabled does not hand payloads to an
//     unauthenticated caller.
//
// These are asserted against the domain functions rather than through the route. The route now
// reaches `getUseCases()`, which opens a database while *building* the graph — so a route-level
// test would need a database to prove a rule that never touches one.
import { describe, expect, it } from "vitest"
import {
	redactionSettingsFrom,
	redactRequestDetail,
	shouldIncludePayloads,
} from "../../apps/api/src/domain/observability.ts"

const sampleDetail = {
	id: "detail-1",
	provider: "openai",
	model: "gpt-4o",
	timestamp: "2026-01-01T00:00:00.000Z",
	status: "success",
	latency: { ttft: 10, total: 20 },
	tokens: { prompt_tokens: 5, completion_tokens: 2 },
	request: { messages: [{ role: "user", content: "PROMPT-SECRET-MARKER" }] },
	providerRequest: { messages: [{ role: "user", content: "PROMPT-SECRET-MARKER" }] },
	providerResponse: { choices: [{ message: { content: "REPLY-SECRET-MARKER" } }] },
	response: { content: "REPLY-SECRET-MARKER" },
}

const PAYLOAD_FIELDS = ["request", "providerRequest", "providerResponse", "response"] as const

/** The listing's own composition of the two rules, which the route relies on. */
const includeFor = (settings: Record<string, unknown>, opts: { authenticated?: boolean } = {}) => {
	const read = redactionSettingsFrom(settings as never)
	return shouldIncludePayloads({
		settings: read.settings,
		requireLoginDisabled: read.requireLoginDisabled,
		requestAuthenticated: read.requireLoginDisabled ? (opts.authenticated ?? false) : false,
	})
}

const detailWith = (include: boolean) =>
	redactRequestDetail({ ...sampleDetail }, include) as Record<string, never>

describe("request-details payload policy", () => {
	it("returns the real payloads for an operator debugging a request", () => {
		const verdict = includeFor({ observabilityIncludePayloads: true, requireLogin: true })
		expect(verdict.include).toBe(true)

		const detail = detailWith(verdict.include)
		expect(detail.request.messages[0].content).toBe("PROMPT-SECRET-MARKER")
		expect(detail.providerRequest.messages[0].content).toBe("PROMPT-SECRET-MARKER")
		expect(detail.providerResponse.choices[0].message.content).toBe("REPLY-SECRET-MARKER")
		expect(detail.response.content).toBe("REPLY-SECRET-MARKER")
		for (const field of PAYLOAD_FIELDS) {
			expect(detail[field]).not.toHaveProperty("withheld")
		}
	})

	it("withholds every payload field when the operator turns it off", () => {
		const verdict = includeFor({ observabilityIncludePayloads: false, requireLogin: true })
		expect(verdict.include).toBe(false)
		expect(verdict.reason).toBe("disabled-by-setting")

		const detail = detailWith(verdict.include)
		for (const field of PAYLOAD_FIELDS) {
			expect(detail[field].withheld).toBe(true)
			expect(JSON.stringify(detail[field])).not.toContain("SECRET-MARKER")
		}
	})

	it("says a withheld payload exists instead of looking empty", () => {
		const detail = detailWith(false)
		// A bare `{redacted:true}` would read as "there was nothing here", which is the confusion
		// this marker exists to prevent: it carries the field name and the size it is hiding.
		for (const field of PAYLOAD_FIELDS) {
			expect(detail[field].field).toBe(field)
			expect(typeof detail[field].bytes).toBe("number")
			expect(detail[field].bytes).toBeGreaterThan(0)
		}
	})

	it("keeps diagnostic metadata in both modes", () => {
		for (const include of [true, false]) {
			const detail = detailWith(include)
			expect(detail.id).toBe("detail-1")
			expect(detail.provider).toBe("openai")
			expect(detail.model).toBe("gpt-4o")
			expect(detail.status).toBe("success")
			expect(detail.latency).toEqual({ ttft: 10, total: 20 })
			expect(detail.tokens).toEqual({ prompt_tokens: 5, completion_tokens: 2 })
		}
	})

	it("an unreadable settings row fails closed", () => {
		// `redactionSettingsFrom` is the reader a broken row flows through; whatever it answers
		// must not be `include: true`.
		for (const broken of [null, undefined, {}, { observabilityIncludePayloads: "true" }]) {
			expect(includeFor(broken as Record<string, unknown>).include).toBe(false)
		}
	})

	it("does not hand payloads to an unauthenticated caller on an open gateway", () => {
		const verdict = includeFor(
			{ observabilityIncludePayloads: true, requireLogin: false },
			{ authenticated: false },
		)
		expect(verdict.include).toBe(false)
	})

	it("does hand them over once that caller is authenticated", () => {
		const verdict = includeFor(
			{ observabilityIncludePayloads: true, requireLogin: false },
			{ authenticated: true },
		)
		expect(verdict.include).toBe(true)
	})
})
