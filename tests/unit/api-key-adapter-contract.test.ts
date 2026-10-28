/**
 * The adapter against a store that behaves like the real one.
 *
 * The unit tests for the use-cases use a fake *I* wrote, so they agreed with
 * whatever shape I assumed. They passed while the real store returned something
 * else and the create route answered 201 with an empty body. These tests drive
 * the adapter with the store's actual contract: `create` returns the row it
 * wrote, and that row's `key` field is the secret.
 */

import { describe, expect, it } from "vitest"

import {
	type ApiKeyStore,
	makeApiKeyManagementPort,
} from "../../apps/api/src/infrastructure/db/repositories/api-key-dashboard-repository.ts"

function store(overrides: Partial<ApiKeyStore> = {}): ApiKeyStore {
	const rows: Record<string, unknown>[] = []
	return {
		async list() {
			return rows
		},
		async findById(id) {
			return rows.find((row) => row.id === id) ?? null
		},
		async create(name, machineId) {
			const row = {
				id: "k1",
				name,
				key: `sk-${machineId}-secret`,
				machineId,
				isActive: true,
				tokenLimit: 0,
				usedTokens: 0,
				resetInterval: "never",
				lastResetAt: null,
				allowedModels: "*",
				allowedEndpoints: [],
				rpmLimit: 0,
				tpmLimit: 0,
				dailyCostLimit: 0,
				requestLimit: 0,
				limitKind: "tokens",
				permissions: null,
				createdBy: "",
			}
			rows.push(row)
			return row
		},
		async update(id, patch) {
			const row = rows.find((r) => r.id === id)
			if (!row) return null
			Object.assign(row, patch)
			return row
		},
		async remove(id) {
			const at = rows.findIndex((r) => r.id === id)
			if (at < 0) return false
			rows.splice(at, 1)
			return true
		},
		async consistentMachineId() {
			return "machine-1"
		},
		...overrides,
	}
}

const scope = {
	tokenLimit: 100,
	resetInterval: "never",
	allowedModels: "*",
	allowedEndpoints: ["chat"],
	rpmLimit: 0,
	tpmLimit: 0,
	dailyCostLimit: 0,
	requestLimit: 0,
	limitKind: "tokens",
	expiresAt: null,
	systemPrompt: "",
	permissions: null,
	createdBy: null,
}

describe("create against the real store contract", () => {
	it("returns the written row as the key, not a wrapper", async () => {
		const port = makeApiKeyManagementPort(store())
		const created = await port.create("alpha", scope)

		expect(created.key.name).toBe("alpha")
		expect(created.key.id).toBe("k1")
	})

	it("takes the secret from the row's key field", async () => {
		const port = makeApiKeyManagementPort(store())
		const created = await port.create("alpha", scope)
		expect(created.secret).toBe("sk-machine-1-secret")
	})

	it("passes the machine id from the store, not from the scope", async () => {
		const port = makeApiKeyManagementPort(store())
		const created = await port.create("alpha", scope)
		expect(created.key.machineId).toBe("machine-1")
	})

	it("forwards every scoped field to the store", async () => {
		let seen: Record<string, unknown> | null = null
		const port = makeApiKeyManagementPort(
			store({
				async create(_name, _machineId, passed) {
					seen = passed
					return { id: "k1", name: "alpha", key: "sk-x", ...passed }
				},
			}),
		)
		await port.create("alpha", { ...scope, dailyCostLimit: 5 })
		expect(seen).toMatchObject({ tokenLimit: 100, dailyCostLimit: 5, allowedEndpoints: ["chat"] })
	})
})

describe("list and remove against the real store contract", () => {
	it("lists what the store lists", async () => {
		const port = makeApiKeyManagementPort(store())
		await port.create("alpha", scope)
		expect(await port.list()).toHaveLength(1)
	})

	it("reports how many rows actually went", async () => {
		const port = makeApiKeyManagementPort(store())
		await port.create("alpha", scope)
		expect(await port.removeMany(["k1", "missing"])).toBe(1)
	})

	it("reports a delete that found nothing", async () => {
		const port = makeApiKeyManagementPort(store())
		expect(await port.remove("nope")).toBe(false)
	})
})
