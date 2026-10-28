import { describe, expect, it } from "vitest"
import {
	DEFAULT_ERROR_LOG_LIMIT,
	MAX_ERROR_LOG_LIMIT,
	resolveErrorLogLimit,
} from "../../apps/api/src/domain/error-log.ts"

describe("resolveErrorLogLimit", () => {
	it("honours a plain in-range count", () => {
		expect(resolveErrorLogLimit("50")).toEqual({ limit: 50, adjusted: false })
		expect(resolveErrorLogLimit(50)).toEqual({ limit: 50, adjusted: false })
	})

	it("defaults when nothing was asked for", () => {
		for (const absent of [null, undefined, ""]) {
			expect(resolveErrorLogLimit(absent)).toEqual({
				limit: DEFAULT_ERROR_LOG_LIMIT,
				adjusted: false,
			})
		}
	})

	it("clamps a count above the ceiling and says so", () => {
		expect(resolveErrorLogLimit("5000")).toEqual({
			limit: MAX_ERROR_LOG_LIMIT,
			adjusted: true,
		})
	})

	it("replaces an unusable count with the default", () => {
		// `parseInt` returned NaN for these, which reached the query as a bind
		// value instead of failing.
		for (const junk of ["abc", "12abc", " ", "NaN", "Infinity", "1.5", "0", "-5"]) {
			const resolved = resolveErrorLogLimit(junk)
			expect(resolved.limit, junk).toBe(DEFAULT_ERROR_LOG_LIMIT)
			expect(resolved.adjusted, junk).toBe(true)
		}
	})

	it("accepts the ceiling itself without flagging it", () => {
		expect(resolveErrorLogLimit(MAX_ERROR_LOG_LIMIT)).toEqual({
			limit: MAX_ERROR_LOG_LIMIT,
			adjusted: false,
		})
	})
})
