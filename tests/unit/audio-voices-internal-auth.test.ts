/**
 * /v1/audio/voices must not depend on a dashboard session.
 *
 * The route used to build a voice list by fetching its own dashboard endpoint,
 * /api/media-providers/tts/voices, over HTTP. That endpoint sits behind the
 * dashboard guard, so with login turned on an external API-key client passed its
 * own gate and was then answered 401 by an internal request carrying no cookie.
 *
 * These cases pin the fix: the route reads the same voice use-case in-process,
 * so no HTTP request is made at all, and the dashboard endpoint keeps its own
 * (authenticated) behaviour unchanged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The real use-case answers `{ voices }` when `lang` is set and
 * `{ byLang, languages }` otherwise. The route depends on that split, so the
 * fake has to reproduce it rather than always returning one shape.
 */
function groupLikeTheUseCase(voices: Array<{ lang: string }>, lang?: string) {
	if (lang) return { voices: voices.filter((v) => v.lang === lang), languages: [], byLang: {} }
	const byLang: Record<string, { code: string; name: string; voices: unknown[] }> = {}
	for (const voice of voices) {
		const bucket = (byLang[voice.lang] ??= { code: voice.lang, name: voice.lang, voices: [] })
		bucket.voices.push(voice)
	}
	return { languages: Object.values(byLang), byLang }
}

const mocks = vi.hoisted(() => ({
	edge: vi.fn(),
	local: vi.fn(),
	eleven: vi.fn(),
	deepgram: vi.fn(),
	inworld: vi.fn(),
}))

vi.mock("@/lib/useCases", () => ({
	getUseCases: () => ({
		ttsVoices: {
			listing: async ({ provider, lang, apiKey }) => {
				if (provider === "edge-tts") {
					const raw = await mocks.edge()
					const voices = raw.map((v) => {
						const [langCode, country] = v.Locale.split("-")
						return {
							id: v.ShortName,
							name: v.FriendlyName,
							locale: v.Locale,
							lang: langCode,
							country,
							gender: v.Gender,
						}
					})
					return groupLikeTheUseCase(voices, lang)
				}
				if (provider === "local-device") {
					const raw = await mocks.local()
					const voices = raw.map((v) => ({
						id: v.id,
						name: v.name,
						locale: v.locale.replace("_", "-"),
						lang: v.lang,
						country: v.country,
						gender: v.gender,
					}))
					return groupLikeTheUseCase(voices, lang)
				}
				if (provider === "elevenlabs") {
					const raw = await mocks.eleven(apiKey ?? "")
					return {
						voices: raw.map((v) => ({ id: v.voice_id, name: v.name })),
						languages: [],
						byLang: {},
					}
				}
				return { voices: [], languages: [], byLang: {} }
			},
			deepgram: async ({ lang }) => {
				const raw = await mocks.deepgram()
				return { voices: raw, byLang: {}, lang }
			},
			inworld: async () => ({ voices: await mocks.inworld(), byLang: {} }),
			elevenlabs: async () => ({ voices: await mocks.eleven(""), byLang: {} }),
			minimax: async () => ({ voices: [], byLang: {} }),
		},
	}),
}))

import { GET as publicVoices } from "../../apps/web/src/app/api/v1/audio/voices/route.ts"

function request(query: string) {
	return new Request(`http://127.0.0.1:20128/v1/audio/voices?${query}`)
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.edge.mockResolvedValue([
		{
			ShortName: "zh-CN-XiaoxiaoNeural",
			FriendlyName: "Xiaoxiao",
			Locale: "zh-CN",
			Gender: "Female",
		},
		{ ShortName: "en-US-JennyNeural", FriendlyName: "Jenny", Locale: "en-US", Gender: "Female" },
	])
	mocks.local.mockResolvedValue([
		{
			id: "local-voice",
			name: "Local",
			locale: "en_US",
			lang: "en",
			country: "US",
			gender: "Female",
		},
	])
	mocks.eleven.mockResolvedValue([{ voice_id: "v1", name: "Example" }])
	mocks.deepgram.mockResolvedValue([{ id: "aura-2-thalia-en", name: "Thalia", lang: "en" }])
	mocks.inworld.mockResolvedValue([])
})

describe("/v1/audio/voices reads the catalogue in-process", () => {
	it("never makes an HTTP request to its own dashboard endpoint", async () => {
		const fetchSpy = vi.fn(() => {
			throw new Error("the route must not self-fetch")
		})
		vi.stubGlobal("fetch", fetchSpy)
		try {
			const response = await publicVoices(request("provider=edge-tts&lang=zh"))
			expect(response.status).toBe(200)
			expect(fetchSpy).not.toHaveBeenCalled()
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it("lists Edge voices with the full /v1/audio/speech model id", async () => {
		const response = await publicVoices(request("provider=edge-tts&lang=zh"))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			object: "list",
			data: [
				{
					id: "zh-CN-XiaoxiaoNeural",
					name: "Xiaoxiao",
					lang: "zh",
					gender: "Female",
					model: "edge-tts/zh-CN-XiaoxiaoNeural",
				},
			],
		})
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*")
	})

	it("lists every language when no filter is supplied", async () => {
		const response = await publicVoices(request("provider=edge-tts"))
		const body = await response.json()
		expect(body.data.map((voice: { id: string }) => voice.id)).toEqual([
			"zh-CN-XiaoxiaoNeural",
			"en-US-JennyNeural",
		])
	})

	it("lists local-device voices the same way", async () => {
		const response = await publicVoices(request("provider=local-device&lang=en"))
		expect(await response.json()).toEqual({
			object: "list",
			data: [
				{
					id: "local-voice",
					name: "Local",
					lang: "en",
					gender: "Female",
					model: "local-device/local-voice",
				},
			],
		})
	})

	it("serves the paid provider catalogues from the same use-case", async () => {
		const deepgram = await publicVoices(request("provider=deepgram&lang=en"))
		expect(deepgram.status).toBe(200)
		expect((await deepgram.json()).data[0]).toMatchObject({
			id: "aura-2-thalia-en",
			model: "dg/aura-2-thalia-en",
		})
	})

	it("rejects an unknown provider without touching a fetcher", async () => {
		const response = await publicVoices(request("provider=nope"))
		expect(response.status).toBe(400)
		expect(mocks.edge).not.toHaveBeenCalled()
	})

	it("surfaces an upstream failure as its own status, not as a dashboard 401", async () => {
		const failure = new Error("Edge voices unavailable") as Error & { status: number }
		failure.status = 502
		mocks.edge.mockRejectedValueOnce(failure)
		const response = await publicVoices(request("provider=edge-tts"))
		expect(response.status).toBe(502)
		expect((await response.json()).error.message).toBe("Edge voices unavailable")
	})
})
