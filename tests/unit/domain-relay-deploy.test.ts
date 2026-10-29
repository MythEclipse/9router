import { describe, expect, it } from "vitest"
import {
	DEPLOY_TIMEOUT_MS,
	deployedPoolOf,
	deploymentFailed,
	deploymentReady,
	deployRequestOf,
	projectNameOf,
	relayUrlOf,
	shouldKeepPolling,
	siteNameOf,
} from "../../apps/api/src/domain/relay-deploy.ts"

describe("projectNameOf", () => {
	it("keeps the name the operator sent", () => {
		expect(projectNameOf("  my-relay  ", 1)).toBe("my-relay")
	})

	it("derives a default from the clock, so two attempts differ", () => {
		expect(projectNameOf(undefined, 1_700_000_000_000)).toMatch(/^relay-[0-9a-z]+$/)
		expect(projectNameOf(undefined, 1_700_000_000_000)).not.toBe(
			projectNameOf(undefined, 1_700_000_001_000),
		)
	})

	it("treats an empty field as untouched instead of an error", () => {
		expect(projectNameOf("", 42)).toMatch(/^relay-/)
		expect(projectNameOf("   ", 42)).toMatch(/^relay-/)
	})

	it("ignores a non-string", () => {
		expect(projectNameOf(7, 42)).toMatch(/^relay-/)
	})
})

describe("deployRequestOf", () => {
	it("reads each provider's own token field, trimmed", () => {
		expect(deployRequestOf("vercel", { vercelToken: " tok " })).toEqual({ token: "tok", fields: {} })
		expect(deployRequestOf("netlify", { netlifyToken: "nfp_x" })).toEqual({
			token: "nfp_x",
			fields: {},
		})
		expect(deployRequestOf("deno", { denoToken: "d", orgDomain: "acme.deno.dev" })).toEqual({
			token: "d",
			fields: { orgDomain: "acme.deno.dev" },
		})
	})

	it("refuses a blank token before any provider call, naming the provider's field", () => {
		expect(deployRequestOf("vercel", {})).toEqual({ error: "Vercel API token is required" })
		expect(deployRequestOf("netlify", { netlifyToken: "   " })).toEqual({
			error: "Netlify API token is required",
		})
		expect(deployRequestOf("deno", { orgDomain: "acme.deno.dev" })).toEqual({
			error: "Deno Deploy API token is required",
		})
	})

	it("does not accept another provider's token field", () => {
		expect(deployRequestOf("vercel", { netlifyToken: "nfp_x" })).toEqual({
			error: "Vercel API token is required",
		})
	})

	it("checks the provider's required fields before the token, as the screens did", () => {
		expect(deployRequestOf("deno", {})).toEqual({ error: "Organization domain is required" })
		expect(deployRequestOf("cloudflare", {})).toEqual({
			error: "Cloudflare Account ID is required",
		})
	})

	it("passes the required fields through, trimmed", () => {
		expect(deployRequestOf("cloudflare", { apiToken: "t", accountId: " acc " })).toEqual({
			token: "t",
			fields: { accountId: "acc" },
		})
	})
})

describe("siteNameOf", () => {
	it("leaves a name alone for providers that take it as-is", () => {
		expect(siteNameOf("vercel", "My-Relay", 1)).toBe("My-Relay")
		expect(siteNameOf("cloudflare", "My-Relay", 1)).toBe("My-Relay")
	})

	it("lowercases and hyphenates a Netlify site name, which becomes a subdomain", () => {
		expect(siteNameOf("netlify", "Netlify-Relay!!", 1)).toBe("netlify-relay")
		expect(siteNameOf("netlify", "  a  b  ", 1)).toBe("a-b")
	})

	it("falls back to the clock-derived name when nothing valid survives", () => {
		expect(siteNameOf("netlify", "!!!", 1000)).toMatch(/^relay-/)
		expect(siteNameOf("netlify", "", 1000)).toMatch(/^relay-/)
	})
})

describe("deployment states", () => {
	it("recognises a serving deployment", () => {
		expect(deploymentReady("READY")).toBe(true)
		expect(deploymentReady("BUILDING")).toBe(false)
	})

	it("recognises both terminal failures", () => {
		expect(deploymentFailed("ERROR")).toBe(true)
		expect(deploymentFailed("CANCELED")).toBe(true)
		expect(deploymentFailed("QUEUED")).toBe(false)
	})
})

describe("shouldKeepPolling", () => {
	const startedAt = 1_000

	it("keeps polling while the deployment is still building", () => {
		expect(shouldKeepPolling({ startedAt, now: 2_000, state: "BUILDING" })).toBe(true)
	})

	it("stops as soon as it is ready", () => {
		expect(shouldKeepPolling({ startedAt, now: 2_000, state: "READY" })).toBe(false)
	})

	it("stops on a terminal failure instead of burning the whole timeout", () => {
		expect(shouldKeepPolling({ startedAt, now: 2_000, state: "ERROR" })).toBe(false)
	})

	it("stops when the time bound is reached", () => {
		expect(
			shouldKeepPolling({
				startedAt,
				now: startedAt + DEPLOY_TIMEOUT_MS,
				state: "BUILDING",
			}),
		).toBe(false)
	})

	it("honours a caller-supplied bound", () => {
		expect(
			shouldKeepPolling({ startedAt, now: startedAt + 10, state: "BUILDING", timeoutMs: 5 }),
		).toBe(false)
	})
})

describe("relayUrlOf", () => {
	it("prefixes a bare host", () => {
		expect(relayUrlOf("relay-abc.vercel.app")).toBe("https://relay-abc.vercel.app")
	})

	it("leaves a full URL alone", () => {
		expect(relayUrlOf("https://x.dev")).toBe("https://x.dev")
		expect(relayUrlOf("http://localhost:1234")).toBe("http://localhost:1234")
	})
})

describe("deployedPoolOf", () => {
	it("registers the relay under its own provider type, so its test dials the right way", () => {
		expect(deployedPoolOf({ provider: "vercel", projectName: "r", deployUrl: "https://r" })).toEqual({
			name: "r",
			proxyUrl: "https://r",
			type: "vercel",
			noProxy: "",
			isActive: true,
			strictProxy: false,
		})
	})

	it("registers each provider under its own name", () => {
		for (const provider of ["vercel", "cloudflare", "deno", "netlify"] as const) {
			expect(deployedPoolOf({ provider, projectName: "r", deployUrl: "u" }).type).toBe(provider)
		}
	})
})
