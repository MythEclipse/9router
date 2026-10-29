import { describe, expect, it } from "vitest"
import { makeModelAvailability } from "../../apps/api/src/application/models/manage-availability.ts"
import {
	ALL_MODELS,
	type AvailabilityConnection,
	activeModelLocks,
	availabilityRows,
	clearLockPatch,
	connectionsWithLock,
	MODEL_LOCK_PREFIX,
} from "../../apps/api/src/domain/model-availability.ts"

const NOW = new Date("2026-10-29T12:00:00Z").getTime()
const future = "2026-10-29T13:00:00Z"
const past = "2026-10-29T11:00:00Z"

describe("activeModelLocks", () => {
	it("reads the lock convention", () => {
		const connection = { id: "c1", provider: "p", [`${MODEL_LOCK_PREFIX}gpt-4o`]: future }
		expect(activeModelLocks(connection, NOW)).toEqual([
			{ key: `${MODEL_LOCK_PREFIX}gpt-4o`, model: "gpt-4o", until: future },
		])
	})

	it("ignores an expired lock", () => {
		// The router has already retried; listing it shows a model as stuck days
		// after it recovered.
		expect(
			activeModelLocks({ id: "c1", provider: "p", [`${MODEL_LOCK_PREFIX}x`]: past }, NOW),
		).toEqual([])
	})

	it("ignores a cleared (null) lock", () => {
		expect(
			activeModelLocks({ id: "c1", provider: "p", [`${MODEL_LOCK_PREFIX}x`]: null }, NOW),
		).toEqual([])
	})

	it("treats an empty model in the key as the whole connection", () => {
		const connection = { id: "c1", provider: "p", [MODEL_LOCK_PREFIX]: future }
		expect(activeModelLocks(connection, NOW)[0]?.model).toBe(ALL_MODELS)
	})

	it("ignores unrelated fields", () => {
		expect(activeModelLocks({ id: "c1", provider: "p", testStatus: "active" }, NOW)).toEqual([])
	})

	it("accepts null", () => {
		expect(activeModelLocks(null, NOW)).toEqual([])
	})
})

describe("availabilityRows", () => {
	it("reports one cooldown row per lock", () => {
		const rows = availabilityRows(
			[
				{
					id: "c1",
					provider: "openai",
					name: "Work",
					lastError: "429",
					[`${MODEL_LOCK_PREFIX}a`]: future,
					[`${MODEL_LOCK_PREFIX}b`]: future,
				},
			],
			NOW,
		)
		expect(rows).toHaveLength(2)
		expect(rows[0]).toMatchObject({
			provider: "openai",
			model: "a",
			status: "cooldown",
			connectionName: "Work",
		})
	})

	it("falls back to email then id for the connection name", () => {
		const byEmail = availabilityRows(
			[{ id: "c1", provider: "p", email: "a@b.c", [`${MODEL_LOCK_PREFIX}x`]: future }],
			NOW,
		)
		expect(byEmail[0]?.connectionName).toBe("a@b.c")
		const byId = availabilityRows(
			[{ id: "c1", provider: "p", [`${MODEL_LOCK_PREFIX}x`]: future }],
			NOW,
		)
		expect(byId[0]?.connectionName).toBe("c1")
	})

	it("reports a wholly unavailable connection only when nothing is cooling down", () => {
		// A connection retrying per-model is not wholly gone; showing both rows
		// would tell the operator to reconnect a connection that is still working.
		const withLocks = availabilityRows(
			[{ id: "c1", provider: "p", testStatus: "unavailable", [`${MODEL_LOCK_PREFIX}x`]: future }],
			NOW,
		)
		expect(withLocks.some((row) => row.status === "unavailable")).toBe(false)

		const withoutLocks = availabilityRows(
			[{ id: "c1", provider: "p", testStatus: "unavailable", lastError: "401" }],
			NOW,
		)
		expect(withoutLocks).toEqual([
			{
				provider: "p",
				model: ALL_MODELS,
				status: "unavailable",
				connectionId: "c1",
				connectionName: "c1",
				lastError: "401",
			},
		])
	})

	it("says nothing about a healthy connection", () => {
		expect(availabilityRows([{ id: "c1", provider: "p", testStatus: "active" }], NOW)).toEqual([])
	})
})

describe("clearLockPatch", () => {
	it("nulls the lock key", () => {
		expect(clearLockPatch({ id: "c1", provider: "p" }, "gpt-4o")).toEqual({
			[`${MODEL_LOCK_PREFIX}gpt-4o`]: null,
		})
	})

	it("also clears the failure state when the connection was unavailable", () => {
		// Without this the connection stays out of rotation with nothing left to
		// explain why: the lock is gone but testStatus still says unavailable.
		expect(clearLockPatch({ id: "c1", provider: "p", testStatus: "unavailable" }, "m")).toEqual({
			[`${MODEL_LOCK_PREFIX}m`]: null,
			testStatus: "active",
			lastError: null,
			lastErrorAt: null,
			backoffLevel: 0,
		})
	})

	it("leaves the backoff of a healthy connection alone", () => {
		expect(clearLockPatch({ id: "c1", provider: "p", testStatus: "active" }, "m")).toEqual({
			[`${MODEL_LOCK_PREFIX}m`]: null,
		})
	})
})

describe("connectionsWithLock", () => {
	it("selects only the connections holding that model's lock", () => {
		const connections = [
			{ id: "c1", provider: "p", [`${MODEL_LOCK_PREFIX}a`]: future },
			{ id: "c2", provider: "p", [`${MODEL_LOCK_PREFIX}b`]: future },
			{ id: "c3", provider: "p" },
		]
		expect(connectionsWithLock(connections, "a").map((c) => c.id)).toEqual(["c1"])
	})

	it("ignores a cleared lock", () => {
		expect(
			connectionsWithLock([{ id: "c1", provider: "p", [`${MODEL_LOCK_PREFIX}a`]: null }], "a"),
		).toEqual([])
	})
})

function harness(connections: AvailabilityConnection[]) {
	const patches: Array<{ id: string; patch: Record<string, unknown> }> = []
	const port = {
		async list(filter?: { provider?: string }) {
			return filter?.provider ? connections.filter((c) => c.provider === filter.provider) : connections
		},
		async update(id: string, patch: Record<string, unknown>) {
			patches.push({ id, patch })
			return {}
		},
	}
	return {
		availability: makeModelAvailability({ connections: port, now: () => new Date(NOW) }),
		patches,
	}
}

describe("modelAvailability.clearCooldown", () => {
	it("patches only the connections that hold the lock", async () => {
		// The earlier shape patched every connection for the provider, which reset
		// a healthy connection's failure counters because another one was cooling.
		const { availability, patches } = harness([
			{ id: "c1", provider: "openai", [`${MODEL_LOCK_PREFIX}b`]: future },
			{ id: "c2", provider: "openai" },
		])
		const result = await availability.clearCooldown({
			action: "clearCooldown",
			provider: "openai",
			model: "b",
		})
		expect(result.cleared).toBe(1)
		expect(patches.map((p) => p.id)).toEqual(["c1"])
	})

	it("reports zero when nothing was cooling down", async () => {
		const { availability, patches } = harness([{ id: "c1", provider: "openai" }])
		expect(
			await availability.clearCooldown({ action: "clearCooldown", provider: "openai", model: "b" }),
		).toEqual({ cleared: 0 })
		expect(patches).toEqual([])
	})

	it("refuses a request that is not a clearCooldown", async () => {
		const { availability } = harness([])
		await expect(
			availability.clearCooldown({ action: "reset", provider: "p", model: "m" }),
		).rejects.toMatchObject({ code: "VALIDATION" })
	})

	it("refuses without a provider or model", async () => {
		const { availability } = harness([])
		await expect(
			availability.clearCooldown({ action: "clearCooldown", provider: "", model: "m" }),
		).rejects.toMatchObject({ code: "VALIDATION" })
		await expect(
			availability.clearCooldown({ action: "clearCooldown", provider: "p", model: null }),
		).rejects.toMatchObject({ code: "VALIDATION" })
	})
})

describe("modelAvailability.list", () => {
	it("counts what it lists", async () => {
		const { availability } = harness([
			{ id: "c1", provider: "p", [`${MODEL_LOCK_PREFIX}a`]: future },
			{ id: "c2", provider: "p", testStatus: "unavailable" },
		])
		const result = await availability.list()
		expect(result.models).toHaveLength(2)
		expect(result.unavailableCount).toBe(2)
	})
})
