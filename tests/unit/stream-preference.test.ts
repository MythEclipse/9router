/**
 * Every protocol that carries an explicit `stream` field defaults it to false —
 * Chat Completions, the Responses API, and the Anthropic Messages API alike.
 * Reading an absent field as "stream" is what put SSE in front of clients that
 * asked for one JSON document; the request still returned 200, so the mismatch
 * surfaced as a broken answer rather than an error.
 *
 * Measured on production before the fix: `POST /v1/chat/completions` with no
 * `stream` against `gemini/gemini-3.5-flash-lite` answered
 * `content-type: text/event-stream`, while the same request against
 * `codebuddy-intl/…` answered `application/json` — two providers, one request,
 * two protocols.
 */
import { describe, expect, it } from "vitest"
import { FORMATS } from "../../apps/web/open-sse/translator/formats.js"
import { prefersStreaming } from "../../apps/web/open-sse/utils/streamPreference.js"

const STREAM_FIELD_FORMATS = [FORMATS.CLAUDE, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES]

describe("prefersStreaming", () => {
	it.each(STREAM_FIELD_FORMATS)(
		"treats an absent stream field on %s as non-streaming",
		(sourceFormat) => {
			for (const body of [undefined, {}, { stream: undefined }]) {
				expect(prefersStreaming(sourceFormat, body)).toBe(false)
			}
		},
	)

	it.each(STREAM_FIELD_FORMATS)("honours an explicit stream:true on %s", (sourceFormat) => {
		expect(prefersStreaming(sourceFormat, { stream: true })).toBe(true)
	})

	it.each(STREAM_FIELD_FORMATS)("honours an explicit stream:false on %s", (sourceFormat) => {
		expect(prefersStreaming(sourceFormat, { stream: false })).toBe(false)
	})

	it.each([FORMATS.GEMINI, FORMATS.ANTIGRAVITY])(
		"leaves %s streaming by default, since its stream is an endpoint not a field",
		(sourceFormat) => {
			expect(prefersStreaming(sourceFormat, {})).toBe(true)
			expect(prefersStreaming(sourceFormat, { stream: false })).toBe(false)
		},
	)

	it("survives a null body", () => {
		expect(prefersStreaming(FORMATS.OPENAI, null)).toBe(false)
		expect(prefersStreaming(FORMATS.CLAUDE, null)).toBe(false)
		expect(prefersStreaming(FORMATS.GEMINI, null)).toBe(true)
	})
})
