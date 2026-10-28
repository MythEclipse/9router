/**
 * The combo page's capacity-adapter rules.
 *
 * A capacity adapter keeps a fallback pool per input modality: when a request needs
 * vision or audio and the chosen model cannot read it, the router swaps in the first
 * enabled pool model instead of failing. The pool is stored in settings, has an
 * older on-disk shape, and must never be allowed to go empty — all three of those
 * rules were scattered through the page with no test.
 */

/** Per-combo routing strategy persisted alongside the model list. */
export interface ComboStrategy {
	fallbackStrategy?: string
	judgeModel?: string
	routerModel?: string
	smartPolicy?: string
	sessionSticky?: boolean
	confidenceThreshold?: number
	[key: string]: unknown
}

/** One capability entry: on/off, rotation mode, and the models that serve it. */
export interface CapEntry {
	enabled: boolean
	roundRobin: boolean
	models: string[]
}

export type CapacityAdapter = Record<string, CapEntry>

/** The modalities the adapter covers, in display order. */
export const CAPACITY_ADAPTER_CAPS = [
	{ key: "vision", label: "Vision", icon: "visibility", desc: "images (png, jpg, webp, …)" },
	// pdf and videoInput stay hidden until the translators can carry those blocks.
	{ key: "audioInput", label: "Audio", icon: "graphic_eq", desc: "audio input" },
]

export const DEFAULT_FALLBACK_MODEL = "oc/mimo-v2.6-flash-free"

export const EMPTY_CAP_ENTRY: CapEntry = { enabled: true, roundRobin: false, models: [] }

export const EMPTY_CAPACITY_ADAPTER: CapacityAdapter = {
	vision: { ...EMPTY_CAP_ENTRY, models: [] },
	pdf: { ...EMPTY_CAP_ENTRY, models: [] },
	audioInput: { ...EMPTY_CAP_ENTRY, models: [] },
	videoInput: { ...EMPTY_CAP_ENTRY, models: [] },
}

/** A blank entry. Built per call so no two capabilities share one `models` array. */
function emptyCapEntry(): CapEntry {
	return { enabled: true, roundRobin: false, models: [] }
}

/** A retired model id, rewritten to its replacement on read. */
export const upgradeLegacyModel = (m: string) =>
	m === "oc/mimo-v2.5-free" ? DEFAULT_FALLBACK_MODEL : m

/**
 * Read one model reference out of a stored entry.
 *
 * The legacy shape held objects (`{model}`), and an entry whose model was blank used
 * to stringify to the literal `"[object Object]"` and get stored as a model id. Only
 * non-empty strings survive here.
 */
function legacyModelIdOf(entry: unknown): string {
	if (typeof entry === "string") return entry
	const maybe = entry as { model?: unknown } | null
	const id = typeof maybe?.model === "string" ? maybe.model : ""
	return id
}

/**
 * Read one capability entry, accepting both storage shapes.
 *
 * The legacy shape was an array of `{model, enabled}`; the current one is an object.
 * Anything unrecognized becomes a fresh empty entry rather than throwing, because a
 * corrupt settings row must not take the whole combos page down.
 */
export function normalizeCapEntry(entry: unknown): CapEntry {
	if (Array.isArray(entry)) {
		return {
			enabled: true,
			roundRobin: false,
			models: entry.map(legacyModelIdOf).map(upgradeLegacyModel).filter(Boolean),
		}
	}
	if (entry && typeof entry === "object") {
		const obj = entry as { enabled?: unknown; roundRobin?: unknown; models?: unknown }
		return {
			enabled: obj.enabled !== false,
			roundRobin: !!obj.roundRobin,
			models: Array.isArray(obj.models)
				? obj.models.map((m) => upgradeLegacyModel(String(m))).filter(Boolean)
				: [],
		}
	}
	return emptyCapEntry()
}

/** Normalize every known capability out of a raw settings blob. */
export function normalizeCapacityAdapter(raw: unknown): CapacityAdapter {
	const source = (raw || {}) as Record<string, unknown>
	const normalized: CapacityAdapter = {}
	for (const cap of CAPACITY_ADAPTER_CAPS) {
		normalized[cap.key] = normalizeCapEntry(source[cap.key])
	}
	return normalized
}

/**
 * The badge shown on a combo card for its smart policy.
 *
 * `confidenceThreshold` has been stored both as a fraction (0.85) and as a
 * percentage (85); the scale is inferred from whether it exceeds 1. A missing or
 * zero threshold means the default 80%, not 0%.
 */
export function getPolicyBadgeLabel(strategy: ComboStrategy = {}): string {
	const policy = strategy.smartPolicy || (strategy.sessionSticky === false ? "per-turn" : "smart")
	if (policy === "strict") return "Strict Lock"
	if (policy === "per-turn") return "Per-Turn"
	if (policy === "custom") {
		const raw = strategy.confidenceThreshold
		const fraction = raw ? (raw <= 1 ? raw : raw / 100) : 0.8
		const pct = Math.round(fraction * 100)
		return `Custom (≥${pct}%)`
	}
	return "Smart (≥80%)"
}

/** The model id a picker result refers to. */
function modelValueOf(model: unknown): string {
	if (typeof model === "string") return model
	const anyModel = model as { value?: string; name?: string } | null
	return anyModel?.value || anyModel?.name || ""
}

/**
 * Add a model to the pool, ignoring blanks and duplicates.
 *
 * Duplicates are rejected rather than deduped silently so the UI can stay honest
 * about what the user clicked.
 */
export function addCapModel(models: string[], model: unknown): string[] {
	const value = modelValueOf(model)
	if (!value || models.includes(value)) return models
	return [...models, value]
}

/**
 * Remove the model at `index`, keeping at least one entry.
 *
 * An empty pool would make the adapter a no-op while still reading as "enabled",
 * so the last removal resets to the default fallback instead.
 */
export function removeCapModelAt(models: string[], index: number): string[] {
	const next = models.filter((_, i) => i !== index)
	return next.length === 0 ? [DEFAULT_FALLBACK_MODEL] : next
}

/** Remove a model by value, with the same never-empty rule. */
export function removeCapModel(models: string[], model: unknown): string[] {
	const value = modelValueOf(model)
	const next = models.filter((m) => m !== value)
	return next.length === 0 ? [DEFAULT_FALLBACK_MODEL] : next
}

/** Move the model at `index` by `delta`, returning the list unchanged at a boundary. */
export function moveCapModel(models: string[], index: number, delta: number): string[] {
	const target = index + delta
	if (target < 0 || target >= models.length) return models
	const next = [...models]
	;[next[index], next[target]] = [next[target], next[index]]
	return next
}
