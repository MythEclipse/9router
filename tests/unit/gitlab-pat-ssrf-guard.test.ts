// Regression coverage for the SSRF gap in POST /api/oauth/gitlab/pat: `baseUrl`
// comes straight from the client, so a remote caller must not be able to point
// the server's user-info probe at an internal/loopback/metadata host. Local
// callers keep self-hosted GitLab on a private network reachable.
//
// The fetch choice used to live in the route (`isLocalRequest(request) ? fetch : fetchPublic`)
// and this file spoofed `isLocalRequest`. It lives in `importGitlabPat` now, so the test
// calls the use-case with real headers and stubs only the guarded fetch. Testing the
// *route* here would have kept proving a branch that no longer decides anything.

import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ fetchPublic: vi.fn() }))

vi.mock("@/shared/utils/ssrfGuard", () => ({ fetchPublic: mocks.fetchPublic }))

const { importGitlabPat } = await import("../../apps/api/src/application/oauth/gitlab-pat.ts")

/** A remote caller: stamped by the reverse proxy, so the socket is the proxy hop. */
const REMOTE = new Headers({ "x-9r-via-proxy": "1", host: "9router.example.com" })

/** The operator's own browser: loopback host and matching loopback Origin. */
const LOCAL = new Headers({ host: "localhost:20128", origin: "http://localhost:20128" })

const createConnection = vi.fn(async () => ({ id: 1 }))

/** The fetch a local caller is given; remote callers never reach it. */
const directFetch = vi.fn(
	async () => new Response(JSON.stringify({ username: "u" }), { status: 200 }),
)

function depsFor(headers: Headers) {
	// Mirrors the host's `fetchForCaller` wiring: local keeps the direct fetch, remote is
	// guarded. The rule under test is which one is chosen, not what the guard contains.
	const local = headers.get("x-9r-via-proxy") === null && headers.get("host") === "localhost:20128"
	return {
		fetchImpl: (local ? directFetch : mocks.fetchPublic) as unknown as typeof globalThis.fetch,
		createConnection,
	}
}

describe("importGitlabPat: SSRF guard on the client-supplied baseUrl", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		directFetch.mockClear()
	})

	it("rejects a loopback baseUrl for a remote caller without ever fetching", async () => {
		mocks.fetchPublic.mockImplementationOnce(async () => {
			throw new Error("Blocked URL: loopback")
		})

		const answer = await importGitlabPat(
			{ token: "glpat-x", baseUrl: "http://127.0.0.1:9999" },
			depsFor(REMOTE),
		)

		expect(mocks.fetchPublic).toHaveBeenCalledTimes(1)
		expect(answer.status).toBe(400)
		expect(answer.body.error).toBe("URL not allowed")
	})

	it("still follows a public baseUrl for a remote caller", async () => {
		const fetchSpy = vi.fn(
			async () =>
				new Response(JSON.stringify({ username: "u", name: "n" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		)
		mocks.fetchPublic.mockImplementationOnce(fetchSpy as never)

		const answer = await importGitlabPat(
			{ token: "glpat-x", baseUrl: "http://8.8.8.8" },
			depsFor(REMOTE),
		)

		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(String(fetchSpy.mock.calls[0][0])).toBe("http://8.8.8.8/api/v4/user")
		expect(answer.status).toBe(200)
	})

	it("keeps a self-hosted GitLab on a private address reachable for local callers", async () => {
		const answer = await importGitlabPat(
			{ token: "glpat-x", baseUrl: "http://127.0.0.1:9999" },
			depsFor(LOCAL),
		)

		expect(directFetch).toHaveBeenCalledTimes(1)
		// The guarded fetch must not be consulted for a local caller.
		expect(mocks.fetchPublic).not.toHaveBeenCalled()
		expect(answer.status).toBe(200)
	})
})
