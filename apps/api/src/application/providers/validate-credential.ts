/** Validate credential. (Types in `validate-credential-types.ts`, static/generic plans in
 * `validate-credential-plans.ts`.) */
import { invalid, notFound } from "../../domain/errors.ts"
import type {
	ProbePlan,
	ProbeRequest,
	ProbeResponse,
	ValidateCredentialDependencies,
	ValidationResult,
} from "./validate-credential-types.ts"
import {
	anthropicCompatibleVerdict,
	cloudflareVerdict,
	mediaProbeVerdict,
	notRefused,
	readServiceAccount,
	refusalMessage,
	webProbeVerdict,
} from "./validate-credential-types.ts"

export type {
	AiProviderEntry,
	ProbeConfig,
	ProbeRequest,
	ProbeResponse,
	RegistryEntry,
	ValidateCredentialDependencies,
	ValidationResult,
} from "./validate-credential-types.ts"

import { genericPlan, staticPlan } from "./validate-credential-plans.ts"
import { probeConfigDriven } from "./validate-credential-probe-config.ts"
import type { ProbeConfig } from "./validate-credential-types.ts"
import { bearer, byStatus, json } from "./validate-credential-types.ts"

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

			const webProbe = await probeConfigDriven(
				{ send, aiProvider, defaultModel },
				provider,
				apiKey,
				"web",
			)
			if (webProbe) return webProbe
			const mediaProbe = await probeConfigDriven(
				{ send, aiProvider, defaultModel },
				provider,
				apiKey,
				"media",
			)
			if (mediaProbe) return mediaProbe

			// `early` is either an answer already reached (the custom-embedding probe
			// answers during planning) or a plan; a plan is the only shape with
			// `request`, so the field decides which.
			const earlyPlan = early && "request" in early ? early : null
			const plan =
				earlyPlan ??
				staticPlan(
					{
						providerConfig,
						aiProvider,
						defaultModel,
						commandCodeBody,
						commandCodeHeaders,
						ollamaLocalHost,
						tokenplanBaseUrl,
					},
					provider,
					apiKey,
				) ??
				genericPlan(
					{
						providerConfig,
						aiProvider,
						defaultModel,
						commandCodeBody,
						commandCodeHeaders,
						ollamaLocalHost,
						tokenplanBaseUrl,
					},
					provider,
					apiKey,
				)
			if (!plan) throw invalid("Provider validation not supported")

			const response = await send(plan.request)
			const valid = plan.verdict(response)
			return { valid, error: valid ? null : (plan.errorMessage ?? refusalMessage(provider)) }
		},
	}
}
