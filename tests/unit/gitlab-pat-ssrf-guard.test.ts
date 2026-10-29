// Regression coverage for the SSRF gap in POST /api/oauth/gitlab/pat: `baseUrl`
// comes straight from the client, so a remote caller must not be able to point
// the server's user-info probe at an internal/loopback/metadata host. Local
// callers keep self-hosted GitLab on a private network reachable.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	isLocalRequest: vi.fn(),
	createProviderConnection: vi.fn(),
	fetchPublic: vi.fn(async () => new Response("{}", { status: 200 })),
}))

vi.mock("@/dashboardGuard", () => ({ isLocalRequest: mocks.isLocalRequest }))
// The public fetch is not what these cases exercise: they assert on the direct fetch used for
// local callers, so the guard module is stubbed rather than loaded.
vi.mock("@/shared/utils/ssrfGuard", () => ({ fetchPublic: mocks.fetchPublic }))
vi.mock("@/models", () => ({ createProviderConnection: mocks.createProviderConnection }))
// The route delegates the flow to a use-case; this file stubs the fetch it injects and
// asserts on that, so the real use-case graph is not what is under test here.
vi.mock("@/lib/useCases", async () => {
	const { importGitlabPat } = await import("../../apps/api/src/application/oauth/gitlab-pat.ts")
	return { getUseCases: () => ({ oauth: { importGitlabPat } }) }
})

// Relative, not `@/...route.js`: the alias maps `@/` to apps/web/src and the `.js` suffix
// has no matching `route.ts`, so the module never resolved.
const { POST } = await import("../../apps/web/src/app/api/oauth/gitlab/pat/route.ts")

const request = (body) => ({ json: async () => body })

describe("POST /api/oauth/gitlab/pat: SSRF guard on client-supplied baseUrl", () => {
	const originalFetch = global.fetch

	beforeEach(() => {
		vi.clearAllMocks()
		mocks.createProviderConnection.mockResolvedValue({ id: 1 })
	})

	afterEach(() => {
		global.fetch = originalFetch
	})

	it("rejects a loopback baseUrl for a remote caller without ever fetching", async () => {
		mocks.isLocalRequest.mockReturnValue(false)
		// Remote callers go through the SSRF-guarded fetch; the guard is what must refuse.
		mocks.fetchPublic.mockImplementationOnce(async () => {
			throw new Error("Blocked URL: loopback")
		})

		const res = await POST(request({ token: "glpat-x", baseUrl: "http://127.0.0.1:9999" }))

		expect(mocks.fetchPublic).toHaveBeenCalledTimes(1)
		expect(res.status).toBe(400)
		expect((await res.json()).error).toBe("URL not allowed")
	})

	it("still follows a public baseUrl for a remote caller", async () => {
		mocks.isLocalRequest.mockReturnValue(false)
		const fetchSpy = vi.fn(
			async () =>
				new Response(JSON.stringify({ username: "u", name: "n" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		)
		mocks.fetchPublic.mockImplementationOnce(fetchSpy as never)

		const res = await POST(request({ token: "glpat-x", baseUrl: "http://8.8.8.8" }))

		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(String(fetchSpy.mock.calls[0][0])).toBe("http://8.8.8.8/api/v4/user")
		expect(res.status).toBe(200)
	})

	it("keeps a self-hosted GitLab on a private address reachable for local callers", async () => {
		mocks.isLocalRequest.mockReturnValue(true)
		const fetchSpy = vi.fn(
			async () => new Response(JSON.stringify({ username: "u" }), { status: 200 }),
		)
		global.fetch = fetchSpy

		const res = await POST(request({ token: "glpat-x", baseUrl: "http://127.0.0.1:9999" }))

		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(res.status).toBe(200)
	})
})
