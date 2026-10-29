import { describe, expect, test } from "vitest"
import {
	planQuotaNotices,
	QUOTA_KINDS,
	QUOTA_LEVELS,
	quotaDedupeKey,
	staleQuotaKeys,
} from "../../apps/api/src/domain/notification-scan"

const warn = { kind: "tokens", level: "warning" }
const crit = { kind: "tokens", level: "critical" }

describe("quotaDedupeKey", () => {
	test("names the condition, so a notice is written once per (key, kind, level)", () => {
		expect(quotaDedupeKey("k1", "tokens", "warning")).toBe("quota:k1:tokens:warning")
	})

	test("tolerates missing parts rather than writing 'undefined'", () => {
		expect(quotaDedupeKey("k1", undefined, undefined)).toBe("quota:k1::")
		expect(quotaDedupeKey(null, "cost", "critical")).toBe("quota::cost:critical")
	})
})

describe("planQuotaNotices", () => {
	test("a critical condition is an error, a warning stays a warning", () => {
		const { notices } = planQuotaNotices([{ id: "k1" }, { id: "k2" }], (key) =>
			key.id === "k1" ? crit : warn,
		)
		expect(notices).toEqual([
			{ keyId: "k1", dedupeKey: "quota:k1:tokens:critical", severity: "error", level: "critical" },
			{ keyId: "k2", dedupeKey: "quota:k2:tokens:warning", severity: "warning", level: "warning" },
		])
	})

	test("a key with no pressure raises nothing and is not live", () => {
		// This is the recovery path: no notice means the sweep retires the old one.
		const { notices, live } = planQuotaNotices([{ id: "k1" }], () => null)
		expect(notices).toEqual([])
		expect(live.size).toBe(0)
	})

	test("keys without an id are skipped, not keyed by 'undefined'", () => {
		const { notices, live } = planQuotaNotices([{}, { id: "" }, { id: "k1" }], () => warn)
		expect(notices.map((n) => n.keyId)).toEqual(["k1"])
		expect([...live]).toEqual(["quota:k1:tokens:warning"])
	})

	test("tolerates a missing key list", () => {
		expect(planQuotaNotices(null, () => warn).notices).toEqual([])
		expect(planQuotaNotices(undefined, () => warn).live.size).toBe(0)
	})

	test("an unrecognised level is treated as a warning, not silently dropped", () => {
		const { notices } = planQuotaNotices([{ id: "k1" }], () => ({ kind: "cost", level: "somber" }))
		expect(notices[0]).toMatchObject({ level: "warning", severity: "warning" })
	})
})

describe("staleQuotaKeys", () => {
	test("retires every condition the pass did not raise", () => {
		const stale = staleQuotaKeys([{ id: "k1" }], new Set(["quota:k1:tokens:warning"]))
		const all = QUOTA_KINDS.flatMap((kind) =>
			QUOTA_LEVELS.map((level) => `quota:k1:${kind}:${level}`),
		)
		expect(stale.sort()).toEqual(all.filter((key) => key !== "quota:k1:tokens:warning").sort())
	})

	test("a recovered key retires its notice", () => {
		// Under budget, the key produces no live entry, so the warning must go.
		expect(staleQuotaKeys([{ id: "k1" }], new Set())).toContain("quota:k1:tokens:warning")
	})

	test("switching budget kind retires the old kind's notice", () => {
		// tokens → cost: the tokens advice is now about a budget that no longer exists.
		const stale = staleQuotaKeys([{ id: "k1" }], new Set(["quota:k1:cost:warning"]))
		expect(stale).toContain("quota:k1:tokens:warning")
		expect(stale).not.toContain("quota:k1:cost:warning")
	})

	test("escalating to critical retires the warning", () => {
		const stale = staleQuotaKeys([{ id: "k1" }], new Set(["quota:k1:tokens:critical"]))
		expect(stale).toContain("quota:k1:tokens:warning")
	})

	test("nothing is retired for a key that is gone", () => {
		// A deleted key has no rows to sweep, and inventing its keys would query for nothing.
		expect(staleQuotaKeys([], new Set(["quota:k1:tokens:warning"]))).toEqual([])
	})

	test("keys without an id are skipped", () => {
		expect(staleQuotaKeys([{}, { id: "" }], new Set())).toEqual([])
	})
})
