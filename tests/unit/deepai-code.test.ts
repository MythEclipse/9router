/**
 * DeepAI Code wire contract (open-sse/shared/deepaiCode.ts) and its registry wiring.
 *
 * Everything here pins behaviour verified against api.deepai.org on 2026-11-14:
 *  - GET /deepai_code/models with no key → 401 auth_required
 *  - the same call with a key but no X-DeepAI-Code-Theos → 426 lane_version_unsupported
 *  - POST /chat/completions without a leading system turn, and /responses without
 *    `instructions`, are answered 400 "This request is not one DeepAI Code sends."
 */

import { describe, expect, it } from "vitest"
import { DefaultExecutor } from "../../apps/web/open-sse/executors/default.js"
import { PROVIDER_CAPABILITIES } from "../../apps/web/open-sse/providers/capabilities.js"
import DeepaiCode from "../../apps/web/open-sse/providers/registry/deepai-code.js"
import { checkFallbackError } from "../../apps/web/open-sse/services/accountFallback.js"
import {
	assertDeepAiCodeContextFits,
	buildDeepAiCodeHeaders,
	DEEPAI_CODE_CONTEXT_BUDGET,
	DEEPAI_CODE_LANE,
	DEEPAI_CODE_SYSTEM_FILLER,
	DeepAiCodeContextError,
	deepaiCodeInstanceId,
	deepaiCodeMachineId,
	ensureDeepAiCodeShape,
	estimateDeepAiCodeTokens,
} from "../../apps/web/open-sse/shared/deepaiCode.js"

const HEX64 = /^[0-9a-f]{64}$/
const HEX32 = /^[0-9a-f]{32}$/

type Shaped = Record<string, unknown> & {
	messages?: Array<{ role?: string; content?: unknown }>
	instructions?: string
}

/** ensureDeepAiCodeShape is typed `unknown` on purpose: it passes through whatever it
 * is given. The tests care about the shaped record, so narrow once here. */
const shape = (body: unknown) => ensureDeepAiCodeShape(body) as Shaped

describe("buildDeepAiCodeHeaders", () => {
	it("puts the key on Api-Key, never Authorization", () => {
		const headers = buildDeepAiCodeHeaders("key-123")
		expect(headers["Api-Key"]).toBe("key-123")
		expect(headers.Authorization).toBeUndefined()
	})

	it("always names the billing lane, which upstream requires", () => {
		// Without this header the endpoint answers 426 lane_version_unsupported, so
		// the lane is not optional metadata.
		expect(buildDeepAiCodeHeaders("k")["X-DeepAI-Code-Theos"]).toBe(DEEPAI_CODE_LANE)
	})

	it("uses a lane upstream accepts", () => {
		// Verified live: lanes 1-6 answer 200 and /theos reports lane_version 6;
		// 7 and above answer 426 lane_version_unsupported. Pinning the constant keeps
		// a future bump from silently regressing every request to 426.
		expect(Number(DEEPAI_CODE_LANE)).toBeGreaterThanOrEqual(1)
		expect(Number(DEEPAI_CODE_LANE)).toBeLessThanOrEqual(6)
	})

	it("sends a sha256 machine fingerprint and a 32-hex instance id", () => {
		const headers = buildDeepAiCodeHeaders("k")
		expect(headers["X-DeepAI-Code-Machine"]).toMatch(HEX64)
		expect(headers["X-DeepAI-Code-Instance"]).toMatch(HEX32)
	})

	it("keeps the machine id stable across calls in one process", () => {
		// Upstream allocates the free daily allowance per device, so a value that
		// changed per request would look like a new device every time.
		expect(deepaiCodeMachineId()).toBe(deepaiCodeMachineId())
		expect(deepaiCodeInstanceId()).toBe(deepaiCodeInstanceId())
	})

	it("accepts a missing key without emitting undefined into the header", () => {
		expect(buildDeepAiCodeHeaders(null)["Api-Key"]).toBe("")
		expect(buildDeepAiCodeHeaders(undefined)["Api-Key"]).toBe("")
	})
})

describe("ensureDeepAiCodeShape — chat lane", () => {
	it("prepends a system turn when the client sent none", () => {
		const shaped = shape({ messages: [{ role: "user", content: "hi" }] })
		expect(shaped.messages?.[0]).toEqual({ role: "system", content: DEEPAI_CODE_SYSTEM_FILLER })
		expect(shaped.messages).toHaveLength(2)
	})

	it("leaves a body that already starts with system untouched", () => {
		const body = {
			messages: [
				{ role: "system", content: "be brief" },
				{ role: "user", content: "hi" },
			],
		}
		expect(ensureDeepAiCodeShape(body)).toBe(body)
	})

	it("accepts developer as the leading role too", () => {
		const body = {
			messages: [
				{ role: "developer", content: "be brief" },
				{ role: "user", content: "hi" },
			],
		}
		expect(ensureDeepAiCodeShape(body)).toBe(body)
	})

	it("preserves every other field", () => {
		const shaped = shape({
			model: "glm-5.3-flash",
			messages: [{ role: "user", content: "hi" }],
			stream: true,
			temperature: 0.2,
		})
		expect(shaped.model).toBe("glm-5.3-flash")
		expect(shaped.stream).toBe(true)
		expect(shaped.temperature).toBe(0.2)
	})
})

describe("ensureDeepAiCodeShape — responses lane", () => {
	it("fills instructions when absent", () => {
		const shaped = shape({ input: [{ role: "user", content: "hi" }] })
		expect(shaped.instructions).toBe(DEEPAI_CODE_SYSTEM_FILLER)
	})

	it("fills instructions when present but blank", () => {
		const shaped = shape({ input: [], instructions: "   " })
		expect(shaped.instructions).toBe(DEEPAI_CODE_SYSTEM_FILLER)
	})

	it("keeps real instructions", () => {
		const body = { input: [], instructions: "answer in French" }
		expect(ensureDeepAiCodeShape(body)).toBe(body)
	})

	it("passes non-object bodies through untouched", () => {
		expect(ensureDeepAiCodeShape(null)).toBeNull()
		expect(ensureDeepAiCodeShape("x")).toBe("x")
		expect(ensureDeepAiCodeShape([1, 2])).toEqual([1, 2])
	})
})

describe("registry entry", () => {
	it("is an apikey provider on the DeepAI Code chat endpoint", () => {
		expect(DeepaiCode.category).toBe("apikey")
		expect(DeepaiCode.transport.baseUrl).toBe("https://api.deepai.org/deepai_code/chat/completions")
	})

	it("uses a raw Api-Key auth descriptor with the device hook", () => {
		// `combined` matters: applyAuth() dereferences apiKey/oauth sub-descriptors
		// when it is absent, and this descriptor only names one header.
		expect(DeepaiCode.transport.auth).toEqual({
			combined: true,
			header: "Api-Key",
			scheme: "raw",
			hooks: ["deepaiCodeHeaders"],
		})
	})

	it("sends an explicit User-Agent, since the WAF rejects the literal `node`", () => {
		// Verified live: UA "node" makes both /models and /chat answer 426
		// lane_version_unsupported; omitting the header entirely still works.
		expect(DeepaiCode.transport.headers["User-Agent"]).toBeTruthy()
		expect(DeepaiCode.transport.headers["User-Agent"]).not.toBe("node")
	})

	it("declares a Responses transport for the Responses-only model", () => {
		const formats = DeepaiCode.transports.map((t) => t.format)
		expect(formats).toContain("openai")
		expect(formats).toContain("openai-responses")
		const astra = DeepaiCode.models.find((m) => m.id === "gpt-6-astra")
		expect(astra).toBeDefined()
		expect(astra?.targetFormat).toBe("openai-responses")
		expect(astra?.supportedFormats).toEqual(["openai-responses"])
	})

	it("declares usage, which reads the Theos balance", () => {
		expect(DeepaiCode.transport.usage?.url).toBe("https://api.deepai.org/deepai_code/theos")
	})

	it("sets usageApikey, not just usage", () => {
		// USAGE_SUPPORTED_PROVIDERS (features.usage) makes the panel show a quota row;
		// USAGE_APIKEY_PROVIDERS (features.usageApikey) is what lets an API-key
		// connection read it at all. Every apikey provider with usage sets both, and
		// omitting the second silently reports "cannot read usage" per connection.
		expect(DeepaiCode.features?.usage).toBe(true)
		expect(DeepaiCode.features?.usageApikey).toBe(true)
	})

	it("has no duplicate model ids", () => {
		const ids = DeepaiCode.models.map((m) => m.id)
		expect(new Set(ids).size).toBe(ids.length)
	})

	it("lists the whole live catalogue", () => {
		// Snapshot of GET /deepai_code/models with a real key: 27 models. A count
		// assertion is what catches a stale hand-written list after upstream adds or
		// retires models.
		expect(DeepaiCode.models).toHaveLength(27)
		for (const id of ["qwen-3.8-flash", "minimax-m3", "claude-sonnet-5-5", "claude-fable-5-2"]) {
			expect(DeepaiCode.models.map((m) => m.id)).toContain(id)
		}
	})
})

describe("assertDeepAiCodeContextFits", () => {
	/** A conversation whose head carries a task statement and whose tail is filler. */
	const conversation = (blocks: number, wordsPerBlock = 1200) => {
		const filler = (n: number) => Array.from({ length: n }, (_, i) => `word${i} lorem`).join(" ")
		const messages: Array<{ role: string; content: string }> = [
			{ role: "system", content: "You are Claude Code. Follow the repo conventions." },
			{ role: "user", content: "TASK: migrate the billing module. Remember SECRET=ORANGE55." },
			{ role: "assistant", content: "Understood." },
		]
		for (let i = 0; i < blocks; i++) {
			messages.push({ role: "user", content: `BLOCK${i} ${filler(wordsPerBlock)}` })
			messages.push({ role: "assistant", content: "ok" })
		}
		messages.push({ role: "user", content: "Reply with only the SECRET value." })
		return { model: "gpt-6-luna", messages }
	}

	it("accepts a conversation inside the window and reports its size", () => {
		const estimated = assertDeepAiCodeContextFits(conversation(1))
		expect(estimated).toBeGreaterThan(0)
		expect(estimated).toBeLessThanOrEqual(DEEPAI_CODE_CONTEXT_BUDGET)
	})

	it("throws instead of trimming when the prompt is too large", () => {
		// The whole point: upstream drops the oldest turns silently, and trimming
		// here would reproduce that failure with a nicer face.
		expect(() => assertDeepAiCodeContextFits(conversation(30))).toThrow(DeepAiCodeContextError)
	})

	it("reports the measured size and the limit in the message", () => {
		// A caller that can compact needs the numbers to know it must compact.
		let message = ""
		try {
			assertDeepAiCodeContextFits(conversation(30))
		} catch (error) {
			message = (error as Error).message
		}
		expect(message).toMatch(/\d+ tokens/)
		expect(message).toContain(String(DEEPAI_CODE_CONTEXT_BUDGET))
		expect(message.toLowerCase()).toContain("compact")
	})

	it("carries a 400 context_length_exceeded, not a 502 gateway error", () => {
		// A context overflow is the caller's to fix; reporting it as a gateway
		// failure makes an agent retry the same oversized prompt forever.
		const error = new DeepAiCodeContextError("too big")
		expect(error.statusCode).toBe(400)
		expect(error.code).toBe("context_length_exceeded")
	})

	it("never mutates the body it rejects", () => {
		// Rejecting must not leave a half-trimmed body behind for a retry to send.
		const body = conversation(30)
		const before = JSON.stringify(body)
		expect(() => assertDeepAiCodeContextFits(body)).toThrow()
		expect(JSON.stringify(body)).toBe(before)
	})

	it("rejects a single pasted file that alone exceeds the window", () => {
		// One big paste is the common way to blow the budget in a single turn.
		const body = {
			model: "gpt-6-luna",
			messages: [
				{ role: "system", content: "You are Claude Code." },
				{ role: "user", content: `Here is the file:\n${"x".repeat(800000)}\n\nSummarize it.` },
			],
		}
		expect(() => assertDeepAiCodeContextFits(body)).toThrow(DeepAiCodeContextError)
	})

	it("passes through shapes it cannot measure rather than rejecting on a guess", () => {
		// Fail-open: a body with no message list must not be rejected blind.
		expect(assertDeepAiCodeContextFits(null)).toBe(0)
		expect(assertDeepAiCodeContextFits({ model: "x" })).toBe(0)
	})
})

describe("estimateDeepAiCodeTokens", () => {
	it("counts text at roughly four characters per token", () => {
		const body = { messages: [{ role: "user", content: "x".repeat(4000) }] }
		expect(estimateDeepAiCodeTokens(body)).toBeGreaterThanOrEqual(1000)
		expect(estimateDeepAiCodeTokens(body)).toBeLessThan(1100)
	})

	it("counts tool schemas, which ride outside the messages", () => {
		const messages = [{ role: "user", content: "hi" }]
		const withoutTools = estimateDeepAiCodeTokens({ messages })
		const withTools = estimateDeepAiCodeTokens({
			messages,
			tools: [{ name: "Read", description: "d".repeat(4000), input_schema: {} }],
		})
		expect(withTools).toBeGreaterThan(withoutTools + 900)
	})

	it("charges images a flat allowance rather than their base64 length", () => {
		const body = {
			messages: [
				{
					role: "user",
					content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }],
				},
			],
		}
		expect(estimateDeepAiCodeTokens(body)).toBeGreaterThan(1000)
	})
})

describe("combo behaviour", () => {
	it("marks an oversized prompt as request-scoped so a combo moves to the next model", () => {
		// The point of raising an error instead of trimming: a combo must be able
		// to try a member with a bigger window. checkFallbackError reports
		// requestScoped for an unmatched 4xx, which combo.ts advances on without
		// cooling the account down.
		const error = new DeepAiCodeContextError("Prompt is ~198697 tokens, ...")
		const decision = checkFallbackError(error.statusCode, error.message, 0, "deepai-code")
		expect(decision.requestScoped).toBe(true)
		expect(decision.cooldownMs).toBe(0)
	})

	it("does not evict a healthy deepai-code account from rotation", () => {
		// A context overflow says nothing about the credential: cooling it down
		// would remove a working connection for later, smaller requests.
		const error = new DeepAiCodeContextError("Prompt is ~198697 tokens, ...")
		const decision = checkFallbackError(error.statusCode, error.message, 0, "deepai-code")
		expect(decision.shouldFallback).toBe(false)
	})
})

describe("published context window", () => {
	it("publishes 50k, not the catalogue's 320k, so clients compact in time", () => {
		// A client that trusts 320k never compacts, and the lane then either
		// answers with nothing (~50k-92k) or silently drops the head (>92k).
		const caps = PROVIDER_CAPABILITIES["deepai-code"]
		expect(caps).toBeDefined()
		for (const [model, entry] of Object.entries(caps as Record<string, any>)) {
			expect(entry.contextWindow, `${model} contextWindow`).toBe(50000)
		}
	})

	it("keeps the published window at or below the budget the executor enforces", () => {
		// Publishing more than we are willing to send would put the client and
		// the executor at odds: the client would build prompts we then have to cut.
		const caps = PROVIDER_CAPABILITIES["deepai-code"] as Record<string, any>
		for (const [model, entry] of Object.entries(caps)) {
			expect(entry.contextWindow, `${model}`).toBeLessThanOrEqual(DEEPAI_CODE_CONTEXT_BUDGET)
		}
	})
})

describe("executor wiring", () => {
	it("applies the DeepAI header hook from the registry descriptor", () => {
		const headers = new DefaultExecutor("deepai-code").buildHeaders(
			{ apiKey: "key-abc" },
			true,
			null,
			"glm-5.3-flash",
			null,
		)
		expect(headers["Api-Key"]).toBe("key-abc")
		expect(headers["X-DeepAI-Code-Theos"]).toBe(DEEPAI_CODE_LANE)
		expect(headers["X-DeepAI-Code-Machine"]).toMatch(HEX64)
		expect(headers.Authorization).toBeUndefined()
		expect(headers["Content-Type"]).toBe("application/json")
	})
})
