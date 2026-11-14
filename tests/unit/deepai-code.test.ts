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
import DeepaiCode from "../../apps/web/open-sse/providers/registry/deepai-code.js"
import {
	buildDeepAiCodeHeaders,
	DEEPAI_CODE_LANE,
	DEEPAI_CODE_SYSTEM_FILLER,
	deepaiCodeInstanceId,
	deepaiCodeMachineId,
	ensureDeepAiCodeShape,
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
