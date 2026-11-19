/**
 * NVIDIA NIM embeddings.
 *
 * NIM's retrieval models are asymmetric and reject a request that does not name
 * the side of the query/passage pair it is embedding:
 *
 *   [400]: 'input_type' parameter is required for asymmetric models
 *
 * The OpenAI embeddings schema has no such field, so the plain OpenAI adapter
 * this provider used to share could never satisfy it - which is what broke both
 * `/v1/embeddings` and the dashboard's Test button. These assertions pin the
 * field onto the wire, and pin the retired model out of the catalogue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../apps/web/open-sse/executors/index.js", () => ({
	getExecutor: vi.fn(() => ({ refreshCredentials: vi.fn().mockResolvedValue(null) })),
	hasSpecializedExecutor: vi.fn(() => false),
}))

vi.mock("../../apps/web/open-sse/services/tokenRefresh.js", () => ({
	refreshWithRetry: vi.fn().mockResolvedValue(null),
}))

vi.mock("../../apps/web/open-sse/utils/proxyFetch.js", () => ({
	default: vi.fn(),
}))

import nvidiaAdapter from "../../apps/web/open-sse/handlers/embeddingProviders/nvidia.js"
import { handleEmbeddingsCore } from "../../apps/web/open-sse/handlers/embeddingsCore.js"
import nvidiaConfig from "../../apps/web/open-sse/providers/registry/nvidia.js"

const NEMOTRON_8B = "nvidia/nemotron-3.5-embed-8b"
const NEMOTRON_1B = "nvidia/nemotron-3-embed-1b"

describe("nvidia embeddings adapter", () => {
	it("supplies the model's input_type when the caller does not", () => {
		const body = nvidiaAdapter.buildBody(NEMOTRON_8B, { input: "hello world" })
		expect(body.input_type).toBe("passage")
	})

	it("supplies truncate so an over-long document is cut rather than refused", () => {
		const body = nvidiaAdapter.buildBody(NEMOTRON_8B, { input: "hello world" })
		expect(body.truncate).toBe("END")
	})

	it("lets the caller choose the side of the pair - a search query is not a document", () => {
		const body = nvidiaAdapter.buildBody(NEMOTRON_8B, { input: "hello", input_type: "query" })
		expect(body.input_type).toBe("query")
	})

	it("wraps a bare string into a one-element array, like the OpenAI adapter", () => {
		const body = nvidiaAdapter.buildBody(NEMOTRON_1B, { input: "hello world" })
		expect(body.input).toEqual(["hello world"])
		expect(body.model).toBe(NEMOTRON_1B)
	})

	it("keeps encoding_format and a positive dimensions, drops an unusable one", () => {
		const kept = nvidiaAdapter.buildBody(NEMOTRON_8B, {
			input: "x",
			encoding_format: "float",
			dimensions: 1024,
		})
		expect(kept.encoding_format).toBe("float")
		expect(kept.dimensions).toBe(1024)

		const dropped = nvidiaAdapter.buildBody(NEMOTRON_8B, { input: "x", dimensions: "" })
		expect("dimensions" in dropped).toBe(false)
	})

	it("sends no input_type for a model that declares none", () => {
		// A symmetric model rejects a field it does not implement, so the default
		// must not be applied blindly to every id under this provider.
		const body = nvidiaAdapter.buildBody("some/other-embed", { input: "x" })
		expect("input_type" in body).toBe(false)
		expect("truncate" in body).toBe(false)
	})

	it("forwards modality only when asked, so a text vector stays a text vector", () => {
		expect("modality" in nvidiaAdapter.buildBody(NEMOTRON_8B, { input: "x" })).toBe(false)
		const withImage = nvidiaAdapter.buildBody(NEMOTRON_8B, {
			input: "x",
			modality: ["text_image"],
		})
		expect(withImage.modality).toEqual(["text_image"])
	})

	it("points at the NIM embeddings endpoint", () => {
		expect(nvidiaAdapter.buildUrl()).toBe("https://integrate.api.nvidia.com/v1/embeddings")
	})

	it("authenticates with a bearer token", () => {
		const headers = nvidiaAdapter.buildHeaders({ apiKey: "nvapi-test" })
		expect(headers.Authorization).toBe("Bearer nvapi-test")
	})
})

describe("nvidia catalogue", () => {
	it("no longer lists the model NIM retired", () => {
		const ids = nvidiaConfig.models.map((m) => m.id)
		expect(ids).not.toContain("nvidia/nv-embedqa-e5-v5")
	})

	it("lists the replacement embedding models", () => {
		const embeddings = nvidiaConfig.models.filter((m) => m.kind === "embedding")
		expect(embeddings.map((m) => m.id)).toEqual([NEMOTRON_8B, NEMOTRON_1B])
	})

	it("declares the input_type each replacement requires", () => {
		for (const id of [NEMOTRON_8B, NEMOTRON_1B]) {
			const entry = nvidiaConfig.models.find((m) => m.id === id)
			expect(entry?.inputType).toBe("passage")
		}
	})
})

describe("handleEmbeddingsCore - nvidia input_type", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn())
	})
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	const RESPONSE = {
		object: "list",
		data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
		model: NEMOTRON_8B,
		usage: { prompt_tokens: 2, total_tokens: 2 },
	}

	function makeOptions(body: { model: string; input: string; [key: string]: unknown }) {
		return {
			body,
			modelInfo: { provider: "nvidia", model: body.model },
			credentials: { apiKey: "nvapi-test" },
			log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			onCredentialsRefreshed: vi.fn(),
			onRequestSuccess: vi.fn(),
		}
	}

	/** The JSON body the handler actually sent upstream. */
	function sentBody(): Record<string, unknown> {
		const call = vi.mocked(fetch).mock.calls[0]
		return JSON.parse(String(call?.[1]?.body))
	}

	it("reaches the upstream with input_type, which the model refuses to do without", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(JSON.stringify(RESPONSE), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		)

		await handleEmbeddingsCore(makeOptions({ model: NEMOTRON_8B, input: "test" }))

		const sent = sentBody()
		expect(sent.input_type).toBe("passage")
		expect(sent.model).toBe(NEMOTRON_8B)
	})

	it("forwards a caller's input_type instead of the default", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(JSON.stringify(RESPONSE), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		)

		await handleEmbeddingsCore(
			makeOptions({ model: NEMOTRON_8B, input: "test", input_type: "query" }),
		)

		expect(sentBody().input_type).toBe("query")
	})

	it("accepts the camelCase spelling too", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(JSON.stringify(RESPONSE), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		)

		await handleEmbeddingsCore(makeOptions({ model: NEMOTRON_8B, input: "test", inputType: "query" }))

		expect(sentBody().input_type).toBe("query")
	})
})
