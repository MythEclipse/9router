/**
 * Kiro client identity.
 *
 * AWS CodeWhisperer gates every Kiro surface on the client version the caller
 * claims. 9router used to identify as `kiro-ide/1.0.0` / `KiroIDE-0.10.32`, and
 * every Kiro request — inference, model list, usage, API-key validation,
 * profile lookup — came back as
 *
 *   {"message":"This version of Kiro is no longer supported. Please update to
 *    the latest version of Kiro to continue."}
 *
 * These tests pin the identity on every surface that talks to Kiro, so a stale
 * version can only ever be reintroduced deliberately. The TLS assertion covers
 * the second half of the same upstream change: an X25519-only ClientHello is
 * reset by AWS OIDC, which surfaced as "fetch failed" when adding an IdC account.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const fetchMock = vi.fn()

vi.mock("../../apps/web/open-sse/utils/proxyFetch.js", () => ({
	proxyAwareFetch: (...args: unknown[]) => fetchMock(...args),
}))

const { KIRO_IDE_VERSION, buildKiroIdentityHeaders, kiroMachineId } = await import(
	"../../apps/web/open-sse/shared/kiroIdentity.js"
)
const { KiroExecutor } = await import("../../apps/web/open-sse/executors/kiro.js")
const { clearKiroModelCache, resolveKiroModels } = await import(
	"../../apps/web/open-sse/services/kiroModels.js"
)
const { getKiroUsage } = await import("../../apps/web/open-sse/services/usage/kiro.js")
const kiroRegistry = (await import("../../apps/web/open-sse/providers/registry/kiro.js")).default

const ROOT = join(import.meta.dirname, "../..")
const IDENTITY_RE = new RegExp(
	`^aws-sdk-js/1\\.0\\.0 ua/2\\.1 os/windows#10\\.0\\.26200 lang/js md/nodejs#22\\.21\\.1 ` +
		`api/(codewhispererstreaming|codewhispererruntime)#1\\.0\\.0 m/(E|N,E) ` +
		`KiroIDE-${KIRO_IDE_VERSION.replace(/\./g, "\\.")}-[0-9a-f]{64}$`,
)

/** Header bag of a recorded fetch call (plain object, not a Headers instance). */
function headersOf(call: unknown[]): Record<string, string> {
	return (call[1] as RequestInit).headers as Record<string, string>
}

afterEach(() => {
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
	fetchMock.mockReset()
	clearKiroModelCache()
})

describe("Kiro identity headers", () => {
	it("advertises the Kiro IDE release that clears Kiro's version floor", () => {
		expect(KIRO_IDE_VERSION).toBe("1.4.154")
	})

	it("builds the IDE-shaped UA pair for the streaming data plane", () => {
		const headers = buildKiroIdentityHeaders({ accessToken: "tok" }, "streaming")
		expect(headers["User-Agent"]).toMatch(IDENTITY_RE)
		expect(headers["User-Agent"]).toContain("api/codewhispererstreaming#1.0.0 m/E ")
		expect(headers["X-Amz-User-Agent"]).toMatch(
			new RegExp(`^aws-sdk-js/1\\.0\\.0 KiroIDE-${KIRO_IDE_VERSION}-[0-9a-f]{64}$`),
		)
	})

	it("builds the runtime/control-plane markers by default", () => {
		const headers = buildKiroIdentityHeaders({ accessToken: "tok" })
		expect(headers["User-Agent"]).toContain("api/codewhispererruntime#1.0.0 m/N,E ")
	})

	it("keeps one machine id per account, distinct across accounts, and leaks no token", () => {
		const a = buildKiroIdentityHeaders({ accessToken: "token-a" })
		const aAgain = buildKiroIdentityHeaders({ accessToken: "token-a" })
		const b = buildKiroIdentityHeaders({ accessToken: "token-b" })
		expect(a).toEqual(aAgain)
		expect(a["X-Amz-User-Agent"]).not.toBe(b["X-Amz-User-Agent"])
		expect(a["User-Agent"]).not.toContain("token-a")
		expect(kiroMachineId({ accessToken: "token-a" })).toMatch(/^[0-9a-f]{64}$/)
	})
})

describe("Kiro surfaces that must present the identity", () => {
	it("stamps it on inference requests", () => {
		const headers = new KiroExecutor().buildHeaders(
			{ accessToken: "tok", providerSpecificData: { authMethod: "builder-id" } },
			true,
			"https://q.us-east-1.amazonaws.com/generateAssistantResponse",
		)
		expect(headers["User-Agent"]).toMatch(IDENTITY_RE)
		expect(headers["User-Agent"]).toContain("api/codewhispererstreaming#1.0.0 m/E ")
		expect(headers["User-Agent"]).not.toContain("kiro-ide/1.0.0")
	})

	it("stamps it on the live model catalog", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => Response.json({ models: [{ modelId: "claude-sonnet-4.5" }] }))
		await resolveKiroModels({ accessToken: "tok" }, { forceRefresh: true })
		const headers = headersOf(fetchSpy.mock.calls[0])
		expect(headers["User-Agent"]).toMatch(IDENTITY_RE)
		expect(headers["X-Amz-User-Agent"]).toMatch(/KiroIDE-/)
	})

	it("stamps it on every usage endpoint attempt", async () => {
		fetchMock.mockImplementation(async () =>
			Response.json({
				usageBreakdownList: [
					{
						resourceType: "AGENTIC_REQUEST",
						currentUsageWithPrecision: 1,
						usageLimitWithPrecision: 2,
					},
				],
			}),
		)
		await getKiroUsage("tok", { authMethod: "builder-id" })
		const headers = headersOf(fetchMock.mock.calls[0])
		expect(headers["User-Agent"]).toMatch(IDENTITY_RE)
		expect(headers["X-Amz-User-Agent"]).toMatch(/KiroIDE-/)
		expect(headers["x-amz-user-agent"]).toBeUndefined()
		expect(headers["user-agent"]).toBeUndefined()
	})

	it("carries no static client identity in the provider registry", () => {
		const headers = kiroRegistry.transport.headers as Record<string, string | undefined>
		expect(headers["User-Agent"]).toBeUndefined()
		expect(headers["X-Amz-User-Agent"]).toBeUndefined()
		expect(JSON.stringify(kiroRegistry)).not.toContain("kiro-ide/")
	})
})

describe("Kiro OAuth-side calls", () => {
	it("sends the identity on profile lookup, model list and API-key validation", async () => {
		const { KiroService } = await import("../../apps/web/src/lib/oauth/services/kiro.js")
		const svc = new KiroService()
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () =>
				Response.json({ models: [{ modelId: "claude-opus-5" }], profiles: [] }),
			)

		await svc.listAvailableProfiles("tok")
		await svc.listAvailableApiKeyModels("key")
		await svc.listAvailableModels("tok", "arn:aws:codewhisperer:us-east-1:1:profile/X")

		expect(fetchSpy.mock.calls).toHaveLength(3)
		for (const call of fetchSpy.mock.calls) {
			const headers = headersOf(call)
			expect(headers["User-Agent"]).toMatch(IDENTITY_RE)
			expect(headers["X-Amz-User-Agent"]).toMatch(/KiroIDE-/)
		}
	})

	it("sends the identity on the post-sign-in profileArn lookup", async () => {
		const { fetchKiroProfileArn } = await import("../../apps/web/src/lib/oauth/providerHelpers.js")
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => Response.json({ profiles: [] }))
		await fetchKiroProfileArn("tok")
		expect(headersOf(fetchSpy.mock.calls[0])["User-Agent"]).toMatch(IDENTITY_RE)
	})
})

describe("TLS ClientHello curve list", () => {
	it("offers X25519 first but not alone, so AWS OIDC does not reset the handshake", () => {
		const source = readFileSync(join(ROOT, "apps/web/open-sse/utils/proxyFetch.ts"), "utf8")
		const match = source.match(/NINEROUTER_TLS_ECDH_CURVE \|\| "([^"]+)"/)
		expect(match?.[1]).toBe("X25519:prime256v1:secp384r1")
		expect(match?.[1].split(":")[0]).toBe("X25519")
	})
})
