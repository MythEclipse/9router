import { afterEach, describe, expect, it, vi } from "vitest"
import embeddingProvider from "../../apps/web/open-sse/handlers/embeddingProviders/ollamaLocal.js"
import ttsProvider from "../../apps/web/open-sse/handlers/ttsProviders/ollamaLocal.js"

afterEach(() => {
	vi.restoreAllMocks()
})

describe("Ollama Local embedding adapter", () => {
	it("resolves configured hosts and sends dimensions to the embeddings endpoint", () => {
		const credentials = { providerSpecificData: { baseUrl: "http://ollama.local:11434/v1/" } }

		expect(embeddingProvider.buildUrl("nomic-embed-text", credentials)).toBe(
			"http://ollama.local:11434/v1/embeddings",
		)
		expect(
			embeddingProvider.buildBody("nomic-embed-text", {
				input: ["hello"],
				dimensions: "768",
				encoding_format: "float",
			}),
		).toEqual({
			model: "nomic-embed-text",
			input: ["hello"],
			dimensions: 768,
			encoding_format: "float",
		})
	})

	it("removes an already-configured embeddings suffix", () => {
		const credentials = {
			providerSpecificData: { baseUrl: "http://ollama.local:11434/v1/embeddings" },
		}
		expect(embeddingProvider.buildUrl("nomic-embed-text", credentials)).toBe(
			"http://ollama.local:11434/v1/embeddings",
		)
	})
})

describe("Ollama Local Phonon TTS adapter", () => {
	it("uses the selected Phonon voice and returns WAV audio", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(new Uint8Array(100), {
					headers: { "content-type": "audio/wav" },
				}),
		)
		vi.stubGlobal("fetch", fetchMock)

		const result = await ttsProvider.synthesize("hello", "phonon:40m-en/Zoey", {
			providerSpecificData: { baseUrl: "http://ollama.local:11434/v1" },
		})

		expect(fetchMock).toHaveBeenCalledWith(
			"http://ollama.local:11434/v1/audio/speech",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					model: "phonon:40m-en",
					input: "hello",
					voice: "Zoey",
					response_format: "wav",
				}),
			}),
		)
		expect(result.format).toBe("wav")
		expect(result.base64).toBe(Buffer.from(new Uint8Array(100)).toString("base64"))
	})

	it("requests raw PCM only when PCM is explicitly selected", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(new Uint8Array(100), {
					headers: { "content-type": "audio/pcm" },
				}),
		)
		vi.stubGlobal("fetch", fetchMock)

		const result = await ttsProvider.synthesize("hello", "phonon", {}, "pcm")

		expect(JSON.parse(fetchMock.mock.calls[0][1].body).response_format).toBe("pcm")
		expect(result.format).toBe("pcm")
	})
})
