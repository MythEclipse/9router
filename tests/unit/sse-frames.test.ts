import { describe, expect, it } from "vitest"
import { DEFAULT_FRAME_EVENT, parseFrame, ServerSentFrameReader } from "@/shared/utils/sseFrames"

/**
 * The install-progress stream is consumed while the body is still arriving, so the
 * reader must survive chunk boundaries that split a frame, a frame with no
 * trailing blank line, and malformed frames. Each of those was a real failure mode
 * of the inline hand-rolled parser this replaces.
 */
describe("parseFrame", () => {
	it("reads event and data", () => {
		expect(parseFrame('event: done\ndata: {"ok":true}')).toEqual({
			event: "done",
			data: { ok: true },
		})
	})

	it("defaults the event name when the frame carries none", () => {
		expect(parseFrame('data: {"message":"step"}')).toEqual({
			event: DEFAULT_FRAME_EVENT,
			data: { message: "step" },
		})
	})

	it("returns null data for a keep-alive or comment frame", () => {
		expect(parseFrame(": ping")).toEqual({ event: DEFAULT_FRAME_EVENT, data: null })
		expect(parseFrame("")).toEqual({ event: DEFAULT_FRAME_EVENT, data: null })
	})

	it("returns null data when the payload is not valid JSON", () => {
		expect(parseFrame("event: error\ndata: {oops")).toEqual({ event: "error", data: null })
	})

	it("returns null data when the payload is valid JSON but not an object", () => {
		expect(parseFrame("event: done\ndata: 42")).toEqual({ event: "done", data: null })
		expect(parseFrame('event: done\ndata: "text"')).toEqual({ event: "done", data: null })
		expect(parseFrame("event: done\ndata: null")).toEqual({ event: "done", data: null })
	})

	it("keeps the last data line when a frame repeats the field", () => {
		expect(parseFrame('data: {"a":1}\ndata: {"b":2}')).toEqual({
			event: DEFAULT_FRAME_EVENT,
			data: { b: 2 },
		})
	})

	it("ignores a field whose prefix only looks like data", () => {
		expect(parseFrame('database: {"a":1}')).toEqual({ event: DEFAULT_FRAME_EVENT, data: null })
	})
})

describe("ServerSentFrameReader", () => {
	it("emits frames only once their terminating blank line arrives", () => {
		const reader = new ServerSentFrameReader()
		expect(reader.push('event: progress\ndata: {"message":"a"}')).toEqual([])
		expect(reader.push("\n")).toEqual([])
		expect(reader.push("\n")).toEqual([{ event: "progress", data: { message: "a" } }])
	})

	it("reassembles a frame split across chunks at an arbitrary byte", () => {
		const reader = new ServerSentFrameReader()
		const frames = [
			...reader.push('event: progress\ndata: {"mess'),
			...reader.push('age":"half"}\n\n'),
		]
		expect(frames).toEqual([{ event: "progress", data: { message: "half" } }])
	})

	it("emits several frames delivered in one chunk, in order", () => {
		const reader = new ServerSentFrameReader()
		const frames = reader.push(
			'event: progress\ndata: {"message":"one"}\n\n' +
				'event: progress\ndata: {"message":"two"}\n\n' +
				'event: done\ndata: {"ok":true}\n\n',
		)
		expect(frames.map((f) => f.event)).toEqual(["progress", "progress", "done"])
		expect(frames.map((f) => f.data?.message ?? null)).toEqual(["one", "two", null])
	})

	it("keeps the incomplete tail and completes it on the next chunk", () => {
		const reader = new ServerSentFrameReader()
		const first = reader.push(
			'event: progress\ndata: {"message":"one"}\n\nevent: progress\ndata: {"mes',
		)
		expect(first).toHaveLength(1)
		const second = reader.push('sage":"two"}\n\n')
		expect(second).toEqual([{ event: "progress", data: { message: "two" } }])
	})

	it("drops nothing when flush is called on a complete stream", () => {
		const reader = new ServerSentFrameReader()
		reader.push('event: done\ndata: {"ok":true}\n\n')
		expect(reader.flush()).toEqual([])
	})

	it("drains a final frame that arrived without its blank line", () => {
		const reader = new ServerSentFrameReader()
		reader.push('event: done\ndata: {"ok":true}')
		expect(reader.flush()).toEqual([{ event: "done", data: { ok: true } }])
	})

	it("is idempotent on flush", () => {
		const reader = new ServerSentFrameReader()
		reader.push('event: done\ndata: {"ok":true}')
		expect(reader.flush()).toHaveLength(1)
		expect(reader.flush()).toEqual([])
	})
})

describe("agrees with the inline parser it replaces", () => {
	/**
	 * The handler this replaces accumulated a string, split on the blank line and
	 * walked the lines with the same prefix rules. Every case below is a stream the
	 * old loop had to handle, asserted to produce the same events and payloads.
	 */
	function legacyParseStream(chunks: string[]) {
		const out: Array<{ event: string; data: any }> = []
		let buffer = ""
		for (const chunk of chunks) {
			buffer += chunk
			const parts = buffer.split("\n\n")
			buffer = parts.pop() || ""
			for (const part of parts) {
				const lines = part.split("\n")
				let event = "progress"
				let data = null
				for (const line of lines) {
					if (line.startsWith("event: ")) event = line.slice(7).trim()
					if (line.startsWith("data: ")) {
						try {
							data = JSON.parse(line.slice(6))
						} catch {
							/* skip */
						}
					}
				}
				if (!data) continue
				out.push({ event, data })
			}
		}
		return out
	}

	const STREAMS: Array<[string, string[]]> = [
		["single frame", ['event: progress\ndata: {"message":"a"}\n\n']],
		["many frames one chunk", ['event: progress\ndata: {"m":1}\n\nevent: done\ndata: {"m":2}\n\n']],
		["frame split mid-json", ['event: done\ndata: {"m":', "2}\n\n"]],
		["frame split before blank line", ['event: done\ndata: {"m":2}', "\n\n"]],
		["keep-alive mixed in", [': ping\n\nevent: progress\ndata: {"m":1}\n\n']],
		["malformed json skipped", ['event: error\ndata: {broken\n\nevent: progress\ndata: {"m":1}\n\n']],
		["empty error payload skipped", ["event: error\ndata: {}\n\n"]],
		["no data frame skipped", ["event: done\n\n"]],
	]

	for (const [label, chunks] of STREAMS) {
		it(label, () => {
			const reader = new ServerSentFrameReader()
			const frames = chunks.flatMap((c) => reader.push(c)).filter((f) => f.data)
			expect(frames).toEqual(legacyParseStream(chunks))
		})
	}
})
