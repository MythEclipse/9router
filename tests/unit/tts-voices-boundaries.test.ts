/**
 * The three TTS voice rules that survive a refactor with no visible symptom.
 *
 * Each one is a failure the picker renders as "no voices", which looks like an empty provider
 * rather than a bug: an unknown provider answered 502 instead of being named, a missing
 * connection answered as an outage, and a MiniMax failure inside a 200 body passed for success.
 * The grouping itself is covered by the domain tests; these are the boundaries around it.
 */
import { describe, expect, test } from "vitest"
import { makeTtsVoices, type TtsVoiceDeps } from "../../apps/api/src/application/tts/tts-voices.ts"
import { AppError } from "../../apps/api/src/domain/errors.ts"

function deps(overrides: Partial<TtsVoiceDeps> = {}): TtsVoiceDeps {
	return {
		connectionOf: async () => ({ apiKey: "key" }),
		fetchVoices: async () => [],
		fetchElevenLabs: async () => [],
		fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch,
		providers: ["edge-tts", "local-device", "elevenlabs", "gemini"],
		...overrides,
	}
}

/** A fetch that answers the given body with the given status, so `res.ok` can be lied to. */
function answerWith(body: string, status = 200): typeof fetch {
	return (async () => new Response(body, { status })) as unknown as typeof fetch
}

function codeOf(error: unknown): string {
	return error instanceof AppError ? error.code : "not-an-AppError"
}

describe("tts voices: an unknown provider is named, not blamed on the upstream", () => {
	test("listing refuses a provider it cannot serve with 400", async () => {
		const voices = makeTtsVoices(deps())
		const error = await voices.listing({ provider: "nope" }).catch((e: unknown) => e)

		expect(codeOf(error)).toBe("VALIDATION")
		expect((error as AppError).status).toBe(400)
		expect((error as AppError).message).toContain("nope")
	})

	test("listing defaults to edge-tts, which needs no connection", async () => {
		const voices = makeTtsVoices(
			deps({
				connectionOf: async () => undefined,
				fetchVoices: async () => [
					{ ShortName: "a", FriendlyName: "A", Locale: "en-US", Gender: "Female" },
				],
			}),
		)

		const answer = (await voices.listing({})) as { voices: { id: string }[] }
		expect(answer.voices.map((v) => v.id)).toEqual(["a"])
	})
})

describe("tts voices: a provider without a connection is the caller's gap, not an outage", () => {
	for (const [name, call] of [
		["deepgram", (v: ReturnType<typeof makeTtsVoices>) => v.deepgram({})],
		["elevenlabs", (v: ReturnType<typeof makeTtsVoices>) => v.elevenlabs({})],
		["inworld", (v: ReturnType<typeof makeTtsVoices>) => v.inworld({})],
		["minimax", (v: ReturnType<typeof makeTtsVoices>) => v.minimax({})],
	] as const) {
		test(`${name} answers 400 before reaching the network`, async () => {
			let called = false
			const voices = makeTtsVoices(
				deps({
					connectionOf: async () => undefined,
					fetchImpl: (async () => {
						called = true
						return new Response("{}")
					}) as unknown as typeof fetch,
				}),
			)

			const error = await call(voices).catch((e: unknown) => e)

			expect(codeOf(error)).toBe("VALIDATION")
			expect((error as AppError).status).toBe(400)
			expect(called).toBe(false)
		})
	}
})

describe("tts voices: MiniMax hides its failure inside a 200 body", () => {
	const minimaxPayload = (baseResp: unknown) =>
		JSON.stringify({ base_resp: baseResp, system_voice: [] })

	test("a non-zero status_code is a 502 even though res.ok is true", async () => {
		const voices = makeTtsVoices(
			deps({ fetchImpl: answerWith(minimaxPayload({ status_code: 1004, status_msg: "bad key" })) }),
		)

		const error = await voices.minimax({}).catch((e: unknown) => e)

		expect(codeOf(error)).toBe("UPSTREAM")
		expect((error as AppError).status).toBe(502)
		expect((error as AppError).message).toContain("bad key")
	})

	test("status_code 0 is a success even when the groups are empty", async () => {
		const voices = makeTtsVoices(deps({ fetchImpl: answerWith(minimaxPayload({ status_code: 0 })) }))

		const answer = (await voices.minimax({})) as { byLang: Record<string, unknown> }
		expect(answer.byLang).toEqual({})
	})

	test("an HTTP failure reports the status, not the body's silence", async () => {
		const voices = makeTtsVoices(deps({ fetchImpl: answerWith("", 503) }))

		const error = await voices.minimax({}).catch((e: unknown) => e)

		expect((error as AppError).status).toBe(502)
		expect((error as AppError).message).toContain("503")
	})
})

describe("tts voices: an upstream refusal keeps the upstream's number", () => {
	test("deepgram answers 502 when the provider refuses", async () => {
		const voices = makeTtsVoices(deps({ fetchImpl: answerWith("denied", 401) }))

		const error = await voices.deepgram({}).catch((e: unknown) => e)

		expect(codeOf(error)).toBe("UPSTREAM")
		expect((error as AppError).message).toContain("401")
	})
})
