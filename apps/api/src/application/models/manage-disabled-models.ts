/**
 * Disabled-model bookkeeping and base-URL validation.
 *
 * `DELETE /api/models/disabled?providerAlias=x` with no `id` re-enables every
 * model for that provider — an empty `ids` means "all", not "none". That is the
 * kind of overloaded parameter worth naming once instead of re-deriving at each
 * call site, so it is settled here.
 *
 * Validation is a separate operation from saving a node on purpose: the operator
 * wants to know the key works *before* the node is stored, and a failed
 * validation must not leave a half-configured node behind.
 */
import { invalid } from "../../domain/errors.ts"
import type { DisabledModelPort, ModelCataloguePort } from "./ports.ts"

export interface DisabledModelDependencies {
	readonly disabled: DisabledModelPort
}

export function makeDisabledModels({ disabled }: DisabledModelDependencies) {
	return {
		/** A provider filter returns just that provider's ids, as the panel asks. */
		async list(providerAlias: string | null): Promise<Record<string, unknown>> {
			const all = await disabled.list()
			if (providerAlias) return { ids: all[providerAlias] ?? [] }
			return { disabled: all }
		},

		async disable(body: { providerAlias?: unknown; ids?: unknown }): Promise<{ success: true }> {
			if (typeof body.providerAlias !== "string" || !body.providerAlias.trim()) {
				throw invalid("providerAlias and ids[] required")
			}
			if (!Array.isArray(body.ids)) throw invalid("providerAlias and ids[] required")
			await disabled.disable(body.providerAlias.trim(), body.ids.map(String))
			return { success: true }
		},

		/**
		 * `id` re-enables one model; its absence re-enables the provider's whole
		 * list. Spelled out because `?providerAlias=x` alone looks like it should
		 * disable nothing rather than enable everything.
		 */
		async enable(input: {
			providerAlias: string | null
			id: string | null
		}): Promise<{ success: true }> {
			if (!input.providerAlias) throw invalid("providerAlias required")
			const ids = input.id ? [input.id] : []
			await disabled.enable(input.providerAlias, ids)
			return { success: true }
		},
	}
}

export type DisabledModels = ReturnType<typeof makeDisabledModels>

export interface BaseUrlValidationDependencies {
	readonly catalogue: ModelCataloguePort
	readonly probeBaseUrl: (input: {
		baseUrl: string
		apiKey: string
		type: string
		modelId?: string
	}) => Promise<Record<string, unknown>>
}

export function makeBaseUrlValidation({ catalogue, probeBaseUrl }: BaseUrlValidationDependencies) {
	return {
		/**
		 * Check a key against a base URL before the node is saved.
		 *
		 * The SSRF guard is applied to remote callers only: a self-hosted node
		 * (`http://localhost:11434`) is exactly what the operator is validating, and
		 * refusing it would make the dashboard unable to add a local provider.
		 */
		async validate(body: {
			baseUrl?: unknown
			apiKey?: unknown
			type?: unknown
			modelId?: unknown
			local: boolean
		}): Promise<Record<string, unknown>> {
			if (typeof body.baseUrl !== "string" || !body.baseUrl.trim()) {
				throw invalid("Base URL and API key required")
			}
			if (typeof body.apiKey !== "string" || !body.apiKey.trim()) {
				throw invalid("Base URL and API key required")
			}
			const baseUrl = body.baseUrl.trim()
			try {
				new URL(baseUrl)
			} catch {
				throw invalid("Invalid URL format")
			}
			const rejected = await catalogue.rejectUrl(baseUrl, body.local)
			if (rejected) throw invalid(rejected)

			return probeBaseUrl({
				baseUrl,
				apiKey: body.apiKey.trim(),
				type: typeof body.type === "string" && body.type ? body.type : "openai-compatible",
				modelId: typeof body.modelId === "string" ? body.modelId : undefined,
			})
		},
	}
}

export type BaseUrlValidation = ReturnType<typeof makeBaseUrlValidation>
