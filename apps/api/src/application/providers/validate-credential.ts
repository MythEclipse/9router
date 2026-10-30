/**
 * Validate an API key by asking the provider.
 *
 * Called from:
 *   - `apps/api/src/application/use-cases.ts` (`makeValidateCredential`, registered
 *     as `validateCredential`)
 *   - `apps/web/src/app/api/providers/validate/route.ts` via
 *     `getUseCases().validateCredential.run(...)`
 *   - `tests/unit/use-case-validate-credential.test.ts`
 *
 * No existing file serves this purpose: `probe-models.ts` probes every model on a
 * stored connection, and `web-login.ts` probes a freshly harvested cookie. This
 * probes a key the operator just typed, before any connection exists.
 *
 * Reads: a compatible/custom-embedding node's base URL and default model. Writes
 * nothing — validation never stores a connection.
 *
 * User instruction, verbatim: "lanjut kenapa malah berhenti".
 */

import {
	anthropicCompatibleVerdict,
	blackboxVerdict,
	cloudflareVerdict,
	mediaProbeVerdict,
	notRefused,
	readerFor,
	readServiceAccount,
	refusalMessage,
	toCookieHeader,
	unwrapCredential,
	webProbeVerdict,
} from "../../domain/credential-verdict.ts"
import { invalid, notFound } from "../../domain/errors.ts"

/** What a probe request needs: where to go and what to send. */
export interface ProbeRequest {
	readonly url: string
	readonly method?: "GET" | "POST"
	readonly headers?: Record<string, string>
	readonly body?: string
	readonly timeoutMs?: number
}

/** A probe's outcome, as the transport reports it. */
export interface ProbeResponse {
	readonly status: number
	readonly ok: boolean
	readonly text?: string
}

/** The verdict the panel shows. */
export interface ValidationResult {
	readonly valid: boolean
	readonly error: string | null
}

export interface ValidateCredentialDependencies {
	/** Sends one probe. Throws only on a network failure. */
	readonly send: (request: ProbeRequest) => Promise<ProbeResponse>
	/** A compatible or custom-embedding node, for its base URL and default model. */
	readonly findNode: (
		provider: string,
	) => Promise<{ readonly baseUrl?: string; readonly defaultModel?: string } | null>
	/** The provider's default model, for probes that need one. */
	readonly defaultModel: (provider: string) => string
	/** The provider's registry entry: base URL, format, headers, auth header. */
	readonly providerConfig: (provider: string) => RegistryEntry | undefined
	/** The provider's AI entry: noAuth, service kinds, apiKeyOptionalWith, credentialForm, probe configs. */
	readonly aiProvider: (provider: string) => AiProviderEntry | undefined
	readonly isOpenAICompatible: (provider: string) => boolean
	readonly isAnthropicCompatible: (provider: string) => boolean
	readonly isCustomEmbedding: (provider: string) => boolean
	/** Probes AWS credentials, which have no bearer key to test. */
	readonly probeAws: (input: {
		readonly apiKey: string
		readonly providerSpecificData?: Record<string, unknown>
	}) => Promise<ValidationResult>
	/** Probes a Qoder PAT, which needs a token exchange first. */
	readonly probeQoder: (input: {
		readonly provider: string
		readonly apiKey: string
		readonly providerSpecificData?: Record<string, unknown>
	}) => Promise<ValidationResult>
	/** Probes Nous, whose /models is public and proves nothing. */
	readonly probeNous: (apiKey: string) => Promise<ValidationResult>
	/** The dynamic base URLs two providers compute from the operator's own data. */
	readonly ollamaLocalHost: (input: { providerSpecificData?: Record<string, unknown> }) => string
	readonly tokenplanBaseUrl: (input: { providerSpecificData?: Record<string, unknown> }) => string
	/** Builds a CommandCode request body, which is not OpenAI-shaped. */
	readonly commandCodeBody: (model: string) => unknown
	/** The header set a CommandCode probe must send to pass for the CLI. */
	readonly commandCodeHeaders: (input: {
		readonly apiKey: string
		readonly sessionId?: string
	}) => Record<string, string>
	readonly randomId: () => string
}

/** A provider's registry entry, as the validator reads it. */
export interface RegistryEntry {
	readonly baseUrl?: string
	readonly format?: string
	readonly headers?: Record<string, string>
	readonly authHeader?: string
	readonly noAuth?: boolean
	readonly validateUrl?: string
}

/** A provider's AI entry, as the validator reads it. */
export interface AiProviderEntry {
	readonly noAuth?: boolean
	readonly name?: string
	readonly apiKeyOptionalWith?: string
	readonly credentialForm?: string
	readonly serviceKinds?: readonly string[]
	readonly searchConfig?: ProbeConfig
	readonly fetchConfig?: ProbeConfig
	readonly ttsConfig?: ProbeConfig
	readonly sttConfig?: ProbeConfig
	readonly embeddingConfig?: ProbeConfig
	readonly imageConfig?: ProbeConfig
	readonly videoConfig?: ProbeConfig
	readonly musicConfig?: ProbeConfig
}

/** The config block a media or search provider is probed through. */
export interface ProbeConfig {
	readonly authType?: string
	readonly authHeader?: string
	readonly baseUrl?: string
	readonly validateUrl?: string
	readonly method?: "GET" | "POST"
	readonly extraHeaders?: Record<string, string>
}

/** One provider's probe, as a value rather than a branch. */
interface ProbePlan {
	readonly request: ProbeRequest
	readonly verdict: (response: ProbeResponse) => boolean
	readonly errorMessage?: string
}

/**
 * A domain status reader as a plan verdict.
 *
 * The domain reads a bare status; a plan is handed the whole response because a
 * few providers decide on the body (gemini-web's chat shell markers) — so the
 * status readers are widened once here rather than each plan unwrapping by hand.
 */
const byStatus =
	(reader: (status: number) => boolean) =>
	(response: ProbeResponse): boolean =>
		reader(response.status)

const PROBE_TIMEOUT_MS = 8000

export function makeValidateCredential(dependencies: ValidateCredentialDependencies) {
	const {
		send,
		findNode,
		defaultModel,
		providerConfig,
		aiProvider,
		isOpenAICompatible,
		isAnthropicCompatible,
		isCustomEmbedding,
		probeAws,
		probeQoder,
		probeNous,
		ollamaLocalHost,
		tokenplanBaseUrl,
		commandCodeBody,
		commandCodeHeaders,
		randomId,
	} = dependencies

	/** The auth header a bearer-style provider wants. */
	const bearer = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}` })
	const json = { "Content-Type": "application/json" }

	/** A minimal chat probe: enough to prove a key, cheap enough to fire often. */
	function chatProbe(
		provider: string,
		url: string,
		apiKey: string,
		extra: Record<string, string> = {},
		model = defaultModel(provider) || "test",
	): ProbeRequest {
		return {
			url,
			method: "POST",
			headers: { ...json, ...bearer(apiKey), ...extra },
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: "test" }],
				max_tokens: 1,
			}),
		}
	}

	/** The plan for a provider whose probe is not one shape, or null to fall through. */
	async function planFor(
		provider: string,
		apiKey: string,
		providerSpecificData: Record<string, unknown>,
	): Promise<ProbePlan | ValidationResult | null> {
		if (isOpenAICompatible(provider)) {
			const node = await findNode(provider)
			if (!node) throw notFound("OpenAI Compatible node")
			const url = `${(node.baseUrl ?? "").replace(/\/$/, "")}/models`
			return {
				request: { url, headers: bearer(apiKey) },
				verdict: (response) => response.ok,
			}
		}

		if (isCustomEmbedding(provider)) {
			const node = await findNode(provider)
			if (!node) throw notFound("Custom Embedding node")
			const baseUrl = (node.baseUrl ?? "").replace(/\/$/, "")
			const models = await send({ url: `${baseUrl}/models`, headers: bearer(apiKey) })
			if (models.ok) return { valid: true, error: null }
			if (models.status === 401 || models.status === 403) {
				return { valid: false, error: refusalMessage(provider) }
			}
			// Many embedding providers have no /models; a 400 about the model still
			// proves the key, so the fallback probe decides.
			return {
				request: {
					url: `${baseUrl}/embeddings`,
					method: "POST",
					headers: { ...bearer(apiKey), ...json },
					body: JSON.stringify({ model: "test", input: "ping" }),
				},
				verdict: byStatus(notRefused),
			}
		}

		if (isAnthropicCompatible(provider)) {
			const node = await findNode(provider)
			if (!node) throw notFound("Anthropic Compatible node")
			let base = (node.baseUrl ?? "").trim().replace(/\/$/, "")
			// An operator often pastes the full endpoint; strip back to the version root,
			// or "v1" ends up appended twice.
			base = base.replace(/\/v1\/messages$/, "").replace(/\/messages$/, "")
			return {
				request: {
					url: `${base}/v1/messages`,
					method: "POST",
					headers: {
						"x-api-key": apiKey,
						"anthropic-version": "2023-06-01",
						"content-type": "application/json",
						...bearer(apiKey),
					},
					body: JSON.stringify({
						model: node.defaultModel || "claude-3-haiku-20240307",
						max_tokens: 1,
						messages: [{ role: "user", content: "test" }],
					}),
				},
				verdict: byStatus(anthropicCompatibleVerdict),
			}
		}

		if (provider === "cloudflare-ai") {
			const accountId = providerSpecificData.accountId
			if (!accountId) return { valid: false, error: "Missing Account ID" }
			return {
				request: chatProbe(
					provider,
					`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`,
					apiKey,
				),
				verdict: byStatus(cloudflareVerdict),
				errorMessage: refusalMessage(provider),
			}
		}

		if (provider === "azure") {
			const endpoint = String(providerSpecificData.azureEndpoint ?? "").replace(/\/$/, "")
			const deployment = providerSpecificData.deployment || "gpt-4"
			const apiVersion = providerSpecificData.apiVersion || "2024-10-01-preview"
			const organization = providerSpecificData.organization
			return {
				request: {
					url: `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`,
					method: "POST",
					headers: {
						"api-key": apiKey,
						...json,
						...(organization ? { "OpenAI-Organization": String(organization) } : {}),
					},
					body: JSON.stringify({
						messages: [{ role: "user", content: "test" }],
						max_tokens: 1,
					}),
				},
				verdict: byStatus(notRefused),
				errorMessage: refusalMessage(provider),
			}
		}

		return null
	}

	/**
	 * The plan for a provider whose probe is a fixed request and a status reading.
	 *
	 * Each entry is data, not a branch: the same three-line shape repeated for
	 * fifteen providers is what made the route 700 lines long.
	 */
	function staticPlan(provider: string, apiKey: string): ProbePlan | null {
		const cfg = providerConfig(provider)
		const ai = aiProvider(provider)

		switch (provider) {
			case "openai":
				return {
					request: { url: "https://api.openai.com/v1/models", headers: bearer(apiKey) },
					verdict: (r) => r.ok,
				}
			case "vercel-ai-gateway":
				return {
					request: { url: "https://ai-gateway.vercel.sh/v1/models", headers: bearer(apiKey) },
					verdict: (r) => r.ok,
				}
			case "anthropic":
				return {
					request: {
						url: "https://api.anthropic.com/v1/messages",
						method: "POST",
						headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", ...json },
						body: JSON.stringify({
							model: "claude-3-haiku-20240307",
							max_tokens: 1,
							messages: [{ role: "user", content: "test" }],
						}),
					},
					verdict: byStatus(readerFor("anthropic")),
				}
			case "gemini":
				return {
					request: {
						url: `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`,
					},
					verdict: (r) => r.ok,
				}
			case "openrouter":
				return {
					request: { url: "https://openrouter.ai/api/v1/models", headers: bearer(apiKey) },
					verdict: (r) => r.ok,
				}
			case "deepgram":
				return {
					request: { url: "https://api.deepgram.com/v1/projects", headers: bearer(apiKey) },
					verdict: (r) => r.ok,
				}
			case "blackbox":
				return {
					request: {
						url: "https://api.blackbox.ai/chat/completions",
						method: "POST",
						headers: { ...bearer(apiKey), ...json },
						body: JSON.stringify({
							model: "gpt-4o",
							messages: [{ role: "user", content: "test" }],
							max_tokens: 10,
						}),
					},
					verdict: byStatus(blackboxVerdict),
				}
			case "opencode-go":
				return {
					request: {
						url: "https://opencode.ai/zen/go/v1/chat/completions",
						method: "POST",
						headers: { ...json, ...bearer(apiKey) },
						body: JSON.stringify({
							model: defaultModel("opencode-go"),
							messages: [{ role: "user", content: "ping" }],
							max_tokens: 1,
							stream: false,
						}),
					},
					verdict: byStatus(notRefused),
				}
			case "commandcode": {
				const payload = commandCodeBody(defaultModel("commandcode")) as {
					threadId?: string
				} | null
				return {
					request: {
						url: String(cfg?.baseUrl ?? ""),
						method: "POST",
						headers: commandCodeHeaders({
							apiKey,
							sessionId: payload?.threadId,
						}),
						body: JSON.stringify(payload),
					},
					verdict: byStatus(notRefused),
				}
			}
			case "vertex":
			case "vertex-partner": {
				const serviceAccount = readServiceAccount(apiKey)
				if (serviceAccount.isServiceAccount) {
					return null
				}
				return {
					request: {
						url: `https://aiplatform.googleapis.com/v1/publishers/google/models/__probe__:generateContent?key=${apiKey}`,
						method: "POST",
						headers: json,
						body: "{}",
					},
					verdict: byStatus(notRefused),
				}
			}
			case "deepseek-web":
				return {
					request: {
						url: "https://chat.deepseek.com/api/v0/users/current",
						method: "GET",
						headers: {
							...bearer(unwrapCredential(apiKey)),
							"User-Agent":
								"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
							Origin: "https://chat.deepseek.com",
							Referer: "https://chat.deepseek.com/",
							"x-app-version": "20241129.0",
							"x-client-platform": "web",
						},
					},
					verdict: (r) => r.ok,
					errorMessage:
						"Invalid token - copy userToken from chat.deepseek.com DevTools -> Application -> Local Storage/Cookies",
				}
			case "gemini-web":
				return {
					request: {
						url: "https://gemini.google.com/app",
						method: "GET",
						headers: {
							Cookie: toCookieHeader(apiKey),
							"User-Agent":
								"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
							Accept: "text/html",
						},
					},
					// A logged-out redirect answers 200 with a login page, so the body is
					// what decides: these two markers only appear in the chat shell.
					verdict: (r) => r.ok && (!!r.text?.includes("SNlM0e") || !!r.text?.includes("BardChatUi")),
					errorMessage:
						"Invalid cookie - copy __Secure-1PSID from gemini.google.com DevTools -> Application -> Cookies",
				}
			case "azure":
				// Handled by the caller: it needs providerSpecificData, and its message
				// names Azure configuration rather than the key alone.
				return null
			case "xai":
			case "ollama":
			case "ollama-local":
			case "xiaomi-tokenplan": {
				const url =
					provider === "ollama-local"
						? `${ollamaLocalHost({ providerSpecificData: {} })}/api/tags`
						: provider === "xiaomi-tokenplan"
							? `${tokenplanBaseUrl({ providerSpecificData: {} })}/models`
							: (cfg?.validateUrl ?? String(cfg?.baseUrl ?? ""))
				return {
					request: { url, headers: bearer(apiKey) },
					verdict: byStatus(readerFor(provider)),
				}
			}
			default:
				break
		}

		if (ai?.credentialForm === "aws") return null

		// A provider the registry marks no-auth needs no probe at all.
		if (cfg?.noAuth || ai?.noAuth) return null

		return null
	}

	/** The generic OpenAI-compatible probe: /models first, a chat probe as fallback. */
	function genericPlan(provider: string, apiKey: string): ProbePlan | null {
		const cfg = providerConfig(provider)
		if (!cfg || cfg.format !== "openai" || !cfg.baseUrl) return null
		const headers: Record<string, string> = { ...json, ...(cfg.headers ?? {}) }
		if (cfg.authHeader === "x-api-key") headers["X-API-Key"] = apiKey
		else headers.Authorization = `Bearer ${apiKey}`
		const modelsUrl = cfg.baseUrl
			.replace(/\/chat\/completions$/, "/models")
			.replace(/\/chatbot$/, "/models")
		return {
			request: { url: modelsUrl, headers },
			verdict: (r) => (r.status === 401 || r.status === 403 ? false : r.ok),
			errorMessage: refusalMessage(provider),
		}
	}

	return {
		/**
		 * Validate a pasted key.
		 *
		 * The order matters and is the route's: the two "node" providers first (they
		 * look up a stored node), then the three providers whose credential is not a
		 * bearer key, then config-driven probes, then the generic fallback. A
		 * provider that reaches the end unresolved is refused as unsupported rather
		 * than reported valid — a validation endpoint that says "fine" when it could
		 * not check anything is worse than one that admits it.
		 */
		async run(input: {
			readonly provider?: unknown
			readonly apiKey?: unknown
			readonly providerSpecificData?: unknown
		}): Promise<ValidationResult> {
			const provider = String(input.provider ?? "").trim()
			const apiKey = typeof input.apiKey === "string" ? input.apiKey : ""
			const providerSpecificData =
				input.providerSpecificData && typeof input.providerSpecificData === "object"
					? (input.providerSpecificData as Record<string, unknown>)
					: {}

			const ai = aiProvider(provider)
			const substituteField = ai?.apiKeyOptionalWith
			const hasSubstitute = !!(substituteField && providerSpecificData[substituteField])
			if (
				!provider ||
				(!apiKey && provider !== "ollama-local" && ai?.noAuth !== true && !hasSubstitute)
			) {
				throw invalid("Provider and API key required")
			}

			const early = await planFor(provider, apiKey, providerSpecificData)
			if (early && "valid" in early) return early

			if (ai?.credentialForm === "aws") {
				return probeAws({ apiKey, providerSpecificData })
			}
			if (provider === "nous") return probeNous(apiKey)
			if (provider === "qoder" || provider === "qoder-cn") {
				return probeQoder({ provider, apiKey, providerSpecificData })
			}
			if (provider === "vertex" || provider === "vertex-partner") {
				const serviceAccount = readServiceAccount(apiKey)
				if (serviceAccount.isServiceAccount) {
					return {
						valid: serviceAccount.valid,
						error: serviceAccount.valid ? null : refusalMessage(provider),
					}
				}
			}

			const webProbe = await probeConfigDriven(provider, apiKey, "web")
			if (webProbe) return webProbe
			const mediaProbe = await probeConfigDriven(provider, apiKey, "media")
			if (mediaProbe) return mediaProbe

			// `early` is either an answer already reached (the custom-embedding probe
			// answers during planning) or a plan; a plan is the only shape with
			// `request`, so the field decides which.
			const earlyPlan = early && "request" in early ? early : null
			const plan = earlyPlan ?? staticPlan(provider, apiKey) ?? genericPlan(provider, apiKey)
			if (!plan) throw invalid("Provider validation not supported")

			const response = await send(plan.request)
			const valid = plan.verdict(response)
			return { valid, error: valid ? null : (plan.errorMessage ?? refusalMessage(provider)) }
		},
	}

	/**
	 * Probe a web or media provider through its own config block.
	 *
	 * Returns null when the provider is not that kind, so the caller falls through:
	 * a provider that serves both chat and search is validated on the chat lane,
	 * which is the lane its key is actually used on.
	 */
	async function probeConfigDriven(
		provider: string,
		apiKey: string,
		kind: "web" | "media",
	): Promise<ValidationResult | null> {
		const ai = aiProvider(provider)
		if (!ai) return null
		const kinds = ai.serviceKinds ?? ["llm"]
		const mediaKinds = new Set(["tts", "embedding", "stt", "image", "video", "music", "imageToText"])

		if (kind === "web") {
			const isWebOnly = kinds.every((k) => k === "webSearch" || k === "webFetch")
			if (!isWebOnly) return null
			const cfg = ai.searchConfig ?? ai.fetchConfig
			if (!cfg) return null
			if (cfg.authType === "none") return { valid: true, error: null }
			const request = authRequest(provider, cfg, apiKey, "web")
			if (!request) return { valid: true, error: null }
			const response = await send(request)
			const valid = webProbeVerdict(response.status)
			return { valid, error: valid ? null : refusalMessage(provider) }
		}

		const isMediaOnly = kinds.every((k) => mediaKinds.has(k))
		if (!isMediaOnly) return null
		const cfg =
			ai.ttsConfig ??
			ai.sttConfig ??
			ai.embeddingConfig ??
			ai.imageConfig ??
			ai.videoConfig ??
			ai.musicConfig
		// No probe config: accept best-effort and let the first real call decide.
		if (!cfg) return { valid: true, error: null }
		if (ai.noAuth || cfg.authType === "none") return { valid: true, error: null }
		const request = authRequest(provider, cfg, apiKey, "media")
		// A scheme needing data this endpoint does not carry cannot be probed; saying
		// so beats falling through to "not supported", which reads as a dashboard bug.
		if (!request) return { valid: true, error: null }
		const response = await send(request)
		const valid = mediaProbeVerdict(response.status)
		return { valid, error: valid ? null : refusalMessage(provider) }
	}

	/**
	 * The request a config block describes.
	 *
	 * The auth schemes that need provider-specific data — PlayHT's two-header form,
	 * AWS sigv4 — return null, which the caller reads as "cannot probe": reporting
	 * them invalid would refuse a key that is fine.
	 */
	function authRequest(
		provider: string,
		cfg: ProbeConfig,
		apiKey: string,
		kind: "web" | "media",
	): ProbeRequest | null {
		const headers: Record<string, string> = { ...json, ...(cfg.extraHeaders ?? {}) }
		let url = cfg.validateUrl ?? cfg.baseUrl ?? ""
		let body: string | undefined

		if (kind === "web") {
			switch (cfg.authHeader) {
				case "bearer":
					headers.Authorization = `Bearer ${apiKey}`
					break
				case "x-api-key":
					headers["x-api-key"] = apiKey
					break
				case "x-subscription-token":
					headers["x-subscription-token"] = apiKey
					break
				case "key":
					url += `?key=${encodeURIComponent(apiKey)}&q=ping&cx=test`
					break
				case "api_key":
					url += `?api_key=${encodeURIComponent(apiKey)}&q=ping&engine=google`
					break
			}
			if (cfg.method === "POST") {
				body = JSON.stringify({ query: "ping", q: "ping", url: "https://example.com" })
			}
			return { url, method: cfg.method ?? "GET", headers, ...(body ? { body } : {}) }
		}

		if (cfg.authHeader === "playht" || cfg.authHeader === "aws-sigv4") return null
		switch (cfg.authHeader) {
			case "bearer":
				headers.Authorization = `Bearer ${apiKey}`
				break
			case "key":
				headers.Authorization = `Key ${apiKey}`
				break
			case "x-api-key":
				headers["x-api-key"] = apiKey
				break
			case "x-key":
				headers["x-key"] = apiKey
				break
			case "xi-api-key":
				headers["xi-api-key"] = apiKey
				break
			case "token":
				headers.Authorization = `Token ${apiKey}`
				break
			case "basic":
				headers.Authorization = `Basic ${apiKey}`
				break
			default:
				return null
		}
		const method = cfg.method ?? "POST"
		if (method !== "GET") {
			body = JSON.stringify({
				input: "ping",
				text: "ping",
				prompt: "ping",
				model: defaultModel(provider) || "test",
			})
		}
		return { url, method, headers, ...(body ? { body } : {}) }
	}
}
