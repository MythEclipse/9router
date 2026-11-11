import { afterEach, describe, expect, it, vi } from "vitest"
import {
	clearQoderCatalog,
	resolveQoderModels,
} from "../../apps/web/open-sse/services/qoderModels.js"
import { proxyAwareFetch } from "../../apps/web/open-sse/utils/proxyFetch.js"

vi.mock("../../apps/web/open-sse/utils/proxyFetch.js", () => ({
	proxyAwareFetch: vi.fn(),
}))

afterEach(() => {
	clearQoderCatalog()
	vi.resetAllMocks()
})

describe("Qoder model catalog", () => {
	it("keeps disabled models and their current upstream names", async () => {
		const latest = {
			key: "qmodel_latest",
			display_name: "Qwen4-Max-Preview",
			enable: false,
			max_input_tokens: 200000,
		}
		vi.mocked(proxyAwareFetch).mockResolvedValue(
			new Response(
				JSON.stringify({
					chat: [latest, { key: "qfmodel", display_name: "Qwen3.8-Flash", enable: true }],
				}),
				{ status: 200 },
			),
		)

		const catalog = await resolveQoderModels(
			{
				provider: "qoder",
				accessToken: "test-token",
				providerSpecificData: { userId: "test-user" },
			},
			{ forceRefresh: true },
		)

		expect(catalog).not.toBeNull()
		expect(catalog!.models.map(({ id, name }) => ({ id, name }))).toEqual([
			{ id: "qmodel_latest", name: "Qwen4-Max-Preview" },
			{ id: "qfmodel", name: "Qwen3.8-Flash" },
		])
		expect(catalog!.rawConfigs.get("qmodel_latest")).toEqual(latest)
	})
})
