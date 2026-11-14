import { serviceKindOf } from "@9router/db/helpers/serviceKind"
import { describe, expect, it } from "vitest"

/**
 * The live stream's boxes are keyed by this classification, so the two things that
 * can silently break it are covered here: the endpoint spellings the gateway
 * actually records (Next rewrites `/v1/*` to `/api/v1/*`, so the same lane arrives
 * under both names), and the lanes that must not swallow each other — an
 * image-to-text call is not a text-to-image call, and a System One decision is not
 * chat traffic.
 */
describe("serviceKindOf", () => {
	it("maps the chat spellings onto the LLM lane", () => {
		for (const endpoint of [
			"/api/v1/chat/completions",
			"/v1/chat/completions",
			"/v1/messages",
			"/v1/messages/count_tokens",
			"/api/v1/responses",
			"/v1/responses/compact",
			"/api/v1/api/chat",
		]) {
			expect(serviceKindOf(endpoint), endpoint).toBe("llm")
		}
	})

	it("treats a missing endpoint as chat traffic", () => {
		// Every row written before handlers recorded an endpoint was a chat row.
		expect(serviceKindOf(undefined)).toBe("llm")
		expect(serviceKindOf(null)).toBe("llm")
		expect(serviceKindOf("")).toBe("llm")
		// A few failure paths record the literal "chat" instead of a path.
		expect(serviceKindOf("chat")).toBe("llm")
	})

	it("maps one endpoint per media lane", () => {
		const lanes = {
			"/api/v1/embeddings": "embedding",
			"/api/v1/systemone": "systemone",
			"/v1/systemone/run": "systemone",
			"/api/v1/images/generations": "image",
			"/v1/images/edits": "image",
			"/v1/images/understanding": "imageToText",
			"/v1/audio/speech": "tts",
			"/v1/audio/transcriptions": "stt",
			"/v1/audio/translations": "stt",
			"/v1/audio/music": "music",
			"/api/v1/videos/generations": "video",
			"/v1/search": "webSearch",
			"/v1/web/fetch": "webFetch",
		}
		for (const [endpoint, kind] of Object.entries(lanes)) {
			expect(serviceKindOf(endpoint), endpoint).toBe(kind)
		}
	})

	it("sees through an absolute URL, a query string and casing", () => {
		expect(serviceKindOf("http://localhost:20128/v1/embeddings")).toBe("embedding")
		expect(serviceKindOf("/api/v1/embeddings?model=text-embedding-3-small")).toBe("embedding")
		expect(serviceKindOf("/API/V1/EMBEDDINGS")).toBe("embedding")
		expect(serviceKindOf("  /v1/chat/completions  ")).toBe("llm")
	})

	it("keeps an unrecognised path out of the chat lane", () => {
		// A batch or a file upload is not chat, and folding it into the LLM box
		// would misreport it as model traffic.
		expect(serviceKindOf("/api/v1/batches")).toBe("other")
		expect(serviceKindOf("/v1/files")).toBe("other")
	})
})
