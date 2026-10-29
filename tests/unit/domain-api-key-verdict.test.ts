import { describe, expect, it } from "vitest"
import {
	isAccepted,
	readFailure,
	readStatus,
	readStatusAnthropic,
	readStatusBlackbox,
	readStatusCloudflare,
	readStatusDefault,
	readStatusRejectUnauthorizedOnly,
	readStatusXai,
	STATUS_READINGS,
} from "../../apps/api/src/domain/api-key-verdict.ts"

describe("readStatusDefault", () => {
	it.each([401, 403])("rejects %i", (status) => {
		expect(readStatusDefault(status)).toBe("rejected")
	})

	it.each([200, 400, 404, 429, 500, 529])("accepts %i", (status) => {
		expect(readStatusDefault(status)).toBe("accepted")
	})
})

describe("readStatusRejectUnauthorizedOnly", () => {
	it("rejects 401", () => {
		expect(readStatusRejectUnauthorizedOnly(401)).toBe("rejected")
	})

	it("accepts 403, because it means a permission is missing not the key", () => {
		expect(readStatusRejectUnauthorizedOnly(403)).toBe("accepted")
	})
})

describe("readStatusXai", () => {
	it("rejects 400, which is how xai reports a bad key", () => {
		expect(readStatusXai(400)).toBe("rejected")
	})

	it("accepts 403, which means valid-but-out-of-credit", () => {
		expect(readStatusXai(403)).toBe("accepted")
	})

	it("accepts 200", () => {
		expect(readStatusXai(200)).toBe("accepted")
	})
})

describe("readStatusBlackbox", () => {
	it.each([200, 400])("accepts %i", (status) => {
		expect(readStatusBlackbox(status)).toBe("accepted")
	})

	it.each([401, 403])("rejects %i", (status) => {
		expect(readStatusBlackbox(status)).toBe("rejected")
	})

	it("is inconclusive on an unexpected 500", () => {
		expect(readStatusBlackbox(500)).toBe("inconclusive")
	})
})

describe("readStatusCloudflare", () => {
	it("rejects 404, which means the account id is wrong", () => {
		expect(readStatusCloudflare(404)).toBe("rejected")
	})

	it("still rejects 401 and 403", () => {
		expect(readStatusCloudflare(401)).toBe("rejected")
		expect(readStatusCloudflare(403)).toBe("rejected")
	})

	it("accepts 200", () => {
		expect(readStatusCloudflare(200)).toBe("accepted")
	})
})

describe("readStatusAnthropic", () => {
	it("rejects 401", () => {
		expect(readStatusAnthropic(401)).toBe("rejected")
	})

	it("accepts 529, which is overload", () => {
		expect(readStatusAnthropic(529)).toBe("accepted")
	})

	it("is inconclusive on any other 5xx", () => {
		expect(readStatusAnthropic(500)).toBe("inconclusive")
		expect(readStatusAnthropic(503)).toBe("inconclusive")
	})

	it("accepts 400, which is a request problem not a key problem", () => {
		expect(readStatusAnthropic(400)).toBe("accepted")
	})
})

describe("readStatus dispatcher", () => {
	it("defaults to the standard reading", () => {
		expect(readStatus(401)).toBe("rejected")
		expect(readStatus(200)).toBe("accepted")
	})

	it("applies the named rule", () => {
		expect(readStatus(400, "xai")).toBe("rejected")
		expect(readStatus(400)).toBe("accepted")
	})

	it("exposes every reading by name", () => {
		expect(Object.keys(STATUS_READINGS).sort()).toEqual([
			"anthropic",
			"blackbox",
			"cloudflare",
			"default",
			"rejectUnauthorizedOnly",
			"xai",
		])
	})
})

describe("isAccepted", () => {
	it("refuses only a rejection", () => {
		expect(isAccepted("rejected")).toBe(false)
		expect(isAccepted("accepted")).toBe(true)
	})

	it("treats inconclusive as accepted, because nothing argues against the key", () => {
		expect(isAccepted("inconclusive")).toBe(true)
	})
})

describe("readFailure", () => {
	it("is inconclusive, not a rejection", () => {
		expect(readFailure()).toBe("inconclusive")
		expect(isAccepted(readFailure())).toBe(true)
	})
})

describe("the readings differ where it matters", () => {
	it("400 is a rejection to xai and an acceptance to everyone else", () => {
		expect(readStatus(400, "xai")).toBe("rejected")
		expect(readStatus(400, "default")).toBe("accepted")
		expect(readStatus(400, "anthropic")).toBe("accepted")
	})

	it("403 is a rejection by default and an acceptance to xai and xiaomi", () => {
		expect(readStatus(403, "default")).toBe("rejected")
		expect(readStatus(403, "xai")).toBe("accepted")
		expect(readStatus(403, "rejectUnauthorizedOnly")).toBe("accepted")
	})

	it("404 is a rejection only for cloudflare", () => {
		expect(readStatus(404, "cloudflare")).toBe("rejected")
		expect(readStatus(404, "default")).toBe("accepted")
	})
})
