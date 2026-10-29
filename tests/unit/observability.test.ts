import { describe, expect, it } from "vitest"
import {
	canReadFullRequestPayload,
	DEFAULT_PAGE_SIZE,
	isPageFailure,
	MAX_PAGE_SIZE,
	REQUEST_PAYLOAD_FIELDS,
	readRequestDetailsPage,
	redactionSettingsFrom,
	redactRequestDetail,
	shouldIncludePayloads,
	WITHHELD_PAYLOAD_HINT,
} from "../../apps/api/src/domain/observability.ts"

describe("readRequestDetailsPage", () => {
	it("defaults page 1 and the default size when the caller says nothing", () => {
		const answer = readRequestDetailsPage({})
		expect(isPageFailure(answer) ? null : answer.page).toEqual({
			page: 1,
			pageSize: DEFAULT_PAGE_SIZE,
		})
	})

	it("recovers from a non-numeric page instead of passing NaN to the store", () => {
		// `parseInt("abc") < 1` is false, so the old check let NaN through to the offset.
		const answer = readRequestDetailsPage({ page: "abc" })
		expect(isPageFailure(answer) ? null : answer.page.page).toBe(1)
	})

	it("refuses page 0 and negative pages rather than silently moving them", () => {
		expect(readRequestDetailsPage({ page: "0" })).toMatchObject({ ok: false, status: 400 })
		expect(readRequestDetailsPage({ page: "-3" })).toMatchObject({ ok: false, status: 400 })
	})

	it("refuses a page size of zero", () => {
		expect(readRequestDetailsPage({ pageSize: "0" })).toMatchObject({ ok: false, status: 400 })
	})

	it("refuses an oversized page size instead of silently shortening the page", () => {
		// The pager drives this endpoint; clamping would show the wrong rows and hide
		// that the pager asked for something impossible.
		expect(readRequestDetailsPage({ pageSize: String(MAX_PAGE_SIZE + 1) })).toMatchObject({
			ok: false,
			status: 400,
		})
	})

	it("accepts exactly the ceiling", () => {
		const answer = readRequestDetailsPage({ pageSize: String(MAX_PAGE_SIZE) })
		expect(isPageFailure(answer) ? null : answer.page.pageSize).toBe(MAX_PAGE_SIZE)
	})

	it("keeps a legitimate page and size", () => {
		const answer = readRequestDetailsPage({ page: "3", pageSize: "50" })
		expect(isPageFailure(answer) ? null : answer.page).toEqual({ page: 3, pageSize: 50 })
	})
})

describe("shouldIncludePayloads", () => {
	it("withholds unless the operator opted in", () => {
		expect(
			shouldIncludePayloads({
				settings: {},
				requireLoginDisabled: false,
				requestAuthenticated: true,
			}).include,
		).toBe(false)
	})

	it("fails closed when the settings row is unreadable", () => {
		// A database error is not consent.
		expect(
			shouldIncludePayloads({
				settings: null,
				requireLoginDisabled: false,
				requestAuthenticated: true,
			}),
		).toMatchObject({ include: false })
	})

	it("withholds on an open gateway even when the flag is on, if unauthenticated", () => {
		const decision = shouldIncludePayloads({
			settings: { observabilityIncludePayloads: true, requireLogin: false },
			requireLoginDisabled: true,
			requestAuthenticated: false,
		})
		// A flag set while thinking of a logged-in dashboard must not become
		// world-readable conversation history on a port anyone can reach.
		expect(decision).toEqual({ include: false, reason: "unauthenticated-on-open-gateway" })
	})

	it("allows it on an open gateway when the request is itself authenticated", () => {
		expect(
			shouldIncludePayloads({
				settings: { observabilityIncludePayloads: true, requireLogin: false },
				requireLoginDisabled: true,
				requestAuthenticated: true,
			}).include,
		).toBe(true)
	})

	it("allows it on a gated gateway without asking about authentication", () => {
		expect(
			shouldIncludePayloads({
				settings: { observabilityIncludePayloads: true, requireLogin: true },
				requireLoginDisabled: false,
				requestAuthenticated: false,
			}).include,
		).toBe(true)
	})
})

describe("redactionSettingsFrom", () => {
	it("reports requireLogin: false as an open gateway", () => {
		expect(redactionSettingsFrom({ requireLogin: false }).requireLoginDisabled).toBe(true)
		expect(redactionSettingsFrom({ requireLogin: true }).requireLoginDisabled).toBe(false)
	})

	it("treats a missing or non-object row as no settings", () => {
		expect(redactionSettingsFrom(null).settings).toBe(null)
		expect(redactionSettingsFrom("oops").settings).toBe(null)
	})
})

describe("redactRequestDetail", () => {
	const detail = {
		id: "req-1",
		model: "gpt-5",
		request: { messages: [{ role: "user", content: "secret" }] },
		response: { text: "reply" },
	}

	it("returns the row untouched when payloads are allowed", () => {
		expect(redactRequestDetail(detail, true)).toBe(detail)
	})

	it("replaces each stored payload with a marker that says how to see it", () => {
		const out = redactRequestDetail(detail, false)
		expect(out.request).toMatchObject({ withheld: true, field: "request" })
		expect((out.request as { hint: string }).hint).toBe(WITHHELD_PAYLOAD_HINT)
		expect(JSON.stringify(out)).not.toContain("secret")
	})

	it("reports the size of what was withheld, so the operator knows it exists", () => {
		const out = redactRequestDetail(detail, false)
		expect((out.request as { bytes: number }).bytes).toBeGreaterThan(0)
	})

	it("leaves non-payload fields alone", () => {
		const out = redactRequestDetail(detail, false)
		expect(out.id).toBe("req-1")
		expect(out.model).toBe("gpt-5")
	})

	it("does not invent a marker for a payload that was never stored", () => {
		// A marker for an absent field would report storage that does not exist.
		const partial = { id: "req-2", response: { text: "x" } }
		const out = redactRequestDetail(partial, false)
		expect(out.request).toBe(undefined)
		expect(out.providerResponse).toBe(undefined)
		expect(out.response).toMatchObject({ withheld: true })
	})

	it("covers every documented payload field", () => {
		const all = Object.fromEntries(REQUEST_PAYLOAD_FIELDS.map((field) => [field, { a: 1 }]))
		const out = redactRequestDetail(all, false)
		for (const field of REQUEST_PAYLOAD_FIELDS) {
			expect(out[field]).toMatchObject({ withheld: true, field })
		}
	})
})

describe("canReadFullRequestPayload", () => {
	it("allows only a password (admin) session", () => {
		expect(canReadFullRequestPayload("admin")).toBe(true)
		expect(canReadFullRequestPayload("key")).toBe(false)
		expect(canReadFullRequestPayload(undefined)).toBe(false)
	})
})
