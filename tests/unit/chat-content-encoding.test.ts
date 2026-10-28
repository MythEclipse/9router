import { zstdCompressSync } from "node:zlib"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({ requireApiKey: false }) }))
vi.mock("open-sse/index.js", () => ({}))
vi.mock("@/sse/services/auth.js", () => ({
	getProviderCredentials: vi.fn(),
	markAccountUnavailable: vi.fn(),
	clearAccountError: vi.fn(),
	extractApiKey: () => null,
	isValidApiKey: () => false,
	apiKeyGateFailure: vi.fn(),
}))
vi.mock("@/sse/services/model.js", () => ({ getModelInfo: vi.fn(), getComboModels: vi.fn() }))
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: vi.fn() }))

import { handleChat } from "../../apps/web/src/sse/handlers/chat.js"

describe("chat compressed JSON validation", () => {
	const bodies = {
		"/v1/responses": JSON.stringify({ input: "hello" }),
		"/v1/chat/completions": JSON.stringify({}),
		"/v1/messages": JSON.stringify({
			max_tokens: 100,
			messages: [{ role: "user", content: "hello" }],
		}),
	}
	for (const path of ["/v1/responses", "/v1/chat/completions", "/v1/messages"]) {
		it(`parses zstd at ${path} before model validation without upstream calls`, async () => {
			const response = await handleChat(
				new Request(`http://localhost${path}`, {
					method: "POST",
					body: zstdCompressSync(bodies[path]),
					headers: { "content-encoding": "zstd" },
				}),
			)
			expect(response.status).toBe(400)
			expect((await response.json()).error.message).toBe("Missing model")
		})
	}
	it("returns a clean 400 for corrupted zstd", async () => {
		const response = await handleChat(
			new Request("http://localhost/v1/responses", {
				method: "POST",
				body: "broken",
				headers: { "content-encoding": "zstd" },
			}),
		)
		expect(response.status).toBe(400)
		expect((await response.json()).error.message).toBe("Invalid JSON body")
	})
})
