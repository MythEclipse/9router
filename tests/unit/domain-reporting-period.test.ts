import { describe, expect, it } from "vitest"

import { csvCell, csvDocument, csvHeader, csvRow } from "../../apps/api/src/domain/csv-export.ts"
import {
	DEFAULT_PERIOD,
	DEFAULT_SPARKS_PERIOD,
	DEFAULT_STREAM_PERIOD,
	DEFAULT_TOKEN_SAVINGS_PERIOD,
	keyFilterOf,
	modelScopeOf,
	periodCutoff,
	REPORTING_PERIODS,
	resolvePeriod,
} from "../../apps/api/src/domain/reporting-period.ts"

describe("resolvePeriod", () => {
	it("accepts every documented period", () => {
		for (const period of REPORTING_PERIODS) {
			expect(resolvePeriod(period)).toEqual({ ok: true, period })
		}
	})

	it("takes the default when the caller names none", () => {
		expect(resolvePeriod(undefined)).toEqual({ ok: true, period: DEFAULT_PERIOD })
		expect(resolvePeriod(null)).toEqual({ ok: true, period: DEFAULT_PERIOD })
	})

	it("treats an empty value as unnamed rather than invalid", () => {
		expect(resolvePeriod("")).toEqual({ ok: true, period: DEFAULT_PERIOD })
		expect(resolvePeriod("   ")).toEqual({ ok: true, period: DEFAULT_PERIOD })
	})

	it("honours the endpoint's own default", () => {
		expect(resolvePeriod(undefined, DEFAULT_SPARKS_PERIOD)).toEqual({
			ok: true,
			period: "30d",
		})
		expect(resolvePeriod(undefined, DEFAULT_STREAM_PERIOD)).toEqual({
			ok: true,
			period: "today",
		})
		expect(resolvePeriod(undefined, DEFAULT_TOKEN_SAVINGS_PERIOD)).toEqual({
			ok: true,
			period: "30d",
		})
	})

	it("refuses an unknown period instead of silently returning a week", () => {
		// This is the behaviour that changed: `errors` and `leaderboard` used to
		// fall back to 7d here, so `?period=90d` returned a week looking correct.
		expect(resolvePeriod("90d")).toEqual({ ok: false, message: "Invalid period" })
		expect(resolvePeriod("garbage")).toEqual({ ok: false, message: "Invalid period" })
	})

	it("refuses a non-string rather than coercing it", () => {
		expect(resolvePeriod(7).ok).toBe(false)
		expect(resolvePeriod(["7d"]).ok).toBe(false)
	})

	it("normalises case and surrounding space", () => {
		expect(resolvePeriod(" 30D ")).toEqual({ ok: true, period: "30d" })
	})
})

describe("periodCutoff", () => {
	const now = new Date("2026-10-29T15:30:00.000Z")

	it("returns null for all time", () => {
		expect(periodCutoff("all", now)).toBeNull()
	})

	it("counts back the stated number of days", () => {
		expect(periodCutoff("7d", now)).toBe("2026-10-22T15:30:00.000Z")
		expect(periodCutoff("24h", now)).toBe("2026-10-28T15:30:00.000Z")
		expect(periodCutoff("30d", now)).toBe("2026-09-29T15:30:00.000Z")
		expect(periodCutoff("60d", now)).toBe("2026-08-30T15:30:00.000Z")
	})

	it("starts today at local midnight, not 24 hours ago", () => {
		const cutoff = periodCutoff("today", now)
		expect(cutoff).not.toBeNull()
		const date = new Date(cutoff as string)
		expect(date.getHours()).toBe(0)
		expect(date.getMinutes()).toBe(0)
		expect(date.getSeconds()).toBe(0)
	})

	it("does not mutate the date it was given", () => {
		const original = new Date(now.getTime())
		periodCutoff("today", original)
		expect(original.toISOString()).toBe(now.toISOString())
	})
})

describe("modelScopeOf and keyFilterOf", () => {
	it("treats an absent scope as unrestricted", () => {
		expect(modelScopeOf(undefined)).toBe("*")
		expect(modelScopeOf(null)).toBe("*")
		expect(modelScopeOf("")).toBe("*")
		expect(modelScopeOf(42)).toBe("*")
	})

	it("keeps a real scope", () => {
		expect(modelScopeOf("gpt-4o")).toBe("gpt-4o")
	})

	it("treats an absent filter as seeing every key", () => {
		expect(keyFilterOf(undefined)).toBeNull()
		expect(keyFilterOf(null)).toBeNull()
		expect(keyFilterOf("")).toBeNull()
		expect(keyFilterOf(7)).toBeNull()
	})

	it("keeps a real key filter", () => {
		expect(keyFilterOf("sk-abc")).toBe("sk-abc")
	})
})

describe("csvCell", () => {
	it("quotes plain text", () => {
		expect(csvCell("hello")).toBe('"hello"')
	})

	it("escapes an embedded quote", () => {
		expect(csvCell('say "hi"')).toBe('"say ""hi"""')
	})

	it("survives a comma", () => {
		expect(csvCell("a,b")).toBe('"a,b"')
	})

	it("renders null and undefined as empty", () => {
		expect(csvCell(null)).toBe('""')
		expect(csvCell(undefined)).toBe('""')
	})

	it("defuses a formula lead", () => {
		for (const lead of ["=", "+", "-", "@"]) {
			expect(csvCell(`${lead}cmd`)).toBe(`"\t${lead}cmd"`)
		}
	})

	it("defuses a formula even when it also contains a quote", () => {
		expect(csvCell('=HYPERLINK("x")')).toBe('"\t=HYPERLINK(""x"")"')
	})

	it("leaves a negative number readable but defused", () => {
		expect(csvCell(-3)).toBe('"\t-3"')
	})
})

describe("csvDocument", () => {
	it("escapes the header by the same rule as the data", () => {
		expect(csvHeader(["a", "b"])).toBe('"a","b"')
	})

	it("builds a document with one line per row", () => {
		const doc = csvDocument(["model", "cost"], [["gpt-4o", 1]])
		expect(doc.split("\n")).toEqual(['"model","cost"', '"gpt-4o","1"'])
	})

	it("keeps a comma inside a row from splitting a column", () => {
		const doc = csvDocument(["model"], [["gpt,4o"]])
		expect(doc.split("\n")[1]).toBe('"gpt,4o"')
	})

	it("produces only the header when there are no rows", () => {
		expect(csvDocument(["a", "b"], [])).toBe('"a","b"')
	})

	it("escapes every cell of a row", () => {
		expect(csvRow(['a"b', "c,d"])).toBe('"a""b","c,d"')
	})
})
