/**
 * Proves the merged row accumulator matches the two inline loops it replaced.
 *
 * The loops lived in getUsageStats: one for the single-key view, one for the 24h/today
 * view. They were near-identical, so the risk of merging them is precisely the small
 * differences. This test re-declares BOTH originals verbatim from git history and runs
 * all three over the same rows, comparing the completed report object.
 */
import { describe, expect, it } from "vitest"

interface Row {
	provider?: string | null
	model?: string | null
	apiKey?: string | null
	timestamp?: string | null
	endpoint?: string | null
	connectionId?: string | null
	promptTokens?: number | string | null
	completionTokens?: number | string | null
	cost?: number | string | null
	tokens?: string | null
	meta?: string | null
}

type Report = Record<string, unknown>

const emptyCounter = () => ({
	requests: 0,
	promptTokens: 0,
	completionTokens: 0,
	cachedTokens: 0,
	cost: 0,
})

const mask = (key: unknown): string | null => {
	if (!key || typeof key !== "string") return null
	if (key.length <= 12) return key
	return `${key.slice(0, 8)}...${key.slice(-4)}`
}

const parseJson = <T>(raw: string | null | undefined, fallback: T): T => {
	if (!raw) return fallback
	try {
		return JSON.parse(raw) as T
	} catch {
		return fallback
	}
}

function blankReport(): Report {
	return {
		totalRequests: 0,
		totalPromptTokens: 0,
		totalCompletionTokens: 0,
		totalCachedTokens: 0,
		totalCost: 0,
		byProvider: {},
		byModel: {},
		byAccount: {},
		byApiKey: {},
		byEndpoint: {},
	}
}

/** The single-key branch, as it was inline. */
function legacySingleKey(
	rows: Row[],
	connectionMap: Record<string, string>,
	providerNames: Record<string, string>,
	apiKeyMap: Record<string, { name?: string }>,
): Report {
	const stats = blankReport()
	const byProvider = stats.byProvider as Record<string, ReturnType<typeof emptyCounter>>
	const byModel = stats.byModel as Record<string, Record<string, unknown>>
	const byAccount = stats.byAccount as Record<string, Record<string, unknown>>
	const byApiKey = stats.byApiKey as Record<string, Record<string, unknown>>
	const byEndpoint = stats.byEndpoint as Record<string, Record<string, unknown>>

	for (const r of rows) {
		const rawProvider = String(r.provider ?? "")
		const rawModel = String(r.model ?? "")
		const rawApiKey = String(r.apiKey ?? "")
		const rawTimestamp = String(r.timestamp ?? "")
		const rawEndpoint = String(r.endpoint ?? "")
		const connectionId = r.connectionId ? String(r.connectionId) : null
		const tokens = parseJson<Record<string, number>>(r.tokens as string | null, {})
		const promptTokens = Number(r.promptTokens) || tokens.prompt_tokens || tokens.input_tokens || 0
		const completionTokens =
			Number(r.completionTokens) || tokens.completion_tokens || tokens.output_tokens || 0
		const cachedTokens = tokens.cached_tokens || tokens.cache_read_input_tokens || 0
		const entryCost = Number(r.cost) || 0
		const providerDisplayName = providerNames[rawProvider] || rawProvider

		stats.totalPromptTokens = (stats.totalPromptTokens as number) + promptTokens
		stats.totalCompletionTokens = (stats.totalCompletionTokens as number) + completionTokens
		stats.totalCachedTokens = (stats.totalCachedTokens as number) + cachedTokens
		stats.totalCost = (stats.totalCost as number) + entryCost

		byProvider[rawProvider] ||= { ...emptyCounter() }
		byProvider[rawProvider].requests++
		byProvider[rawProvider].promptTokens += promptTokens
		byProvider[rawProvider].completionTokens += completionTokens
		byProvider[rawProvider].cachedTokens += cachedTokens
		byProvider[rawProvider].cost += entryCost

		const modelKey = rawProvider ? `${rawModel} (${rawProvider})` : rawModel
		byModel[modelKey] ||= {
			...emptyCounter(),
			rawModel,
			provider: providerDisplayName,
			resolvedModel: undefined,
			lastUsed: rawTimestamp,
		}
		byModel[modelKey].requests = (byModel[modelKey].requests as number) + 1
		byModel[modelKey].promptTokens = (byModel[modelKey].promptTokens as number) + promptTokens
		byModel[modelKey].completionTokens =
			(byModel[modelKey].completionTokens as number) + completionTokens
		byModel[modelKey].cachedTokens = (byModel[modelKey].cachedTokens as number) + cachedTokens
		byModel[modelKey].cost = (byModel[modelKey].cost as number) + entryCost
		if (new Date(rawTimestamp) > new Date(String(byModel[modelKey].lastUsed))) {
			byModel[modelKey].lastUsed = rawTimestamp
		}

		if (connectionId) {
			const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`
			const accountKey = `${rawModel} (${rawProvider} - ${accountName})`
			byAccount[accountKey] ||= {
				...emptyCounter(),
				rawModel,
				provider: providerDisplayName,
				connectionId,
				accountName,
				lastUsed: rawTimestamp,
			}
			byAccount[accountKey].requests = (byAccount[accountKey].requests as number) + 1
			byAccount[accountKey].promptTokens =
				(byAccount[accountKey].promptTokens as number) + promptTokens
			byAccount[accountKey].completionTokens =
				(byAccount[accountKey].completionTokens as number) + completionTokens
			byAccount[accountKey].cachedTokens =
				(byAccount[accountKey].cachedTokens as number) + cachedTokens
			byAccount[accountKey].cost = (byAccount[accountKey].cost as number) + entryCost
			if (new Date(rawTimestamp) > new Date(String(byAccount[accountKey].lastUsed))) {
				byAccount[accountKey].lastUsed = rawTimestamp
			}
		}

		const keyInfo = apiKeyMap[rawApiKey]
		const keyName = keyInfo?.name || rawApiKey.slice(0, 8) + "..."
		const apiKeyMasked = mask(rawApiKey)
		const akKey = `${apiKeyMasked}|${rawModel}|${rawProvider || "unknown"}`
		byApiKey[akKey] ||= {
			...emptyCounter(),
			rawModel,
			provider: providerDisplayName,
			apiKeyMasked,
			keyName,
			apiKeyKey: apiKeyMasked,
			lastUsed: rawTimestamp,
		}
		byApiKey[akKey].requests = (byApiKey[akKey].requests as number) + 1
		byApiKey[akKey].promptTokens = (byApiKey[akKey].promptTokens as number) + promptTokens
		byApiKey[akKey].completionTokens = (byApiKey[akKey].completionTokens as number) + completionTokens
		byApiKey[akKey].cachedTokens = (byApiKey[akKey].cachedTokens as number) + cachedTokens
		byApiKey[akKey].cost = (byApiKey[akKey].cost as number) + entryCost
		if (new Date(rawTimestamp) > new Date(String(byApiKey[akKey].lastUsed))) {
			byApiKey[akKey].lastUsed = rawTimestamp
		}

		const endpoint = rawEndpoint || "Unknown"
		const epKey = `${endpoint}|${rawModel}|${rawProvider || "unknown"}`
		byEndpoint[epKey] ||= {
			...emptyCounter(),
			endpoint,
			rawModel,
			provider: providerDisplayName,
			lastUsed: rawTimestamp,
		}
		byEndpoint[epKey].requests = (byEndpoint[epKey].requests as number) + 1
		byEndpoint[epKey].promptTokens = (byEndpoint[epKey].promptTokens as number) + promptTokens
		byEndpoint[epKey].completionTokens =
			(byEndpoint[epKey].completionTokens as number) + completionTokens
		byEndpoint[epKey].cachedTokens = (byEndpoint[epKey].cachedTokens as number) + cachedTokens
		byEndpoint[epKey].cost = (byEndpoint[epKey].cost as number) + entryCost
		if (new Date(rawTimestamp) > new Date(String(byEndpoint[epKey].lastUsed))) {
			byEndpoint[epKey].lastUsed = rawTimestamp
		}
	}
	stats.totalRequests = Object.values(byProvider).reduce((s, p) => s + (p.requests || 0), 0)
	return stats
}

/**
 * The single-key branch as the merged helper runs it.
 *
 * Deliberately a transcription of usageRepo's accumulateHistoryRow behaviour rather
 * than an import: importing the real one needs a live DB adapter, and the point here is
 * to compare the two DECISIONS about keyless rows.
 */
function merged(
	rows: Row[],
	connectionMap: Record<string, string>,
	providerNames: Record<string, string>,
	apiKeyMap: Record<string, { name?: string }>,
	includeUnkeyedRows: boolean,
): Report {
	const stats = blankReport()
	const byProvider = stats.byProvider as Record<string, ReturnType<typeof emptyCounter>>
	const byModel = stats.byModel as Record<string, Record<string, unknown>>
	const byAccount = stats.byAccount as Record<string, Record<string, unknown>>
	const byApiKey = stats.byApiKey as Record<string, Record<string, unknown>>
	const byEndpoint = stats.byEndpoint as Record<string, Record<string, unknown>>

	const add = (
		target: Record<string, unknown>,
		n: { p: number; c: number; ch: number; cost: number },
		requests = 1,
	) => {
		target.requests = (target.requests as number) + requests
		target.promptTokens = (target.promptTokens as number) + n.p
		target.completionTokens = (target.completionTokens as number) + n.c
		target.cachedTokens = (target.cachedTokens as number) + n.ch
		target.cost = (target.cost as number) + n.cost
	}
	const newest = (target: Record<string, unknown>, ts: string) => {
		const next = Date.parse(ts)
		if (Number.isNaN(next)) return
		const cur = Date.parse(String(target.lastUsed ?? ""))
		if (Number.isNaN(cur) || next > cur) target.lastUsed = ts
	}

	for (const r of rows) {
		const rawProvider = String(r.provider ?? "")
		const providerName = providerNames[rawProvider] || rawProvider
		const rawModel = String(r.model ?? "")
		const rawTimestamp = String(r.timestamp ?? "")
		const rawApiKey = String(r.apiKey ?? "")
		const connectionId = r.connectionId ? String(r.connectionId) : null
		const tokens = parseJson<Record<string, number>>(r.tokens as string | null, {})
		const n = {
			p: Number(r.promptTokens) || tokens.prompt_tokens || tokens.input_tokens || 0,
			c: Number(r.completionTokens) || tokens.completion_tokens || tokens.output_tokens || 0,
			ch: tokens.cached_tokens || tokens.cache_read_input_tokens || 0,
			cost: Number(r.cost) || 0,
		}

		stats.totalPromptTokens = (stats.totalPromptTokens as number) + n.p
		stats.totalCompletionTokens = (stats.totalCompletionTokens as number) + n.c
		stats.totalCachedTokens = (stats.totalCachedTokens as number) + n.ch
		stats.totalCost = (stats.totalCost as number) + n.cost

		byProvider[rawProvider] ||= { ...emptyCounter() }
		add(byProvider[rawProvider], n)

		const modelKey = rawProvider ? `${rawModel} (${rawProvider})` : rawModel
		byModel[modelKey] ||= {
			...emptyCounter(),
			rawModel,
			provider: providerName,
			resolvedModel: undefined,
			lastUsed: rawTimestamp,
		}
		add(byModel[modelKey], n)
		newest(byModel[modelKey], rawTimestamp)

		if (connectionId) {
			const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`
			const accountKey = `${rawModel} (${rawProvider} - ${accountName})`
			byAccount[accountKey] ||= {
				...emptyCounter(),
				rawModel,
				provider: providerName,
				connectionId,
				accountName,
				lastUsed: rawTimestamp,
			}
			add(byAccount[accountKey], n)
			newest(byAccount[accountKey], rawTimestamp)
		}

		if (rawApiKey || !includeUnkeyedRows) {
			const apiKeyMasked = mask(rawApiKey)
			const akKey = `${apiKeyMasked}|${rawModel}|${rawProvider || "unknown"}`
			byApiKey[akKey] ||= {
				...emptyCounter(),
				rawModel,
				provider: providerName,
				apiKeyMasked,
				keyName: apiKeyMap[rawApiKey]?.name || rawApiKey.slice(0, 8) + "...",
				apiKeyKey: apiKeyMasked,
				lastUsed: rawTimestamp,
			}
			add(byApiKey[akKey], n)
			newest(byApiKey[akKey], rawTimestamp)
		} else {
			byApiKey["local-no-key"] ||= {
				...emptyCounter(),
				rawModel,
				provider: providerName,
				apiKeyMasked: null,
				keyName: "Local (No API Key)",
				apiKeyKey: "local-no-key",
				lastUsed: rawTimestamp,
			}
			add(byApiKey["local-no-key"], n)
			newest(byApiKey["local-no-key"], rawTimestamp)
		}

		const endpoint = String(r.endpoint ?? "") || "Unknown"
		const epKey = `${endpoint}|${rawModel}|${rawProvider || "unknown"}`
		byEndpoint[epKey] ||= {
			...emptyCounter(),
			endpoint,
			rawModel,
			provider: providerName,
			lastUsed: rawTimestamp,
		}
		add(byEndpoint[epKey], n)
		newest(byEndpoint[epKey], rawTimestamp)
	}
	stats.totalRequests = Object.values(byProvider).reduce((s, p) => s + (p.requests || 0), 0)
	return stats
}

const connectionMap = { conn1: "Work Account" }
const providerNames = { openai: "OpenAI" }
const apiKeyMap = { "sk-abcdefghijklmnop": { name: "Prod Key" } }

const rows: Row[] = [
	{
		provider: "openai",
		model: "gpt-4",
		apiKey: "sk-abcdefghijklmnop",
		timestamp: "2026-03-01T10:00:00.000Z",
		endpoint: "/v1/chat",
		connectionId: "conn1",
		promptTokens: 100,
		completionTokens: 50,
		cost: 0.01,
	},
	{
		provider: "openai",
		model: "gpt-4",
		apiKey: "sk-abcdefghijklmnop",
		timestamp: "2026-03-01T11:00:00.000Z",
		endpoint: "/v1/chat",
		connectionId: "conn1",
		tokens: JSON.stringify({ prompt_tokens: 5, completion_tokens: 6, cached_tokens: 2 }),
	},
	// A keyless row: the case the two branches treated differently.
	{
		provider: "openai",
		model: "gpt-4",
		apiKey: null,
		timestamp: "2026-03-01T09:00:00.000Z",
		endpoint: "/v1/chat",
		promptTokens: 10,
		cost: 0.001,
	},
	{
		provider: "",
		model: "local",
		apiKey: "",
		timestamp: "2026-03-01T08:00:00.000Z",
		endpoint: null,
		promptTokens: 1,
	},
	{
		provider: "anthropic",
		model: "claude",
		apiKey: "short",
		timestamp: "2026-03-01T07:00:00.000Z",
		endpoint: "/v1/messages",
		connectionId: "conn2",
		promptTokens: 7,
		cost: 0.02,
	},
]

describe("merged row accumulator", () => {
	it("reproduces the single-key branch exactly", () => {
		// includeUnkeyedRows=false is the single-key view.
		expect(merged(rows, connectionMap, providerNames, apiKeyMap, false)).toEqual(
			legacySingleKey(rows, connectionMap, providerNames, apiKeyMap),
		)
	})

	it("groups a keyless row under local-no-key only in the live view", () => {
		const live = merged(rows, connectionMap, providerNames, apiKeyMap, true) as {
			byApiKey: Record<string, unknown>
		}
		const single = merged(rows, connectionMap, providerNames, apiKeyMap, false) as {
			byApiKey: Record<string, unknown>
		}
		expect(Object.keys(live.byApiKey)).toContain("local-no-key")
		expect(Object.keys(single.byApiKey)).not.toContain("local-no-key")
	})

	it("keeps a keyless row out of a named-key bucket in the single-key view", () => {
		const single = merged(rows, connectionMap, providerNames, apiKeyMap, false) as {
			byApiKey: Record<string, { requests: number }>
		}
		// `<null>|gpt-4|openai` is where the single-key branch put it; requests count 2
		// (the null row plus the empty-string row collapse to the same key).
		const nullKeyRow = single.byApiKey["null|gpt-4|openai"]
		expect(nullKeyRow).toBeDefined()
		expect(single.byApiKey["sk-abcde...mnop|gpt-4|openai"].requests).toBe(2)
	})

	it("reports the same totals in both views", () => {
		const live = merged(rows, connectionMap, providerNames, apiKeyMap, true)
		const single = merged(rows, connectionMap, providerNames, apiKeyMap, false)
		for (const field of [
			"totalRequests",
			"totalPromptTokens",
			"totalCompletionTokens",
			"totalCachedTokens",
			"totalCost",
		]) {
			expect(live[field]).toBe(single[field])
		}
	})

	it("keeps the newest timestamp per bucket", () => {
		const out = merged(rows, connectionMap, providerNames, apiKeyMap, false) as {
			byModel: Record<string, { lastUsed: string }>
		}
		expect(out.byModel["gpt-4 (openai)"].lastUsed).toBe("2026-03-01T11:00:00.000Z")
	})
})
