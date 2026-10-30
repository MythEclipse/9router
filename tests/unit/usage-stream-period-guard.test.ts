/**
 * The period guard on the usage SSE route.
 *
 * Module under test: `apps/web/src/app/api/usage/stream/route.ts` — `GET`. No test file exists for it;
 * the route is absent from every `tests/` file in the repo.
 *
 * Why this file exists: the other six usage routes refuse an unknown `?period=` through a shared rule
 * (`usage/leaderboard` even carries a comment about "a week of data labelled with what the caller
 * asked for"). The SSE route was the one that never got it, and it is the one where the failure is
 * silent: `periodCutoff` in `packages/db` maps an unknown period to `null`, which means unbounded, so
 * `?period=abc` streams the whole history rather than a week, and nothing in the response says so.
 *
 * What the cases assert, and why not `response.status`: when the guard is missing there is no error at
 * all — the route returns a healthy 200 `text/event-stream` and starts reading the database. Checking
 * only the status made two mutations survive (guard deleted, guard forced false), because 200 is also
 * the correct status for every valid period. The test therefore asserts what must *not* happen: no
 * query is issued and no stream is opened for a period that is not offered.
 *
 * User's verbatim instruction: "lanjut"
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const getUsageStats = vi.fn(async () => ({ requests: 0 }))
const getActiveRequests = vi.fn(async () => ({
	activeRequests: [],
	recentRequests: [],
	errorProvider: null,
}))

vi.mock("@9router/auth/dashboardPermissions", () => ({
	getSessionContext: async () => ({ apiKeyFilter: null, allowedModels: "*" }),
}))

vi.mock("@/lib/usageDb", () => ({
	getUsageStats: (...args: unknown[]) => getUsageStats(...(args as [])),
	getActiveRequests: (...args: unknown[]) => getActiveRequests(...(args as [])),
	statsEmitter: { on: () => {}, off: () => {} },
}))

const { GET } = await import("../../apps/web/src/app/api/usage/stream/route.ts")

function ask(query: string): Request {
	return new Request(`http://localhost/api/usage/stream${query}`)
}

beforeEach(() => {
	getUsageStats.mockClear()
	getActiveRequests.mockClear()
})

describe("an unknown period is refused before anything is read", () => {
	it("queries nothing for a typo, because an unrefused period is unbounded", async () => {
		// `periodCutoff("abc")` is null and null means unbounded. Without the guard this route
		// answers 200 with an event stream and reads the whole history, so a status assertion
		// alone cannot see the defect — the absence of the query is what proves the refusal.
		await GET(ask("?period=abc"))
		expect(getUsageStats).not.toHaveBeenCalled()
		expect(getActiveRequests).not.toHaveBeenCalled()
	})

	it("answers 400 and names the value, so the caller can see the typo", async () => {
		const response = await GET(ask("?period=90d"))
		expect(response.status).toBe(400)
		expect(JSON.stringify(await response.json())).toContain("90d")
	})

	it("refuses every period that is not offered", async () => {
		for (const period of ["90d", "1y", "week", "all-time", "7D", "abc"]) {
			getUsageStats.mockClear()
			const response = await GET(ask(`?period=${encodeURIComponent(period)}`))
			expect(response.status, `${JSON.stringify(period)} must be refused`).toBe(400)
			expect(getUsageStats, `${period} must not reach the database`).not.toHaveBeenCalled()
		}
	})

	it("does not answer an event stream on the refusal path", async () => {
		const response = await GET(ask("?period=abc"))
		expect(response.headers.get("Content-Type") ?? "").not.toContain("text/event-stream")
	})

	it("treats a request with no period at all as today, not as everything", async () => {
		// The default is the shard that is cheapest to serve and the one the panel opens on.
		// Anything unbounded here would make a bare GET the most expensive call in the route.
		const response = await GET(ask(""))
		expect(response.status).toBe(200)
		const period = (getUsageStats.mock.calls[0] as unknown[])?.[0]
		expect(period).toBe("today")
	})
})
