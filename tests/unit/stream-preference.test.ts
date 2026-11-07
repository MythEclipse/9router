/**
 * The Anthropic Messages API defaults `stream` to false. Reading an absent
 * field as "stream" is what put SSE in front of Claude clients that asked for
 * one JSON document — the request still returned 200, so the mismatch surfaced
 * as a broken answer rather than an error.
 */
import { describe, expect, it } from "vitest"
import { FORMATS } from "../../apps/web/open-sse/translator/formats.js"
import { prefersStreaming } from "../../apps/web/open-sse/utils/streamPreference.js"

describe("prefersStreaming", () => {
	it.each([undefined, {}, { stream: undefined }])(
		"treats an absent stream field on a claude request as non-streaming (%j)",
		(body) => {
			expect(prefersStreaming(FORMATS.CLAUDE, body)).toBe(false)
		},
	)

	it("honours an explicit stream:true from a claude client", () => {
		expect(prefersStreaming(FORMATS.CLAUDE, { stream: true })).toBe(true)
	})

	it("honours an explicit stream:false from a claude client", () => {
		expect(prefersStreaming(FORMATS.CLAUDE, { stream: false })).toBe(false)
	})

	it.each([FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES])(
		"keeps the previous absent-means-stream reading for %s",
		(sourceFormat) => {
			expect(prefersStreaming(sourceFormat, {})).toBe(true)
			expect(prefersStreaming(sourceFormat, { stream: false })).toBe(false)
			expect(prefersStreaming(sourceFormat, { stream: true })).toBe(true)
		},
	)

	it("survives a null body", () => {
		expect(prefersStreaming(FORMATS.OPENAI, null)).toBe(true)
		expect(prefersStreaming(FORMATS.CLAUDE, null)).toBe(false)
	})
})
