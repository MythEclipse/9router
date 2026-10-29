import { describe, expect, test } from "vitest"
import {
	externalProxyRefusal,
	headroomFailureStatus,
	headroomPortFromUrl,
	headroomStartOptions,
	headroomStartPort,
	headroomStopStatus,
	headroomUrl,
	INSTALL_CLIENT_ERROR_CODES,
	START_CLIENT_ERROR_CODES,
	UNINSTALL_CLIENT_ERROR_CODES,
} from "../../apps/api/src/domain/headroom-lifecycle"

const isLoopback = (url: unknown) => {
	try {
		return ["localhost", "127.0.0.1"].includes(new URL(String(url)).hostname)
	} catch {
		return false
	}
}

describe("headroomPortFromUrl", () => {
	test("reads an explicit port", () => {
		expect(headroomPortFromUrl("http://localhost:8787")).toBe(8787)
		expect(headroomPortFromUrl("http://127.0.0.1:9000/x")).toBe(9000)
	})

	test("a URL with no port yields null, not 80", () => {
		// Defaulting to a web port would point the proxy somewhere it never was.
		expect(headroomPortFromUrl("http://localhost")).toBe(null)
		expect(headroomPortFromUrl("https://example.com")).toBe(null)
	})

	test("junk yields null rather than throwing", () => {
		expect(headroomPortFromUrl("not a url")).toBe(null)
		expect(headroomPortFromUrl(null)).toBe(null)
	})
})

describe("headroomStartPort", () => {
	test("uses the configured port", () => {
		expect(headroomStartPort("http://localhost:9123")).toBe(9123)
	})

	test("falls back to Headroom's default when the URL names none", () => {
		expect(headroomStartPort("http://localhost")).toBe(8787)
		expect(headroomStartPort("garbage")).toBe(8787)
	})
})

describe("headroomStartOptions", () => {
	test("kompress defaults on and codeAware defaults off", () => {
		// These are the defaults the settings screen shows.
		expect(headroomStartOptions({})).toEqual({ codeAware: false, kompress: true })
		expect(headroomStartOptions(null)).toEqual({ codeAware: false, kompress: true })
	})

	test("an explicit setting wins", () => {
		expect(headroomStartOptions({ headroomCodeAware: true, headroomKompress: false })).toEqual({
			codeAware: true,
			kompress: false,
		})
	})

	test("only a literal true enables codeAware", () => {
		expect(headroomStartOptions({ headroomCodeAware: "true" }).codeAware).toBe(false)
	})

	test("only a literal false disables kompress", () => {
		expect(headroomStartOptions({ headroomKompress: 0 }).kompress).toBe(true)
	})
})

describe("headroomUrl", () => {
	test("a configured URL wins", () => {
		expect(headroomUrl({ headroomUrl: "http://localhost:9999" }, "http://localhost:8787")).toBe(
			"http://localhost:9999",
		)
	})

	test("blank or missing falls back to the default", () => {
		expect(headroomUrl({ headroomUrl: "   " }, "http://localhost:8787")).toBe("http://localhost:8787")
		expect(headroomUrl(null, "http://localhost:8787")).toBe("http://localhost:8787")
	})
})

describe("externalProxyRefusal", () => {
	test("a loopback URL may be started locally", () => {
		expect(externalProxyRefusal("http://localhost:8787", isLoopback)).toBe(null)
		expect(externalProxyRefusal("http://127.0.0.1:8787", isLoopback)).toBe(null)
	})

	test("a remote URL is refused with a code the UI can branch on", () => {
		expect(externalProxyRefusal("https://headroom.example.com", isLoopback)).toEqual({
			message: "External Headroom proxies must be started outside 9Router",
			code: "EXTERNAL_PROXY",
		})
	})

	test("an unparseable URL is refused, not guessed as local", () => {
		// Spawning a process for a URL this dashboard cannot reach is the failure the gate prevents.
		expect(externalProxyRefusal("garbage", isLoopback)).not.toBe(null)
	})
})

describe("headroomFailureStatus", () => {
	test("NOT_INSTALLED is the caller's problem for start", () => {
		expect(headroomFailureStatus({ code: "NOT_INSTALLED" }, START_CLIENT_ERROR_CODES)).toBe(400)
	})

	test("an unknown code is a fault here, not the caller's", () => {
		expect(headroomFailureStatus({ code: "EACCES" }, START_CLIENT_ERROR_CODES)).toBe(500)
		expect(headroomFailureStatus(null, START_CLIENT_ERROR_CODES)).toBe(500)
		expect(headroomFailureStatus({}, START_CLIENT_ERROR_CODES)).toBe(500)
	})

	test("uninstall does not treat NOT_INSTALLED as its own", () => {
		// There is nothing to remove, so that code cannot come from this path.
		expect(headroomFailureStatus({ code: "NOT_INSTALLED" }, UNINSTALL_CLIENT_ERROR_CODES)).toBe(500)
		expect(headroomFailureStatus({ code: "INVALID_EXTRAS" }, UNINSTALL_CLIENT_ERROR_CODES)).toBe(400)
	})

	test("install accepts NO_PYTHON as the caller's problem", () => {
		expect(headroomFailureStatus({ code: "NO_PYTHON" }, INSTALL_CLIENT_ERROR_CODES)).toBe(400)
	})
})

describe("headroomStopStatus", () => {
	test("a real stop is 200", () => {
		expect(headroomStopStatus({ stopped: true })).toBe(200)
	})

	test("nothing to stop is 409, not 200", () => {
		// 200 would leave the dashboard claiming "stopped" for a proxy it never had.
		expect(headroomStopStatus({ stopped: false })).toBe(409)
		expect(headroomStopStatus(null)).toBe(409)
	})
})
