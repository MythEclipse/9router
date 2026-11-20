/**
 * The Antigravity model picker must read the live catalogue, not the static list.
 *
 * Three separate defects stacked into one symptom — "antigravity does not work in
 * prod": the picker offered models upstream no longer serves, selecting one sent an
 * id the backend answers 404 NOT_FOUND for, and nothing reported the fallback
 * because the catalogue probe looked like a transient failure.
 *
 *   1. the resolver called `/v1internal:models` on the sandbox host, which answers
 *      an HTML 404. `fetchAvailableModels` is the endpoint that exists.
 *   2. it sent no Antigravity User-Agent, so even the right endpoint answered
 *      403 PERMISSION_DENIED. Both failures were swallowed by `directResolver`,
 *      which falls back to the static catalogue and only records a warning.
 *   3. the response was read as `{ models: [...] }`; it is `{ models: { <id>: {...} } }`,
 *      keyed by the id the request has to echo back.
 *
 * The parser also has to drop three kinds of entry that are not chat models. The
 * `-disabled` ones matter most: upstream lists a tier-gated model under a
 * `-disabled` key precisely so it is not sent, and sending it 404s.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { ANTIGRAVITY_IDE_USER_AGENT } from "../../apps/web/open-sse/providers/shared.js"

const { resolveCustomModels } = await import("@/lib/providerModelsHost")

/** One live-catalogue entry, shaped like the real response. */
function entry(overrides: Record<string, unknown> = {}) {
	return {
		displayName: "Gemini 3.8 Flash (High)",
		supportsImages: true,
		recommended: true,
		...overrides,
	}
}

/** A catalogue body keyed the way upstream keys it. */
function catalogue(models: Record<string, unknown>) {
	return { models }
}

function jsonResponse(body: unknown, init: { status?: number } = {}) {
	const status = init.status ?? 200
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	}
}

const CONNECTION = { id: "conn-1", provider: "antigravity", accessToken: "token-abc" }

type ResolvedModels = { id: string; name: string }[]

/** Narrow the union so the assertions can read the fields they care about. */
function asModels(result: Awaited<ReturnType<typeof resolveCustomModels>>) {
	return result as { kind: string; models?: ResolvedModels; warning?: string } | null
}

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

describe("Antigravity live model catalogue", () => {
	it("asks fetchAvailableModels on the prod host with an Antigravity User-Agent", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(catalogue({ "gemini-3.8-flash-high": entry() })))
		vi.stubGlobal("fetch", fetchMock)

		await resolveCustomModels({ provider: "antigravity", connection: CONNECTION, timeoutMs: 5000 })

		expect(fetchMock).toHaveBeenCalledTimes(1)
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
		// The sandbox `/v1internal:models` endpoint is an HTML 404; this is the one
		// the Antigravity backend actually serves.
		expect(url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels")
		expect(init.method).toBe("POST")
		// Without this header the same request answers 403 PERMISSION_DENIED.
		expect((init.headers as Record<string, string>)["User-Agent"]).toBe(ANTIGRAVITY_IDE_USER_AGENT)
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-abc")
	})

	it("reads the id-keyed map and names each model from displayName", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse(
					catalogue({
						"gemini-3.8-flash-high": entry({ displayName: "Gemini 3.8 Flash (High)" }),
						"claude-sonnet-4-6": entry({ displayName: "Claude Sonnet 4.6 (Thinking)" }),
					}),
				),
			),
		)

		const result = asModels(
			await resolveCustomModels({
				provider: "antigravity",
				connection: CONNECTION,
				timeoutMs: 5000,
			}),
		)

		expect(result?.kind).toBe("models")
		// No warning: a successful probe must not be reported as a fallback.
		expect(result?.warning).toBeUndefined()
		expect(result?.models).toEqual([
			{ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
			{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
		])
	})

	it("drops tier-gated, internal and tab-completion entries", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse(
					catalogue({
						"gemini-3.8-flash-high": entry(),
						// Tier-gated: upstream lists these under a `-disabled` key and answers
						// 404 if they are sent anyway.
						"gemini-4-argon-disabled": entry({ displayName: "Gemini 4 Argon", disabled: true }),
						"gemini-4-carbon-disabled": entry({ displayName: "Gemini 4 Carbon", disabled: true }),
						// Editor tab-completion lanes, not requestable chat models.
						tab_flash_lite_preview: entry({ displayName: "Tab" }),
						// Upstream's own aliases.
						"internal-alias": entry({ isInternal: true }),
					}),
				),
			),
		)

		const result = asModels(
			await resolveCustomModels({
				provider: "antigravity",
				connection: CONNECTION,
				timeoutMs: 5000,
			}),
		)

		expect(result?.models?.map((m) => m.id)).toEqual(["gemini-3.8-flash-high"])
	})

	it("falls back to the static catalogue when the probe fails, and says why", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: "PERMISSION_DENIED" }, { status: 403 })),
		)

		const result = asModels(
			await resolveCustomModels({
				provider: "antigravity",
				connection: CONNECTION,
				timeoutMs: 5000,
			}),
		)

		// The fallback is still allowed — the picker has to render — but it is no
		// longer silent, which is what let the stale list ship unnoticed.
		expect(result?.kind).toBe("models")
		expect(result?.warning).toContain("403")
		expect(result?.models?.length).toBeGreaterThan(0)
	})
})
