import {
	type IdempotencyStore,
	makeIdempotency,
} from "9router-api/application/idempotency/idempotency"
import type { IdempotencyRecord } from "9router-api/domain/idempotency"
import { describe, expect, it } from "vitest"

/** An in-memory store with the same claim semantics as the database one. */
function memoryStore(): IdempotencyStore & { rows: Map<string, IdempotencyRecord> } {
	const rows = new Map<string, IdempotencyRecord>()
	return {
		rows,
		async read(key) {
			return rows.get(key) ?? null
		},
		async claim(entry) {
			if (rows.has(entry.key)) return false
			rows.set(entry.key, {
				state: "in_progress",
				fingerprint: entry.fingerprint,
				status: null,
				contentType: null,
				body: null,
				expiresAt: entry.expiresAt,
			})
			return true
		},
		async complete(key, entry) {
			const existing = rows.get(key)
			if (!existing) return
			rows.set(key, {
				...existing,
				state: "done",
				status: entry.status,
				contentType: entry.contentType,
				body: entry.body,
			})
		},
		async release(key) {
			rows.delete(key)
		},
		async prune(now) {
			let removed = 0
			for (const [key, row] of rows) {
				if (row.expiresAt <= now) {
					rows.delete(key)
					removed += 1
				}
			}
			return removed
		},
	}
}

describe("makeIdempotency", () => {
	it("claims a fresh key", async () => {
		const idempotency = makeIdempotency({ store: memoryStore() })
		await expect(idempotency.begin("k", "fp")).resolves.toEqual({ verdict: "fresh" })
	})

	it("replays the stored answer for the same key and body", async () => {
		const store = memoryStore()
		const idempotency = makeIdempotency({ store })

		await idempotency.begin("k", "fp")
		await idempotency.finish("k", {
			status: 200,
			contentType: "application/json",
			body: '{"ok":true}',
		})

		await expect(idempotency.begin("k", "fp")).resolves.toEqual({
			verdict: "replay",
			replay: { status: 200, contentType: "application/json", body: '{"ok":true}' },
		})
	})

	it("refuses the same key with a different body", async () => {
		const idempotency = makeIdempotency({ store: memoryStore() })
		await idempotency.begin("k", "fp")
		await expect(idempotency.begin("k", "other")).resolves.toEqual({ verdict: "conflict" })
	})

	it("refuses a concurrent retry while the first is running", async () => {
		const idempotency = makeIdempotency({ store: memoryStore() })
		await idempotency.begin("k", "fp")
		await expect(idempotency.begin("k", "fp")).resolves.toEqual({ verdict: "in_progress" })
	})

	it("frees the key when the request failed, so the retry can run", async () => {
		const store = memoryStore()
		const idempotency = makeIdempotency({ store })

		await idempotency.begin("k", "fp")
		await idempotency.abandon("k")

		await expect(idempotency.begin("k", "fp")).resolves.toEqual({ verdict: "fresh" })
	})

	it("releases a streamed answer instead of storing it", async () => {
		const store = memoryStore()
		const idempotency = makeIdempotency({ store })

		await idempotency.begin("k", "fp")
		await idempotency.finish("k", {
			status: 200,
			contentType: "text/event-stream",
			body: "data: {}\n\n",
		})

		// A stream cannot be replayed from a stored body, so the next attempt runs for real.
		await expect(idempotency.begin("k", "fp")).resolves.toEqual({ verdict: "fresh" })
	})

	it("releases a 5xx instead of turning a failure into the answer", async () => {
		const store = memoryStore()
		const idempotency = makeIdempotency({ store })

		await idempotency.begin("k", "fp")
		await idempotency.finish("k", { status: 502, contentType: "application/json", body: "{}" })

		await expect(idempotency.begin("k", "fp")).resolves.toEqual({ verdict: "fresh" })
	})

	it("stops replaying after the window closes", async () => {
		let now = 1_000_000
		const store = memoryStore()
		const idempotency = makeIdempotency({ store, now: () => now })

		await idempotency.begin("k", "fp")
		await idempotency.finish("k", { status: 200, contentType: "application/json", body: "{}" })

		now += 25 * 60 * 60 * 1000
		await expect(idempotency.begin("k", "fp")).resolves.toEqual({ verdict: "fresh" })
	})
})
