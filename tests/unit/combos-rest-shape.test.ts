import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The wire shape of `GET /api/combos`.
 *
 * Every dashboard caller reads `(await res.json()).combos` and falls back to
 * `|| []` on anything unexpected, so a route that answers with the bare array
 * does not fail — it renders an empty page with no error anywhere. That is
 * exactly how the combos page lost all seven of its rows on a deployment while
 * the gateway kept routing through them.
 *
 * The route reads the procedure result, so the assertion is on the shape the
 * dashboard consumes, not on the array contents.
 */
const fx = vi.hoisted(() => ({
	combos: [] as Array<Record<string, unknown>>,
}))

vi.mock("@/lib/orpcClient", () => ({
	createApiClient: async () => ({
		combos: { list: async () => ({ combos: fx.combos }) },
	}),
	sessionClaimsOf: () => ({ role: "admin" }),
}))

vi.mock("@/lib/useCases", () => ({ getUseCases: () => ({}) }))

vi.mock("@9router/auth/dashboardPermissions", () => ({
	getSessionContext: async () => ({ userId: "test", role: "admin" }),
}))

const { GET } = await import("../../apps/web/src/app/api/combos/route.js")

const twoCombos = () => [
	{ id: "a", name: "text", models: ["gemini/gemini-3.5-flash-lite"], kind: null },
	{ id: "b", name: "ATLAS", models: ["nvidia/nemotron-3.5-super"], kind: null },
]

describe("GET /api/combos", () => {
	beforeEach(() => {
		fx.combos = twoCombos()
	})

	it("answers { combos } so the dashboard's .combos read finds the rows", async () => {
		const body = await (await GET()).json()

		expect(Array.isArray(body)).toBe(false)
		expect(body.combos).toHaveLength(2)
		expect(body.combos.map((c: { name: string }) => c.name)).toEqual(["text", "ATLAS"])
	})

	it("keeps an empty list as { combos: [] } rather than an empty array", async () => {
		fx.combos = []

		const body = await (await GET()).json()

		expect(Array.isArray(body)).toBe(false)
		expect(body.combos).toEqual([])
	})
})
