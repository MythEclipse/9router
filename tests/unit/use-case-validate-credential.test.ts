// Tests for apps/api/src/application/providers/validate-credential.ts — the module
// under test turns a pasted API key into one probe request and reads the answer.
//
// Behaviour under test: the four providers that must be routed off the generic
// path (compatible node, custom embedding, anthropic-compatible node, AWS), the
// config-driven web/media probes, the generic OpenAI-compatible fallback, and the
// refusal to say "valid" for a provider it cannot check at all.
//
// No existing test file covers this: the logic was inline in
// apps/web/src/app/api/providers/validate/route.ts.
//
// User instruction, verbatim: "lanjut kenapa malah berhenti".

import { describe, expect, it, vi } from "vitest"
import {
	makeValidateCredential,
	type ProbeRequest,
} from "../../apps/api/src/application/providers/validate-credential.ts"

function harness(
	options: {
		responses?: ProbeRequest[] extends never
			? never
			: Record<string, { status: number; ok?: boolean; text?: string }>
		node?: { baseUrl?: string; defaultModel?: string } | null
		config?: Record<string, unknown>
		ai?: Record<string, unknown>
	} = {},
) {
	const sent: ProbeRequest[] = []
	const send = vi.fn(async (request: ProbeRequest) => {
		sent.push(request)
		const match = Object.entries(options.responses ?? {}).find(([key]) => request.url.includes(key))
		const canned = match?.[1] ?? { status: 500 }
		return {
			status: canned.status,
			ok: canned.ok ?? (canned.status >= 200 && canned.status < 300),
			text: canned.text,
		}
	})
	const useCase = makeValidateCredential({
		send,
		findNode: async () =>
			options.node === undefined
				? { baseUrl: "https://node.test/", defaultModel: "m1" }
				: options.node,
		defaultModel: (provider) => `model-${provider}`,
		providerConfig: () => (options.config ?? undefined) as never,
		aiProvider: () => (options.ai ?? undefined) as never,
		isOpenAICompatible: (p) => p === "openai-compatible-x",
		isAnthropicCompatible: (p) => p === "anthropic-compatible-x",
		isCustomEmbedding: (p) => p === "embedding-x",
		probeAws: async () => ({ valid: true, error: null }),
		probeQoder: async () => ({ valid: true, error: null }),
		probeNous: async () => ({ valid: true, error: null }),
		ollamaLocalHost: () => "http://127.0.0.1:11434",
		tokenplanBaseUrl: () => "https://tokenplan.test/v1",
		commandCodeBody: () => ({ transformed: true }),
		randomId: () => "session-1",
	})
	return { useCase, send, sent }
}

describe("input validation", () => {
	it("refuses a missing provider", async () => {
		const { useCase } = harness()
		await expect(useCase.run({ apiKey: "k" })).rejects.toThrow("Provider and API key required")
	})

	it("refuses a missing key", async () => {
		const { useCase } = harness()
		await expect(useCase.run({ provider: "openai" })).rejects.toThrow("Provider and API key required")
	})

	it("accepts a missing key for a no-auth provider", async () => {
		const { useCase } = harness({ ai: { noAuth: true } })
		await expect(useCase.run({ provider: "searxng" })).rejects.toThrow(
			"Provider validation not supported",
		)
	})

	it("accepts a missing key when providerSpecificData substitutes for it", async () => {
		// Bedrock's `profile` stands in for the key, so validating that setup must not
		// be refused as "no key".
		const { useCase } = harness({ ai: { apiKeyOptionalWith: "profile" } })
		await expect(
			useCase.run({ provider: "bedrock", providerSpecificData: { profile: "default" } }),
		).rejects.toThrow("Provider validation not supported")
	})
})

describe("the compatible-node providers", () => {
	it("probes a compatible node's /models and trims the trailing slash", async () => {
		const { useCase, sent } = harness({ responses: { "/models": { status: 200 } } })
		const result = await useCase.run({ provider: "openai-compatible-x", apiKey: "k" })
		expect(sent[0].url).toBe("https://node.test/models")
		expect(result).toEqual({ valid: true, error: null })
	})

	it("reports 404 when the node does not exist", async () => {
		const { useCase } = harness({ node: null })
		await expect(useCase.run({ provider: "openai-compatible-x", apiKey: "k" })).rejects.toMatchObject(
			{ code: "NOT_FOUND" },
		)
	})

	it("probes an anthropic-compatible node at /v1/messages", async () => {
		const { useCase, sent } = harness({ responses: { "/v1/messages": { status: 400 } } })
		const result = await useCase.run({ provider: "anthropic-compatible-x", apiKey: "k" })
		expect(sent[0].url).toBe("https://node.test/v1/messages")
		// 400 about the model still proves the key.
		expect(result.valid).toBe(true)
	})

	it("strips a /messages suffix before appending /v1/messages", async () => {
		const { useCase, sent } = harness({
			node: { baseUrl: "https://node.test/v1/messages", defaultModel: "m" },
			responses: { "/v1/messages": { status: 200 } },
		})
		await useCase.run({ provider: "anthropic-compatible-x", apiKey: "k" })
		expect(sent[0].url).toBe("https://node.test/v1/messages")
	})
})

describe("custom embedding", () => {
	it("answers valid as soon as /models succeeds", async () => {
		const { useCase } = harness({ responses: { "/models": { status: 200 } } })
		expect(await useCase.run({ provider: "embedding-x", apiKey: "k" })).toEqual({
			valid: true,
			error: null,
		})
	})

	it("answers invalid on an auth refusal without a second call", async () => {
		const { useCase, sent } = harness({ responses: { "/models": { status: 401 } } })
		const result = await useCase.run({ provider: "embedding-x", apiKey: "k" })
		expect(result.valid).toBe(false)
		expect(sent).toHaveLength(1)
	})

	it("falls back to /embeddings when /models is merely absent", async () => {
		// Many embedding APIs have no /models; a 400 about the test model still
		// proves the key.
		const { useCase, sent } = harness({
			responses: { "/models": { status: 404 }, "/embeddings": { status: 400 } },
		})
		const result = await useCase.run({ provider: "embedding-x", apiKey: "k" })
		expect(sent).toHaveLength(2)
		expect(sent[1].url).toBe("https://node.test/embeddings")
		expect(result.valid).toBe(true)
	})
})

describe("providers whose credential is not a bearer key", () => {
	it("routes AWS credentials to the AWS probe", async () => {
		const { useCase, send } = harness({ ai: { credentialForm: "aws" } })
		const result = await useCase.run({ provider: "bedrock", apiKey: "k" })
		expect(send).not.toHaveBeenCalled()
		expect(result.valid).toBe(true)
	})

	it("routes Nous to its authenticated inference probe", async () => {
		const { useCase, send } = harness()
		expect((await useCase.run({ provider: "nous", apiKey: "k" })).valid).toBe(true)
		expect(send).not.toHaveBeenCalled()
	})

	it("routes Qoder to its token exchange", async () => {
		const { useCase, send } = harness()
		expect((await useCase.run({ provider: "qoder", apiKey: "k" })).valid).toBe(true)
		expect(send).not.toHaveBeenCalled()
	})

	it("judges a Vertex service-account file without any network call", async () => {
		const { useCase, send } = harness()
		const file = JSON.stringify({
			type: "service_account",
			client_email: "a@b",
			private_key: "pk",
			project_id: "p",
		})
		expect((await useCase.run({ provider: "vertex", apiKey: file })).valid).toBe(true)
		expect(send).not.toHaveBeenCalled()
	})

	it("probes a raw Vertex key", async () => {
		const { useCase, sent } = harness({ responses: { aiplatform: { status: 404 } } })
		const result = await useCase.run({ provider: "vertex", apiKey: "raw-key" })
		expect(sent[0].url).toContain("key=raw-key")
		// 404 means the probe model does not exist; the key was accepted.
		expect(result.valid).toBe(true)
	})
})

describe("config-driven probes", () => {
	it("probes a web-only provider through its searchConfig", async () => {
		const { useCase, sent } = harness({
			ai: {
				serviceKinds: ["webSearch"],
				searchConfig: { baseUrl: "https://search.test/q", authHeader: "bearer", method: "GET" },
			},
			responses: { "search.test": { status: 200 } },
		})
		expect((await useCase.run({ provider: "websearch", apiKey: "k" })).valid).toBe(true)
		expect(sent[0].headers?.Authorization).toBe("Bearer k")
	})

	it("accepts a no-auth web provider without probing", async () => {
		const { useCase, send } = harness({
			ai: { serviceKinds: ["webSearch"], searchConfig: { authType: "none", baseUrl: "https://x" } },
		})
		expect((await useCase.run({ provider: "searxng", apiKey: "k" })).valid).toBe(true)
		expect(send).not.toHaveBeenCalled()
	})

	it("probes a media provider through its ttsConfig", async () => {
		const { useCase, sent } = harness({
			ai: {
				serviceKinds: ["tts"],
				ttsConfig: { baseUrl: "https://tts.test/speak", authHeader: "x-api-key" },
			},
			responses: { "tts.test": { status: 200 } },
		})
		expect((await useCase.run({ provider: "tts-x", apiKey: "k" })).valid).toBe(true)
		expect(sent[0].headers?.["x-api-key"]).toBe("k")
	})

	it("accepts a media provider with no probe config, best-effort", async () => {
		const { useCase, send } = harness({ ai: { serviceKinds: ["embedding"] } })
		expect((await useCase.run({ provider: "embed-y", apiKey: "k" })).valid).toBe(true)
		expect(send).not.toHaveBeenCalled()
	})

	it("accepts a provider whose auth scheme needs data it does not have", async () => {
		// PlayHT needs two headers; reporting it invalid would refuse a fine key.
		const { useCase, send } = harness({
			ai: { serviceKinds: ["tts"], ttsConfig: { baseUrl: "https://p", authHeader: "playht" } },
		})
		expect((await useCase.run({ provider: "playht-x", apiKey: "k" })).valid).toBe(true)
		expect(send).not.toHaveBeenCalled()
	})

	it("lets a dual-purpose provider fall through to the LLM probe", async () => {
		const { useCase, sent } = harness({
			ai: {
				serviceKinds: ["llm", "webSearch"],
				searchConfig: { baseUrl: "https://search.test", authHeader: "bearer" },
			},
			config: { format: "openai", baseUrl: "https://llm.test/v1/chat/completions" },
			responses: { "https://llm.test/v1/models": { status: 200 } },
		})
		expect((await useCase.run({ provider: "hybrid", apiKey: "k" })).valid).toBe(true)
		expect(sent[0].url).toBe("https://llm.test/v1/models")
	})
})

describe("the generic OpenAI-compatible fallback", () => {
	it("derives /models from a chat completions URL", async () => {
		const { useCase, sent } = harness({
			config: { format: "openai", baseUrl: "https://x.test/v1/chat/completions" },
			responses: { "x.test/v1/models": { status: 200 } },
		})
		await useCase.run({ provider: "generic", apiKey: "k" })
		expect(sent[0].url).toBe("https://x.test/v1/models")
	})

	it("uses X-API-Key when the registry says so", async () => {
		const { useCase, sent } = harness({
			config: { format: "openai", baseUrl: "https://x.test/v1/chat", authHeader: "x-api-key" },
			responses: { "x.test": { status: 200 } },
		})
		await useCase.run({ provider: "generic", apiKey: "k" })
		expect(sent[0].headers?.["X-API-Key"]).toBe("k")
		expect(sent[0].headers?.Authorization).toBeUndefined()
	})

	it("refuses to answer valid for a provider it cannot check", async () => {
		// A validation endpoint that says "fine" when it checked nothing is worse
		// than one that admits it cannot.
		const { useCase } = harness()
		await expect(useCase.run({ provider: "mystery", apiKey: "k" })).rejects.toThrow(
			"Provider validation not supported",
		)
	})
})

describe("the per-provider readings reach the answer", () => {
	it("reports azure's own message when the key is refused", async () => {
		const { useCase } = harness({ responses: { "azure.test": { status: 401 } } })
		const result = await useCase.run({
			provider: "azure",
			apiKey: "k",
			providerSpecificData: { azureEndpoint: "https://azure.test/" },
		})
		expect(result.valid).toBe(false)
		expect(result.error).toMatch(/Azure configuration/)
	})

	it("reports cloudflare's account message for a bad account id", async () => {
		const { useCase } = harness({ responses: { cloudflare: { status: 404 } } })
		const result = await useCase.run({
			provider: "cloudflare-ai",
			apiKey: "k",
			providerSpecificData: { accountId: "acc" },
		})
		expect(result.error).toMatch(/Account ID/)
	})

	it("refuses cloudflare without an account id, without probing", async () => {
		const { useCase, send } = harness()
		const result = await useCase.run({ provider: "cloudflare-ai", apiKey: "k" })
		expect(result).toEqual({ valid: false, error: "Missing Account ID" })
		expect(send).not.toHaveBeenCalled()
	})

	it("reads gemini-web by the chat-shell markers in the body", async () => {
		const { useCase } = harness({
			responses: { "gemini.google.com": { status: 200, text: "<html>login page</html>" } },
		})
		const result = await useCase.run({ provider: "gemini-web", apiKey: "cookie" })
		expect(result.valid).toBe(false)
		expect(result.error).toMatch(/Invalid cookie/)
	})
})
