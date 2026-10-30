/**
 * SSRF guard on POST /api/cli-tools/cowork-mcp-tools (#3782).
 *
 * Remote callers must not be able to force server-side fetches to
 * internal URLs; local-host use (self-hosted MCP servers) keeps working.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/server", () => ({
	NextResponse: {
		json: (body, init) =>
			new Response(JSON.stringify(body), {
				status: init?.status ?? 200,
				headers: { "content-type": "application/json" },
			}),
	},
}))

// The route now reaches the procedure through the in-process client, which carries the dashboard
// session. There is no Next request scope in a test file, so the session is part of the wiring
// this test fakes — a password session, which is what a dashboard caller has. Mocking it here
// (rather than making the route tolerate a missing session) is deliberate: a route that silently
// runs with no session is the bug this avoids.
vi.mock("@9router/auth/dashboardPermissions", () => ({
	getSessionContext: async () => ({
		session: { userId: "owner-1", email: "owner@local", role: "admin" },
		permissions: [],
		apiKeyFilter: null,
	}),
}))

// The route reaches the real use-case, but not a real database: only the wiring is faked, so
// these cases still assert the SSRF decision itself rather than a mock's opinion of it.
vi.mock("@/lib/useCases", async () => {
	const { probeCoworkMcpTools } = await import(
		"../../apps/api/src/application/cowork-mcp/probe-mcp-tools.ts"
	)
	return { getUseCases: () => ({ coworkMcp: { probeTools: probeCoworkMcpTools } }) }
})

const { POST } = await import("../../apps/web/src/app/api/cli-tools/cowork-mcp-tools/route.js")

function remoteRequest(url) {
	return new Request("http://gateway.example.com/api/cli-tools/cowork-mcp-tools", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ url }),
	})
}

describe("cowork-mcp-tools SSRF guard", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	it("rejects loopback URLs from remote callers without fetching", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch")
		const res = await POST(remoteRequest("http://127.0.0.1:18731/internal-admin"))
		expect(res.status).toBe(400)
		expect(await res.json()).toEqual({ error: "URL not allowed" })
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it("rejects private-network URLs from remote callers", async () => {
		for (const url of [
			"http://10.0.0.5/mcp",
			"http://192.168.1.1/mcp",
			"http://localhost:3000/mcp",
		]) {
			const res = await POST(remoteRequest(url))
			expect(res.status, `should reject ${url}`).toBe(400)
		}
	})

	it("still requires a url", async () => {
		const res = await POST(
			new Request("http://gateway.example.com/api/cli-tools/cowork-mcp-tools", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			}),
		)
		expect(res.status).toBe(400)
	})
})
