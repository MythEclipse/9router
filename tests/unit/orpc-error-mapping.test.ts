/**
 * A domain error must keep its status across the transport, even when it is not the same
 * class instance the mapper was compiled against.
 *
 * The dashboard loads `apps/api` through Next's transpile pipeline, and `domain/errors.ts`
 * gets evaluated once for the router chunk and once for the route chunk. The two `AppError`
 * classes are structurally identical and mutually unrecognisable to `instanceof`. A live
 * probe found the result: `POST /api/providers/nope/test` answered 500 where the use-case
 * had thrown `notFound`, so every `NOT_FOUND`, `VALIDATION` and `CONFLICT` in the migrated
 * routes was flattened into "Internal server error" — while every unit test passed, because
 * each of them imported both sides from one module graph.
 *
 * The first case below is the one that would have caught it: a plain object carrying the
 * shape of an `AppError` stands in for the other copy's instance.
 */
import { describe, expect, it } from "vitest"
import { AppError, conflict, invalid, notFound } from "../../apps/api/src/domain/errors.ts"
import { statusFor, toORPCError } from "../../apps/api/src/presentation/orpc/error-mapping.ts"

/** An `AppError` from a second copy of the module: right shape, wrong class identity. */
function foreignAppError() {
	const error = new Error("Connection not found")
	return Object.assign(error, { code: "NOT_FOUND", name: "AppError" })
}

describe("toORPCError keeps a domain error's status across module copies", () => {
	it("reads the shape, so a structurally identical error is not flattened to 500", () => {
		const mapped = toORPCError(foreignAppError())
		expect(mapped.code).toBe("NOT_FOUND")
		expect(mapped.status).toBe(404)
		expect(mapped.message).toBe("Connection not found")
	})

	it("still maps a real instance the same way", () => {
		const mapped = toORPCError(notFound("Connection"))
		expect(mapped.code).toBe("NOT_FOUND")
		expect(mapped.status).toBe(404)
	})

	it("carries a status the code cannot express, such as a provider's 429", () => {
		const refusal = new AppError("UPSTREAM", "Too many requests", { status: 429 })
		expect(toORPCError(refusal).status).toBe(429)
	})

	it("keeps a conflict's data, which is what the caller acts on", () => {
		const mapped = toORPCError(conflict("Name already used", { existingId: "c9" }))
		expect(mapped.status).toBe(409)
		expect(mapped.data).toMatchObject({ existingId: "c9" })
	})

	it("maps a validation failure to 400 rather than 500", () => {
		expect(toORPCError(invalid("Provider and API key required")).status).toBe(400)
	})

	it("refuses to promote an arbitrary throw that names no known code", () => {
		// Otherwise any thrown object with a `code` field could pick its own client-visible
		// status, including a 200-shaped code that does not exist.
		const mapped = toORPCError(Object.assign(new Error("boom"), { code: "NOT_A_CODE" }))
		expect(mapped.code).toBe("INTERNAL")
		expect(mapped.status).toBe(500)
		expect(mapped.message).toBe("Internal server error")
	})

	it("keeps the status table and the vocabulary in step", () => {
		for (const code of [
			"VALIDATION",
			"UNAUTHORIZED",
			"FORBIDDEN",
			"NOT_FOUND",
			"CONFLICT",
		] as const) {
			expect(statusFor(code)).toBeGreaterThanOrEqual(400)
			expect(statusFor(code)).toBeLessThan(500)
		}
	})
})
