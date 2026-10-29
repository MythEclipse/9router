import { describe, expect, it, vi } from "vitest"
import {
	pollSessionStatus,
	readIdeStatus,
	stopProviderProxy,
} from "../../apps/api/src/application/oauth/dispatch-actions.ts"
import {
	canDetectIde,
	canPollSession,
	canStopProxy,
	SESSION_PROVIDERS,
	sessionStateOf,
	sessionSurvivesPoll,
	unsupportedActionMessage,
} from "../../apps/api/src/domain/oauth-dispatch.ts"

describe("which providers support which action", () => {
	it("polls for every provider that runs a callback proxy", () => {
		for (const provider of SESSION_PROVIDERS) {
			expect(canPollSession(provider)).toBe(true)
			expect(canStopProxy(provider)).toBe(true)
		}
	})

	it("refuses a provider that has no proxy to poll or stop", () => {
		expect(canPollSession("gitlab")).toBe(false)
		expect(canStopProxy("gitlab")).toBe(false)
		expect(canPollSession("")).toBe(false)
	})

	it("offers IDE detection only where there is a desktop app to detect", () => {
		expect(canDetectIde("trae")).toBe(true)
		expect(canDetectIde("windsurf")).toBe(true)
		expect(canDetectIde("kiro")).toBe(false)
	})
})

describe("sessionSurvivesPoll", () => {
	it("keeps a finished MiMo session alive until the browser exchanges it", () => {
		expect(sessionSurvivesPoll("xiaomi-mimo")).toBe(true)
	})

	it("lets every other provider clear its session as soon as it is answered", () => {
		for (const provider of ["codex", "xai", "trae", "windsurf", "zed"]) {
			expect(sessionSurvivesPoll(provider)).toBe(false)
		}
	})
})

describe("unsupportedActionMessage", () => {
	it("names the providers that would accept the action", () => {
		expect(unsupportedActionMessage("poll-status", ["codex", "zed"])).toBe(
			"Poll only supported for codex/zed",
		)
		expect(unsupportedActionMessage("stop-proxy", ["codex"])).toBe("Proxy only supported for codex")
	})

	it("falls back to naming the action for anything else", () => {
		expect(unsupportedActionMessage("ide-status", ["trae"])).toBe(
			"ide-status only supported for trae",
		)
	})
})

describe("sessionStateOf", () => {
	it("trims the value the browser sent", () => {
		expect(sessionStateOf("  abc ")).toBe("abc")
	})

	it("answers nothing for a missing or blank state", () => {
		expect(sessionStateOf(null)).toBeNull()
		expect(sessionStateOf("   ")).toBeNull()
	})
})

/** A host whose session stores are stubbed, recording what was called. */
function deps(overrides: Record<string, unknown> = {}) {
	const calls: string[] = []
	return {
		calls,
		readSession: vi.fn((): { status: string } | null => null),
		clearSession: vi.fn((provider: string, state: string) =>
			calls.push(`clear:${provider}:${state}`),
		),
		stopProxy: vi.fn((provider: string) => calls.push(`stop:${provider}`)),
		detectIde: vi.fn(async () => ({ installed: true })),
		...overrides,
	}
}

describe("pollSessionStatus", () => {
	it("refuses a provider that cannot be polled before reading any state", async () => {
		const host = deps()
		const answer = await pollSessionStatus("gitlab", "abc", host as never)
		expect(answer.ok).toBe(false)
		expect(answer.error).toContain("Poll only supported for")
		expect(host.readSession).not.toHaveBeenCalled()
	})

	it("refuses a poll with no state rather than answering 'unknown'", async () => {
		const host = deps()
		const answer = await pollSessionStatus("codex", null, host as never)
		expect(answer).toEqual({ ok: false, status: 400, error: "Missing state" })
	})

	it("answers 'unknown' for a state no session was ever started under", async () => {
		const host = deps()
		const answer = await pollSessionStatus("codex", "abc", host as never)
		expect(answer.body).toEqual({ status: "unknown" })
	})

	it("reports a pending session by its own status, so the screen keeps waiting", async () => {
		const host = deps({ readSession: vi.fn(() => ({ status: "pending" })) })
		const answer = await pollSessionStatus("codex", "abc", host as never)
		expect(answer.body).toEqual({ status: "pending" })
		expect(host.clearSession).not.toHaveBeenCalled()
	})

	it("clears a finished session for the providers that exchange server-side", async () => {
		const host = deps({ readSession: vi.fn(() => ({ status: "done", email: "a@b.c" })) })
		const answer = await pollSessionStatus("codex", "abc", host as never)
		expect(answer.body).toEqual({ status: "done", email: "a@b.c" })
		expect(host.clearSession).toHaveBeenCalledWith("codex", "abc")
	})

	it("does not clear a finished MiMo session, whose exchange has not happened yet", async () => {
		const host = deps({ readSession: vi.fn(() => ({ status: "done" })) })
		await pollSessionStatus("xiaomi-mimo", "abc", host as never)
		expect(host.clearSession).not.toHaveBeenCalled()
		expect(host.stopProxy).not.toHaveBeenCalled()
	})

	it("does clear a failed MiMo session, because no exchange will ever come", async () => {
		const host = deps({ readSession: vi.fn(() => ({ status: "error" })) })
		await pollSessionStatus("xiaomi-mimo", "abc", host as never)
		expect(host.clearSession).toHaveBeenCalledWith("xiaomi-mimo", "abc")
		expect(host.stopProxy).toHaveBeenCalledWith("xiaomi-mimo")
	})
})

describe("stopProviderProxy", () => {
	it("stops the provider's proxy", () => {
		const host = deps()
		const answer = stopProviderProxy("zed", host as never)
		expect(answer.body).toEqual({ success: true })
		expect(host.stopProxy).toHaveBeenCalledWith("zed")
	})

	it("succeeds even though there is nothing left to stop", () => {
		// The dashboard calls this on cancel and on unmount; an error here would show over a
		// login that had already worked.
		const host = deps()
		expect(stopProviderProxy("codex", host as never).ok).toBe(true)
	})

	it("refuses a provider that never had a proxy", () => {
		const answer = stopProviderProxy("kiro", deps() as never)
		expect(answer.ok).toBe(false)
		expect(answer.error).toContain("Proxy only supported for")
	})
})

describe("readIdeStatus", () => {
	it("answers the detection result for a provider that has a desktop app", async () => {
		const answer = await readIdeStatus("trae", deps() as never)
		expect(answer.body).toEqual({ installed: true })
	})

	it("refuses rather than answering false for a provider without one", async () => {
		// "not installed" and "not applicable" lead to different screens.
		const host = deps()
		const answer = await readIdeStatus("kiro", host as never)
		expect(answer.ok).toBe(false)
		expect(host.detectIde).not.toHaveBeenCalled()
	})
})
