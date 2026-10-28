import { describe, expect, it } from "vitest"
import { makeBulkEditApiKeys } from "../../apps/api/src/application/api-keys/bulk-edit-api-keys.ts"
import {
	MAX_BULK_KEYS,
	mayBulkEdit,
	parseBulkPatch,
	parseBulkSelection,
	splitSelection,
} from "../../apps/api/src/domain/bulk-key-edit.ts"

describe("parseBulkPatch", () => {
	it("accepts every whitelisted field", () => {
		const result = parseBulkPatch({ tokenLimit: 10, isActive: false })
		expect(result).toEqual({ ok: true, patch: { tokenLimit: 10, isActive: false } })
	})

	it("refuses a field outside the whitelist, by name", () => {
		const result = parseBulkPatch({ tokenLimit: 1, permissions: {} })
		expect(result).toEqual({
			ok: false,
			error: 'Field "permissions" cannot be changed in bulk',
		})
	})

	it("refuses the secret and the key material explicitly", () => {
		for (const field of ["key", "keyHash"]) {
			const result = parseBulkPatch({ [field]: "x" })
			expect(!result.ok && result.error).toContain(field)
		}
	})

	it("refuses an empty patch", () => {
		expect(parseBulkPatch({})).toEqual({ ok: false, error: "No editable fields given" })
	})

	it("rejects a non-object patch instead of throwing", () => {
		for (const bad of [null, undefined, "nope", 42, ["a"]]) {
			const result = parseBulkPatch(bad)
			expect(result.ok).toBe(false)
		}
	})
})

describe("parseBulkSelection", () => {
	it("keeps the caller's order", () => {
		const result = parseBulkSelection(["c", "a", "b"])
		expect(result.ok && result.ids).toEqual(["c", "a", "b"])
	})

	it("removes duplicates", () => {
		const result = parseBulkSelection(["a", "a", "b"])
		expect(result.ok && result.ids).toEqual(["a", "b"])
	})

	it("refuses an empty selection", () => {
		expect(parseBulkSelection([])).toEqual({ ok: false, error: "No keys selected" })
		expect(parseBulkSelection(null)).toEqual({ ok: false, error: "No keys selected" })
	})

	it("drops empty ids rather than selecting them", () => {
		expect(parseBulkSelection(["", "a"])).toMatchObject({ ok: true, ids: ["a"] })
	})

	it("accepts exactly the cap and refuses one more", () => {
		const atCap = Array.from({ length: MAX_BULK_KEYS }, (_, i) => `k${i}`)
		expect(parseBulkSelection(atCap).ok).toBe(true)

		const overCap = [...atCap, "one-more"]
		const result = parseBulkSelection(overCap)
		expect(result).toEqual({
			ok: false,
			error: `Select at most ${MAX_BULK_KEYS} keys at once`,
		})
	})

	it("counts the cap after de-duplication", () => {
		const doubled = Array.from({ length: MAX_BULK_KEYS }, (_, i) => `k${i}`)
		expect(parseBulkSelection([...doubled, ...doubled]).ok).toBe(true)
	})
})

describe("mayBulkEdit", () => {
	it("refuses a key session", () => {
		expect(mayBulkEdit("apikey")).toBe(false)
	})

	it("allows a password session", () => {
		expect(mayBulkEdit("admin")).toBe(true)
	})
})

describe("splitSelection", () => {
	it("separates what exists from what does not", () => {
		const result = splitSelection(["a", "gone"], new Set(["a"]))
		expect(result).toEqual({ targets: ["a"], missing: ["gone"] })
	})
})

function harness(existing: readonly string[]) {
	const live = new Set(existing)
	const audit: unknown[] = []
	let throwOn: string | null = null

	const useCases = makeBulkEditApiKeys({
		keys: {
			async listIds() {
				return [...live]
			},
			async update(id, patch) {
				if (id === throwOn) throw new Error("disk full")
				if (!live.has(id)) return false
				audit.push({ updated: id, patch })
				return true
			},
		},
		audit: {
			async recordBulkUpdate(event) {
				audit.push(event)
			},
		},
	})

	return {
		useCases,
		audit,
		remove: (id: string) => live.delete(id),
		failOn: (id: string) => {
			throwOn = id
		},
	}
}

const passwordCaller = { role: "admin" }

describe("bulk update use-case", () => {
	it("refuses a key session with a forbidden", async () => {
		const h = harness(["a"])
		await expect(
			h.useCases.update({ ids: ["a"], patch: { tokenLimit: 1 } }, { role: "apikey" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" })
	})

	it("rejects a malformed patch as a validation error, not a crash", async () => {
		const h = harness(["a"])
		await expect(
			h.useCases.update({ ids: ["a"], patch: null }, passwordCaller),
		).rejects.toMatchObject({ code: "VALIDATION" })
	})

	it("updates every selected key", async () => {
		const h = harness(["a", "b"])
		const result = await h.useCases.update(
			{ ids: ["a", "b"], patch: { tokenLimit: 5 } },
			passwordCaller,
		)
		expect(result.updated).toEqual(["a", "b"])
		expect(result.missing).toEqual([])
		expect(result.failed).toEqual([])
	})

	it("reports a key that vanished as missing, not failed", async () => {
		const h = harness(["a", "b"])
		h.remove("b")
		const result = await h.useCases.update(
			{ ids: ["a", "b"], patch: { tokenLimit: 5 } },
			passwordCaller,
		)
		expect(result).toEqual({ updated: ["a"], missing: ["b"], failed: [] })
	})

	it("keeps the rest when one write throws", async () => {
		const h = harness(["a", "b", "c"])
		h.failOn("b")
		const result = await h.useCases.update(
			{ ids: ["a", "b", "c"], patch: { tokenLimit: 5 } },
			passwordCaller,
		)
		expect(result.updated).toEqual(["a", "c"])
		expect(result.failed).toEqual([{ id: "b", error: "disk full" }])
	})

	it("audits once with the field names, not once per key", async () => {
		const h = harness(["a", "b"])
		h.audit.length = 0
		await h.useCases.update(
			{ ids: ["a", "b"], patch: { tokenLimit: 5, isActive: false } },
			passwordCaller,
		)
		const entries = h.audit.filter((e) => "updatedCount" in (e as object))
		expect(entries).toEqual([{ updatedCount: 2, fields: ["tokenLimit", "isActive"] }])
	})

	it("writes no audit entry when nothing changed", async () => {
		const h = harness(["a"])
		h.audit.length = 0
		await h.useCases.update({ ids: ["gone"], patch: { tokenLimit: 5 } }, passwordCaller)
		expect(h.audit.filter((e) => "updatedCount" in (e as object))).toHaveLength(0)
	})
})
