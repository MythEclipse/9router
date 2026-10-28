import { describe, expect, it } from "vitest"
import type { ErrorLogEntry, ErrorLogPort } from "../../apps/api/src/application/dependencies.ts"
import {
	makeClearErrorLogs,
	makeListErrorLogs,
} from "../../apps/api/src/application/error-logs/read-error-logs.ts"
import {
	DEFAULT_ERROR_LOG_LIMIT,
	MAX_ERROR_LOG_LIMIT,
} from "../../apps/api/src/domain/error-log.ts"

function fakePort(overrides: Partial<ErrorLogPort> = {}): ErrorLogPort & { seen: number[] } {
	const seen: number[] = []
	return {
		seen,
		async list(limit) {
			seen.push(limit)
			const rows: ErrorLogEntry[] = Array.from({ length: Math.min(limit, 3) }, (_, i) => ({
				id: i + 1,
			}))
			return rows
		},
		async clear() {
			return true
		},
		...overrides,
	}
}

describe("listErrorLogs", () => {
	it("passes the resolved limit to the port", async () => {
		const port = fakePort()
		await makeListErrorLogs(port)("25")
		expect(port.seen).toEqual([25])
	})

	it("defaults an absent limit and reports no adjustment", async () => {
		const port = fakePort()
		const page = await makeListErrorLogs(port)(undefined)
		expect(port.seen).toEqual([DEFAULT_ERROR_LOG_LIMIT])
		expect(page.adjusted).toBe(false)
	})

	it("flags a clamped limit so the caller can tell why it got fewer rows", async () => {
		const port = fakePort()
		const page = await makeListErrorLogs(port)("99999")
		expect(port.seen).toEqual([MAX_ERROR_LOG_LIMIT])
		expect(page.adjusted).toBe(true)
		expect(page.limit).toBe(MAX_ERROR_LOG_LIMIT)
	})

	it("never hands a non-numeric limit to the port", async () => {
		// This is the regression the domain test pins from the other side: the old
		// handler ran parseInt and passed NaN straight into the query.
		const port = fakePort()
		await makeListErrorLogs(port)("abc")
		expect(port.seen).toEqual([DEFAULT_ERROR_LOG_LIMIT])
	})

	it("returns the rows the port produced, unmodified", async () => {
		const port = fakePort()
		const page = await makeListErrorLogs(port)(2)
		expect(page.logs).toHaveLength(2)
		expect(page.logs[0]).toEqual({ id: 1 })
	})
})

describe("clearErrorLogs", () => {
	it("reports success when the port deleted the rows", async () => {
		await expect(makeClearErrorLogs(fakePort())()).resolves.toEqual({ cleared: true })
	})

	it("fails loudly when the port could not delete", async () => {
		// The old handler answered { success: true } unconditionally, so a failed
		// clear left the dashboard showing rows that were still there.
		const port = fakePort({
			async clear() {
				return false
			},
		})
		await expect(makeClearErrorLogs(port)()).rejects.toMatchObject({ code: "INTERNAL" })
	})
})
