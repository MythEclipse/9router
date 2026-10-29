// Tests for apps/api/src/domain/batch-selection.ts — the rule that decides which
// connections a batch test covers, and the auth group each one belongs to.
//
// No existing test file covers this: the grouping was inline in
// apps/web/src/app/api/providers/test-batch/route.ts, which had no unit test.
// (provider-test-models-routing.test.ts covers model probing, a different route.)
//
// User instruction, verbatim: "lanjut kenapa malah berhenti".

import { describe, expect, it } from "vitest"
import {
	authGroupOf,
	BATCH_MODES,
	isSupportedMode,
	matchesMode,
	type ProviderClassifiers,
	selectConnections,
	unsupportedModeMessage,
} from "../../apps/api/src/domain/batch-selection.ts"

const classifiers = (overrides: Partial<ProviderClassifiers> = {}): ProviderClassifiers => ({
	isFree: () => false,
	isOAuth: () => false,
	isApiKey: () => false,
	isCompatible: () => false,
	...overrides,
})

const connection = (id: string, provider: string, authType?: string | null) => ({
	id,
	provider,
	authType,
})

describe("isSupportedMode", () => {
	it("accepts every documented mode", () => {
		for (const mode of BATCH_MODES) expect(isSupportedMode(mode)).toBe(true)
	})

	it("refuses anything else", () => {
		expect(isSupportedMode("everything")).toBe(false)
		expect(isSupportedMode("")).toBe(false)
		expect(isSupportedMode("Provider")).toBe(false)
	})
})

describe("unsupportedModeMessage", () => {
	it("names every mode the endpoint accepts", () => {
		const message = unsupportedModeMessage()
		for (const mode of BATCH_MODES) expect(message).toContain(mode)
	})
})

describe("authGroupOf", () => {
	it("files an OAuth account of a free provider under free", () => {
		// The two are separate buttons in the dashboard; a free-tier OAuth account
		// belongs to the free one, which is what the route already did.
		expect(authGroupOf(connection("a", "kiro", "oauth"), classifiers({ isFree: () => true }))).toBe(
			"free",
		)
	})

	it("files an OAuth account of a paid provider under oauth", () => {
		expect(authGroupOf(connection("a", "claude", "oauth"), classifiers())).toBe("oauth")
	})

	it("prefers the stored authType over the registry", () => {
		// An account that authenticates with a key must not be probed as OAuth just
		// because the registry also offers OAuth for that provider.
		const c = connection("a", "gemini", "apikey")
		expect(authGroupOf(c, classifiers({ isOAuth: () => true }))).toBe("apikey")
	})

	it("treats a stored cookie authType as keyed", () => {
		// `cookie` is a real stored value and no mode selects it; the probe's own
		// split is "OAuth or not", so a cookie connection is probed as keyed.
		expect(authGroupOf(connection("a", "web", "cookie"), classifiers())).toBe("apikey")
	})

	it("treats a stored subscription authType as keyed", () => {
		expect(authGroupOf(connection("a", "x", "subscription"), classifiers())).toBe("apikey")
	})

	it("falls back to the registry when no authType is stored, in declaration order", () => {
		expect(authGroupOf(connection("a", "p"), classifiers({ isFree: () => true }))).toBe("free")
		expect(
			authGroupOf(connection("a", "p"), classifiers({ isFree: () => true, isOAuth: () => true })),
		).toBe("free")
		expect(authGroupOf(connection("a", "p"), classifiers({ isOAuth: () => true }))).toBe("oauth")
		expect(authGroupOf(connection("a", "p"), classifiers({ isApiKey: () => true }))).toBe("apikey")
	})

	it("reads a compatible provider before defaulting to apikey", () => {
		expect(authGroupOf(connection("a", "p"), classifiers({ isCompatible: () => true }))).toBe(
			"compatible",
		)
	})

	it("defaults an unclassified provider to apikey", () => {
		expect(authGroupOf(connection("a", "mystery"), classifiers())).toBe("apikey")
	})
})

describe("matchesMode", () => {
	const free = connection("f", "kiro")
	const paid = connection("p", "claude", "oauth")
	const key = connection("k", "openai", "apikey")
	const compat = connection("c", "openai-compatible-x")
	const group = classifiers({
		isFree: (p) => p === "kiro",
		isCompatible: (p) => p.startsWith("openai-compatible-"),
	})

	it("selects everything for all", () => {
		for (const c of [free, paid, key, compat]) expect(matchesMode(c, "all", group)).toBe(true)
	})

	it("selects one provider id for provider", () => {
		expect(matchesMode(free, "provider", group, "kiro")).toBe(true)
		expect(matchesMode(paid, "provider", group, "kiro")).toBe(false)
	})

	it("selects nothing for provider without an id", () => {
		// The route fell through every branch here and returned an empty run; that
		// is a client bug, not an operator mistake, so nothing is the honest answer.
		expect(matchesMode(free, "provider", group, undefined)).toBe(false)
	})

	it("selects by group for the three group modes", () => {
		expect(matchesMode(free, "free", group)).toBe(true)
		expect(matchesMode(free, "oauth", group)).toBe(false)
		expect(matchesMode(paid, "oauth", group)).toBe(true)
		expect(matchesMode(key, "apikey", group)).toBe(true)
		expect(matchesMode(compat, "apikey", group)).toBe(false)
	})

	it("selects by prefix for compatible, not by group", () => {
		expect(matchesMode(compat, "compatible", group)).toBe(true)
		expect(matchesMode(free, "compatible", group)).toBe(false)
	})
})

describe("selectConnections", () => {
	const group = classifiers({ isFree: (p) => p === "kiro" })
	const all = [
		connection("1", "kiro", "oauth"),
		connection("2", "claude", "oauth"),
		connection("3", "openai", "apikey"),
	]

	it("keeps order stable", () => {
		expect(selectConnections(all, { mode: "all" }, group).map((c) => c.id)).toEqual(["1", "2", "3"])
	})

	it("narrows to one provider", () => {
		expect(
			selectConnections(all, { mode: "provider", providerId: "claude" }, group).map((c) => c.id),
		).toEqual(["2"])
	})

	it("narrows to a group", () => {
		expect(selectConnections(all, { mode: "free" }, group).map((c) => c.id)).toEqual(["1"])
		expect(selectConnections(all, { mode: "apikey" }, group).map((c) => c.id)).toEqual(["3"])
	})

	it("returns an empty run for a provider id no connection carries", () => {
		expect(selectConnections(all, { mode: "provider", providerId: "ghost" }, group)).toEqual([])
	})

	it("does not mutate the input", () => {
		const input = [...all]
		selectConnections(input, { mode: "all" }, group)
		expect(input).toHaveLength(3)
	})
})
