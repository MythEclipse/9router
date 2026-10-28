/**
 * Web search provider selection and credential resolution.
 *
 * The invariant under test: credentials are resolved at call time from the
 * injected resolver, never inlined, and never reused from the chat lane.
 */
import { describe, expect, it, vi } from "vitest"
import {
	resolveSearchCredentials,
	resolveSearchProvider,
	supportsSearch,
} from "../../apps/web/open-sse/handlers/webSearchCredentials.js"

/** Helper: the raw lock-key string a positional call would have leaked. */
const res_lockKeyString = () => "websearch:serper"

describe("supportsSearch", () => {
	it("accepts a provider with a dedicated search config", () => {
		expect(supportsSearch("serper")).toBe(true)
	})

	it("accepts a provider that searches via chat", () => {
		expect(supportsSearch("perplexity")).toBe(true)
	})

	it("rejects a provider with no search capability", () => {
		expect(supportsSearch("kiro")).toBe(false)
	})

	it("rejects an unknown provider", () => {
		expect(supportsSearch("nope-not-real")).toBe(false)
		expect(supportsSearch(undefined)).toBe(false)
	})
})

describe("resolveSearchProvider", () => {
	it("honours an explicit configured provider", () => {
		const sel = resolveSearchProvider({
			providerId: "serper",
			requestProvider: "kiro",
			candidates: [],
		})
		expect(sel.providerId).toBe("serper")
		expect(sel.source).toBe("settings")
	})

	it("ignores a configured provider that cannot search", () => {
		// Misconfiguration must not silently produce a search that cannot run.
		const sel = resolveSearchProvider({
			providerId: "kiro",
			requestProvider: "kiro",
			candidates: ["serper"],
		})
		expect(sel.providerId).toBe("serper")
		expect(sel.source).toBe("auto")
	})

	it("uses the request's own provider when it can search", () => {
		const sel = resolveSearchProvider({
			providerId: null,
			requestProvider: "perplexity",
			candidates: [],
		})
		expect(sel.providerId).toBe("perplexity")
		expect(sel.source).toBe("request-provider")
	})

	it("falls back to a candidate when the chat provider cannot search", () => {
		// tavily outranks serper in the preference list, so order is stable rather
		// than following whatever order candidates happened to arrive in.
		const sel = resolveSearchProvider({
			providerId: null,
			requestProvider: "kiro",
			candidates: ["serper", "tavily"],
		})
		expect(sel.providerId).toBe("tavily")
		expect(sel.source).toBe("auto")
	})

	it("prefers a well-known provider over candidate ordering, for stability", () => {
		const sel = resolveSearchProvider({
			providerId: null,
			requestProvider: "kiro",
			candidates: ["some-obscure-engine", "searxng"],
		})
		expect(sel.providerId).toBe("searxng")
	})

	it("skips candidates that cannot search", () => {
		const sel = resolveSearchProvider({
			providerId: null,
			requestProvider: "kiro",
			candidates: ["kiro", "serper"],
		})
		expect(sel.providerId).toBe("serper")
	})

	it("reports none when nothing can search", () => {
		const sel = resolveSearchProvider({
			providerId: null,
			requestProvider: "kiro",
			candidates: ["also-kiro"],
		})
		expect(sel.providerId).toBeNull()
		expect(sel.source).toBe("none")
	})

	it("reports none with no inputs at all", () => {
		expect(resolveSearchProvider({}).providerId).toBeNull()
	})
})

describe("resolveSearchCredentials", () => {
	it("bypasses the lookup entirely for a no-auth provider", async () => {
		const getProviderCredentials = vi.fn()
		const res = await resolveSearchCredentials({
			provider: { noAuth: true },
			providerId: "searxng",
			getProviderCredentials,
		})

		expect(res.noAuth).toBe(true)
		expect(res.credentials).toBeNull()
		expect(getProviderCredentials).not.toHaveBeenCalled()
	})

	it("resolves through the injected resolver", async () => {
		const creds = { accessToken: "resolved-at-runtime" }
		const getProviderCredentials = vi.fn().mockResolvedValue(creds)

		const res = await resolveSearchCredentials({
			provider: { noAuth: false },
			providerId: "serper",
			getProviderCredentials,
		})

		expect(res.credentials).toBe(creds)
		expect(getProviderCredentials).toHaveBeenCalledOnce()
		expect(getProviderCredentials.mock.calls[0][0]).toBe("serper")
	})

	it("namespaces the lock key so a search failure cannot lock the chat lane", async () => {
		const getProviderCredentials = vi.fn().mockResolvedValue({})
		const res = await resolveSearchCredentials({
			provider: {},
			providerId: "serper",
			getProviderCredentials,
		})

		expect(res.lockKey).toBe("websearch:serper")
		// The lock key must reach the resolver namespaced, or a search failure
		// would write an account-wide lock and take the chat lane offline too.
		// It travels as an options object, NOT positionally: the app resolver's
		// third positional parameter is `model`, so a bare string there would
		// filter credentials by a model named "websearch:<id>" and match nothing.
		const forwarded = getProviderCredentials.mock.calls[0][2]
		expect(typeof forwarded).toBe("object")
		expect(forwarded.lockKey).toBe("websearch:serper")
	})

	it("passes no positional model, so credential selection is not model-filtered", async () => {
		const getProviderCredentials = vi.fn().mockResolvedValue({})
		await resolveSearchCredentials({
			provider: {},
			providerId: "serper",
			getProviderCredentials,
		})

		// Slot 3 is the options object; a lock key string in that position would be
		// read as `model` by getProviderCredentials.
		expect(getProviderCredentials.mock.calls[0][1]).toBeInstanceOf(Set)
		expect(getProviderCredentials.mock.calls[0][2]).not.toBe(res_lockKeyString())
	})

	it("falls back to the linked chat provider's credentials", async () => {
		const shared = { accessToken: "shared-key" }
		const getProviderCredentials = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(shared)

		const res = await resolveSearchCredentials({
			provider: { credentialFallback: "ollama" },
			providerId: "ollama-search",
			getProviderCredentials,
		})

		expect(res.credentials).toBe(shared)
		expect(getProviderCredentials.mock.calls.map((c) => c[0])).toEqual(["ollama-search", "ollama"])
	})

	it("returns null credentials rather than throwing when lookup fails", async () => {
		const res = await resolveSearchCredentials({
			provider: {},
			providerId: "serper",
			getProviderCredentials: vi.fn().mockRejectedValue(new Error("store down")),
		})
		expect(res.credentials).toBeNull()
	})
})
