// The executor must forward the proxy URL it is handed by proxyAwareFetch.
// Isolated from the transport tests: mocking opencodeTlsClient.js here would
// otherwise replace the real module under test in sibling suites.
//
// Ported from tests/unit/opencode-executor-proxy-forwarding.test.js (upstream
// 54a88d04). The CLI-runner mock upstream needed has no local counterpart —
// this executor reaches the binary only through the agent harness, which is
// mocked instead so the wiring assertion never touches the network.
import { describe, expect, it, vi } from "vitest"

const { tlsFetchMock } = vi.hoisted(() => ({ tlsFetchMock: vi.fn() }))

vi.mock("../../apps/web/open-sse/services/opencodeTlsClient.js", () => ({
	opencodeTlsFetch: tlsFetchMock,
	OpencodeTlsUnavailableError: class extends Error {},
}))
vi.mock("../../apps/web/open-sse/utils/opencodeAgentHarness.js", () => ({
	loadAgentHarness: async () => null,
	applyAgentHarness: () => {},
}))

describe("opencode executor forwards the resolved proxy", () => {
	it("passes the proxy URL through to opencodeTlsFetch", async () => {
		tlsFetchMock.mockResolvedValue(new Response("ok", { status: 200 }))

		const { OpenCodeExecutor } = await import("../../apps/web/open-sse/executors/opencode.js")
		const exec = new OpenCodeExecutor("opencode")

		try {
			await exec.execute({
				model: "oc/gpt-oss-120b",
				body: { messages: [{ role: "user", content: "hi" }] },
				stream: true,
				credentials: {},
				proxyOptions: { connectionProxyEnabled: true, connectionProxyUrl: "socks5://127.0.0.1:9050" },
			})
		} catch {
			// execute() talks to the real network upstream; the wiring assertion is
			// on the adapter call below, not on its outcome.
		}

		expect(tlsFetchMock).toHaveBeenCalled()
		expect(tlsFetchMock.mock.calls[0][2].proxyUrl).toBe("socks5://127.0.0.1:9050")
		vi.doUnmock("../../apps/web/open-sse/services/opencodeTlsClient.js")
	})
})
