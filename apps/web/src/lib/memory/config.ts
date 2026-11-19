/**
 * Resolving the memory stage's configuration.
 *
 * Two layers, no migration: the global defaults live in the `settings` row
 * (`DEFAULT_SETTINGS.memory`), and a combo may override any of them under
 * `comboStrategies[<name>].memory`. That is the same row and the same per-combo
 * map the routing strategy already reads, so nothing new is stored and a combo
 * can be given its own bank without touching the global setting.
 *
 * `enabled` is the master switch and the only field that cannot be turned on by
 * an override: a per-combo block may narrow or retune an enabled stage, never
 * enable one the operator left off.
 */

export type RecallBudget = "low" | "mid" | "high"

export interface MemoryConfig {
	enabled: boolean
	baseUrl: string
	/** Bearer token for the Hindsight deployment. Never logged, never returned. */
	apiKey: string
	/** The one bank every principal shares. */
	bankId: string
	recall: boolean
	retain: boolean
	/**
	 * Whether recall also returns the bank's untagged memories — the shared
	 * knowledge an admin or a scheduled consolidation job wrote.
	 *
	 * `true` means recall uses `tags_match: "any"` (this principal's memories plus
	 * untagged ones); `false` means `any_strict` (only this principal's). Off is the
	 * correct choice for a public combo with no curated shared corpus, because with
	 * it on, anything ever written untagged is readable by every caller.
	 */
	includeShared: boolean
	/**
	 * Extra tags OR'd into every recall, for a bank whose shared corpus is tagged
	 * rather than untagged.
	 *
	 * A bank seeded by another tool commonly tags its knowledge (`host:omarchy`,
	 * `knowledge:decision`) instead of leaving it untagged, and recall filtered to
	 * the principal tag alone would never see any of it. These are read-side only:
	 * the gateway never writes them, so a caller cannot inherit another principal's
	 * write scope by naming one.
	 */
	sharedTags: string[]
	recallBudget: RecallBudget
	recallMaxTokens: number
	timeoutMs: number
}

const DEFAULTS: MemoryConfig = {
	enabled: false,
	baseUrl: "http://localhost:8888",
	apiKey: "",
	bankId: "9router",
	recall: true,
	retain: true,
	includeShared: true,
	sharedTags: [],
	recallBudget: "mid",
	recallMaxTokens: 1200,
	timeoutMs: 800,
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback
}

function asPositiveInt(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number(value)
	return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback
}

function asBudget(value: unknown, fallback: RecallBudget): RecallBudget {
	return value === "low" || value === "mid" || value === "high" ? value : fallback
}

function asString(value: unknown, fallback: string): string {
	return typeof value === "string" ? value.trim() : fallback
}

/** A tag list, trimmed, without empties or duplicates. */
function asTags(value: unknown): string[] {
	if (!Array.isArray(value)) return []
	const seen = new Set<string>()
	for (const entry of value) {
		if (typeof entry !== "string") continue
		const tag = entry.trim()
		if (tag) seen.add(tag)
	}
	return [...seen]
}

/**
 * Fold the global block and an optional per-combo block into one config.
 *
 * @param settings the settings row (`getSettings()`), or a partial stand-in
 * @param comboName the resolved combo entry name, when the request routes as one
 */
export function resolveMemoryConfig(
	settings: Record<string, unknown> | null | undefined,
	comboName?: string | null,
): MemoryConfig {
	const global = asRecord(settings?.memory)
	const perCombo = comboName
		? asRecord(asRecord(settings?.comboStrategies)?.[comboName])?.memory
		: undefined
	const override = asRecord(perCombo) ?? {}

	const enabled = asBoolean(global?.enabled, DEFAULTS.enabled)
	// A per-combo block cannot enable a stage the operator left off; it only tunes
	// one that is already on.
	const tuned = enabled ? { ...(global ?? {}), ...override } : (global ?? {})

	return {
		enabled,
		baseUrl: asString(tuned.baseUrl, DEFAULTS.baseUrl),
		apiKey: asString(tuned.apiKey, DEFAULTS.apiKey),
		bankId: asString(tuned.bankId, DEFAULTS.bankId),
		recall: asBoolean(tuned.recall, DEFAULTS.recall),
		retain: asBoolean(tuned.retain, DEFAULTS.retain),
		includeShared: asBoolean(tuned.includeShared, DEFAULTS.includeShared),
		sharedTags: asTags(tuned.sharedTags),
		recallBudget: asBudget(tuned.recallBudget, DEFAULTS.recallBudget),
		recallMaxTokens: asPositiveInt(tuned.recallMaxTokens, DEFAULTS.recallMaxTokens),
		timeoutMs: asPositiveInt(tuned.timeoutMs, DEFAULTS.timeoutMs),
	}
}

/** The bank path every endpoint hangs off. */
export function bankPath(bankId: string, suffix = ""): string {
	return `/v1/default/banks/${encodeURIComponent(bankId)}${suffix}`
}
