import { v4 as uuidv4 } from "uuid"
import { AWS_EVENTSTREAM } from "../config/awsConstants.ts"
import {
	KIRO_CODEWHISPERER_TARGET,
	KIRO_ENDPOINT_FALLBACK_STATUSES,
	resolveKiroModel,
} from "../config/kiroConstants.ts"
import { PROVIDERS } from "../config/providers.ts"
import { STREAM_FIRST_CHUNK_TIMEOUT_MS } from "../config/runtimeConfig.ts"
import { refreshKiroToken } from "../services/tokenRefresh.ts"
import { buildKiroIdentityHeaders } from "../shared/kiroIdentity.ts"
import { crc32, parseEventFrame } from "../utils/awsEventStream.ts"
import { SSE_DONE, SSE_HEADERS } from "../utils/sseConstants.ts"
import { estimateInputTokens } from "../utils/usageTracking.ts"
import { BaseExecutor } from "./base.ts"

import {
	appendRepairInstruction,
	concatChunks,
	encoder,
	encodeSSEError,
	envPositiveInt,
	inspectSSEChunk,
	isEllipsisOnly,
	isShortFutureAction,
	makeAbortError,
	readResponsePrefix,
	readWithTimeout,
} from "./kiroStream.ts"
import { transformEventStreamToSSE } from "./kiroTransform.ts"

export type { KiroStreamTransformOptions } from "./kiroStream.ts"

const KIRO_REPAIR_BUFFER_MAX_BYTES = 8 * 1024 * 1024
const KIRO_SERVICE_REGIONS = {
	q: new Set(["us-east-1", "eu-central-1"]),
	runtime: new Set(["us-east-1", "eu-central-1"]),
	codewhisperer: new Set(["us-east-1"]),
}
const KIRO_REPAIR_HEARTBEAT_MS = 10_000
export class KiroExecutor extends BaseExecutor {
	constructor() {
		super("kiro", PROVIDERS.kiro)
	}

	buildHeaders(credentials, _stream = true, url = "") {
		const headers = {
			...this.config.headers,
			// Kiro rejects any client below its IDE version floor with
			// "This version of Kiro is no longer supported". The identity carries
			// the version *and* a per-account machine id, so it is stamped here
			// rather than in the static registry headers.
			...buildKiroIdentityHeaders(credentials, "streaming"),
			"Amz-Sdk-Request": "attempt=1; max=3",
			"Amz-Sdk-Invocation-Id": uuidv4(),
		}
		if (url.includes("://codewhisperer.")) {
			headers["X-Amz-Target"] = KIRO_CODEWHISPERER_TARGET
		} else {
			delete headers["X-Amz-Target"]
		}

		// API-key auth: the key is stored as accessToken and sent as a bearer token
		// exactly like an OAuth access token, but with an extra `tokentype: API_KEY`
		// header so CodeWhisperer treats it as a long-lived API key rather than an
		// OIDC/social access token. Mirrors the Kiro IDE headless-auth behavior.
		// Enterprise / Microsoft Entra (external_idp) tokens are OAuth access tokens,
		// but CodeWhisperer requires TokenType=EXTERNAL_IDP to bind them to profiles.
		const authMethod = credentials?.providerSpecificData?.authMethod
		const isApiKey = authMethod === "api_key"
		const isExternalIdp = authMethod === "external_idp"

		const apiKey = credentials?.apiKey || (isApiKey ? credentials?.accessToken : null)
		if (isApiKey && apiKey) {
			headers["Authorization"] = `Bearer ${apiKey}`
			headers["TokenType"] = "API_KEY"
		} else if (credentials?.accessToken) {
			headers["Authorization"] = `Bearer ${credentials.accessToken}`
			if (isExternalIdp) {
				headers["TokenType"] = "EXTERNAL_IDP"
			}
		}

		// CLIRO parity for the Amazon surfaces: the Kiro runtime accepts the
		// SSO bearer header + agent-mode marker. Without these the deprecated
		// path gateway answers REQUEST_BODY_INVALID for modern payloads.
		if (credentials?.accessToken) {
			headers["x-amz-sso-bearer"] = credentials.accessToken
		}
		headers["x-amzn-kiro-agent-mode"] = "spec"
		headers["x-amzn-codewhisperer-machine-id"] = "kiro-desktop"
		const profileArn = credentials?.providerSpecificData?.profileArn
		if (profileArn) {
			headers["x-amzn-codewhisperer-profile-arn"] = profileArn
		}

		return headers
	}

	/**
	 * Auth-aware endpoint ordering.
	 *
	 * API-key Kiro connections use the Amazon Q surface. The legacy
	 * codewhisperer.* GenerateAssistantResponse endpoint can authenticate the key
	 * but rejects the same valid payload with REQUEST_BODY_INVALID. Since a 400
	 * is terminal in BaseExecutor, putting CodeWhisperer first prevents the working
	 * q.* endpoint from ever being tried. Keep q.* first only for api_key accounts.
	 *
	 * The Kiro IDE gateway (runtime.*.kiro.dev) expects Kiro OIDC/social tokens
	 * and rejects TokenType=API_KEY. External IdP enterprise tokens instead
	 * use the CodeWhisperer surface, with the `TokenType: EXTERNAL_IDP` header.
	 * Other OAuth methods keep the default order (kiro.dev first) since their
	 * tokens are what that gateway accepts.
	 */
	getOrderedBaseUrls(credentials) {
		const baseUrls = this.getBaseUrls()
		const _authMethod = credentials?.providerSpecificData?.authMethod
		// IAM Identity Center (idc) tokens are AWS SSO access tokens - the same
		// family as external_idp/api_key. The kiro.dev gateway rejects them with
		// 403 "bearer token invalid", so they must hit the CodeWhisperer
		// *.amazonaws.com surface, and in the region the token was minted in
		// (the baseUrls are hardcoded us-east-1).
		// Kiro deprecated the legacy path-style GenerateAssistantResponse on
		// runtime.*.kiro.dev (IDE 1.0.228+ moved to POST / + x-amz-target). The
		// path gateway now answers valid modern payloads with 400
		// REQUEST_BODY_INVALID, and 400 is terminal in BaseExecutor, so kiro.dev
		// must never be the first surface for any auth method. Amazon surfaces
		// reject foreign tokens with 401/403, which DO fall through, so trying
		// q/codewhisperer first is safe for every auth method (CLIRO parity).

		// Only a covered region reaches the hostname that receives the bearer token.
		const requestedRegion = (credentials?.providerSpecificData?.region || "us-east-1").trim()
		const regionalize = (u) => {
			if (!u.includes("amazonaws.com")) return u
			const service = u.match(/\/\/([a-z]+)\.[a-z0-9-]+\.amazonaws\.com/)?.[1]
			const covered = KIRO_SERVICE_REGIONS[service]
			if (!covered || !covered.has(requestedRegion)) return u
			return u.replace(/([a-z]+)\.[a-z0-9-]+\.amazonaws\.com/, `$1.${requestedRegion}.amazonaws.com`)
		}

		const amazon = baseUrls.filter((u) => u.includes("amazonaws.com")).map(regionalize)
		const others = baseUrls.filter((u) => !u.includes("amazonaws.com"))
		const q = amazon.filter((u) => u.includes("://q."))
		const remaining = amazon.filter((u) => !u.includes("://q."))
		return q.length > 0 ? [...q, ...remaining, ...others] : [...amazon, ...others]
	}

	buildUrl(_model, _stream, urlIndex = 0, credentials = null) {
		const baseUrls = this.getOrderedBaseUrls(credentials)
		const url = baseUrls[urlIndex] || baseUrls[0] || this.config.baseUrl
		return url
	}

	// Retry only endpoint/auth-surface failures. Payload-invalid HTTP 400 must be
	// terminal: sending the same malformed body to every surface cannot repair it.
	shouldRetry(status, urlIndex) {
		const hasFallback = urlIndex + 1 < this.getFallbackCount()
		return (
			super.shouldRetry(status, urlIndex) ||
			(hasFallback && KIRO_ENDPOINT_FALLBACK_STATUSES.has(status))
		)
	}

	transformRequest(_model, body, _stream, _credentials) {
		return body
	}

	/**
	 * Kiro execute - delegate to BaseExecutor for endpoint fallback + retry, then
	 * transform the binary AWS EventStream into OpenAI-shaped SSE on success.
	 *
	 * BaseExecutor.execute() walks config.baseUrls (runtime.us-east-1.kiro.dev →
	 * codewhisperer → q) advancing to the next host on 429 (shouldRetry) and on
	 * network/5xx errors, while tryRetry handles in-place retries per `retry: {429: 2}`.
	 * Note: api-key connections reorder these so the *.amazonaws.com hosts come
	 * first - see getOrderedBaseUrls/buildUrl above.
	 * Note: the baseUrls are alternate surfaces of one regional service, so rotation
	 * is edge-level failover - it does not grant fresh 429 quota. Per-account 429
	 * spreading is handled upstream by account rotation in sse/handlers/chat.js.
	 *
	 * Errors are returned untransformed so the upstream handler can read the body,
	 * classify the status, and trigger account fallback/cooldown.
	 */
	async execute(args) {
		const result = await super.execute(args)
		if (result?.response?.ok) {
			// KIRO_INTEGRITY_GATE=off streams through, forfeiting the tool-call repair retry.
			if (process.env.KIRO_INTEGRITY_GATE === "off") {
				result.response = this.transformEventStreamToSSE(result.response, args.model, {
					toolSpecs:
						args.body?.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext
							?.tools || [],
				})
			} else {
				this.attachIntegrityGate(result, args)
			}
		}
		return result
	}

	attachIntegrityGate(result, args) {
		const abortController = new AbortController()
		const maxBytes = envPositiveInt(
			"KIRO_TOOL_CALL_REPAIR_BUFFER_MAX_BYTES",
			KIRO_REPAIR_BUFFER_MAX_BYTES,
		)
		const legacyTimeout = envPositiveInt(
			"KIRO_TOOL_CALL_REPAIR_TIMEOUT_MS",
			STREAM_FIRST_CHUNK_TIMEOUT_MS,
		)
		const ttftTimeoutMs = envPositiveInt("KIRO_TOOL_CALL_REPAIR_TTFT_TIMEOUT_MS", legacyTimeout)
		const stallTimeoutMs = envPositiveInt("KIRO_TOOL_CALL_REPAIR_STALL_TIMEOUT_MS", legacyTimeout)
		const repairEnabled =
			args.credentials?.providerSpecificData?.kiroToolCallRepair !== false &&
			process.env.KIRO_TOOL_CALL_REPAIR !== "false"
		const forwardAbort = () => abortController.abort(args.signal?.reason)
		args.signal?.addEventListener("abort", forwardAbort, { once: true })
		let open = true
		let heartbeatTimer

		const stream = new ReadableStream({
			start: async (controller) => {
				const heartbeat = () => {
					if (!open) return
					try {
						controller.enqueue(encoder.encode(": kiro-validation\n\n"))
					} catch {
						open = false
					}
				}
				heartbeat()
				heartbeatTimer = setInterval(heartbeat, KIRO_REPAIR_HEARTBEAT_MS)

				try {
					const bytes = await this.runIntegrityRecovery(result.response, args, {
						signal: abortController.signal,
						maxBytes,
						ttftTimeoutMs,
						stallTimeoutMs,
						repairEnabled,
						requestBody: args.body,
					})
					if (abortController.signal.aborted) throw makeAbortError(abortController.signal.reason)
					controller.enqueue(bytes)
					controller.close()
				} catch (error) {
					if (open && error.name === "AbortError") {
						controller.error(error)
					} else if (open && error.name !== "AbortError") {
						controller.enqueue(
							encodeSSEError(
								"kiro_integrity_gate_failed",
								error.message || "Kiro integrity validation failed",
							),
						)
						controller.close()
					}
				} finally {
					open = false
					clearInterval(heartbeatTimer)
					args.signal?.removeEventListener?.("abort", forwardAbort)
				}
			},
			cancel(reason) {
				open = false
				clearInterval(heartbeatTimer)
				abortController.abort(reason || "client cancelled")
			},
		})

		result.response = new Response(stream, {
			status: result.response.status,
			statusText: result.response.statusText,
			headers: { ...SSE_HEADERS },
		})
	}

	async runIntegrityRecovery(rawResponse, args, options) {
		const first = await this.readRecoverableIntegrityAttempt(
			rawResponse,
			args.model,
			{ ...options, requestBody: args.body },
			"initial",
		)
		if (first.kind === "complete") return first.bytes
		if (first.kind === "terminal_stop" || first.kind === "upstream_error") {
			return this.integrityFailureSSE(first)
		}
		if (first.kind === "invalid_tool" && !options.repairEnabled) {
			return encodeSSEError("invalid_kiro_tool_call", first.message, first.diagnostics)
		}

		const repairKind = ["ellipsis", "short_final", "invalid_tool"].includes(first.kind)
			? first.kind
			: null
		const repairBody = repairKind
			? appendRepairInstruction(args.body, repairKind === "invalid_tool" ? "tool" : repairKind)
			: structuredClone(args.body || {})

		const retry = await BaseExecutor.prototype.execute.call(this, {
			...args,
			body: repairBody,
			signal: options.signal,
		})
		if (!retry?.response?.ok) {
			let body = ""
			try {
				body = await readResponsePrefix(
					retry?.response,
					options.signal,
					Math.min(options.maxBytes, 4096),
					options.stallTimeoutMs,
				)
			} catch (error) {
				if (error.name === "AbortError") throw error
			}
			return encodeSSEError(
				"kiro_integrity_retry_upstream_error",
				body || `Kiro integrity retry failed with HTTP ${retry?.response?.status || 502}`,
				{ status: retry?.response?.status || 502 },
			)
		}

		const second = await this.readRecoverableIntegrityAttempt(
			retry.response,
			args.model,
			{ ...options, requestBody: args.body },
			"retry",
		)
		if (second.kind === "complete") return second.bytes
		if (second.kind === "terminal_stop" || second.kind === "upstream_error") {
			return this.integrityFailureSSE(second)
		}
		const code =
			second.kind === "ellipsis"
				? "kiro_ellipsis_retry_failed"
				: second.kind === "short_final"
					? "kiro_short_final_retry_failed"
					: second.kind === "invalid_tool"
						? "kiro_tool_call_repair_retry_failed"
						: "kiro_missing_terminal_retry_failed"
		return encodeSSEError(
			code,
			`Kiro integrity validation failed after one bounded retry: ${second.message || second.kind}`,
			{ attempts: [first.diagnostics, second.diagnostics].filter(Boolean) },
		)
	}

	integrityFailureSSE(attempt) {
		const disposition = attempt.diagnostics?.stop_disposition
		const code =
			attempt.diagnostics?.terminal_provenance === "integrity_buffer_exceeded"
				? "kiro_integrity_buffer_exceeded"
				: attempt.kind === "upstream_error"
					? "kiro_upstream_eventstream_error"
					: disposition === "terminal_refusal"
						? "kiro_terminal_refusal"
						: disposition === "terminal_incomplete"
							? "kiro_terminal_incomplete"
							: "kiro_unknown_stop_reason"
		return encodeSSEError(
			code,
			attempt.message || "Kiro stream ended with a terminal failure",
			attempt.diagnostics,
		)
	}

	async readRecoverableIntegrityAttempt(rawResponse, model, options, attempt) {
		try {
			return await this.readIntegrityAttempt(rawResponse, model, options, attempt)
		} catch (error) {
			if (error.name === "AbortError") throw error
			return {
				kind: "missing_terminal",
				message: error.message || "Kiro transport read failed",
				diagnostics: {
					attempt,
					terminal_provenance: "transport_read_error",
					transport_state: "upstream_error",
					stop_reason: null,
					stop_disposition: "terminal_incomplete",
					response_state: "no_semantic_output",
					event_counts: {},
					incomplete_frame_bytes: 0,
				},
			}
		}
	}

	async readIntegrityAttempt(rawResponse, model, options, attempt) {
		let diagnostics
		const transformed = this.transformEventStreamToSSE(rawResponse, model, {
			maxToolBytes: Math.max(1, Math.floor(options.maxBytes / 2)),
			requestBody: options.requestBody,
			onTerminalState: (value) => {
				diagnostics = value
			},
		})
		const reader = transformed.body.getReader()
		const chunks = []
		let totalBytes = 0
		let sawChunk = false
		const output = { content: "", reasoning: "", hasToolCalls: false, error: null }

		try {
			while (true) {
				const timeoutMs = sawChunk ? options.stallTimeoutMs : options.ttftTimeoutMs
				const phase = sawChunk ? "stalled" : "timed out before first chunk"
				const { done, value } = await readWithTimeout(
					reader,
					options.signal,
					timeoutMs,
					`Kiro integrity validation ${phase}`,
				)
				if (done) break
				sawChunk = true
				totalBytes += value.byteLength
				if (totalBytes > options.maxBytes) {
					await reader.cancel("kiro_integrity_buffer_exceeded").catch(() => {})
					return {
						kind: "terminal_stop",
						message: `Kiro integrity buffer exceeded ${options.maxBytes} bytes`,
						diagnostics: { terminal_provenance: "integrity_buffer_exceeded" },
					}
				}
				chunks.push(value)
				inspectSSEChunk(value, output)
			}
		} catch (error) {
			await reader.cancel(error.message).catch(() => {})
			throw error
		}

		const safeDiagnostics = {
			attempt,
			terminal_provenance: diagnostics?.terminal_provenance || "missing_terminal_diagnostics",
			transport_state: diagnostics?.transport_state || "unknown",
			stop_reason: diagnostics?.stop_reason || null,
			stop_disposition: diagnostics?.stop_disposition || "terminal_incomplete",
			response_state: diagnostics?.response_state || "no_semantic_output",
			event_counts: diagnostics?.event_counts || {},
			incomplete_frame_bytes: diagnostics?.incomplete_frame_bytes || 0,
		}
		if (safeDiagnostics.stop_disposition === "retryable_protocol_failure") {
			const kind =
				safeDiagnostics.terminal_provenance === "invalid_tool_call" ? "invalid_tool" : "retryable_stop"
			return { kind, message: output.error?.message, diagnostics: safeDiagnostics }
		}
		if (
			safeDiagnostics.stop_disposition === "terminal_incomplete" ||
			safeDiagnostics.stop_disposition === "terminal_refusal" ||
			safeDiagnostics.stop_disposition === "unknown_failure"
		) {
			const kind =
				safeDiagnostics.terminal_provenance === "upstream_eventstream_error"
					? "upstream_error"
					: safeDiagnostics.terminal_provenance === "integrity_buffer_exceeded"
						? "terminal_stop"
						: ["metadata_stop_reason", "message_stop_event"].includes(safeDiagnostics.terminal_provenance)
							? "terminal_stop"
							: "missing_terminal"
			return { kind, message: output.error?.message, diagnostics: safeDiagnostics }
		}
		if (output.error) {
			return { kind: "missing_terminal", message: output.error.message, diagnostics: safeDiagnostics }
		}
		if (!output.hasToolCalls) {
			if (
				isEllipsisOnly(output.content) ||
				(!output.content.trim() && isEllipsisOnly(output.reasoning))
			) {
				return { kind: "ellipsis", diagnostics: safeDiagnostics }
			}
			if (isShortFutureAction(output.content)) {
				return { kind: "short_final", diagnostics: safeDiagnostics }
			}
		}
		return { kind: "complete", bytes: concatChunks(chunks, totalBytes), diagnostics: safeDiagnostics }
	}

	transformEventStreamToSSE(response, model, options) {
		return transformEventStreamToSSE(response, model, options)
	}

	async refreshCredentials(credentials, log, proxyOptions = null) {
		if (!credentials.refreshToken) return null

		try {
			// Use centralized refreshKiroToken function (handles both AWS SSO OIDC and Social Auth)
			const result = await refreshKiroToken(
				credentials.refreshToken,
				credentials.providerSpecificData,
				log,
				proxyOptions,
			)

			return result
		} catch (error) {
			log?.error?.("TOKEN", `Kiro refresh error: ${error.message}`)
			return null
		}
	}
}

export default KiroExecutor
