import {
	IDEMPOTENCY_KEY_MAX_LENGTH,
	type IdempotencyRecord,
	idempotencyVerdict,
	isIdempotencyKeyRefused,
	isReplayableResponse,
	resolveIdempotencyKey,
} from "9router-api/domain/idempotency"
import { describe, expect, it } from "vitest"

const record = (overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord => ({
	state: "done",
	fingerprint: "abc",
	status: 200,
	contentType: "application/json",
	body: "{}",
	expiresAt: Date.now() + 60_000,
	...overrides,
})

describe("resolveIdempotencyKey", () => {
	it("accepts a printable key", () => {
		const result = resolveIdempotencyKey("a1b2-c3d4")
		expect(isIdempotencyKeyRefused(result)).toBe(false)
		expect(isIdempotencyKeyRefused(result) ? null : result.key).toBe("a1b2-c3d4")
	})

	it("refuses an absent, empty or non-string key", () => {
		for (const value of [undefined, null, "", 42]) {
			expect(isIdempotencyKeyRefused(resolveIdempotencyKey(value))).toBe(true)
		}
	})

	it("refuses a key with whitespace instead of trimming it", () => {
		// Trimming would make `abc` and `abc ` the same key on one client and different on
		// another, which is exactly the double-charge this header exists to prevent.
		expect(isIdempotencyKeyRefused(resolveIdempotencyKey("abc "))).toBe(true)
		expect(isIdempotencyKeyRefused(resolveIdempotencyKey("a\tb"))).toBe(true)
	})

	it("refuses a key longer than the documented maximum", () => {
		expect(
			isIdempotencyKeyRefused(resolveIdempotencyKey("x".repeat(IDEMPOTENCY_KEY_MAX_LENGTH))),
		).toBe(false)
		expect(
			isIdempotencyKeyRefused(resolveIdempotencyKey("x".repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1))),
		).toBe(true)
	})
})

describe("idempotencyVerdict", () => {
	it("is fresh when nothing is stored", () => {
		expect(idempotencyVerdict(null, "abc")).toBe("fresh")
	})

	it("replays a finished request with the same body", () => {
		expect(idempotencyVerdict(record(), "abc")).toBe("replay")
	})

	it("refuses the same key with a different body", () => {
		expect(idempotencyVerdict(record(), "different")).toBe("conflict")
	})

	it("refuses a second request while the first is running", () => {
		expect(idempotencyVerdict(record({ state: "in_progress" }), "abc")).toBe("in_progress")
	})

	it("is fresh again once the record expired", () => {
		expect(idempotencyVerdict(record({ expiresAt: Date.now() - 1 }), "abc")).toBe("fresh")
	})
})

describe("isReplayableResponse", () => {
	it("stores a JSON answer", () => {
		expect(isReplayableResponse({ status: 200, contentType: "application/json" })).toBe(true)
	})

	it("stores a client error, so the retry gets the same rejection", () => {
		expect(isReplayableResponse({ status: 429, contentType: "application/json" })).toBe(true)
	})

	it("refuses a streamed body", () => {
		expect(isReplayableResponse({ status: 200, contentType: "text/event-stream" })).toBe(false)
	})

	it("refuses a 5xx, which the retry is supposed to survive", () => {
		expect(isReplayableResponse({ status: 502, contentType: "application/json" })).toBe(false)
	})
})
