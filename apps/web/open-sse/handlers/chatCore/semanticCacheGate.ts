import { getAdapter } from "@9router/db/driver"
import {
	checkSemanticCache,
	checkSemanticCacheStream,
	hydrateSemanticCache,
	setSemanticCacheMaxEntries,
	setSemanticCacheTtlMs,
} from "../../rtk/semanticCache.ts"
import { measureCacheSavings, recordTokenSavings } from "../../rtk/tokenSaverStats.ts"
import { applyModelAlias, calledModelName } from "../../utils/modelAlias.ts"
import { saveUsageStats } from "./requestDetail.ts"

/**
 * Record a cache hit as a usage row.
 *
 * A hit is a request that cost nothing, and that is exactly why it has to be written down: the
 * saving is only checkable per key, per model and per day if the hit is a row with `cached = 1`
 * and a zero cost. The token counts come from the cached answer when it carries them; a streamed
 * hit has no parsed usage, and `0/0` with `cached = 1` is the honest shape.
 */
function recordCacheHitUsage(input: {
	provider: string
	model: string
	connectionId?: string | null
	apiKey?: string | null
	endpoint?: string | null
	tokens: Record<string, number> | null
}): void {
	saveUsageStats({
		provider: input.provider,
		model: input.model,
		tokens: input.tokens ?? { prompt_tokens: 0, completion_tokens: 0 },
		connectionId: input.connectionId,
		apiKey: input.apiKey,
		endpoint: input.endpoint,
		label: "CACHE HIT",
		silent: true,
		cached: true,
		// Nothing was called upstream, so the duration is the cache lookup, not a model.
		latency: { total: 0 },
	})
}

/** The `usage` block of a cached answer, when it has one. */
function cachedUsageOf(response: unknown): Record<string, number> | null {
	if (!response || typeof response !== "object") return null
	const usage = (response as { usage?: unknown }).usage
	return usage && typeof usage === "object" ? (usage as Record<string, number>) : null
}

export interface SemanticCacheGateInput {
	enabled?: boolean
	ttlHours?: number
	maxEntries?: number
	body: Record<string, unknown> & { stream?: boolean }
	provider: string
	model: string
	requestedModel?: string
	connectionId?: string
	apiKey?: string
	clientRawRequest?: { endpoint?: string; [key: string]: unknown }
	log?: {
		info?: (tag: string, message: string) => void
		[key: string]: unknown
	}
}

/**
 * Semantic / Duplicate Prompt Cache gate.
 *
 * Applies the settings (TTL + cap) and returns the cached answer as a
 * `Response` when the request is a hit, or `null` when the request must go
 * upstream. Both branches are here so the TTL wiring cannot run without the
 * lookup it exists for.
 */
export function semanticCacheGate(
	input: SemanticCacheGateInput,
): { success: true; response: Response } | null {
	const { enabled, body, provider, model, requestedModel, connectionId, apiKey, log } = input
	const { ttlHours, maxEntries } = input
	// Cache TTL and cap come from settings so the Token Saver sliders apply
	// without a proxy restart.
	if (enabled) {
		const hours = Number(ttlHours)
		if (Number.isFinite(hours) && hours > 0) setSemanticCacheTtlMs(hours * 60 * 60 * 1000)
		if (maxEntries > 0) setSemanticCacheMaxEntries(maxEntries)
		// Load the durable copy on first enabled request, not at import: the cache lives in `kv`
		// now, and a restart should not look like a cold install. Not awaited — the request in
		// hand must not wait for a table read it may not need.
		void hydrateSemanticCache()
	}

	if (enabled && !body.stream) {
		const cachedResponse = checkSemanticCache(body, `${provider}/${model}`)
		if (cachedResponse) {
			log?.info?.("CACHE", `⚡ Instant semantic cache hit for ${provider}/${model}`)
			// A hit replays the provider's own billed usage - that is exactly what
			// the second identical request would have cost.
			recordTokenSavings(getAdapter(), { provider, model, cache: measureCacheSavings(cachedResponse) })
			// The hit is a real request that cost nothing. Without this row the saving exists
			// only in a counter that dies with the process, and "what did the cache save this
			// key today" has no answer.
			recordCacheHitUsage({
				provider,
				model,
				connectionId,
				apiKey,
				endpoint: input.clientRawRequest?.endpoint,
				tokens: cachedUsageOf(cachedResponse),
			})
			// A cache hit must not name the model that originally served it either.
			applyModelAlias(cachedResponse, calledModelName(requestedModel, model))
			return {
				success: true,
				response: new Response(JSON.stringify(cachedResponse), {
					headers: { "Content-Type": "application/json", "X-9Router-Cache": "HIT" },
				}),
			}
		}
	}

	// Streamed hits replay the bytes that were captured after translation, so the client
	// receives the same frames it would have received the first time.
	if (enabled && body.stream) {
		const cachedStream = checkSemanticCacheStream(body, `${provider}/${model}`)
		if (cachedStream) {
			log?.info?.("CACHE", `⚡ Instant stream cache hit for ${provider}/${model}`)
			recordCacheHitUsage({
				provider,
				model,
				connectionId,
				apiKey,
				endpoint: input.clientRawRequest?.endpoint,
				tokens: null,
			})
			return {
				success: true,
				response: new Response(cachedStream, {
					headers: { "Content-Type": "text/event-stream", "X-9Router-Cache": "HIT" },
				}),
			}
		}
	}

	return null
}
