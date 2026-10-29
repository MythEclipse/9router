import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	getProviderConnectionById: vi.fn(),
	getApiKeys: vi.fn(),
	getConsistentMachineId: vi.fn(),
}))

vi.mock("@/lib/localDb", async (importOriginal) => ({
	...(await importOriginal()),
	getProviderConnectionById: mocks.getProviderConnectionById,
	getApiKeys: mocks.getApiKeys,
}))

vi.mock("@/shared/utils/machineId", () => ({
	getConsistentMachineId: mocks.getConsistentMachineId,
}))

vi.mock("next/server", () => ({
	NextResponse: {
		json(body, init = {}) {
			return new Response(JSON.stringify(body), {
				status: init.status || 200,
				headers: { "Content-Type": "application/json" },
			})
		},
	},
}))

const originalFetch = global.fetch

describe("provider test-models route kind routing", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.getProviderConnectionById.mockResolvedValue({
			id: "conn-hf",
			provider: "huggingface",
		})
		mocks.getApiKeys.mockResolvedValue([{ key: "sk-internal", isActive: true }])
		mocks.getConsistentMachineId.mockResolvedValue("cli-token")

		global.fetch = vi.fn((url) => {
			if (String(url).includes("/api/v1/images/generations")) {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							created: 1,
							data: [{ b64_json: "abc" }],
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					),
				)
			}
			return Promise.resolve(
				new Response(
					JSON.stringify({
						choices: [{ message: { role: "assistant", content: "ok" } }],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			)
		})
	})

	afterEach(() => {
		global.fetch = originalFetch
	})

	it("routes huggingface image models to /api/v1/images/generations", async () => {
		// The route delegates to the probe use-case now. Building the whole graph
		// would open a second SQLite handle, which `createDb` refuses under Vitest,
		// so the use-case is assembled over the mocked connection store and the real
		// host functions — the routing under test is `pingModelByKind`'s, unchanged.
		const { makeProbeModels } = await import(
			"../../apps/api/src/application/providers/probe-models.ts"
		)
		const host = await import("@/lib/providerConnectionHost")
		const probeModels = makeProbeModels({
			connections: {
				find: (id) => mocks.getProviderConnectionById(id),
				list: async () => [],
				create: async () => {
					throw new Error("unused")
				},
				update: async () => null,
				remove: async () => false,
			},
			catalogue: {
				label: (p) => p,
				isOpenAICompatible: () => false,
				isAnthropicCompatible: () => false,
				isCustomEmbedding: () => false,
				isWebCookie: () => false,
				apiKeySubstituteField: () => null,
				isCreatable: () => true,
				usesAwsCredentialForm: () => false,
			},
			knownModels: host.probeTargetsFor,
			aliasOf: host.providerAliasOf,
			liveModels: async () => null,
			probe: host.probeModel,
			isSerialProbe: host.isSerialProbe,
		})
		vi.doMock("@/lib/useCases", () => ({ getUseCases: () => ({ probeModels }) }))
		// The route reaches its procedure through the in-process client, which carries the
		// dashboard session. There is no Next request scope in a unit test, so the session
		// is part of the wiring faked here rather than something the route can look up.
		vi.doMock("@9router/auth/dashboardPermissions", () => ({
			getSessionContext: async () => ({
				session: { userId: "owner-1", email: "owner@local", role: "admin" },
				permissions: [],
				apiKeyFilter: null,
			}),
		}))

		const { POST } = await import("../../apps/web/src/app/api/providers/[id]/test-models/route.js")

		// `open-sse/utils/proxyFetch` replaces `globalThis.fetch` as an import side
		// effect, so a spy installed earlier is discarded. Installing it here, after
		// the route and its probe are loaded, is what makes the assertion below
		// observe the dispatcher's own call.
		// A minimal image response: the dispatcher reads `data` for image kinds and
		// reports "no image data" for an empty body, which would fail the row even
		// though the routing under test is correct.
		const fetchSpy = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: [{ url: "https://img.test/x.png" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		)
		global.fetch = fetchSpy

		const req = new Request("http://localhost/api/providers/conn-hf/test-models", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
		})

		const res = await POST(req, { params: Promise.resolve({ id: "conn-hf" }) })
		const body = await res.json()

		expect(body.provider).toBe("huggingface")
		expect(body.results.some((r) => r.modelId === "black-forest-labs/FLUX.1-schnell" && r.ok)).toBe(
			true,
		)
		expect(fetchSpy).toHaveBeenCalledWith(
			expect.stringContaining("/api/v1/images/generations"),
			expect.objectContaining({
				method: "POST",
			}),
		)
	})
})
