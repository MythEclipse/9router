/**
 * Three one-line predicates that no test executed.
 *
 * Modules under test:
 * - `apps/api/src/domain/reporting-period.ts` — `isReportingPeriod`. No test file is named after this
 *   module; the period *resolution* rules (`resolvePeriod` and friends) are tested elsewhere, but the
 *   guard they call is not.
 * - `apps/api/src/domain/mitm-panel.ts` — `isMitmToolAction`. `tests/unit/mitm-panel.test.ts` exists
 *   but contains zero references to it, which a name-only inventory counts as covered.
 * - `apps/api/src/domain/errors.ts` — `tooLarge`. No test names this module; it is the constructor for
 *   the one error status (`PAYLOAD_TOO_LARGE` → 413) that only fires on an oversized body.
 *
 * Why bother with one-liners: each is a *branch selector*. If `isReportingPeriod` said yes to a stray
 * string, `usage` would build a query for a range nobody asked for; if `isMitmToolAction` said yes to a
 * typo, the panel would act on a tool action that does not exist; if `tooLarge` produced the wrong
 * code, a 413 would surface as a 500 and the client would retry a request that can never fit.
 *
 * User's verbatim instruction: "lanjut"
 */

import { tooLarge } from "9router-api/domain/errors"
import { isMitmToolAction, MITM_TOOL_ACTIONS } from "9router-api/domain/mitm-panel"
import { isReportingPeriod, REPORTING_PERIODS } from "9router-api/domain/reporting-period"
import { describe, expect, it } from "vitest"

describe("isReportingPeriod", () => {
	it("accepts every period the dashboard offers", () => {
		for (const period of REPORTING_PERIODS) {
			expect(isReportingPeriod(period)).toBe(true)
		}
	})

	it("refuses a period that is not on the list", () => {
		for (const value of ["", "90d", "week", "TODAY", "7D", " 7d "]) {
			expect(isReportingPeriod(value), `${JSON.stringify(value)} must be refused`).toBe(false)
		}
	})

	it("refuses an arbitrary string, so a query range cannot be invented", () => {
		expect(isReportingPeriod("2024-01-01")).toBe(false)
		expect(isReportingPeriod("all; DROP TABLE usage")).toBe(false)
	})
})

describe("isMitmToolAction", () => {
	it("accepts every action the panel sends", () => {
		for (const action of MITM_TOOL_ACTIONS) {
			expect(isMitmToolAction(action)).toBe(true)
		}
	})

	it("refuses anything that is not one of those strings", () => {
		for (const value of ["", "Enable", "enable ", "install", "trust-certificate"]) {
			expect(isMitmToolAction(value), `${JSON.stringify(value)} must be refused`).toBe(false)
		}
	})

	it("refuses non-strings, so a parsed JSON body cannot smuggle one in", () => {
		for (const value of [null, undefined, 0, 1, true, {}, [], ["enable"]]) {
			expect(isMitmToolAction(value), `${JSON.stringify(value)} must be refused`).toBe(false)
		}
	})
})

describe("tooLarge", () => {
	it("carries the one status the client can act on", () => {
		// `error-mapping.ts` maps exactly this code to 413; any other code becomes a 500 and the
		// client retries a request that can never fit.
		const error = tooLarge()
		expect(error.code).toBe("PAYLOAD_TOO_LARGE")
	})

	it("has a default message, because a size limit refusal needs no detail to be understood", () => {
		expect(tooLarge().message).toBe("Payload too large")
	})

	it("keeps a specific message when the caller supplies one", () => {
		expect(tooLarge("Body exceeds 10 MB").message).toBe("Body exceeds 10 MB")
	})

	it("is an Error, so it survives a throw and reaches the error mapper intact", () => {
		expect(tooLarge()).toBeInstanceOf(Error)
	})
})
