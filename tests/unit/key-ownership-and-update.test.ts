import { describe, expect, it } from "vitest"
import type { ApiKeyView } from "../../apps/api/src/application/api-keys/manage-api-keys-dashboard.ts"
import { makeManageSingleKey } from "../../apps/api/src/application/api-keys/manage-single-key.ts"
import { mayReadKey, mayWriteKey } from "../../apps/api/src/domain/key-ownership.ts"
import { buildKeyUpdate } from "../../apps/api/src/domain/key-update.ts"

const ENDPOINT_KINDS = ["chat", "responses", "models", "embeddings", "images", "audio"]

function matches(patterns: readonly string[], model: string): boolean {
	const req = model.trim().toLowerCase()
	return patterns.some((allowed) => {
		if (allowed === "*" || allowed === req) return true
		if (allowed.endsWith("*")) return req.startsWith(allowed.slice(0, -1))
		if (allowed.startsWith("*")) return req.endsWith(allowed.slice(1))
		return false
	})
}

const row = (over: Partial<{ key: string; createdBy: string }> = {}) => ({
	key: "sk-mine",
	createdBy: "",
	...over,
})

describe("mayReadKey", () => {
	it("reports a missing key as not found", () => {
		const v = mayReadKey(null, { role: "admin" })
		expect(v).toMatchObject({ allowed: false, reason: "not_found" })
	})

	it("lets a password session read any key", () => {
		expect(mayReadKey(row(), { role: "admin" })).toEqual({ allowed: true })
	})

	it("lets a key session read itself", () => {
		expect(mayReadKey(row(), { role: "apikey", apiKey: "sk-mine" })).toEqual({
			allowed: true,
		})
	})

	it("hides another key from a key session, as not-found rather than forbidden", () => {
		const v = mayReadKey(row(), { role: "apikey", apiKey: "sk-other" })
		expect(v).toMatchObject({ allowed: false, reason: "not_found" })
	})
})

describe("mayWriteKey", () => {
	it("refuses a key session without manageApiKeys before looking at the row", () => {
		const v = mayWriteKey(
			null,
			{
				role: "apikey",
				apiKey: "sk-mine",
				permissions: { manageApiKeys: false },
			},
			"edit",
		)
		expect(v).toMatchObject({
			allowed: false,
			reason: "forbidden",
			message: "Permission denied: manageApiKeys",
		})
	})

	it("reports a missing row as not found for a permitted caller", () => {
		const v = mayWriteKey(
			null,
			{
				role: "apikey",
				apiKey: "sk-mine",
				permissions: { manageApiKeys: true },
			},
			"edit",
		)
		expect(v).toMatchObject({ allowed: false, reason: "not_found" })
	})

	it("refuses managing the credential you are holding", () => {
		const caller = {
			role: "apikey",
			apiKey: "sk-mine",
			permissions: { manageApiKeys: true },
		}
		expect(mayWriteKey(row(), caller, "edit")).toMatchObject({
			allowed: false,
			message: "Cannot manage your own API key",
		})
		expect(mayWriteKey(row(), caller, "delete")).toMatchObject({
			allowed: false,
			message: "Cannot manage your own API key",
		})
	})

	it("refuses another creator's key, naming the action", () => {
		const caller = {
			role: "apikey",
			apiKey: "sk-mine",
			permissions: { manageApiKeys: true },
		}
		const other = row({ key: "sk-child", createdBy: "sk-someone-else" })
		expect(mayWriteKey(other, caller, "edit")).toMatchObject({
			message: "Permission denied: cannot edit other keys",
		})
		expect(mayWriteKey(other, caller, "delete")).toMatchObject({
			message: "Permission denied: cannot delete other keys",
		})
	})

	it("allows editing a key the caller created", () => {
		const caller = {
			role: "apikey",
			apiKey: "sk-mine",
			permissions: { manageApiKeys: true },
		}
		expect(mayWriteKey(row({ key: "sk-child", createdBy: "sk-mine" }), caller, "edit")).toEqual({
			allowed: true,
		})
	})

	it("lets a password session through without a permission", () => {
		expect(mayWriteKey(row(), { role: "admin" }, "delete")).toEqual({ allowed: true })
	})
})

describe("buildKeyUpdate", () => {
	const base = {
		otherNames: [],
		id: "k1",
		creatorScope: null,
		endpointKinds: ENDPOINT_KINDS,
		matchesAllowedModels: matches,
		defaultPermissions: { viewUsage: true, manageApiKeys: false },
	}

	it("builds an empty patch from an empty body", () => {
		expect(buildKeyUpdate({ ...base, body: {} })).toEqual({ ok: true, patch: {} })
	})

	it("clears a field that was sent empty rather than ignoring it", () => {
		const result = buildKeyUpdate({
			...base,
			body: { systemPrompt: "", expiresAt: null },
		})
		expect(result).toMatchObject({
			ok: true,
			patch: { systemPrompt: "", expiresAt: null },
		})
	})

	it("refuses an empty name", () => {
		expect(buildKeyUpdate({ ...base, body: { name: "  " } })).toMatchObject({
			ok: false,
			error: { field: "name", message: "Name is required" },
		})
	})

	it("refuses a name another key already has", () => {
		const result = buildKeyUpdate({
			...base,
			body: { name: "taken" },
			otherNames: [{ id: "k2", name: "taken" }],
		})
		expect(result).toMatchObject({
			ok: false,
			error: { field: "name" },
		})
	})

	it("allows keeping your own name", () => {
		const result = buildKeyUpdate({
			...base,
			body: { name: "taken" },
			otherNames: [{ id: "k1", name: "taken" }],
		})
		expect(result).toMatchObject({ ok: true, patch: { name: "taken" } })
	})

	it("refuses an unknown endpoint kind", () => {
		const result = buildKeyUpdate({ ...base, body: { allowedEndpoints: ["cht"] } })
		expect(result).toMatchObject({ ok: false, error: { field: "allowedEndpoints" } })
	})

	it("de-duplicates endpoint kinds", () => {
		const result = buildKeyUpdate({
			...base,
			body: { allowedEndpoints: ["chat", "chat", "models"] },
		})
		expect(result).toMatchObject({ ok: true, patch: { allowedEndpoints: ["chat", "models"] } })
	})

	it("falls back to the tokens limit kind for an unknown one", () => {
		expect(buildKeyUpdate({ ...base, body: { limitKind: "nope" } })).toMatchObject({
			ok: true,
			patch: { limitKind: "tokens" },
		})
	})

	it("coerces numeric fields and keeps junk at zero", () => {
		const result = buildKeyUpdate({
			...base,
			body: { rpmLimit: "5", tpmLimit: "abc", requestLimit: null },
		})
		expect(result).toMatchObject({
			ok: true,
			patch: { rpmLimit: 5, tpmLimit: 0, requestLimit: 0 },
		})
	})

	it("refuses a token limit above a key session's cap", () => {
		const result = buildKeyUpdate({
			...base,
			creatorScope: { tokenLimit: 100 },
			body: { tokenLimit: 500 },
		})
		expect(result).toMatchObject({
			ok: false,
			error: {
				field: "tokenLimit",
				message: "Token limit cannot exceed your maximum (100).",
			},
		})
	})

	it("refuses a cost limit above a key session's cap", () => {
		const result = buildKeyUpdate({
			...base,
			creatorScope: { dailyCostLimit: 10 },
			body: { dailyCostLimit: 50 },
		})
		expect(result).toMatchObject({
			ok: false,
			error: {
				field: "dailyCostLimit",
				message: "Daily cost limit cannot exceed your maximum ($10).",
			},
		})
	})

	it("clamps models to the creator's scope for a key session", () => {
		const result = buildKeyUpdate({
			...base,
			creatorScope: { allowedModels: "gpt-4o" },
			body: { allowedModels: "*" },
		})
		expect(result).toMatchObject({ ok: true, patch: { allowedModels: "gpt-4o" } })
	})

	it("leaves models alone for a password session", () => {
		expect(buildKeyUpdate({ ...base, body: { allowedModels: "anything" } })).toMatchObject({
			ok: true,
			patch: { allowedModels: "anything" },
		})
	})

	it("forces a key session's permissions to the default", () => {
		const result = buildKeyUpdate({
			...base,
			creatorScope: {},
			body: { permissions: { viewUsage: true, manageApiKeys: true } },
		})
		expect(result).toMatchObject({
			ok: true,
			patch: { permissions: { viewUsage: true, manageApiKeys: false } },
		})
	})

	it("honours a password session's permissions", () => {
		const asked = { viewUsage: true, manageApiKeys: true }
		expect(buildKeyUpdate({ ...base, body: { permissions: asked } })).toMatchObject({
			ok: true,
			patch: { permissions: asked },
		})
	})
})

function harness(rows: ApiKeyView[]) {
	const live = new Map(rows.map((r) => [r.id, r]))
	const audits: unknown[] = []
	const useCases = makeManageSingleKey({
		keys: {
			async findById(id) {
				return live.get(id) ?? null
			},
			async list() {
				return [...live.values()]
			},
			async update(id, patch) {
				const row = live.get(id)
				if (!row) return null
				const next = { ...row, ...patch } as ApiKeyView
				live.set(id, next)
				return next
			},
			async remove(id) {
				return live.delete(id)
			},
		},
		audit: {
			async recordKeyDeleted(e) {
				audits.push(e)
			},
		},
		endpointKinds: ENDPOINT_KINDS,
		matchesAllowedModels: matches,
		defaultPermissions: { viewUsage: true, manageApiKeys: false },
	})
	return { useCases, audits }
}

function keyRow(over: Partial<ApiKeyView> = {}): ApiKeyView {
	return {
		id: "k1",
		name: "mine",
		key: "sk-mine",
		machineId: "m",
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
		...over,
	}
}

const admin = {
	role: "admin",
	scope: {},
	permissions: { viewUsage: true, manageApiKeys: true },
}

describe("single-key use-case", () => {
	it("404s a missing key", async () => {
		const h = harness([])
		await expect(h.useCases.get("nope", admin)).rejects.toMatchObject({
			code: "NOT_FOUND",
		})
	})

	it("404s another key for a key session", async () => {
		const h = harness([keyRow({ id: "k2", key: "sk-other" })])
		await expect(
			h.useCases.get("k2", { ...admin, role: "apikey", apiKey: "sk-mine" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" })
	})

	it("deletes and records who did it", async () => {
		const h = harness([keyRow()])
		await h.useCases.remove("k1", admin)
		expect(h.audits).toEqual([{ actor: "Password user", keyName: "mine" }])
	})

	it("still deletes when the audit write fails", async () => {
		const h = harness([keyRow()])
		const useCases = makeManageSingleKey({
			keys: {
				async findById() {
					return keyRow()
				},
				async list() {
					return [keyRow()]
				},
				async update() {
					return null
				},
				async remove() {
					return true
				},
			},
			audit: {
				async recordKeyDeleted() {
					throw new Error("audit down")
				},
			},
			endpointKinds: ENDPOINT_KINDS,
			matchesAllowedModels: matches,
			defaultPermissions: null,
		})
		await expect(useCases.remove("k1", admin)).resolves.toBeUndefined()
	})

	it("applies an edit", async () => {
		const h = harness([keyRow()])
		const updated = await h.useCases.update("k1", { tokenLimit: 5 }, admin)
		expect(updated.tokenLimit).toBe(5)
	})

	it("refuses a duplicate name as a conflict", async () => {
		const h = harness([keyRow(), keyRow({ id: "k2", name: "taken", key: "sk-2" })])
		await expect(h.useCases.update("k1", { name: "taken" }, admin)).rejects.toMatchObject({
			code: "CONFLICT",
		})
	})
})
