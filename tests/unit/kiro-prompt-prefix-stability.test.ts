/**
 * Kiro caches the head of the prompt implicitly — measured on the upstream: the
 * same conversation sent twice costs 0.0385461 then 0.0206178 credits, 47% less.
 * That only works while the head is byte-identical between turns.
 *
 * `contentPrefix` is written into the FIRST user turn, and it used to be
 * `systemPrompt + "[Context: Current time is <toISOString()>]"`. A millisecond
 * timestamp at the head of the prompt changes on every request, so no two turns
 * ever shared a prefix and the cache could not hit once: 0% over 5595 requests
 * in production, against 96% for opencode and 94.8% for codebuddy.
 *
 * The clock now rides on the current message instead, which only moves the tail.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import "../translator/registerAll.js"
import { FORMATS } from "../../apps/web/open-sse/translator/formats.js"
import { translateRequest } from "../../apps/web/open-sse/translator/index.js"

const SYSTEM = "You are a careful assistant working in a large repository."

const body = () => ({
	system: SYSTEM,
	messages: [
		{ role: "user", content: "Read the config file." },
		{ role: "assistant", content: "Here it is: port = 4014." },
		{ role: "user", content: "Now change the port to 8080." },
	],
})

const build = () =>
	// translateRequest's provider parameter is typed `null` in the engine; the
	// value is what selects the kiro-specific request path.
	(translateRequest as any)(
		FORMATS.CLAUDE,
		FORMATS.KIRO,
		"claude-sonnet-4.5",
		body(),
		true,
		null,
		"kiro",
	)

const headOf = (payload: any) =>
	payload?.conversationState?.history?.[0]?.userInputMessage?.content ?? ""

const currentOf = (payload: any) =>
	payload?.conversationState?.currentMessage?.userInputMessage?.content ?? ""

afterEach(() => {
	vi.useRealTimers()
})

describe("the Kiro prompt prefix", () => {
	it("is identical across turns even when the clock moves", () => {
		vi.useFakeTimers()

		vi.setSystemTime(new Date("2026-11-07T10:00:00.000Z"))
		const first = build()

		vi.setSystemTime(new Date("2026-11-07T10:07:31.482Z"))
		const second = build()

		expect(headOf(first)).toContain(SYSTEM)
		expect(headOf(second)).toBe(headOf(first))
	})

	it("still tells the model the time, on the turn being asked", () => {
		vi.useFakeTimers()

		vi.setSystemTime(new Date("2026-11-07T10:00:00.000Z"))
		const first = build()

		vi.setSystemTime(new Date("2026-11-07T10:07:31.482Z"))
		const second = build()

		expect(currentOf(first)).toContain("[Context: Current time is 2026-11-07T10:00:00.000Z]")
		expect(currentOf(second)).toContain("[Context: Current time is 2026-11-07T10:07:31.482Z]")
	})

	it("never puts the timestamp in the head of the conversation", () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-11-07T10:00:00.000Z"))

		expect(headOf(build())).not.toContain("[Context: Current time")
	})

	it("keeps the system prompt in the head, which is what has to be stable", () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-11-07T10:00:00.000Z"))

		// The CodeWhisperer surface rejects a top-level systemPrompt, so the system
		// text has no home other than the first user turn.
		expect(headOf(build())).toContain(SYSTEM)
	})
})
