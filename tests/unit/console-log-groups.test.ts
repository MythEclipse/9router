import { describe, expect, it } from "vitest"
import {
	countLines,
	detectLevel,
	groupLogs,
	normalizeProviderId,
	parseLogLine,
	SYSTEM_GROUP_ID,
} from "../../apps/web/src/shared/utils/consoleLogGroups.js"

// The console page buckets lines per provider so a failing model is not buried
// in a wall of text. These cases pin the two head shapes the logger actually
// emits, plus the noise that must never be mistaken for a provider.

const PIPE_LINE =
	"[16:05:16] ℹ️  [PROXY] OPENCODE | deepseek-v4.1-flash-free | conn=vercel-relay | pool=c2f04a7d | type=vercel"
const SLASH_LINE = "[16:05:18] 🟣 ✗ ERROR 429 · opencode/deepseek-v4.1-flash-free · 2133ms"
const AUTH_LINE = "[16:05:20] ℹ️  [AUTH] Using gemini account: foo@bar.com"
const STACK_LINE = "    at Object.<anonymous> (/app/x.js:1:1)"
const BANNER_LINE = "▲ Next.js 16.4.3"

describe("parseLogLine", () => {
	it("reads the pipe form the PROXY/REQUEST tags print", () => {
		const parsed = parseLogLine(PIPE_LINE)

		expect(parsed.provider).toBe("opencode")
		expect(parsed.model).toBe("deepseek-v4.1-flash-free")
		expect(parsed.tag).toBe("PROXY")
		expect(parsed.time).toBe("16:05:16")
	})

	it("reads the slash form the error lines print", () => {
		const parsed = parseLogLine(SLASH_LINE)

		expect(parsed.provider).toBe("opencode")
		expect(parsed.model).toBe("deepseek-v4.1-flash-free")
		expect(parsed.level).toBe("error")
	})

	it("resolves both head shapes to the same group id", () => {
		expect(parseLogLine(PIPE_LINE).provider).toBe(parseLogLine(SLASH_LINE).provider)
		expect(parseLogLine(PIPE_LINE).model).toBe(parseLogLine(SLASH_LINE).model)
	})

	it("finds the slash form mid-sentence", () => {
		const parsed = parseLogLine(
			"[16:05:25] ⚠️  [FALLBACK] ⏱ fallback budget spent for opencode/big-pickle after 2 proxy pools",
		)

		expect(parsed.provider).toBe("opencode")
		expect(parsed.model).toBe("big-pickle")
	})

	it("does not mistake a stack frame for a provider", () => {
		expect(parseLogLine(STACK_LINE).provider).toBeNull()
	})

	it("does not mistake a banner for a provider", () => {
		expect(parseLogLine(BANNER_LINE).provider).toBeNull()
	})

	it("leaves non-request lines unassigned but keeps their text", () => {
		const parsed = parseLogLine(AUTH_LINE)

		expect(parsed.provider).toBeNull()
		expect(parsed.tag).toBe("AUTH")
		expect(parsed.text).toBe(AUTH_LINE)
	})
})

describe("detectLevel", () => {
	it("reads the logger glyphs", () => {
		expect(detectLevel(SLASH_LINE)).toBe("error")
		expect(detectLevel("[16:00:00] ⚠️  [CHAT] quota")).toBe("warn")
		expect(detectLevel("[16:00:00] ℹ️  [AUTH] ok")).toBe("info")
		expect(detectLevel("[16:00:00] 🔍 [REQUEST] x")).toBe("debug")
		expect(detectLevel("[16:00:00] ✓ done")).toBe("success")
		expect(detectLevel(BANNER_LINE)).toBe("plain")
	})
})

describe("normalizeProviderId", () => {
	it("folds case so OPENCODE and opencode share one group", () => {
		expect(normalizeProviderId("OPENCODE")).toBe(normalizeProviderId("opencode"))
	})
})

describe("groupLogs", () => {
	const lines = [PIPE_LINE, SLASH_LINE, AUTH_LINE, STACK_LINE, BANNER_LINE]

	it("buckets request lines per provider+model and keeps every other line", () => {
		const groups = groupLogs(lines)

		const opencode = groups.find((group) => group.provider === "opencode")
		expect(opencode?.lines).toHaveLength(2)
		expect(countLines(groups)).toBe(lines.length)
	})

	it("keeps unparsed lines in the system group rather than dropping them", () => {
		const groups = groupLogs(lines)
		const system = groups.find((group) => group.id === SYSTEM_GROUP_ID)

		expect(system?.lines).toHaveLength(3)
	})

	it("puts request groups before the system group", () => {
		const groups = groupLogs(lines)

		expect(groups[groups.length - 1].id).toBe(SYSTEM_GROUP_ID)
	})

	it("surfaces the worst severity of a group", () => {
		const groups = groupLogs(lines)

		expect(groups.find((group) => group.provider === "opencode")?.level).toBe("error")
	})

	it("uses display names when supplied", () => {
		const groups = groupLogs([PIPE_LINE], { opencode: "OpenCode Free" })

		expect(groups[0].label).toContain("OpenCode Free")
	})

	it("returns nothing for an empty buffer", () => {
		expect(groupLogs([])).toEqual([])
	})
})
