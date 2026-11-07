/**
 * Kiro never reports token counts: the surfaces that answer (`q`,
 * `codewhisperer`) return only `assistantResponseEvent`, `contextUsageEvent`
 * (a percentage, not tokens) and `meteringEvent` (credits) — no `metadataEvent`
 * and no `metricsEvent`, even with a profile-arn and a tool call. Verified by
 * probing the upstream directly.
 *
 * The executor therefore derives the counts from the request body and marks them
 * `estimated: true`. That marker used to be dropped three times over: when the
 * OpenAI-shaped extractor rebuilt the usage, when kiro-to-claude rebuilt it again
 * for the message_delta, and when normalizeUsage filtered the fields it knew. So
 * 5638 production rows carried an estimate with nothing to say so — and a
 * `cached_tokens: 0` that read as "nothing was cached" rather than "nobody
 * counted".
 */
import { describe, expect, it } from "vitest"
import "../translator/registerAll.js"
import { FORMATS } from "../../apps/web/open-sse/translator/formats.js"
import { initState, translateResponse } from "../../apps/web/open-sse/translator/index.js"
import { extractUsage, normalizeUsage } from "../../apps/web/open-sse/utils/usageTracking.js"

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

const kiroChunk = (estimated: boolean) => ({
	id: "chatcmpl-kiro",
	object: "chat.completion.chunk",
	created: 1,
	model: "claude-sonnet-4.5",
	choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
	usage: {
		prompt_tokens: 118613,
		completion_tokens: 42,
		total_tokens: 118655,
		...(estimated ? { estimated: true } : {}),
	},
})

const throughKiroToClaude = (estimated: boolean) => {
	const state = initState(FORMATS.CLAUDE)
	const events: any[] = []
	const out = translateResponse(FORMATS.KIRO, FORMATS.CLAUDE, kiroChunk(estimated), state)
	if (out) events.push(...(Array.isArray(out) ? out : [out]))
	const delta = events.find((e) => e?.type === "message_delta")
	return { events, delta }
}

describe("the estimate marker on the kiro→claude route", () => {
	it("survives the message_delta the client and the recorder read", () => {
		const { delta } = throughKiroToClaude(true)
		expect(delta?.usage?.estimated).toBe(true)
		expect(delta?.usage?.input_tokens).toBe(118613)
	})

	it("is absent when the counts were real", () => {
		const { delta } = throughKiroToClaude(false)
		expect(delta?.usage?.estimated).toBeUndefined()
	})

	it("survives extractUsage, which is what actually gets stored", () => {
		const { delta } = throughKiroToClaude(true)
		expect((extractUsage(delta) as any)?.estimated).toBe(true)
	})
})
