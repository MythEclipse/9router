import crypto from "node:crypto"
import { getModelTargetFormat } from "../config/providerModels.ts"
import { normalizeResponsesInput } from "../translator/formats/responsesApi.ts"
import { FORMATS } from "../translator/formats.ts"
import { normalizeResponsesTools, sanitizeResponsesItems } from "../utils/responsesTools.ts"
import { resolveSessionId } from "../utils/sessionManager.ts"
import { DefaultExecutor } from "./default.ts"

const SESSION_HEADER = "x-opencode-session"
const SESSION_FIELD = "_opencodeGoSession"
const MAX_SESSION_LENGTH = 256

const RESPONSES_BASE_URL = "https://opencode.ai/zen/go/v1/responses"
const GEMINI_BASE_URL = "https://opencode.ai/inference/go/v1/models"

/** Fields a caller may hand `prepareRequestCredentials` to derive a session. */
interface OpencodeCredentialContext {
	body?: Record<string, unknown> | null
	credentials?: Record<string, unknown> | null
	providerSessionId?: unknown
	clientTool?: unknown
}

function normalizeSession(value) {
	if (typeof value !== "string") return null
	const normalized = value.trim()
	if (!normalized || normalized.length > MAX_SESSION_LENGTH) return null
	return normalized
}

function nativeSession(headers) {
	if (!headers || typeof headers !== "object") return null
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === SESSION_HEADER) return normalizeSession(value)
	}
	return null
}

function translatedSession(sessionId, clientTool) {
	const digest = crypto
		.createHash("sha256")
		.update(`opencode-go\0${clientTool || "generic"}\0${sessionId}`)
		.digest("hex")
		.slice(0, 32)
	return `ses_${digest}`
}

// Responses-only per the provider registry (grok-4.6, gpt-5.6-luna, muse-spark, …),
// including the family-regex fallback for passthrough ids - never hardcode model ids here.
function isResponsesModel(model) {
	return getModelTargetFormat("opencode-go", model) === FORMATS.OPENAI_RESPONSES
}

function isGeminiModel(model) {
	return getModelTargetFormat("opencode-go", model) === FORMATS.GEMINI
}

// Last line of defense for native Responses clients (sourceFormat === targetFormat
// skips translation): coerce items in place so malformed tool payloads 400 here
// with a clear shape instead of upstream as InputValidationError.
export class OpenCodeGoExecutor extends DefaultExecutor {
	constructor() {
		super("opencode-go")
	}

	buildUrl(model, stream, urlIndex = 0, credentials = null) {
		if (isGeminiModel(model)) {
			const cleanModel = typeof model === "string" ? model.replace(/\([^()]+\)\s*$/, "").trim() : model
			return `${GEMINI_BASE_URL}/${cleanModel}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`
		}
		// Muse Spark lives on /responses even when a stale runtimeTransport leaks in.
		if (isResponsesModel(model)) return RESPONSES_BASE_URL
		return super.buildUrl(model, stream, urlIndex, credentials)
	}

	prepareRequestCredentials({
		body,
		credentials,
		providerSessionId,
		clientTool,
	}: OpencodeCredentialContext = {}) {
		const sourceCredentials = credentials || {}
		const native = nativeSession(sourceCredentials.rawHeaders)
		const resolved =
			normalizeSession(providerSessionId) ||
			resolveSessionId({
				headers: sourceCredentials.rawHeaders,
				body,
				connectionId: sourceCredentials.connectionId,
				scope: "opencode-go",
			})

		return {
			...sourceCredentials,
			[SESSION_FIELD]: native || translatedSession(resolved, clientTool),
		}
	}

	async execute(args) {
		const credentials = this.prepareRequestCredentials(args)
		return super.execute({ ...args, credentials })
	}

	buildHeaders(credentials, stream = true, url, model) {
		const headers = super.buildHeaders(credentials || {}, stream, url, model)
		const prepared = credentials?.[SESSION_FIELD]
		if (prepared) {
			headers[SESSION_HEADER] = prepared
			return headers
		}

		const fallback = this.prepareRequestCredentials({ credentials })
		headers[SESSION_HEADER] = fallback[SESSION_FIELD]
		return headers
	}

	transformRequest(model, body, stream, credentials) {
		const out = super.transformRequest(model, body, stream, credentials)
		if (!isResponsesModel(model || body?.model)) return out
		const normalized = normalizeResponsesInput(out.input)
		if (normalized) out.input = normalized
		if (!Array.isArray(out.input) || out.input.length === 0) {
			out.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }]
		}
		// Responses names the output cap max_output_tokens, not max_tokens.
		if (out.max_output_tokens === undefined) {
			if (out.max_completion_tokens !== undefined) out.max_output_tokens = out.max_completion_tokens
			else if (out.max_tokens !== undefined) out.max_output_tokens = out.max_tokens
		}
		delete out.max_tokens
		delete out.max_completion_tokens
		if (out.reasoning_effort !== undefined && out.reasoning === undefined) {
			out.reasoning = { effort: out.reasoning_effort, summary: "auto" }
		}
		if (out.reasoning && typeof out.reasoning === "object" && !Array.isArray(out.reasoning)) {
			if (!out.reasoning.summary) out.reasoning.summary = "auto"
		}
		delete out.reasoning_effort
		out.stream = true
		out.store = false
		normalizeResponsesTools(out)
		sanitizeResponsesItems(out)
		return out
	}
}
