// The "smart" proxy strategy pins a provider to one pool and only moves when
// that pool reports a limit/error. That promise needs two signals wired in,
// and both were missing:
//
//   1. markAccountUnavailable() returned early for `proxy:<poolId>`
//      connections (they have no DB row to lock), so the health store never
//      learned about the failure and the next request re-picked the same pool.
//   2. clearAccountError() returned early for the same connection shape, so a
//      pool that recovered stayed parked until its cooldown expired.
//
// These tests pin both directions plus the pool-id parsing for rotating
// residential pools (`proxy:<poolId>:<sid>`).
import { beforeEach, describe, expect, it } from "vitest"

const { markAccountUnavailable, clearAccountError } = await import("../../src/sse/services/auth.js")
const { getProxyHealth, resetProxyHealth } = await import("../../src/lib/network/proxyHealth.js")

describe("proxy-backed connections drive the proxy health store", () => {
	beforeEach(() => {
		resetProxyHealth()
	})

	it("parks the pool after a fallback-eligible error", async () => {
		const res = await markAccountUnavailable(
			"proxy:pool-a",
			429,
			"rate limit exceeded",
			"opencode",
			"some-model",
		)
		expect(res.shouldFallback).toBe(true)
		expect(getProxyHealth("opencode").blocked).toContain("pool-a")
	})

	it("parses the pool id out of a rotating-session connection id", async () => {
		// Rotating residential pools append `:<sid>` to the connection id. The
		// cooldown must land on the pool, not on the per-session id.
		const res = await markAccountUnavailable(
			"proxy:pool-rot:123456789",
			429,
			"rate limit exceeded",
			"opencode",
			"some-model",
		)
		expect(res.shouldFallback).toBe(true)
		const health = getProxyHealth("opencode")
		expect(health.blocked).toContain("pool-rot")
		expect(health.blocked).not.toContain("pool-rot:123456789")
	})

	it("does not park the pool for a caller-side error", async () => {
		// A 400 is the caller's request being wrong, not the pool's fault: parking
		// it would rotate away from a perfectly healthy exit IP.
		const res = await markAccountUnavailable(
			"proxy:pool-b",
			400,
			"invalid request body",
			"opencode",
			"some-model",
		)
		expect(res.shouldFallback).toBe(false)
		expect(getProxyHealth("opencode").blocked).not.toContain("pool-b")
	})

	it("clears the cooldown and re-pins the pool after a success", async () => {
		await markAccountUnavailable("proxy:pool-c", 429, "rate limit exceeded", "opencode", "some-model")
		expect(getProxyHealth("opencode").blocked).toContain("pool-c")

		await clearAccountError("proxy:pool-c", {}, "some-model", "opencode")

		const health = getProxyHealth("opencode")
		expect(health.blocked).not.toContain("pool-c")
		expect(health.current).toBe("pool-c")
	})

	it("keys health by provider so one provider's failure does not park another's pool", async () => {
		await markAccountUnavailable(
			"proxy:shared-pool",
			429,
			"rate limit exceeded",
			"opencode",
			"some-model",
		)
		expect(getProxyHealth("opencode").blocked).toContain("shared-pool")
		expect(getProxyHealth("other-provider").blocked).not.toContain("shared-pool")
	})
})
