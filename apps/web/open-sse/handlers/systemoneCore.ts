import { getModelUpstreamId } from "../config/providerModels.ts"
import { FETCH_CONNECT_TIMEOUT_MS, HTTP_STATUS } from "../config/runtimeConfig.ts"
import { generateSessionId } from "../executors/opencode-zen.ts"
import { PROVIDER_MEDIA } from "../providers/index.ts"
import { createErrorResult, formatProviderError, parseUpstreamError } from "../utils/error.ts"

const OPENCODE_PROVIDERS = new Set(["opencode", "opencode-zen"])

/**
 * Resolve the System One URL. A saved host override is joined with the registry
 * `path` (e.g. "/v1/systemone") without doubling a "/v1" or "/v1/systemone" the
 * user already included. Without `path`, the override is used as a full URL.
 */
export function buildSystemoneUrl(override, cfg) {
	const base = override?.trim()
	if (!base) return cfg?.baseUrl
	if (!cfg?.path) return base
	const host = base.replace(/\/+$/, "")
	const path = cfg.path.replace(/\/+$/, "")
	if (host.endsWith(path)) return host
	const prefix = path.slice(0, path.lastIndexOf("/"))
	if (prefix && host.endsWith(prefix)) return host + path.slice(prefix.length)
	return host + path
}

/** Canonical name of the state field on the System One wire. */
const DEFAULT_STATE_FIELD = "state"

/**
 * Read the state out of a System One body.
 *
 * `state` is the canonical field; a lane whose upstream renamed it accepts that name too
 * (Google's decisions endpoint calls it `input`), so one body stays valid for every lane
 * and the handler renames it on the way out. A shorthand object (`{ prompt }` or
 * `{ text }`) is unwrapped to its string.
 */
export function readSystemoneState(body) {
	const raw = body?.state ?? body?.input
	if (raw === undefined || raw === null) return undefined
	if (typeof raw === "object" && !Array.isArray(raw)) {
		if (typeof raw.prompt === "string") return raw.prompt
		if (typeof raw.text === "string") return raw.text
	}
	return raw
}

/** Wire name this lane uses for the state (`input` on Google's decisions endpoint). */
export function systemoneStateField(cfg) {
	const field = cfg?.stateField
	return typeof field === "string" && field.trim() ? field.trim() : DEFAULT_STATE_FIELD
}

/**
 * Auth headers for a System One lane.
 *
 * `authHeader` follows the sttConfig vocabulary: "bearer" (also "token"/"key", or absent)
 * means `Authorization: Bearer <token>`, while any other value is a literal header name
 * carrying the raw key. Google rejects an API key sent in Authorization, so its lane names
 * `x-goog-api-key`.
 */
export function buildSystemoneAuthHeaders(cfg, token) {
	if (!token) return {}
	const header = typeof cfg?.authHeader === "string" ? cfg.authHeader.trim() : ""
	if (!header || header === "bearer" || header === "token" || header === "key") {
		return { Authorization: `Bearer ${token}` }
	}
	return { [header]: token }
}

/**
 * Core System One (Jev) handler - native decision payload pass-through.
 * URL/headers come from the registry's systemoneConfig; body and JSON response
 * are forwarded untouched (decision models have no chat translation layer).
 *
 * @returns {Promise<{ success: boolean, response: Response, usage?: object, status?: number, error?: string }>}
 */
export async function handleSystemoneCore({ body, modelInfo, credentials, log, onRequestSuccess }) {
	const { provider, model } = modelInfo
	const cfg = PROVIDER_MEDIA[provider]?.systemoneConfig
	let targetUrl = buildSystemoneUrl(credentials?.providerSpecificData?.baseUrl, cfg)
	if (!targetUrl) {
		return createErrorResult(
			HTTP_STATUS.BAD_REQUEST,
			`Provider '${provider}' does not support System One.`,
		)
	}
	// Cloudflare-style endpoints embed the account and model in the path.
	if (targetUrl.includes("{accountId}")) {
		const accountId = credentials?.providerSpecificData?.accountId
		if (!accountId) {
			return createErrorResult(
				HTTP_STATUS.BAD_REQUEST,
				`Provider '${provider}' requires accountId in providerSpecificData.`,
			)
		}
		targetUrl = targetUrl.replace("{accountId}", accountId)
	}
	if (targetUrl.includes("{model}")) {
		targetUrl = targetUrl.replace(/\{model\}/g, model)
	}

	// Validate input at the trust boundary; question-level shape is upstream's job.
	// `state` is canonical, `input` is the same field on lanes that renamed it (Google).
	const state = readSystemoneState(body)
	if (state === undefined) {
		return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: state")
	}
	if (!body.questions || typeof body.questions !== "object" || Array.isArray(body.questions)) {
		return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: questions")
	}

	// Normalize shorthand string questions (e.g. { q: "Is this correct?" } -> { q: { type: "noul", instructions: "Is this correct?" } })
	let questions = body.questions
	if (questions && typeof questions === "object" && !Array.isArray(questions)) {
		let hasShorthand = false
		for (const val of Object.values(questions)) {
			if (typeof val === "string") {
				hasShorthand = true
				break
			}
		}
		if (hasShorthand) {
			const normalized: Record<string, unknown> = {}
			for (const [key, val] of Object.entries(questions)) {
				normalized[key] = typeof val === "string" ? { type: "noul", instructions: val } : val
			}
			questions = normalized
		}
	}

	// noAuth free lanes carry accessToken "public" from the credential stub.
	const token = credentials?.apiKey || credentials?.accessToken
	const headers = {
		"Content-Type": "application/json",
		...buildSystemoneAuthHeaders(cfg, token),
		...((cfg.headers as Record<string, string> | undefined) || {}),
		// Zen lanes expect the official client session header; other providers don't need it.
		...(OPENCODE_PROVIDERS.has(provider) ? { "x-opencode-session": generateSessionId() } : {}),
	}
	// Cloudflare validates the body model as a short selector (e.g. "clef-flash"), not the full id.
	// The state goes out under this lane's own name and the alias key is dropped, so an
	// upstream is never handed both `state` and `input`.
	const { state: _state, input: _input, ...rest } = body
	const requestBody = {
		...rest,
		[systemoneStateField(cfg)]: state,
		questions,
		model: getModelUpstreamId(provider, model) || model,
	}

	log?.debug?.("SYSTEMONE", `${provider.toUpperCase()} | ${model}`)

	let providerResponse
	try {
		providerResponse = await fetch(targetUrl, {
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
			...(typeof AbortSignal?.timeout === "function"
				? { signal: AbortSignal.timeout(FETCH_CONNECT_TIMEOUT_MS) }
				: {}),
		})
	} catch (error) {
		const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY)
		log?.debug?.("SYSTEMONE", `Fetch error: ${errMsg}`)
		return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg)
	}

	if (!providerResponse.ok) {
		const { statusCode, message } = await parseUpstreamError(providerResponse)
		const errMsg = formatProviderError(new Error(message), provider, model, statusCode)
		log?.debug?.("SYSTEMONE", `Provider error: ${errMsg}`)
		return createErrorResult(statusCode, errMsg)
	}

	let responseBody
	try {
		responseBody = await providerResponse.json()
	} catch {
		return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Invalid JSON response from ${provider}`)
	}

	if (onRequestSuccess) await onRequestSuccess()

	const usage = responseBody?.usage
	return {
		success: true as const,
		usage: usage
			? { prompt_tokens: usage.input_tokens || 0, completion_tokens: usage.output_tokens || 0 }
			: null,
		response: new Response(JSON.stringify(responseBody), {
			headers: {
				"Content-Type": "application/json",
				"Access-Control-Allow-Origin": "*",
			},
		}),
	}
}
