import { describe, expect, it } from "vitest"
import { normalizeChatCoreOptions } from "../../apps/web/open-sse/handlers/chatCore/options"

describe("normalizeChatCoreOptions", () => {
	it("folds the flat legacy shape", () => {
		const n = normalizeChatCoreOptions({
			body: {},
			modelInfo: { provider: "p", model: "m" },
			credentials: {},
			rtkEnabled: true,
			headroomEnabled: true,
			cavemanLevel: "lite",
			semanticCacheEnabled: true,
			semanticCacheTtlHours: 7,
			connectionId: "c1",
			clientSignal: null as any,
		} as never)
		expect(n.tokenSavers.rtkEnabled).toBe(true)
		expect(n.tokenSavers.headroomEnabled).toBe(true)
		expect(n.tokenSavers.cavemanLevel).toBe("lite")
		expect(n.semanticCache.enabled).toBe(true)
		expect(n.semanticCache.ttlHours).toBe(7)
		expect(n.client.connectionId).toBe("c1")
	})

	it("lets a group win over the flat name", () => {
		const n = normalizeChatCoreOptions({
			body: {},
			modelInfo: { provider: "p", model: "m" },
			credentials: {},
			rtkEnabled: false,
			tokenSavers: { rtkEnabled: true },
		} as never)
		expect(n.tokenSavers.rtkEnabled).toBe(true)
	})

	it("keeps a flat value the group omits", () => {
		const n = normalizeChatCoreOptions({
			body: {},
			modelInfo: { provider: "p", model: "m" },
			credentials: {},
			ponytailEnabled: true,
			tokenSavers: { rtkEnabled: false },
		} as never)
		expect(n.tokenSavers.ponytailEnabled).toBe(true)
	})
})
