import { describe, expect, it } from "vitest"
import {
	DEFAULT_MITM_ROUTER_BASE,
	isPerToolDnsAction,
	type MitmPlatform,
	mitmHasPrivilege,
	mitmNeedsPasswordPrompt,
	mitmPrivilegeRefusal,
	normaliseMitmRouterBaseUrl,
	presentMitmStatus,
	readMitmStartRequest,
	readMitmToolToggle,
	resolveMitmPassword,
	storedMitmRouterBaseUrl,
} from "../../apps/api/src/domain/mitm-panel.ts"

const linuxUser: MitmPlatform = { isWindows: false, privilege: "user", sudoPasswordRequired: true }
const linuxRoot: MitmPlatform = { isWindows: false, privilege: "root", sudoPasswordRequired: true }
const windowsUser: MitmPlatform = {
	isWindows: true,
	privilege: "user",
	sudoPasswordRequired: false,
}
const windowsAdmin: MitmPlatform = {
	isWindows: true,
	privilege: "windows-admin",
	sudoPasswordRequired: false,
}

describe("resolveMitmPassword", () => {
	it("prefers what the operator just typed over anything remembered", () => {
		// A corrected password must win; otherwise a rejected password is retried forever.
		expect(resolveMitmPassword({ provided: "typed", cached: "cached", stored: "stored" })).toBe(
			"typed",
		)
	})

	it("falls back to the session cache before the encrypted store", () => {
		expect(resolveMitmPassword({ cached: "cached", stored: "stored" })).toBe("cached")
	})

	it("uses the encrypted store only when nothing else is available", () => {
		expect(resolveMitmPassword({ stored: "stored" })).toBe("stored")
	})

	it("treats blank input as absent, so a cleared field never becomes the password", () => {
		expect(resolveMitmPassword({ provided: "   ", cached: "cached" })).toBe("cached")
		expect(resolveMitmPassword({})).toBe("")
	})
})

describe("mitmHasPrivilege", () => {
	it("needs nothing more than root", () => {
		expect(mitmHasPrivilege(linuxRoot, "")).toBe(true)
	})

	it("needs a password for a sudo-gated host when unprivileged", () => {
		expect(mitmHasPrivilege(linuxUser, "")).toBe(false)
		expect(mitmHasPrivilege(linuxUser, "hunter2")).toBe(true)
	})

	it("never accepts a password on Windows, because none can escalate mid-request", () => {
		// The trap: a Windows operator who types a password must not be told it worked.
		expect(mitmHasPrivilege(windowsUser, "hunter2")).toBe(false)
		expect(mitmHasPrivilege(windowsAdmin, "")).toBe(true)
	})
})

describe("mitmNeedsPasswordPrompt", () => {
	it("asks on a sudo-gated host with no password in hand", () => {
		expect(mitmNeedsPasswordPrompt(linuxUser, false)).toBe(true)
		expect(mitmNeedsPasswordPrompt(linuxUser, true)).toBe(false)
	})

	it("never asks on Windows: the prompt cannot help, only an elevated restart can", () => {
		expect(mitmNeedsPasswordPrompt(windowsUser, false)).toBe(false)
	})

	it("does not ask a process that is already privileged", () => {
		expect(mitmNeedsPasswordPrompt(linuxRoot, false)).toBe(false)
	})
})

describe("mitmPrivilegeRefusal", () => {
	it("names the real fix on Windows", () => {
		expect(mitmPrivilegeRefusal(windowsUser, "start MITM")).toContain("restart")
	})

	it("names sudo elsewhere", () => {
		expect(mitmPrivilegeRefusal(linuxUser, "start MITM")).toContain("sudo")
	})
})

describe("normaliseMitmRouterBaseUrl", () => {
	it("treats blank as 'give me the default back' rather than an error", () => {
		expect(normaliseMitmRouterBaseUrl("")).toEqual({ ok: true, value: DEFAULT_MITM_ROUTER_BASE })
		expect(normaliseMitmRouterBaseUrl(null)).toEqual({
			ok: true,
			value: DEFAULT_MITM_ROUTER_BASE,
		})
	})

	it("trims trailing slashes, because every consumer appends a path", () => {
		expect(normaliseMitmRouterBaseUrl("http://host:20128///")).toEqual({
			ok: true,
			value: "http://host:20128",
		})
	})

	it("refuses a non-URL and a non-http scheme", () => {
		expect(normaliseMitmRouterBaseUrl("not a url")).toMatchObject({ ok: false, status: 400 })
		expect(normaliseMitmRouterBaseUrl("ftp://host")).toMatchObject({ ok: false, status: 400 })
	})
})

describe("storedMitmRouterBaseUrl", () => {
	it("re-validates rather than echoing a stored value", () => {
		// A value written by an older build must not come back to the UI unchanged.
		expect(storedMitmRouterBaseUrl("http://host:20128/")).toBe("http://host:20128")
		expect(storedMitmRouterBaseUrl("garbage")).toBe(DEFAULT_MITM_ROUTER_BASE)
		expect(storedMitmRouterBaseUrl(undefined)).toBe(DEFAULT_MITM_ROUTER_BASE)
	})
})

describe("readMitmToolToggle", () => {
	it("rejects a body with no tool before any privilege check runs", () => {
		expect(readMitmToolToggle({ action: "enable" })).toEqual({
			ok: false,
			status: 400,
			error: "tool and action required",
		})
	})

	it("rejects an unknown action rather than silently doing nothing", () => {
		expect(readMitmToolToggle({ tool: "cursor", action: "rotate" })).toMatchObject({
			ok: false,
			status: 400,
		})
	})

	it("accepts the three actions the panel sends", () => {
		for (const action of ["enable", "disable", "trust-cert"] as const) {
			expect(readMitmToolToggle({ tool: "cursor", action })).toMatchObject({
				ok: true,
				value: { tool: "cursor", action },
			})
		}
	})
})

describe("readMitmStartRequest", () => {
	it("requires an apiKey, because the proxy authenticates its clients with it", () => {
		expect(readMitmStartRequest({})).toEqual({
			ok: false,
			status: 400,
			error: "Missing apiKey",
		})
	})

	it("keeps 'did not mention the URL' distinct from 'blank URL'", () => {
		const omitted = readMitmStartRequest({ apiKey: "k" })
		const blank = readMitmStartRequest({ apiKey: "k", mitmRouterBaseUrl: "" })
		expect(omitted.ok ? omitted.value.mitmRouterBaseUrl : "wrong").toBe(undefined)
		expect(blank.ok ? blank.value.mitmRouterBaseUrl : "wrong").toBe("")
	})

	it("only force-kills port 443 on a literal true", () => {
		const truthy = readMitmStartRequest({ apiKey: "k", forceKillPort443: "yes" })
		const literal = readMitmStartRequest({ apiKey: "k", forceKillPort443: true })
		expect(truthy.ok ? truthy.value.forceKillPort443 : null).toBe(false)
		expect(literal.ok ? literal.value.forceKillPort443 : null).toBe(true)
	})
})

describe("presentMitmStatus", () => {
	it("spells every field the panel reads, with nulls rather than undefined", () => {
		const view = presentMitmStatus({
			platform: linuxUser,
			status: {},
			hasCachedPassword: false,
			storedRouterBaseUrl: "",
		})
		expect(view).toEqual({
			running: false,
			pid: null,
			certExists: false,
			certTrusted: false,
			dnsStatus: {},
			hasCachedPassword: false,
			isWin: false,
			needsSudoPassword: true,
			isAdmin: false,
			mitmRouterBaseUrl: DEFAULT_MITM_ROUTER_BASE,
		})
	})

	it("stops asking for a password once one has been cached", () => {
		const view = presentMitmStatus({
			platform: linuxUser,
			status: { running: true, pid: 42 },
			hasCachedPassword: true,
			storedRouterBaseUrl: "http://host:20128",
		})
		expect(view.needsSudoPassword).toBe(false)
		expect(view.running).toBe(true)
		expect(view.pid).toBe(42)
	})
})

describe("isPerToolDnsAction", () => {
	it("separates the machine-wide action from the per-tool ones", () => {
		// Treating trust-cert as per-tool writes a hosts entry for a tool named "trust-cert".
		expect(isPerToolDnsAction("enable")).toBe(true)
		expect(isPerToolDnsAction("disable")).toBe(true)
		expect(isPerToolDnsAction("trust-cert")).toBe(false)
	})
})
