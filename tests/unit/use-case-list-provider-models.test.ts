import { describe, expect, it, vi } from "vitest"
import {
	MODELS_TIMEOUT_MS,
	type ModelListDependencies,
	makeListProviderModels,
	ProviderRefusal,
} from "../../apps/api/src/application/providers/list-provider-models.ts"
import type {
	ModelListAdapter,
	StoredConnection,
} from "../../apps/api/src/application/providers/ports.ts"

const CONNECTION: StoredConnection = {
	id: "conn-1",
	provider: "openai",
	apiKey: "sk-key",
	providerSpecificData: {},
}

type CustomAnswer = Awaited<ReturnType<ModelListDependencies["resolveCustom"]>>

function harness(options: {
	connection?: StoredConnection | null
	adapter?: ModelListAdapter
	answer?: { ok: boolean; status: number; payload: unknown }
	custom?: CustomAnswer
}) {
	const find = vi.fn(async () =>
		options.connection === undefined ? CONNECTION : options.connection,
	)
	const fetchModels = vi.fn(
		async () => options.answer ?? { ok: true, status: 200, payload: { data: [{ id: "gpt" }] } },
	)
	const resolveCustom = vi.fn(async () => options.custom ?? null)
	const list = makeListProviderModels({
		connections: { find },
		catalogue: {
			label: (p) => p,
			isOpenAICompatible: () => false,
			isAnthropicCompatible: () => false,
			isCustomEmbedding: () => false,
			isWebCookie: () => false,
			apiKeySubstituteField: () => null,
			isCreatable: () => true,
			usesAwsCredentialForm: () => false,
			modelListAdapter: () => options.adapter ?? { kind: "unsupported" },
		},
		fetchModels,
		resolveCustom,
	})
	return { list, find, fetchModels, resolveCustom }
}

type SentRequest = {
	url: string
	headers: Record<string, string>
	body?: string
	timeoutMs: number
}

const sent = (fetchModels: { mock: { calls: unknown[][] } }): SentRequest =>
	fetchModels.mock.calls[0][0] as unknown as SentRequest

describe("listProviderModels — the connection", () => {
	it("answers 404 before fetching when the connection is unknown", async () => {
		const { list, fetchModels } = harness({ connection: null })
		await expect(list.run("missing")).rejects.toMatchObject({ code: "NOT_FOUND" })
		expect(fetchModels).not.toHaveBeenCalled()
	})

	it("names the connection whose list it answered", async () => {
		const { list } = harness({
			adapter: {
				kind: "fixed-endpoint",
				url: "https://api.example.com/v1/models",
				method: "GET",
				headers: {},
				authHeader: "Authorization",
				authPrefix: "Bearer ",
				parse: () => [],
			},
		})
		expect(await list.run("conn-1")).toMatchObject({
			provider: "openai",
			connectionId: "conn-1",
		})
	})
})

describe("listProviderModels — a compatible node", () => {
	const node = (provider: string, baseUrl?: string): StoredConnection => ({
		...CONNECTION,
		provider,
		apiKey: "node-key",
		providerSpecificData: baseUrl ? { baseUrl } : {},
	})

	it("appends /models to the connection's own base URL", async () => {
		const { list, fetchModels } = harness({
			connection: node("openai-compatible-1", "https://node.example.com/v1"),
			adapter: { kind: "openai-compatible" },
		})
		await list.run("conn-1")
		expect(sent(fetchModels).url).toBe("https://node.example.com/v1/models")
	})

	it("strips the full message endpoint before appending /models", async () => {
		const { list, fetchModels } = harness({
			connection: node("anthropic-compatible-1", "https://node.example.com/v1/messages"),
			adapter: { kind: "anthropic-compatible" },
		})
		await list.run("conn-1")
		expect(sent(fetchModels).url).toBe("https://node.example.com/v1/models")
	})

	it("sends both keys an Anthropic node may check, plus the version", async () => {
		const { list, fetchModels } = harness({
			connection: node("anthropic-compatible-1", "https://node.example.com/v1"),
			adapter: { kind: "anthropic-compatible" },
		})
		await list.run("conn-1")
		const { headers } = sent(fetchModels)
		expect(headers["x-api-key"]).toBe("node-key")
		expect(headers.Authorization).toBe("Bearer node-key")
		expect(headers["anthropic-version"]).toBe("2023-06-01")
	})

	it("refuses a node with no base URL rather than fetching nowhere", async () => {
		const { list, fetchModels } = harness({
			connection: node("openai-compatible-1"),
			adapter: { kind: "openai-compatible" },
		})
		await expect(list.run("conn-1")).rejects.toThrow(
			"No base URL configured for OpenAI compatible provider",
		)
		expect(fetchModels).not.toHaveBeenCalled()
	})

	it("names the Anthropic node's own missing URL, not the OpenAI one", async () => {
		const { list } = harness({
			connection: node("anthropic-compatible-1"),
			adapter: { kind: "anthropic-compatible" },
		})
		await expect(list.run("conn-1")).rejects.toThrow(/Anthropic compatible/)
	})

	it("reads an empty answer as an empty list, not an error", async () => {
		const { list } = harness({
			connection: node("openai-compatible-1", "https://node.example.com/v1"),
			adapter: { kind: "openai-compatible" },
			answer: { ok: true, status: 200, payload: {} },
		})
		expect((await list.run("conn-1")).models).toEqual([])
	})
})

describe("listProviderModels — a fixed endpoint", () => {
	const adapter: ModelListAdapter = {
		kind: "fixed-endpoint",
		url: "https://api.example.com/v1/models",
		method: "GET",
		headers: { "Content-Type": "application/json" },
		authHeader: "Authorization",
		authPrefix: "Bearer ",
		parse: (payload) => (payload as { data?: unknown[] })?.data ?? [],
	}

	it("puts the token in the header when that is how the provider asks", async () => {
		const { list, fetchModels } = harness({ adapter })
		await list.run("conn-1")
		const request = sent(fetchModels)
		expect(request.headers.Authorization).toBe("Bearer sk-key")
		expect(request.url).toBe("https://api.example.com/v1/models")
	})

	it("puts the token in the query string when that is how the provider asks", async () => {
		const { list, fetchModels } = harness({
			adapter: { ...adapter, authHeader: undefined, authQuery: "key" },
		})
		await list.run("conn-1")
		expect(sent(fetchModels).url).toBe("https://api.example.com/v1/models?key=sk-key")
	})

	it("prefers a copilot token over the API key", async () => {
		const { list, fetchModels } = harness({
			connection: { ...CONNECTION, providerSpecificData: { copilotToken: "copilot" } },
			adapter,
		})
		await list.run("conn-1")
		expect(sent(fetchModels).headers.Authorization).toBe("Bearer copilot")
	})

	it("answers 401 when there is no credential to present", async () => {
		const { list, fetchModels } = harness({
			connection: { id: "conn-1", provider: "openai", providerSpecificData: {} },
			adapter,
		})
		await expect(list.run("conn-1")).rejects.toMatchObject({
			status: 401,
			message: "No valid token found",
		})
		expect(fetchModels).not.toHaveBeenCalled()
	})

	it("sends a POST body only when the provider wants one", async () => {
		const { list, fetchModels } = harness({
			adapter: { ...adapter, method: "POST", body: { limit: 100 } },
		})
		await list.run("conn-1")
		expect(sent(fetchModels).body).toBe(JSON.stringify({ limit: 100 }))
	})

	it("carries the provider's own status, so a 429 stays a 429", async () => {
		const { list } = harness({ adapter, answer: { ok: false, status: 429, payload: null } })
		await expect(list.run("conn-1")).rejects.toMatchObject({
			status: 429,
			message: "Failed to fetch models: 429",
		})
	})

	it("uses the provider's own parser, not a generic one", async () => {
		const { list } = harness({
			adapter: { ...adapter, parse: () => [{ id: "from-provider-parser" }] },
			answer: { ok: true, status: 200, payload: { data: [{ id: "generic" }] } },
		})
		expect((await list.run("conn-1")).models).toEqual([{ id: "from-provider-parser" }])
	})

	it("bounds the request so a silent provider cannot hold it open", async () => {
		const { list, fetchModels } = harness({ adapter })
		await list.run("conn-1")
		expect(sent(fetchModels).timeoutMs).toBe(MODELS_TIMEOUT_MS)
	})
})

describe("listProviderModels — a custom resolver", () => {
	it("reports the resolver's models", async () => {
		const { list } = harness({
			adapter: { kind: "custom" },
			custom: { kind: "models", models: [{ id: "live" }] },
		})
		expect((await list.run("conn-1")).models).toEqual([{ id: "live" }])
	})

	it("keeps the resolver's warning so a fallback is visible", async () => {
		const { list } = harness({
			adapter: { kind: "custom" },
			custom: { kind: "models", models: [], warning: "Codex models: 500" },
		})
		expect(await list.run("conn-1")).toMatchObject({ warning: "Codex models: 500" })
	})

	it("turns a resolver refusal into a refusal carrying its status", async () => {
		const { list } = harness({
			adapter: { kind: "custom" },
			custom: { kind: "error", message: "No valid token found", status: 401 },
		})
		await expect(list.run("conn-1")).rejects.toBeInstanceOf(ProviderRefusal)
		await expect(list.run("conn-1")).rejects.toMatchObject({ status: 401 })
	})

	it("falls through to the fixed endpoint when no resolver claims the provider", async () => {
		const { list, fetchModels } = harness({
			adapter: {
				kind: "fixed-endpoint",
				url: "https://api.example.com/v1/models",
				method: "GET",
				headers: {},
				authHeader: "Authorization",
				authPrefix: "Bearer ",
				parse: () => [{ id: "fixed" }],
			},
			custom: null,
		})
		expect((await list.run("conn-1")).models).toEqual([{ id: "fixed" }])
		expect(fetchModels).toHaveBeenCalledOnce()
	})
})

describe("listProviderModels — a provider with no list", () => {
	it("names the provider in a 400 rather than failing a fetch", async () => {
		const { list, fetchModels } = harness({ adapter: { kind: "unsupported" } })
		await expect(list.run("conn-1")).rejects.toThrow(
			"Provider openai does not support models listing",
		)
		expect(fetchModels).not.toHaveBeenCalled()
	})
})
