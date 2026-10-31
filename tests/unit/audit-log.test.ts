import {
	AUDIT_LOG_DEFAULT_LIMIT,
	AUDIT_LOG_MAX_LIMIT,
	describeAction,
	isAuditLimitRefused,
	resolveAuditLimit,
	summarisePayload,
} from "9router-api/domain/audit-log"
import { describe, expect, it } from "vitest"

describe("resolveAuditLimit", () => {
	it("defaults when the caller did not ask", () => {
		const result = resolveAuditLimit(undefined)
		expect(isAuditLimitRefused(result) ? null : result.limit).toBe(AUDIT_LOG_DEFAULT_LIMIT)
	})

	it("accepts a query-string number", () => {
		const result = resolveAuditLimit("25")
		expect(isAuditLimitRefused(result) ? null : result.limit).toBe(25)
	})

	it("clamps a value above the ceiling instead of refusing it", () => {
		const result = resolveAuditLimit(String(AUDIT_LOG_MAX_LIMIT * 10))
		expect(isAuditLimitRefused(result) ? null : result.limit).toBe(AUDIT_LOG_MAX_LIMIT)
	})

	it("refuses a value that is not a positive integer", () => {
		for (const value of ["abc", "0", "-5", "1.5"]) {
			expect(isAuditLimitRefused(resolveAuditLimit(value))).toBe(true)
		}
	})
})

describe("describeAction", () => {
	it("splits a well-formed action", () => {
		expect(describeAction("provider.update")).toEqual({ resource: "provider", verb: "update" })
	})

	it("keeps a malformed action visible instead of repairing it", () => {
		expect(describeAction("update")).toEqual({ resource: "update", verb: "unknown" })
		expect(describeAction("provider.")).toEqual({ resource: "provider.", verb: "unknown" })
	})
})

describe("summarisePayload", () => {
	it("keeps identifiers and drops values", () => {
		const summary = summarisePayload({ id: "conn_1", apiKey: "sk-secret", baseUrl: "https://x" })
		expect(summary.id).toBe("conn_1")
		// The secret is not copied; only the fact that the field was involved is.
		expect(summary["changed:apiKey"]).toBe(true)
		expect(JSON.stringify(summary)).not.toContain("sk-secret")
	})

	it("keeps a list of field names but not their contents", () => {
		const summary = summarisePayload({ fields: ["name", { nested: "x" }] })
		expect(summary.fields).toEqual(["name"])
	})

	it("answers an empty summary for anything that is not an object", () => {
		expect(summarisePayload(null)).toEqual({})
		expect(summarisePayload("text")).toEqual({})
		expect(summarisePayload([1, 2])).toEqual({})
	})
})
