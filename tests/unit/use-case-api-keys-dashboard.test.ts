import { describe, expect, it } from "vitest"
import type {
	ApiKeyManagementPort,
	ApiKeyView,
} from "../../apps/api/src/application/api-keys/manage-api-keys-dashboard.ts"
import { makeManageApiKeys } from "../../apps/api/src/application/api-keys/manage-api-keys-dashboard.ts"

function matches(patterns: readonly string[], model: string): boolean {
	const req = model.trim().toLowerCase()
	return patterns.some((allowed) => {
		if (allowed === "*" || allowed === req) return true
		if (allowed.endsWith("*")) return req.startsWith(allowed.slice(0, -1))
		if (allowed.startsWith("*")) return req.endsWith(allowed.slice(1))
		return false
	})
}

function row(overrides: Partial<ApiKeyView> = {}): ApiKeyView {
	return {
		id: "k1",
		name: "existing",
		key: "sk-prefix",
		machineId: "m1",
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
		...overrides,
	}
}

function harness(initial: readonly ApiKeyView[] = []) {
	const rows = [...initial]
	const audit: unknown[] = []
	let created: Record<string, unknown> | null = null

	const port: ApiKeyManagementPort = {
		async list() {
			return rows
		},
		async create(name, scope) {
			created = { name, ...scope }
			const key = row({ id: "k-new", name, tokenLimit: scope.tokenLimit })
			rows.push(key)
			return { key, secret: "sk-shown-once" }
		},
		async removeMany(ids) {
			const before = rows.length
			for (const id of ids) {
				const at = rows.findIndex((r) => r.id === id)
				if (at >= 0) rows.splice(at, 1)
			}
			return before - rows.length
		},
		async remove(id) {
			const at = rows.findIndex((r) => r.id === id)
			if (at < 0) return false
			rows.splice(at, 1)
			return true
		},
	}

	const useCases = makeManageApiKeys({
		keys: port,
		audit: {
			async recordKeyCreated(event) {
				audit.push(event)
			},
		},
		matchesAllowedModels: matches,
		endpointKinds: ["chat", "responses", "models", "embeddings", "images", "audio"],
	})

	return {
		useCases,
		rows,
		audit,
		get created() {
			return created
		},
	}
}

const passwordCaller = {
	role: "admin",
	scope: {},
	permissions: null,
}

describe("create — permissions", () => {
	it("refuses a key session without manageApiKeys", async () => {
		const h = harness()
		await expect(
			h.useCases.create(
				{ name: "sub" },
				{
					role: "apikey",
					scope: {},
					permissions: { viewUsage: true, manageApiKeys: false },
				},
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" })
	})

	it("lets a key session mint one when it holds the permission", async () => {
		const h = harness()
		const result = await h.useCases.create(
			{ name: "sub" },
			{
				role: "apikey",
				scope: { tokenLimit: 100 },
				permissions: { viewUsage: true, manageApiKeys: true },
				apiKey: "parent",
				keyName: "parent-key",
			},
		)
		expect(result.secret).toBe("sk-shown-once")
	})
})

describe("create — name", () => {
	it("requires a name", async () => {
		const h = harness()
		await expect(h.useCases.create({ name: "   " }, passwordCaller)).rejects.toMatchObject({
			code: "VALIDATION",
			message: "Name is required",
		})
	})

	it("rejects a name that is not a string", async () => {
		const h = harness()
		await expect(h.useCases.create({ name: 42 }, passwordCaller)).rejects.toMatchObject({
			code: "VALIDATION",
		})
	})

	it("rejects a duplicate name as a conflict", async () => {
		const h = harness([row({ name: "taken" })])
		await expect(h.useCases.create({ name: "taken" }, passwordCaller)).rejects.toMatchObject({
			code: "CONFLICT",
		})
	})

	it("compares the trimmed name to what exists", async () => {
		const h = harness([row({ name: "taken" })])
		await expect(h.useCases.create({ name: "  taken  " }, passwordCaller)).rejects.toMatchObject({
			code: "CONFLICT",
		})
	})
})

describe("create — scoping", () => {
	it("refuses a sub-key that outlives its creator's token cap", async () => {
		const h = harness()
		await expect(
			h.useCases.create(
				{ name: "sub", tokenLimit: 500 },
				{
					role: "apikey",
					scope: { tokenLimit: 100 },
					permissions: { viewUsage: true, manageApiKeys: true },
				},
			),
		).rejects.toMatchObject({
			code: "VALIDATION",
			message: "Token limit cannot exceed your maximum (100).",
		})
	})

	it("refuses a sub-key that outspends its creator's cost cap", async () => {
		const h = harness()
		await expect(
			h.useCases.create(
				{ name: "sub", dailyCostLimit: 50 },
				{
					role: "apikey",
					scope: { dailyCostLimit: 10 },
					permissions: { viewUsage: true, manageApiKeys: true },
				},
			),
		).rejects.toMatchObject({
			code: "VALIDATION",
			message: "Daily cost limit cannot exceed your maximum ($10).",
		})
	})

	it("gives a key session the default permissions whatever it asks", async () => {
		const h = harness()
		await h.useCases.create(
			{ name: "sub", permissions: { viewUsage: true, manageApiKeys: true } },
			{
				role: "apikey",
				scope: {},
				permissions: { viewUsage: true, manageApiKeys: true },
			},
		)
		expect(h.created?.permissions).toEqual({ viewUsage: true, manageApiKeys: false })
	})

	it("clamps a wildcard model request to the creator's list", async () => {
		const h = harness()
		await h.useCases.create(
			{ name: "sub", allowedModels: "*" },
			{
				role: "apikey",
				scope: { allowedModels: "gpt-4o,claude-*" },
				permissions: { viewUsage: true, manageApiKeys: true },
			},
		)
		expect(h.created?.allowedModels).toBe("gpt-4o,claude-*")
	})

	it("refuses an endpoint kind that does not exist", async () => {
		const h = harness()
		await expect(
			h.useCases.create(
				{ name: "sub", allowedEndpoints: ["chat", "admin"] },
				{
					role: "apikey",
					scope: { allowedEndpoints: ["chat"] },
					permissions: { viewUsage: true, manageApiKeys: true },
				},
			),
		).rejects.toMatchObject({ code: "VALIDATION" })
	})

	it("clamps endpoints to the creator's set", async () => {
		const h = harness()
		await h.useCases.create(
			{ name: "sub", allowedEndpoints: ["chat", "images"] },
			{
				role: "apikey",
				scope: { allowedEndpoints: ["chat"] },
				permissions: { viewUsage: true, manageApiKeys: true },
			},
		)
		// Nothing survives the creator's set, so the key gets the creator's list —
		// an empty endpoint list would deny every request.
		expect(h.created?.allowedEndpoints).toEqual(["chat"])
	})

	it("defaults an unrestricted password session to a wildcard", async () => {
		const h = harness()
		await h.useCases.create({ name: "sub" }, passwordCaller)
		expect(h.created?.allowedModels).toBe("*")
		expect(h.created?.resetInterval).toBe("never")
	})
})

describe("create — field coercion", () => {
	it("turns junk numeric fields into zero", async () => {
		const h = harness()
		await h.useCases.create(
			{ name: "sub", rpmLimit: "abc", tpmLimit: null, requestLimit: undefined },
			passwordCaller,
		)
		expect(h.created?.rpmLimit).toBe(0)
		expect(h.created?.tpmLimit).toBe(0)
		expect(h.created?.requestLimit).toBe(0)
	})

	it("falls back to the tokens limit kind for an unknown value", async () => {
		const h = harness()
		await h.useCases.create({ name: "sub", limitKind: "nonsense" }, passwordCaller)
		expect(h.created?.limitKind).toBe("tokens")
	})

	it("keeps a recognised limit kind", async () => {
		const h = harness()
		await h.useCases.create({ name: "sub", limitKind: "cost" }, passwordCaller)
		expect(h.created?.limitKind).toBe("cost")
	})

	it("records the creator key only for a key session", async () => {
		const h = harness()
		await h.useCases.create(
			{ name: "sub" },
			{
				...passwordCaller,
				apiKey: "should-not-land",
			},
		)
		expect(h.created?.createdBy).toBeNull()
	})
})

describe("audit", () => {
	it("records the creator and the permissions granted", async () => {
		const h = harness()
		await h.useCases.create({ name: "sub" }, passwordCaller)
		expect(h.audit).toEqual([
			{
				actor: "Password user",
				keyName: "sub",
				permissions: { viewUsage: true, manageApiKeys: false },
			},
		])
	})

	it("names the key that minted another", async () => {
		const h = harness()
		await h.useCases.create(
			{ name: "sub" },
			{
				role: "apikey",
				scope: {},
				permissions: { viewUsage: true, manageApiKeys: true },
				keyName: "parent-key",
				keyId: "k-parent",
			},
		)
		expect((h.audit[0] as { actor: string }).actor).toBe('API key "parent-key"')
	})

	it("still returns the key when the audit write fails", async () => {
		const keys: ApiKeyManagementPort = {
			async list() {
				return []
			},
			async create(name) {
				return { key: row({ name }), secret: "sk-shown-once" }
			},
			async removeMany() {
				return 0
			},
			async remove() {
				return false
			},
		}
		const useCases = makeManageApiKeys({
			keys,
			audit: {
				async recordKeyCreated() {
					throw new Error("audit down")
				},
			},
			matchesAllowedModels: matches,
			endpointKinds: ["chat", "responses", "models", "embeddings", "images", "audio"],
		})
		const result = await useCases.create({ name: "sub" }, passwordCaller)
		expect(result.secret).toBe("sk-shown-once")
	})
})

describe("removeMany", () => {
	it("refuses an empty selection instead of reporting success", async () => {
		const h = harness([row()])
		await expect(h.useCases.removeMany([])).rejects.toMatchObject({
			code: "VALIDATION",
		})
	})

	it("deletes the named keys and reports how many went", async () => {
		const h = harness([row({ id: "a" }), row({ id: "b", name: "b" })])
		expect(await h.useCases.removeMany(["a", "b"])).toBe(2)
		expect(h.rows).toHaveLength(0)
	})
})
