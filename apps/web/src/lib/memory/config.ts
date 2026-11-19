/**
 * Resolving the memory stage's configuration.
 *
 * **Nothing here is enabled globally.** The global `memory` block is connection
 * settings only — where Hindsight is, which bank, what budget — and it carries no
 * `enabled` flag. Turning the stage on is a per-scope decision, made in one of two
 * places:
 *
 *   - a **per-key opt-in**, stored in `kv` scope `memoryOptIn` and keyed by the
 *     key's id (see `memoryOptInRepo`). This is the default way: one key gets
 *     memory, every other key on the gateway does not.
 *   - `comboStrategies[<name>].memory.enabled`, for a combo that should always
 *     carry memory regardless of which key calls it.
 *
 * The reason for the split is blast radius. A global switch turns memory on for
 * every caller at once — including a public combo, where "retain" means one
 * caller's conversation becomes readable context for the next. A per-key or
 * per-combo switch makes enabling it an explicit act with a named owner, and
 * anything unnamed stays off.
 *
 * Both scopes share the same connection settings; they decide *whether* the stage
 * runs, and the narrowest scope that asked for it has the last word on tuning.
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
	 * (`host:omarchy`, `knowledge:decision`) rather than left untagged. Read-side
	 * only: the gateway never writes these, so a caller cannot reach another
	 * principal's write scope by naming one.
	 */
	sharedTags: string[]
	/**
	 * Tags stamped on every retain, in addition to the principal tag.
	 *
	 * Empty by default, and it should stay empty for a bank that serves a public
	 * combo. These tags are readable by every caller that lists them in
	 * `sharedTags`, so stamping one on retain publishes that conversation to all of
	 * them — a public caller's chat becomes another public caller's memory. Set it
	 * only when the bank has a single trusted writer (e.g. sharing one bank with a
	 * personal coding agent, where the "other caller" is you).
	 */
	retainTags: string[]
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
	retainTags: [],
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

export interface MemoryConfigInput {
	/** The settings row (`getSettings()`), or a partial stand-in. */
	settings: Record<string, unknown> | null | undefined
	/** The resolved combo entry name, when the request routes as one. */
	comboName?: string | null
	/**
	 * Whether the calling API key opted in (`memoryOptInRepo.isKeyOptedIn`).
	 *
	 * A key that opted in runs the stage even when no combo asks for it; that is the
	 * point of a per-key switch. Default false — an unknown or keyless caller gets no
	 * memory unless a combo it reaches explicitly enables it.
	 */
	keyOptedIn?: boolean
	/**
	 * Whether the caller may run the stage without opting in.
	 *
	 * Only for the dashboard/admin path and local single-user mode, where there is
	 * no third party whose conversation could leak into another's context. Passed
	 * explicitly rather than inferred from "no API key", because "no key" is also
	 * what a misconfigured public caller looks like.
	 */
	trustedCaller?: boolean
}

/**
 * Fold the connection settings, the per-combo block and the per-key opt-in into
 * one config for this request.
 *
 * Enablement is the OR of the scope decisions; the last word on tuning goes to the
 * narrowest scope that asked for the stage, so a combo's block beats the global
 * connection settings.
 */
export function resolveMemoryConfig(input: MemoryConfigInput): MemoryConfig {
	const { settings, comboName, keyOptedIn, trustedCaller } = input
	const global = asRecord(settings?.memory)
	const perCombo = comboName
		? asRecord(asRecord(settings?.comboStrategies)?.[comboName])?.memory
		: undefined
	const override = asRecord(perCombo) ?? {}

	const comboEnabled = asBoolean(override.enabled, false)
	const enabled = comboEnabled || keyOptedIn === true || trustedCaller === true
	// A scope that did not enable the stage contributes no tuning either: applying a
	// combo's knobs to a request the combo does not cover would tune a stage nobody
	// asked to run.
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
		retainTags: asTags(tuned.retainTags),
		recallBudget: asBudget(tuned.recallBudget, DEFAULTS.recallBudget),
		recallMaxTokens: asPositiveInt(tuned.recallMaxTokens, DEFAULTS.recallMaxTokens),
		timeoutMs: asPositiveInt(tuned.timeoutMs, DEFAULTS.timeoutMs),
	}
}

/** The bank path every endpoint hangs off. */
export function bankPath(bankId: string, suffix = ""): string {
	return `/v1/default/banks/${encodeURIComponent(bankId)}${suffix}`
}
