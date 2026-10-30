/**
 * The route, not the rules.
 *
 * `auth-status-usecase.test.ts` covers what the answer must contain and how it closes on failure.
 * This file covers the wiring: that the handler reaches the session through the host port, and
 * that a bad cookie and a broken settings read are both reported as signed out rather than thrown.
 *
 * The route gained a use-case graph, so it needs three mocks where it used to need one: the
 * settings read and `cookies()` are reached through the port, and `getUseCases` opens the database
 * when the graph is built.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
	cookies: vi.fn(),
	getSettings: vi.fn(),
	isOidcConfigured: vi.fn(),
	isSamlConfigured: vi.fn(),
	getDashboardAuthSession: vi.fn(),
	getUseCases: vi.fn(),
}))

vi.mock("next/server", () => ({ NextResponse: { json: mocks.json } }))
vi.mock("next/headers", () => ({ cookies: mocks.cookies }))
// The route asks the real use-case graph for `authStatus.read`; only the *host reads* underneath
// it are faked. Stubbing the graph itself would test that a mock returns a mock.
vi.mock("@/lib/useCases", async (importOriginal) => ({
	...(await importOriginal()),
	getUseCases: mocks.getUseCases,
}))

/**
 * The real use-case implementation, without building the whole graph.
 *
 * `getUseCases()` opens the database, which a unit test must not do. So the route is handed the
 * genuine `readAuthStatus` bound the way the graph binds it — the function under test is real, and
 * only the host reads it calls are faked.
 */
const realAuthStatusUseCases = async () => {
	const { readAuthStatus } = await import("9router-api/application/auth-status/read-status")
	return { authStatus: { read: readAuthStatus } }
}

vi.mock("@/lib/localDb", async (importOriginal) => ({
	...(await importOriginal()),
	getSettings: mocks.getSettings,
}))

vi.mock("@9router/auth/oidc", () => ({ isOidcConfigured: mocks.isOidcConfigured }))
vi.mock("@9router/auth/saml", () => ({ isSamlConfigured: mocks.isSamlConfigured }))
vi.mock("@9router/auth/dashboardSession", () => ({
	getDashboardAuthSession: mocks.getDashboardAuthSession,
}))

const { GET } = await import("../../apps/web/src/app/api/auth/status/route.js")

describe("GET /api/auth/status", () => {
	beforeEach(async () => {
		vi.clearAllMocks()
		// A real graph: the route must reach the real `authStatus.read`, with only the host reads
		// it depends on faked. Stubbing the graph would test that a mock returns a mock.
		mocks.getUseCases.mockReturnValue(await realAuthStatusUseCases())
		mocks.getSettings.mockResolvedValue({ requireLogin: true, authMode: "password" })
		mocks.cookies.mockResolvedValue({ get: vi.fn(() => ({ value: "session-token" })) })
		mocks.isOidcConfigured.mockReturnValue(false)
		mocks.isSamlConfigured.mockReturnValue(false)
	})

	it("talks to the session through the cookie, not through a passed-in context", async () => {
		mocks.getDashboardAuthSession.mockResolvedValue({ role: "admin" })

		const response = await GET()

		expect(mocks.getDashboardAuthSession).toHaveBeenCalledWith("session-token")
		expect(response.body.role).toBe("admin")
	})

	it("answers signed out when the cookie does not verify", async () => {
		mocks.getDashboardAuthSession.mockResolvedValue(null)

		const response = await GET()

		expect(response.body.authenticated).toBe(false)
	})

	it("answers signed out, with every key, when the settings read throws", async () => {
		mocks.getSettings.mockRejectedValue(new Error("database unavailable"))

		const response = await GET()

		expect(response.body.authenticated).toBe(false)
		expect(response.body.requireLogin).toBe(true)
		// The regression that started this: the failure answer used to omit these.
		expect(response.body).toHaveProperty("permissions")
		expect(response.body).toHaveProperty("homePath")
	})
})
