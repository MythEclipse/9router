import { describe, expect, test } from "bun:test"
import { readAllToolStatuses } from "../../apps/api/src/application/cli-tools/read-all-statuses.ts"

/**
 * The batch exists to save eighteen round-trips, so the only thing that can go wrong is one
 * reader taking the answer down with it. Every test here is about that: a tool that throws must
 * still appear, and must appear as `null` rather than as absent.
 */

const ok = (body: Record<string, unknown>) => async () => body
const boom = async (): Promise<Record<string, unknown>> => {
	throw new Error("EACCES")
}

describe("reading every tool status", () => {
	test("the answer has one key per reader, in the order given", async () => {
		const answer = await readAllToolStatuses({
			cline: ok({ installed: true }),
			codex: ok({ installed: false }),
		})
		expect(Object.keys(answer.body)).toEqual(["cline", "codex"])
		expect(answer.status).toBe(200)
	})

	test("a reader that throws is null for its own tool, and the others still answer", async () => {
		const answer = await readAllToolStatuses({
			cline: ok({ installed: true }),
			broken: boom,
			codex: ok({ installed: false }),
		})
		expect(answer.body.broken).toBeNull()
		expect(answer.body.cline).toEqual({ installed: true })
		expect(answer.body.codex).toEqual({ installed: false })
	})

	test("every reader failing still answers 200 with all keys present", async () => {
		const answer = await readAllToolStatuses({ a: boom, b: boom })
		expect(answer.status).toBe(200)
		expect(answer.body).toEqual({ a: null, b: null })
	})

	test("an empty map is an empty answer, not an error", async () => {
		const answer = await readAllToolStatuses({})
		expect(answer.status).toBe(200)
		expect(answer.body).toEqual({})
	})

	test("the readers run concurrently, so nineteen tools cost one wait", async () => {
		let inFlight = 0
		let peak = 0
		const slow = () => async () => {
			inFlight++
			peak = Math.max(peak, inFlight)
			await new Promise((resolve) => setTimeout(resolve, 5))
			inFlight--
			return { installed: true }
		}
		await readAllToolStatuses({ a: slow(), b: slow(), c: slow(), d: slow() })
		expect(peak).toBe(4)
	})

	test("a reader that settles after another throws is still reported", async () => {
		const answer = await readAllToolStatuses({
			fast_failure: boom,
			slow_success: async () => {
				await new Promise((resolve) => setTimeout(resolve, 5))
				return { installed: true }
			},
		})
		expect(answer.body.fast_failure).toBeNull()
		expect(answer.body.slow_success).toEqual({ installed: true })
	})
})
