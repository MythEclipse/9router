import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// `getUseCases()` builds the whole graph, and settings is part of it. Only the two readers this
// route can reach are needed; both are fakes, so nothing opens a database.
vi.mock("../../apps/web/src/lib/localDb.js", () => ({
	getProviderConnections: vi.fn(),
	getSettings: vi.fn(async () => ({})),
	getProviderNodes: vi.fn(async () => []),
	getApiKeys: vi.fn(async () => []),
	updateSettings: vi.fn(async () => {}),
}))

// The route reaches the real use-case, but not a real database: only the wiring is faked, so the
// assertions still describe MiniMax's verdict handling rather than a mock's opinion of it.
vi.mock("@/lib/useCases", async () => {
	const { makeTtsVoices } = await import("../../apps/api/src/application/tts/tts-voices.ts")
	const { getProviderConnections } = await import("../../apps/web/src/lib/localDb.js")
	return {
		getUseCases: () => ({
			ttsVoices: makeTtsVoices({
				// Same query the real reader sends: the provider and `isActive`. Asserting on the
				// spy is part of these cases — a connection on another provider must not be used,
				// and case 2 below proves the China host is asked for its own.
				connectionOf: async (provider: string) => {
					const all = (await getProviderConnections({
						provider,
						isActive: true,
					} as never)) as { apiKey?: string }[]
					return all[0] as never
				},
				fetchVoices: async () => [],
				fetchElevenLabs: async () => [],
				fetchImpl: globalThis.fetch,
				// The route only ever asks for MiniMax, and this file is about its verdict handling;
				// an empty allow-list would answer 400 before the fetch these cases assert on.
				providers: ["minimax", "minimax-cn", "edge-tts"],
			} as never),
		}),
	}
})

// The route reaches the procedure through the in-process client, which carries the dashboard
// session. A test file has no Next request scope, so the session is faked here rather than
// letting the route run without one — that silent case is the bug this guards against.
vi.mock("@9router/auth/dashboardPermissions", () => ({
	getSessionContext: async () => ({
		session: { userId: "owner-1", email: "owner@local", role: "admin" },
		permissions: [],
		apiKeyFilter: null,
	}),
}))

import { GET } from "../../apps/web/src/app/api/media-providers/tts/minimax/voices/route.js"
import { getProviderConnections } from "../../apps/web/src/lib/localDb.js"

const originalFetch = global.fetch

describe("MiniMax voices API", () => {
	beforeEach(() => {
		global.fetch = vi.fn()
		vi.clearAllMocks()
	})

	afterEach(() => {
		global.fetch = originalFetch
	})

	it("fetches global MiniMax voices with stored API key", async () => {
		getProviderConnections.mockResolvedValueOnce([{ apiKey: "test-key" }])
		global.fetch.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					system_voice: [
						{ voice_id: "English_expressive_narrator", voice_name: "Expressive Narrator" },
						{ voice_id: "Chinese (Mandarin)_female_beijing", voice_name: "Female Beijing" },
					],
					voice_cloning: [{ voice_id: "clone_123", voice_name: "My Voice" }],
					base_resp: { status_code: 0, status_msg: "success" },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		)

		const response = await GET(new Request("http://localhost/api/media-providers/tts/minimax/voices"))
		const body = await response.json()

		expect(response.status).toBe(200)
		expect(getProviderConnections).toHaveBeenCalledWith({ provider: "minimax", isActive: true })
		expect(global.fetch).toHaveBeenCalledWith(
			"https://api.minimax.io/v1/get_voice",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer test-key",
					"Content-Type": "application/json",
				}),
				body: JSON.stringify({ voice_type: "all" }),
			}),
		)
		expect(body.byLang.English.voices[0].id).toBe("English_expressive_narrator")
		expect(body.byLang["Chinese (Mandarin)"].voices[0].id).toBe("Chinese (Mandarin)_female_beijing")
		expect(body.byLang.Custom.voices[0]).toMatchObject({
			id: "clone_123",
			name: "My Voice · Cloned",
			category: "voice_cloning",
		})
	})

	it("fetches China MiniMax voices when provider=minimax-cn", async () => {
		getProviderConnections.mockResolvedValueOnce([{ apiKey: "test-key" }])
		global.fetch.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					system_voice: [
						{ voice_id: "Chinese (Mandarin)_female_beijing", voice_name: "Female Beijing" },
					],
					base_resp: { status_code: 0, status_msg: "success" },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		)

		const response = await GET(
			new Request("http://localhost/api/media-providers/tts/minimax/voices?provider=minimax-cn"),
		)
		const body = await response.json()

		expect(response.status).toBe(200)
		expect(getProviderConnections).toHaveBeenCalledWith({ provider: "minimax-cn", isActive: true })
		expect(global.fetch.mock.calls[0][0]).toBe("https://api.minimaxi.com/v1/get_voice")
		expect(body.byLang["Chinese (Mandarin)"].voices[0].id).toBe("Chinese (Mandarin)_female_beijing")
	})
})
