/**
 * Kiro never reports token counts: the surfaces that answer (`q`,
 * `codewhisperer`) return only `assistantResponseEvent`, `contextUsageEvent`
 * (a percentage, not tokens) and `meteringEvent` (credits) — no `metadataEvent`,
 * so no `tokenUsage`, so no `cacheReadInputTokens`. Verified by probing the
 * upstream directly, with and without a profile-arn header.
 *
 * The executor therefore derives `prompt_tokens` from the request body and marks
 * it `estimated: true`. That marker used to be dropped when the usage was rebuilt
 * for storage, so 5638 production rows carried an estimate with no indication it
 * was one — and a `cached_tokens: 0` that reads as "nothing was cached" rather
 * than "nobody counted".
 */
import { describe, expect, it } from "vitest"
import { normalizeUsage } from "../../apps/web/open-sse/utils/usageTracking.js"

const norm = (usage: any) => normalizeUsage(usage) as any

describe("normalizeUsage", () => {
	it("keeps the estimated marker", () => {
		const out = norm({ prompt_tokens: 1200, completion_tokens: 40, estimated: true })
		expect(out.estimated).toBe(true)
	})

	it("does not invent the marker when the counts were measured", () => {
		const out = norm({ prompt_tokens: 1200, completion_tokens: 40 })
		expect(out.estimated).toBeUndefined()
	})

	it("still normalises the token fields around it", () => {
		const out = norm({
			prompt_tokens: "1200",
			completion_tokens: 40,
			cached_tokens: 1100,
			estimated: true,
		})
		expect(out.prompt_tokens).toBe(1200)
		expect(out.cached_tokens).toBe(1100)
		expect(out.estimated).toBe(true)
	})
})
