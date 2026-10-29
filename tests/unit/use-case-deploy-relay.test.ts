import { describe, expect, it, vi } from "vitest"
import {
	type DeployDeps,
	deployRelay,
	type RelayProviderDeps,
} from "../../apps/api/src/application/proxy-pools/deploy-relay.ts"

const POOL = { id: "p1", type: "vercel", proxyUrl: "https://relay.example", name: "relay" }

function provider(overrides: Partial<RelayProviderDeps> = {}): RelayProviderDeps {
	return {
		start: vi.fn(async () => ({ id: "d1", projectId: "proj-1", state: "QUEUED" })),
		poll: vi.fn(async () => ({ state: "READY", url: "relay.example" })),
		...overrides,
	}
}

function deps(overrides: Partial<DeployDeps> = {}): DeployDeps {
	const p = provider()
	return {
		provider: vi.fn(() => p),
		createPool: vi.fn(async () => POOL),
		sleep: vi.fn(async () => undefined),
		now: vi.fn(() => 1_000),
		...overrides,
	}
}

describe("deployRelay", () => {
	it("deploys, waits, and registers the pool", async () => {
		const d = deps()
		const answer = await deployRelay({ provider: "vercel", body: { vercelToken: "tok" } }, d)
		expect(answer).toEqual({ proxyPool: POOL, deployUrl: "https://relay.example" })
	})

	it("registers the pool under the provider's own type", async () => {
		const d = deps()
		await deployRelay({ provider: "netlify", body: { netlifyToken: "tok" } }, d)
		expect(d.createPool).toHaveBeenCalledWith(expect.objectContaining({ type: "netlify" }))
	})

	it("refuses an unknown provider before calling anything", async () => {
		const d = deps({ provider: vi.fn(() => null) })
		await expect(
			deployRelay({ provider: "heroku" as never, body: { vercelToken: "tok" } }, d),
		).rejects.toThrow("Unknown relay provider")
		expect(d.createPool).not.toHaveBeenCalled()
	})

	it("passes the provider's required fields through", async () => {
		const p = provider()
		const d = deps({ provider: vi.fn(() => p) })
		await deployRelay({ provider: "cloudflare", body: { apiToken: "tok", accountId: " acc " } }, d)
		expect(p.start).toHaveBeenCalledWith({
			token: "tok",
			projectName: expect.any(String),
			fields: { accountId: "acc" },
		})
	})

	it("refuses a cloudflare deploy with no account id, before calling the provider", async () => {
		const p = provider()
		const d = deps({ provider: vi.fn(() => p) })
		await expect(
			deployRelay({ provider: "cloudflare", body: { vercelToken: "tok" } }, d),
		).rejects.toThrow("Cloudflare Account ID is required")
		expect(p.start).not.toHaveBeenCalled()
	})

	it("refuses a blank token before any provider call", async () => {
		const p = provider()
		const d = deps({ provider: vi.fn(() => p) })
		await expect(deployRelay({ provider: "vercel", body: { vercelToken: "" } }, d)).rejects.toThrow(
			"API token is required",
		)
		expect(p.start).not.toHaveBeenCalled()
	})

	it("uses the project name the caller sent", async () => {
		const p = provider()
		const d = deps({ provider: vi.fn(() => p) })
		await deployRelay({ provider: "vercel", body: { vercelToken: "tok", projectName: " mine " } }, d)
		expect(p.start).toHaveBeenCalledWith({ token: "tok", projectName: "mine", fields: {} })
	})

	it("does the provider's post-start work before polling", async () => {
		const order: string[] = []
		const p = provider({
			afterStart: vi.fn(async () => {
				order.push("afterStart")
			}),
			poll: vi.fn(async () => {
				order.push("poll")
				return { state: "READY", url: "relay.example" }
			}),
		})
		const d = deps({ provider: vi.fn(() => p) })
		await deployRelay({ provider: "vercel", body: { vercelToken: "tok" } }, d)
		expect(order).toEqual(["afterStart", "poll"])
	})

	it("keeps polling while the deployment is still building", async () => {
		let calls = 0
		const p = provider({
			poll: vi.fn(async () => {
				calls += 1
				return calls < 3 ? { state: "BUILDING" } : { state: "READY", url: "relay.example" }
			}),
		})
		const d = deps({ provider: vi.fn(() => p) })
		await deployRelay({ provider: "vercel", body: { vercelToken: "tok" } }, d)
		expect(calls).toBe(3)
	})

	it("refuses a deployment that failed, naming its state instead of a timeout", async () => {
		const p = provider({ poll: vi.fn(async () => ({ state: "ERROR" })) })
		const d = deps({ provider: vi.fn(() => p) })
		await expect(
			deployRelay({ provider: "vercel", body: { vercelToken: "tok" } }, d),
		).rejects.toThrow("Deployment failed: ERROR")
	})

	it("stops polling on a failed deployment instead of waiting out the timeout", async () => {
		const p = provider({ poll: vi.fn(async () => ({ state: "CANCELED" })) })
		const d = deps({ provider: vi.fn(() => p) })
		await expect(
			deployRelay({ provider: "vercel", body: { vercelToken: "tok" } }, d),
		).rejects.toThrow()
		expect(p.poll).toHaveBeenCalledTimes(1)
	})

	it("refuses a ready deployment that reported no URL", async () => {
		const p = provider({ poll: vi.fn(async () => ({ state: "READY" })) })
		const d = deps({ provider: vi.fn(() => p) })
		await expect(
			deployRelay({ provider: "vercel", body: { vercelToken: "tok" } }, d),
		).rejects.toThrow("without a URL")
	})

	it("does not register a pool when the deployment failed", async () => {
		const p = provider({ poll: vi.fn(async () => ({ state: "ERROR" })) })
		const d = deps({ provider: vi.fn(() => p) })
		await expect(
			deployRelay({ provider: "vercel", body: { vercelToken: "tok" } }, d),
		).rejects.toThrow()
		expect(d.createPool).not.toHaveBeenCalled()
	})

	it("reads a deployment that is already ready on the first answer without sleeping", async () => {
		const p = provider({ poll: vi.fn(async () => ({ state: "READY", url: "relay.example" })) })
		const d = deps({ provider: vi.fn(() => p) })
		await deployRelay({ provider: "vercel", body: { vercelToken: "tok" } }, d)
		expect(d.sleep).toHaveBeenCalled()
	})
})
