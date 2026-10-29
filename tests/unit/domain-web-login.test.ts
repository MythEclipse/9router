// Tests for apps/api/src/domain/web-login.ts — the module under test decides which
// stored connection a finished browser login refreshes, and which duplicates it
// cleans up.
//
// Behaviour under test: match by email; adopt the single email-less row; never
// guess between two email-less rows; delete only same-email duplicates; never
// leak the credential past a 10-character preview.
//
// No existing test file covers this: the matching rule was spread across an
// `if/else` and a cleanup loop inside
// apps/web/src/app/api/providers/web-login/route.ts.
//
// User instruction, verbatim: "lanjut kenapa malah berhenti".

import { describe, expect, it } from "vitest"
import {
	conflictMessage,
	connectionNameFor,
	credentialPreview,
	duplicatesOf,
	findRefreshTarget,
	isWebLoginConnection,
	readIdentityVerdict,
	WEB_LOGIN_AUTH_METHOD,
	webLoginProviderData,
	webLoginRowsOf,
} from "../../apps/api/src/domain/web-login.ts"

const row = (id: string, email?: string | null, updatedAt?: string) => ({
	id,
	email,
	updatedAt,
	providerSpecificData: { authMethod: WEB_LOGIN_AUTH_METHOD },
})

describe("isWebLoginConnection", () => {
	it("recognises a row this button created", () => {
		expect(isWebLoginConnection(row("a"))).toBe(true)
	})

	it("refuses a row the operator typed", () => {
		expect(isWebLoginConnection({ id: "a", providerSpecificData: {} })).toBe(false)
		expect(isWebLoginConnection({ id: "a" })).toBe(false)
	})

	it("refuses a row that stores a cookie some other way", () => {
		expect(
			isWebLoginConnection({ id: "a", providerSpecificData: { authMethod: "manual-cookie" } }),
		).toBe(false)
	})
})

describe("webLoginRowsOf", () => {
	it("keeps only web-login rows", () => {
		const rows = [row("a"), { id: "b", providerSpecificData: { authMethod: "manual" } }, row("c")]
		expect(webLoginRowsOf(rows).map((r) => r.id)).toEqual(["a", "c"])
	})

	it("orders newest first, so a re-login refreshes the row in use", () => {
		const rows = [
			row("old", "a@b.c", "2026-01-01T00:00:00Z"),
			row("new", "a@b.c", "2026-06-01T00:00:00Z"),
		]
		expect(webLoginRowsOf(rows).map((r) => r.id)).toEqual(["new", "old"])
	})

	it("puts a row with no updatedAt last", () => {
		const rows = [row("none"), row("dated", undefined, "2026-01-01T00:00:00Z")]
		expect(webLoginRowsOf(rows).map((r) => r.id)).toEqual(["dated", "none"])
	})
})

describe("findRefreshTarget", () => {
	it("matches by email, so a second account keeps its own row", () => {
		const rows = [row("first", "one@x.com"), row("second", "two@x.com")]
		expect(findRefreshTarget(rows, "two@x.com")?.id).toBe("second")
	})

	it("returns null when the email matches nothing, so a new row is created", () => {
		expect(findRefreshTarget([row("first", "one@x.com")], "new@x.com")).toBeNull()
	})

	it("adopts the only email-less row", () => {
		expect(findRefreshTarget([row("only")], "")?.id).toBe("only")
	})

	it("refuses to guess between two email-less rows", () => {
		// Guessing here would silently overwrite somebody else's account.
		expect(findRefreshTarget([row("a"), row("b")], "")).toBeNull()
	})

	it("returns null when there are no rows at all", () => {
		expect(findRefreshTarget([], "")).toBeNull()
		expect(findRefreshTarget([], "a@b.c")).toBeNull()
	})
})

describe("duplicatesOf", () => {
	it("finds the other rows carrying the same email", () => {
		const kept = row("keep", "a@b.c")
		const rows = [kept, row("dup1", "a@b.c"), row("other", "z@b.c"), row("dup2", "a@b.c")]
		expect(duplicatesOf(rows, kept, "a@b.c").map((r) => r.id)).toEqual(["dup1", "dup2"])
	})

	it("never deletes when no email was revealed", () => {
		// Every row without an email compares equal, so there is no duplicate.
		const kept = row("keep")
		expect(duplicatesOf([kept, row("b")], kept, "")).toEqual([])
	})

	it("returns nothing when the account is unique", () => {
		const kept = row("keep", "a@b.c")
		expect(duplicatesOf([kept, row("other", "z@b.c")], kept, "a@b.c")).toEqual([])
	})
})

describe("connectionNameFor", () => {
	it("prefers the account's email", () => {
		expect(connectionNameFor("a@b.c", "Gemini")).toBe("a@b.c")
	})

	it("falls back to the provider's display name", () => {
		expect(connectionNameFor("", "Gemini")).toBe("Gemini")
	})
})

describe("credentialPreview", () => {
	it("shows ten characters and an ellipsis", () => {
		expect(credentialPreview("abcdefghijklmnop")).toBe("abcdefghij…")
	})

	it("returns null when there is no credential", () => {
		expect(credentialPreview(undefined)).toBeNull()
		expect(credentialPreview("")).toBeNull()
		expect(credentialPreview(null)).toBeNull()
	})
})

describe("webLoginProviderData", () => {
	it("marks the connection as a web login", () => {
		expect(webLoginProviderData(false)).toEqual({ authMethod: WEB_LOGIN_AUTH_METHOD })
	})

	it("records the token source when it came from localStorage", () => {
		// The two sources are replayed differently; a connection that lost the
		// distinction fails at request time, not at login time.
		expect(webLoginProviderData(true)).toEqual({
			authMethod: WEB_LOGIN_AUTH_METHOD,
			tokenSource: "localStorage",
		})
	})
})

describe("readIdentityVerdict", () => {
	it("passes a valid identity through", () => {
		expect(readIdentityVerdict({ status: "valid", email: "a@b.c" })).toEqual({ rejected: false })
	})

	it("rejects an invalid identity with the probe's message", () => {
		expect(readIdentityVerdict({ status: "invalid", error: "bad shape" })).toEqual({
			rejected: true,
			error: "bad shape",
		})
	})

	it("supplies a message when the probe gave none", () => {
		// A login that just finished in the browser is authoritative; the operator
		// needs to be told something even when the endpoint was terse.
		const verdict = readIdentityVerdict({ status: "invalid" })
		expect(verdict).toMatchObject({ rejected: true })
		expect((verdict as { error: string }).error).toMatch(/captured session was rejected/)
	})
})

describe("conflictMessage", () => {
	it("names the taken connection so the operator knows what to delete", () => {
		expect(conflictMessage("work")).toContain('"work"')
	})
})
