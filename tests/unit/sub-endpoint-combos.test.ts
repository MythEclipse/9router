/**
 * Unit tests for combo support in sub-endpoints:
 * - /v1/embeddings (handleEmbeddings)
 * - /v1/systemone (handleSystemone)
 * - /v1/audio/transcriptions (handleStt)
 * - /v1/videos/generations (handleVideoCreate)
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	combos: {} as Record<string, any>,
	embeddingsCore: vi.fn(),
	systemoneCore: vi.fn(),
	sttCore: vi.fn(),
	videoCore: vi.fn(),
	getCredentials: vi.fn(),
}))

vi.mock("@/lib/localDb", async (importOriginal) => ({
	...(await importOriginal()),
	getSettings: vi.fn(async () => ({ requireApiKey: false })),
	getComboByName: vi.fn(async (name) => mocks.combos[name] || null),
	getProviderConnectionById: vi.fn(async () => ({ id: "c1", provider: "xai" })),
	getCustomModels: vi.fn(async () => []),
}))

vi.mock("@/sse/services/auth.js", () => ({
	extractApiKey: () => null,
	isValidApiKey: async () => true,
	apiKeyGateFailure: () => null,
	getProviderCredentials: mocks.getCredentials,
	clearAccountError: vi.fn(async () => {}),
	markAccountUnavailable: vi.fn(async () => ({ shouldFallback: true, cooldownMs: 0 })),
	shouldTryNextAccount: () => false,
	shouldLogAuthFailure: () => false,
}))

vi.mock("@/sse/services/tokenRefresh.js", () => ({
	checkAndRefreshToken: vi.fn(async (_p, c) => c),
	updateProviderCredentials: vi.fn(async () => {}),
}))

vi.mock("open-sse/handlers/embeddingsCore", () => ({
	handleEmbeddingsCore: mocks.embeddingsCore,
}))

vi.mock("open-sse/handlers/systemoneCore", () => ({
	handleSystemoneCore: mocks.systemoneCore,
}))

vi.mock("open-sse/handlers/sttCore", () => ({
	handleSttCore: mocks.sttCore,
}))

vi.mock("open-sse/handlers/videoCore", () => ({
	getVideoConfig: (provider: string) =>
		provider === "xai" ? { baseUrl: "https://api.x.ai/v1" } : null,
	handleVideoProxyCore: mocks.videoCore,
	sanitizeSecrets: (s: string) => s,
}))

import { handleEmbeddings } from "@/sse/handlers/embeddings.js"
import { handleStt } from "@/sse/handlers/stt.js"
import { handleSystemone } from "@/sse/handlers/systemone.js"
import { handleVideoCreate } from "@/sse/handlers/videoGeneration.js"

describe("Sub-endpoint combo support", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.getCredentials.mockResolvedValue({
			connectionId: "conn-1",
			connectionName: "Test Account",
			apiKey: "test-key",
		})
	})

	describe("Embeddings Combo", () => {
		it("expands combo and fails over from first failing model to second", async () => {
			mocks.combos["embed-combo"] = {
				name: "embed-combo",
				kind: "embedding",
				models: ["openai/text-embedding-3-small", "openai/text-embedding-3-large"],
			}

			// First model fails (500)
			mocks.embeddingsCore.mockResolvedValueOnce({
				success: false,
				status: 500,
				error: "First provider error",
				response: new Response(JSON.stringify({ error: "fail" }), { status: 500 }),
			})

			// Second model succeeds (200)
			mocks.embeddingsCore.mockResolvedValueOnce({
				success: true,
				response: new Response(
					JSON.stringify({
						object: "list",
						data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
						model: "text-embedding-3-large",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
				usage: { prompt_tokens: 5, total_tokens: 5 },
			})

			const req = new Request("http://localhost/v1/embeddings", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "embed-combo", input: "test text" }),
			})

			const res = await handleEmbeddings(req)
			expect(res.status).toBe(200)
			const json = await res.json()
			expect(json.model).toBe("text-embedding-3-large")
			expect(mocks.embeddingsCore).toHaveBeenCalledTimes(2)
		})
	})

	describe("System One Combo", () => {
		it("expands combo and fails over between systemone models", async () => {
			mocks.combos["sys-combo"] = {
				name: "sys-combo",
				kind: "systemone",
				models: ["openai/gpt-4o", "openai/gpt-4.1"],
			}

			// First model fails
			mocks.systemoneCore.mockResolvedValueOnce({
				success: false,
				status: 502,
				error: "Gateway error",
				response: new Response(JSON.stringify({ error: "bad gateway" }), { status: 502 }),
			})

			// Second model succeeds
			mocks.systemoneCore.mockResolvedValueOnce({
				success: true,
				response: new Response(
					JSON.stringify({
						decision: "approved",
						model: "gpt-4.1",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
				usage: { prompt_tokens: 10, completion_tokens: 5 },
			})

			const req = new Request("http://localhost/v1/systemone", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "sys-combo",
					state: { test: true },
					questions: { q: "proceed?" },
				}),
			})

			const res = await handleSystemone(req)
			expect(res.status).toBe(200)
			const json = await res.json()
			expect(json.decision).toBe("approved")
			expect(mocks.systemoneCore).toHaveBeenCalledTimes(2)
		})
	})

	describe("STT Combo", () => {
		it("expands combo and fails over between stt models", async () => {
			mocks.combos["stt-combo"] = {
				name: "stt-combo",
				kind: "stt",
				models: ["openai/whisper-1", "groq/whisper-large-v3"],
			}

			// First model fails
			mocks.sttCore.mockResolvedValueOnce({
				success: false,
				status: 500,
				error: "Whisper fail",
				response: new Response(JSON.stringify({ error: "whisper fail" }), { status: 500 }),
			})

			// Second model succeeds
			mocks.sttCore.mockResolvedValueOnce({
				success: true,
				response: new Response(JSON.stringify({ text: "Hello world transcribed" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			})

			const fd = new FormData()
			fd.append("model", "stt-combo")
			fd.append("file", new File([new Uint8Array(10)], "audio.mp3", { type: "audio/mp3" }))

			const req = new Request("http://localhost/v1/audio/transcriptions", {
				method: "POST",
				body: fd,
			})

			const res = await handleStt(req)
			expect(res.status).toBe(200)
			const json = await res.json()
			expect(json.text).toBe("Hello world transcribed")
			expect(mocks.sttCore).toHaveBeenCalledTimes(2)
		})
	})

	describe("Video Combo", () => {
		it("expands combo and fails over between video models", async () => {
			mocks.combos["video-combo"] = {
				name: "video-combo",
				kind: "video",
				models: ["xai/grok-imagine-video", "xai/grok-imagine-video-pro"],
			}

			// First model fails
			mocks.videoCore.mockResolvedValueOnce({
				success: false,
				status: 500,
				error: "Video model error",
				response: new Response(JSON.stringify({ error: "video model error" }), { status: 500 }),
			})

			// Second model succeeds
			mocks.videoCore.mockResolvedValueOnce({
				success: true,
				response: new Response(
					JSON.stringify({
						id: "vid-123",
						status: "processing",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			})

			const req = new Request("http://localhost/v1/videos/generations", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "video-combo", prompt: "A soaring eagle" }),
			})

			const res = await handleVideoCreate(req, "generations")
			expect(res.status).toBe(200)
			const json = await res.json()
			expect(json.id).toBe("vid-123")
			expect(mocks.videoCore).toHaveBeenCalledTimes(2)
		})
	})
})
