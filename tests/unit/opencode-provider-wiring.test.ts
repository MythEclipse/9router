import { describe, expect, it } from "vitest"
import { PROVIDERS } from "../../apps/web/open-sse/config/providers.js"
import { getExecutor, hasSpecializedExecutor } from "../../apps/web/open-sse/executors/index.js"

// End-to-end wiring check for the rebuilt opencode provider: registry entry,
// executor resolution, endpoint routing and free-tier headers must all agree
// without a spawned CLI in the picture.
describe("opencode provider wiring", () => {
	const opencode = getExecutor("opencode")

	it("registers one HTTP provider with the free-lane transport", () => {
		expect(PROVIDERS.opencode?.baseUrl).toBe("https://opencode.ai")
		expect(PROVIDERS.opencode?.forceStream).toBe(true)
		expect(PROVIDERS.opencode?.noAuth).toBe(true)
		expect(hasSpecializedExecutor("opencode")).toBe(true)
		expect(opencode.constructor.name).toBe("OpenCodeExecutor")
	})

	it("exposes the free models on the opencode lane", async () => {
		// Models are keyed by alias in PROVIDER_MODELS, not on the transport map.
		const { PROVIDER_MODELS } = await import("../../apps/web/open-sse/config/providerModels.js")
		const models = (PROVIDER_MODELS as unknown as Record<string, Array<{ id: string }>>).oc
		expect(Array.isArray(models)).toBe(true)
		expect(models.length).toBeGreaterThan(0)
		expect(models.some((m) => m.id === "big-pickle")).toBe(true)
	})

	it("no longer resolves any CLI-backed variant", () => {
		expect(hasSpecializedExecutor("oc2")).toBe(false)
		expect(hasSpecializedExecutor("opencode-v2")).toBe(false)
	})

	it("routes each model family to its inference endpoint", () => {
		expect(opencode.buildUrl("deepseek-v4.1-flash-free")).toBe(
			"https://opencode.ai/inference/openai/v1/chat/completions",
		)
		expect(opencode.buildUrl("muse-spark-1.3-contributor-free")).toBe(
			"https://opencode.ai/inference/openai/v1/responses",
		)
		expect(opencode.buildUrl("union-alpha")).toBe("https://opencode.ai/inference/openai/v1/messages")
	})

	it("sends the current CLI fingerprint and a canonical session header", () => {
		const headers = opencode.buildHeaders(
			{},
			true,
			"https://opencode.ai/inference/openai/v1/chat/completions",
		)
		expect(headers["User-Agent"]).toBe("opencode/latest/2.1.4/cli")
		expect(headers["x-opencode-client"]).toBe("cli")
		expect(headers["Authorization"]).toBe("Bearer public")
		expect(headers["x-opencode-session"]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
	})

	// `public` is one anonymous allowance shared by every caller, so a connection
	// that has its own credential has to be able to speak for it.
	it("presents a configured credential instead of the anonymous identity", () => {
		const url = "https://opencode.ai/inference/openai/v1/chat/completions"

		expect(opencode.buildHeaders({ apiKey: "console-token" }, true, url).Authorization).toBe(
			"Bearer console-token",
		)
		expect(opencode.buildHeaders({ accessToken: "oauth-token" }, true, url).Authorization).toBe(
			"Bearer oauth-token",
		)
		// The noAuth stub passes "public" through accessToken; it must stay anonymous.
		expect(opencode.buildHeaders({ accessToken: "public" }, true, url).Authorization).toBe(
			"Bearer public",
		)
	})
})
