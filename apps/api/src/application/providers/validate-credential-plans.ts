/** Validate credential: static and generic probe plans. */

import type { AiProviderEntry, ProbePlan, RegistryEntry } from "./validate-credential-types.ts"
import {
	bearer,
	blackboxVerdict,
	byStatus,
	json,
	notRefused,
	readerFor,
	readServiceAccount,
	refusalMessage,
	toCookieHeader,
	unwrapCredential,
} from "./validate-credential-types.ts"

/** The host wiring a static/generic plan needs. */
export interface ProbePlanHost {
	readonly providerConfig: (provider: string) => RegistryEntry | undefined
	readonly aiProvider: (provider: string) => AiProviderEntry | undefined
	readonly defaultModel: (provider: string) => string
	readonly commandCodeBody: (model: string) => unknown
	readonly commandCodeHeaders: (input: {
		readonly apiKey: string
		readonly sessionId?: string
	}) => Record<string, string>
	readonly ollamaLocalHost: (input: { providerSpecificData?: Record<string, unknown> }) => string
	readonly tokenplanBaseUrl: (input: { providerSpecificData?: Record<string, unknown> }) => string
}

/**
 * The plan for a provider whose probe is a fixed request and a status reading.
 *
 * Each entry is data, not a branch: the same three-line shape repeated for
 * fifteen providers is what made the route 700 lines long.
 */
export function staticPlan(
	host: ProbePlanHost,
	provider: string,
	apiKey: string,
): ProbePlan | null {
	const {
		providerConfig,
		aiProvider,
		defaultModel,
		commandCodeBody,
		commandCodeHeaders,
		ollamaLocalHost,
		tokenplanBaseUrl,
	} = host
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
					url: "https://opencode.ai/inference/go/openai/v1/chat/completions",
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
export function genericPlan(
	host: ProbePlanHost,
	provider: string,
	apiKey: string,
): ProbePlan | null {
	const { providerConfig } = host
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
