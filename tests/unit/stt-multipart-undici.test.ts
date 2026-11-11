// STT multipart bodies must be built with the FormData implementation that the
// `fetch` in use can serialize.
//
// Next.js polyfills globalThis.FormData with a Web API implementation undici's
// fetch cannot serialize; handed one, it falls back to String(body) and sends
// "[object FormData]" as text/plain, so the upstream 400/422s on a missing file
// and model. Ported from the upstream suite (v0.5.119, "STT: build multipart
// bodies with undici's FormData").
//
// Ported from tests/unit/stt-multipart-undici.test.js at 54a88d04.

import { handleSttCore } from "open-sse/handlers/sttCore.js"
import { afterEach, describe, expect, it, vi } from "vitest"

describe("STT multipart FormData", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("builds OpenAI-compatible multipart payload with file and model", async () => {
		let capturedBody: any = null
		vi.stubGlobal("fetch", async (_url: string, opts: any) => {
			capturedBody = opts.body
			return new Response(JSON.stringify({ text: "transcribed speech" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})
		})

		const form = new FormData()
		form.set("model", "whisper-1")
		form.set("file", new File([new Uint8Array([0, 1, 2])], "audio.wav", { type: "audio/wav" }))
		form.set("language", "uk")

		const result = await handleSttCore({
			provider: "openai",
			model: "whisper-1",
			formData: form,
			credentials: { apiKey: "test-key" },
			sttConfig: {
				baseUrl: "https://api.openai.com/v1/audio/transcriptions",
				authType: "bearer",
				format: "openai",
			},
		})

		expect(result.success).toBe(true)
		expect(capturedBody).toBeDefined()
		expect(capturedBody.get("model")).toBe("whisper-1")
		expect(capturedBody.get("language")).toBe("uk")
		const filePart = capturedBody.get("file")
		expect(filePart).toBeDefined()
		expect(filePart.name).toBe("audio.wav")
	})
})
