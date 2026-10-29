/**
 * The provider-connection host.
 *
 * `apps/api` cannot import these modules itself: `apps/web` resolves `@/` aliases
 * and `open-sse/` that this project's TypeScript does not know. So the owning
 * app supplies them as functions and the use-case only sees ports.
 */

import type { ConnectionHost } from "9router-api/infrastructure/db/repositories/provider-connection-repository"
import { createProviderCatalogue } from "9router-api/infrastructure/db/repositories/provider-connection-repository"
import { getProviderModels, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels"
import { PROVIDERS } from "open-sse/config/providers"
import { resolveProviderAlias } from "open-sse/services/model"
import { pingModelByKind, WEB_COOKIE_PROVIDERS } from "@/app/api/models/test/ping"
import { getSettings, updateSettings } from "@/lib/localDb"
import {
	createProviderConnection,
	deleteProviderConnection,
	getProviderConnectionById,
	getProviderConnections,
	getProviderNodeById,
	getProviderNodes,
	getProxyPoolById,
	updateProviderConnection,
} from "@/models"
import { APIKEY_PROVIDERS, SERVER_CONFIG } from "@/shared/constants/config"
import {
	AI_PROVIDERS,
	FREE_TIER_PROVIDERS,
	isAnthropicCompatibleProvider,
	isCustomEmbeddingProvider,
	isOpenAICompatibleProvider,
	WEB_COOKIE_PROVIDERS as WEB_COOKIE_PROVIDER_IDS,
} from "@/shared/constants/providers"
import { toProviderConnectionResponse, usesAwsCredentialForm } from "./providerConnectionResponse"
import { normalizeProviderId, normalizeProviderSpecificData } from "./providerNormalization"

/** The three tables the connection use-case reads, as the stores expose them. */
export const connectionHost: ConnectionHost = {
	connections: {
		list: (filter) => getProviderConnections(filter),
		find: (id) => getProviderConnectionById(id),
		create: (fields) => createProviderConnection(fields),
		update: (id, fields) => updateProviderConnection(id, fields),
		remove: (id) => deleteProviderConnection(id),
	},
	nodes: {
		find: (id) => getProviderNodeById(id),
		list: () => getProviderNodes(),
	},
	pools: {
		exists: async (id) => !!(await getProxyPoolById(id)),
	},
}

/**
 * What kinds of provider exist.
 *
 * `acceptsApiKey` covers the API-key providers plus the dual-auth ones that live
 * under category `oauth` but declare an `apikey` auth mode — they are not in
 * `APIKEY_PROVIDERS`, so testing membership alone would refuse them.
 */
export const providerCatalogue = createProviderCatalogue({
	label: (provider) => AI_PROVIDERS[provider]?.name,
	isOpenAICompatible: isOpenAICompatibleProvider,
	isAnthropicCompatible: isAnthropicCompatibleProvider,
	isCustomEmbedding: isCustomEmbeddingProvider,
	isWebCookie: (provider) => !!WEB_COOKIE_PROVIDER_IDS[provider],
	acceptsApiKey: (provider) =>
		!!APIKEY_PROVIDERS[provider] || !!AI_PROVIDERS[provider]?.authModes?.includes("apikey"),
	isFreeTier: (provider) => !!FREE_TIER_PROVIDERS[provider],
	apiKeySubstituteField: (provider) => AI_PROVIDERS[provider]?.apiKeyOptionalWith ?? null,
	usesAwsCredentialForm,
})

/** What the connection use-case needs beyond the tables. */
export const connectionResponse = toProviderConnectionResponse

export { normalizeProviderId, normalizeProviderSpecificData }

/**
 * Where the header overrides live, and the two lookups that read them.
 *
 * `resolveProviderAlias` maps the id a URL carries (`gcli`) to the canonical
 * registry id (`gemini-cli`). Keying by the raw id is what let one provider
 * accumulate two override entries.
 */
export const providerOverrides = {
	async read() {
		const settings = await getSettings()
		return (settings.providerOverrides as Record<string, { headers?: Record<string, string> }>) || {}
	},
	async write(overrides: Record<string, unknown>) {
		await updateSettings({ providerOverrides: overrides })
	},
	resolveAlias: (id: string) => resolveProviderAlias(id),
	builtinHeaders: (canonical: string) =>
		(PROVIDERS as Record<string, { headers?: Record<string, string> }>)[canonical]?.headers || {},
}

/**
 * The free-model cache: one entry per process.
 *
 * Kept here rather than in the use-case so the lifetime belongs to the process
 * that owns it; the use-case only decides when the entry counts as fresh.
 */
let freeModelEntry: { value: unknown[]; storedAt: number } | null = null

export const freeModelCache = {
	read: () => freeModelEntry as never,
	write: (entry: { value: unknown[]; storedAt: number }) => {
		freeModelEntry = entry
	},
}

const KILO_MODELS_URL = "https://api.kilo.ai/api/gateway/models"

/** Kilo marks its free tier with `isFree`; the caller keeps only those. */
export async function fetchKiloCatalogue(): Promise<readonly Record<string, unknown>[]> {
	const res = await fetch(KILO_MODELS_URL, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(10000),
	})
	if (!res.ok) throw new Error(`Kilo API returned ${res.status}`)
	const json = (await res.json()) as { data?: readonly Record<string, unknown>[] }
	return json.data ?? []
}

/** The models the catalogue knows for an alias, in the probe's target shape. */
export function probeTargetsFor(alias: string) {
	return getProviderModels(alias).map(
		(model: { id?: string; name?: string; kind?: string; type?: string }) => ({
			id: model.id ?? "",
			name: model.name,
			kind: model.kind,
			type: model.type,
		}),
	)
}

/** The alias the router resolves this provider id through. */
export function providerAliasOf(provider: string): string {
	return PROVIDER_ID_TO_ALIAS[provider] || provider
}

/**
 * A compatible connection's live model list, read through the local route.
 *
 * Probing asks the same endpoint the dashboard's model panel asks, so the probe
 * sees the same list the operator sees. A refusal here is not fatal: the caller
 * falls back to the catalogue.
 */
export async function fetchConnectionModels(
	connectionId: string,
): Promise<readonly Record<string, unknown>[] | null> {
	const baseUrl = `http://127.0.0.1:${process.env.PORT || SERVER_CONFIG.port}`
	try {
		const res = await fetch(`${baseUrl}/api/providers/${connectionId}/models`)
		if (!res.ok) return null
		const data = (await res.json()) as { models?: readonly Record<string, unknown>[] }
		return data.models ?? null
	} catch {
		return null
	}
}

/** Probe one model through the router, which is the path the request would take. */
export async function probeModel(modelRef: string, kind: string): Promise<Record<string, unknown>> {
	const baseUrl = `http://127.0.0.1:${process.env.PORT || SERVER_CONFIG.port}`
	return pingModelByKind(modelRef, kind, baseUrl)
}

/**
 * Cookie-based providers queue per account, so their probes must not overlap.
 *
 * This is the set the probe budget uses, not the registry's `webCookie` category:
 * they share a name but not their contents, and the probe is what has to be
 * serialised.
 */
export function isSerialProbe(provider: string): boolean {
	return WEB_COOKIE_PROVIDERS.has(provider)
}
