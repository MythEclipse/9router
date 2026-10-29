import { describe, expect, it } from "vitest"

import {
	historyCsvRow,
	makeUsageReports,
	RECENT_LOG_LIMIT,
	type UsageReportPort,
	usageScopeOf,
} from "../../apps/api/src/application/usage/report-usage.ts"

function harness() {
	const calls: { method: string; args: unknown[] }[] = []
	const usage: UsageReportPort = {
		async stats(...args) {
			calls.push({ method: "stats", args })
			return { total: 1 }
		},
		async chart(...args) {
			calls.push({ method: "chart", args })
			return { series: [] }
		},
		async sparks(...args) {
			calls.push({ method: "sparks", args })
			return { days: [] }
		},
		async history(filter) {
			calls.push({ method: "history", args: [filter] })
			return [
				{
					timestamp: "2026-10-29T00:00:00.000Z",
					provider: "openai",
					model: "gpt-4o",
					cost: 0.5,
					tokens: { prompt_tokens: 10, completion_tokens: 20 },
				},
			]
		},
		async recentLogs(limit) {
			calls.push({ method: "recentLogs", args: [limit] })
			return ["line"]
		},
	}
	return { useCases: makeUsageReports({ usage }), calls }
}

const scope = { apiKeyFilter: null, allowedModels: "*" }

describe("usageScopeOf", () => {
	it("treats an absent session as unrestricted", () => {
		expect(usageScopeOf(null)).toEqual({ apiKeyFilter: null, allowedModels: "*" })
	})

	it("narrows a real payload", () => {
		expect(usageScopeOf({ apiKeyFilter: "sk-a", allowedModels: "gpt-4o" })).toEqual({
			apiKeyFilter: "sk-a",
			allowedModels: "gpt-4o",
		})
	})

	it("ignores a payload of the wrong type", () => {
		expect(usageScopeOf({ apiKeyFilter: 7, allowedModels: 9 })).toEqual({
			apiKeyFilter: null,
			allowedModels: "*",
		})
	})
})

describe("stats", () => {
	it("passes the resolved period and scope to the port", async () => {
		const h = harness()
		await h.useCases.stats("30d", { apiKeyFilter: "sk-a", allowedModels: "gpt-*" })
		expect(h.calls[0]).toEqual({
			method: "stats",
			args: ["30d", "sk-a", "gpt-*"],
		})
	})

	it("defaults to a week when the caller names no period", async () => {
		const h = harness()
		await h.useCases.stats(undefined, scope)
		expect((h.calls[0].args as unknown[])[0]).toBe("7d")
	})

	it("refuses an unknown period instead of returning a week", async () => {
		const h = harness()
		await expect(h.useCases.stats("90d", scope)).rejects.toMatchObject({
			code: "VALIDATION",
			message: "Invalid period",
		})
		expect(h.calls).toHaveLength(0)
	})
})

describe("chart", () => {
	it("passes the scope through", async () => {
		const h = harness()
		await h.useCases.chart("24h", { apiKeyFilter: null, allowedModels: "*" })
		expect(h.calls[0]).toEqual({ method: "chart", args: ["24h", null, "*"] })
	})

	it("refuses an unknown period", async () => {
		const h = harness()
		await expect(h.useCases.chart("nope", scope)).rejects.toMatchObject({
			code: "VALIDATION",
		})
	})
})

describe("sparks", () => {
	it("defaults to a month, not a week", async () => {
		const h = harness()
		await h.useCases.sparks(undefined, scope)
		expect((h.calls[0].args as unknown[])[0]).toBe("30d")
	})

	it("honours an explicit period", async () => {
		const h = harness()
		await h.useCases.sparks("today", scope)
		expect((h.calls[0].args as unknown[])[0]).toBe("today")
	})
})

describe("logs", () => {
	it("asks for the named limit rather than a literal", async () => {
		const h = harness()
		await h.useCases.logs()
		expect(h.calls[0]).toEqual({ method: "recentLogs", args: [RECENT_LOG_LIMIT] })
	})
})

describe("history", () => {
	it("returns rows as JSON when no format is given", async () => {
		const h = harness()
		const result = await h.useCases.history(undefined, scope)
		expect(result.kind).toBe("json")
	})

	it("treats an unknown format as JSON rather than erroring", async () => {
		const h = harness()
		const result = await h.useCases.history("xml", scope)
		expect(result.kind).toBe("json")
	})

	it("builds CSV with an escaped header", async () => {
		const h = harness()
		const result = await h.useCases.history("csv", scope)
		if (result.kind !== "csv") throw new Error("expected csv")
		const [header, row] = result.body.split("\n")
		expect(header).toBe(
			'"timestamp","provider","model","connectionId","apiKeyMasked","endpoint","status","cost","promptTokens","completionTokens"',
		)
		expect(row).toContain('"gpt-4o"')
	})

	it("names the file after the day", async () => {
		const h = harness()
		const result = await h.useCases.history("csv", scope)
		if (result.kind !== "csv") throw new Error("expected csv")
		expect(result.filename).toMatch(/^usage-report-\d{4}-\d{2}-\d{2}\.csv$/)
	})

	it("passes the key filter to the port and omits it when absent", async () => {
		const h = harness()
		await h.useCases.history(undefined, scope)
		expect(h.calls[0].args).toEqual([{}])

		const h2 = harness()
		await h2.useCases.history(undefined, { apiKeyFilter: "sk-a", allowedModels: "*" })
		expect(h2.calls[0].args).toEqual([{ apiKey: "sk-a" }])
	})
})

describe("historyCsvRow", () => {
	it("uses prompt/completion tokens when given", () => {
		const row = historyCsvRow({
			timestamp: "t",
			tokens: { prompt_tokens: 1, completion_tokens: 2 },
		})
		expect(row.slice(-2)).toEqual([1, 2])
	})

	it("falls back to input/output token names", () => {
		const row = historyCsvRow({
			timestamp: "t",
			tokens: { input_tokens: 3, output_tokens: 4 },
		})
		expect(row.slice(-2)).toEqual([3, 4])
	})

	it("reports an absent status as ok", () => {
		expect(historyCsvRow({ timestamp: "t" })[6]).toBe("ok")
	})

	it("keeps an explicit status", () => {
		expect(historyCsvRow({ timestamp: "t", status: "error" })[6]).toBe("error")
	})

	it("renders absent fields as empty strings", () => {
		const row = historyCsvRow({ timestamp: "t" })
		expect(row.slice(1, 6)).toEqual(["", "", "", "", ""])
	})
})
