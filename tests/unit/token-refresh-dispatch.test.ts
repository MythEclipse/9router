// Guards the refactored REFRESH_HANDLERS dispatch: null-guards + the two different defaults.
import { describe, expect, it } from "vitest"

const load = () => import("../../apps/web/open-sse/services/tokenRefresh.js")

describe("tokenRefresh dispatch", () => {
	it("getAccessToken returns null for missing/invalid refreshToken", async () => {
		const mod = await load()
		expect(await mod.getAccessToken("claude", {}, null)).toBeNull()
		expect(await mod.getAccessToken("claude", { refreshToken: 123 }, null)).toBeNull()
	})

	it("getAccessToken default: unsupported provider → null", async () => {
		const mod = await load()
		expect(await mod.getAccessToken("totally-unknown", { refreshToken: "x" }, null)).toBeNull()
	})

	it("refreshTokenByProvider returns null without refreshToken", async () => {
		const mod = await load()
		expect(await mod.refreshTokenByProvider("claude", {}, null)).toBeNull()
	})
})
