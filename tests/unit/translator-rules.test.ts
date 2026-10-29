import { describe, expect, test } from "vitest"
import {
	consoleLogsPayload,
	TRANSLATOR_DUMP_FILES,
	translatorDumpFile,
	translatorRefreshUsable,
	translatorSendStatus,
	translatorStep,
	translatorTarget,
} from "../../apps/api/src/domain/translator"

describe("translatorDumpFile", () => {
	test("every documented dump file is allowed", () => {
		for (const file of TRANSLATOR_DUMP_FILES) {
			expect(translatorDumpFile(file)).toBe(file)
		}
	})

	test("path traversal is rejected", () => {
		// This is the only thing between the dashboard and an arbitrary file write.
		expect(translatorDumpFile("../../.env")).toBe(null)
		expect(translatorDumpFile("../config.json")).toBe(null)
		expect(translatorDumpFile("/etc/passwd")).toBe(null)
		expect(translatorDumpFile("logs/translator/1_req_client.json")).toBe(null)
	})

	test("a near miss is rejected, not coerced", () => {
		expect(translatorDumpFile("1_req_client.json ")).toBe(null)
		expect(translatorDumpFile("1_REQ_CLIENT.JSON")).toBe(null)
		expect(translatorDumpFile("8_req_extra.json")).toBe(null)
	})

	test("a missing or non-string name is rejected", () => {
		expect(translatorDumpFile(null)).toBe(null)
		expect(translatorDumpFile(undefined)).toBe(null)
		expect(translatorDumpFile(1)).toBe(null)
		expect(translatorDumpFile("")).toBe(null)
	})
})

describe("translatorStep", () => {
	test("the three stages are accepted as numbers", () => {
		expect(translatorStep(1)).toBe(1)
		expect(translatorStep(2)).toBe(2)
		expect(translatorStep(3)).toBe(3)
	})

	test("a numeric string is accepted", () => {
		// JSON bodies carry the step either way depending on the caller.
		expect(translatorStep("1")).toBe(1)
		expect(translatorStep("3")).toBe(3)
	})

	test("step 0, 4, and junk are rejected", () => {
		expect(translatorStep(0)).toBe(null)
		expect(translatorStep(4)).toBe(null)
		expect(translatorStep(-1)).toBe(null)
		expect(translatorStep("all")).toBe(null)
		expect(translatorStep(null)).toBe(null)
		expect(translatorStep(undefined)).toBe(null)
	})
})

describe("translatorTarget", () => {
	test("both present is a target", () => {
		expect(translatorTarget("openai", "gpt-4o")).toEqual({ provider: "openai", model: "gpt-4o" })
	})

	test("either missing is rejected", () => {
		// Step 3 cannot infer the provider; guessing builds headers for the wrong API.
		expect(translatorTarget("", "gpt-4o")).toBe(null)
		expect(translatorTarget("openai", "")).toBe(null)
		expect(translatorTarget(undefined, "gpt-4o")).toBe(null)
		expect(translatorTarget("openai", undefined)).toBe(null)
		expect(translatorTarget(7, "gpt-4o")).toBe(null)
	})
})

describe("translatorSendStatus", () => {
	test("the provider's own status passes through", () => {
		// A 429 must stay a 429 or the operator reads rate limiting as a dashboard fault.
		expect(translatorSendStatus(429)).toBe(429)
		expect(translatorSendStatus(401)).toBe(401)
		expect(translatorSendStatus(503)).toBe(503)
	})

	test("a transport failure is 502, not 500", () => {
		// Nothing was learned about the provider, and the dashboard did not break.
		expect(translatorSendStatus(null)).toBe(502)
	})

	test("a status below 400 is not an error status", () => {
		expect(translatorSendStatus(200)).toBe(502)
		expect(translatorSendStatus(304)).toBe(502)
	})

	test("a non-integer is not passthrough", () => {
		expect(translatorSendStatus(Number.NaN)).toBe(502)
		expect(translatorSendStatus(4.5)).toBe(502)
	})
})

describe("translatorRefreshUsable", () => {
	test("a new access token is usable", () => {
		expect(translatorRefreshUsable({ accessToken: "fresh" })).toBe(true)
	})

	test("a new copilot token is usable", () => {
		expect(translatorRefreshUsable({ copilotToken: "fresh" })).toBe(true)
	})

	test("a partial refresh is not usable", () => {
		// Retrying with it sends the same rejected token and doubles the latency of every expiry.
		expect(translatorRefreshUsable({})).toBe(false)
		expect(translatorRefreshUsable({ accessToken: "" })).toBe(false)
		expect(translatorRefreshUsable(null)).toBe(false)
	})
})

describe("consoleLogsPayload", () => {
	test("an empty buffer answers with an empty list", () => {
		expect(consoleLogsPayload([])).toEqual({ success: true, logs: [] })
	})

	test("a missing buffer answers with an empty list, not undefined", () => {
		expect(consoleLogsPayload(undefined)).toEqual({ success: true, logs: [] })
		expect(consoleLogsPayload(null)).toEqual({ success: true, logs: [] })
	})

	test("lines pass through untouched", () => {
		expect(consoleLogsPayload(["a", "b"]).logs).toEqual(["a", "b"])
	})
})
