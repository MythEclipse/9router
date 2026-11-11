import { describe, expect, it } from "vitest"
import { DefaultExecutor } from "../../apps/web/open-sse/executors/default.js"
import { getCapabilitiesForModel } from "../../apps/web/open-sse/providers/capabilities.js"
import nvidiaConfig from "../../apps/web/open-sse/providers/registry/nvidia.js"
import { checkFallbackError } from "../../apps/web/open-sse/services/accountFallback.js"
import { stripUnsupportedParams } from "../../apps/web/open-sse/translator/concerns/paramSupport.js"

describe("NVIDIA transport quirks", () => {
	it("declares dropClientMetadata and timeoutMs", () => {
		expect(nvidiaConfig.transport.quirks?.dropClientMetadata).toBe(true)
		expect(nvidiaConfig.transport.timeoutMs).toBe(90000)
	})

	it("lists meta/llama-3.3-70b-instruct and the active models", () => {
		const hasLlama = nvidiaConfig.models.some((m) => m.id === "meta/llama-3.3-70b-instruct")
		const hasLightning = nvidiaConfig.models.some(
			(m) => m.id === "nvidia/nemotron-3.5-lightning-30b-a3b",
		)
		const hasBolt = nvidiaConfig.models.some((m) => m.id === "nvidia/nemotron-3.5-bolt-e4b")
		const hasLaguna = nvidiaConfig.models.some((m) => m.id === "poolside/laguna-xs-2.1")

		expect(hasLlama).toBe(true)
		expect(hasLightning).toBe(true)
		expect(hasBolt).toBe(true)
		expect(hasLaguna).toBe(true)
	})
})

describe("NVIDIA parameter stripping", () => {
	it("strips client_metadata, prompt_cache_key, service_tier, and extra fields", () => {
		const payload: Record<string, any> = {
			model: "meta/llama-3.3-70b-instruct",
			messages: [
				{ role: "user", content: "hello" },
				{ role: "assistant", content: "hi", reasoning: "thinking text" },
			],
			client_metadata: { source: "claude-code" },
			prompt_cache_key: "cache-123",
			service_tier: "default",
			anthropic_beta: ["tools-2024"],
			thinking_budget: 1024,
			user_id: "user-456",
			custom_field: "test",
			temperature: 0.7,
		}

		stripUnsupportedParams("nvidia", "meta/llama-3.3-70b-instruct", payload)

		expect(payload.client_metadata).toBeUndefined()
		expect(payload.prompt_cache_key).toBeUndefined()
		expect(payload.service_tier).toBeUndefined()
		expect(payload.anthropic_beta).toBeUndefined()
		expect(payload.thinking_budget).toBeUndefined()
		expect(payload.user_id).toBeUndefined()
		expect(payload.custom_field).toBeUndefined()
		expect(payload.temperature).toBe(0.7)

		// Checks reasoning field was renamed to reasoning_content
		expect(payload.messages[1].reasoning).toBeUndefined()
		expect(payload.messages[1].reasoning_content).toBe("thinking text")
	})

	it("DefaultExecutor.transformRequest strips all unsupported params and non-streaming stream_options", () => {
		const executor = new DefaultExecutor("nvidia")
		const body = {
			model: "meta/llama-3.3-70b-instruct",
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello", reasoning: "secret thought" },
			],
			client_metadata: { source: "claude-code" },
			stream_options: { include_usage: true },
			prompt_cache_key: "cache-key-1",
			service_tier: "auto",
		}

		const transformed = executor.transformRequest("meta/llama-3.3-70b-instruct", body, false, {})

		expect("client_metadata" in transformed).toBe(false)
		expect("stream_options" in transformed).toBe(false)
		expect("prompt_cache_key" in transformed).toBe(false)
		expect("service_tier" in transformed).toBe(false)
		expect("reasoning" in transformed.messages[1]).toBe(false)
		expect(transformed.messages[1].reasoning_content).toBe("secret thought")
	})
})

describe("NVIDIA fallback and capabilities", () => {
	it("triggers modelScoped cooldown on 400 degraded", () => {
		const result = checkFallbackError(
			400,
			"DEGRADED function cannot be invoked",
			0,
			"nvidia" as never,
		)
		expect(result.shouldFallback).toBe(true)
		expect(result.modelScoped).toBe(true)
		expect(result.cooldownMs).toBe(15 * 60 * 1000)
	})

	it("distinguishes tools support per model", () => {
		const llamaCaps = getCapabilitiesForModel("nvidia", "meta/llama-3.3-70b-instruct")
		const minimaxCaps = getCapabilitiesForModel("nvidia", "minimaxai/minimax-m3")

		expect(llamaCaps.tools).toBe(true)
		expect(minimaxCaps.tools).toBe(false)
	})
})
