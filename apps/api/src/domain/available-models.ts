/**
 * Model catalogue health: whether a row is reachable right now.
 *
 * `/api/usage/available-models` rebuilds the whole catalog server-side because a key session
 * holding only `viewUsage` cannot open `/api/models`. Assembling the rows is I/O; deciding what
 * *health* each row has is not, and it is where the answers were quietly wrong:
 *
 * - **A provider is keyed two ways.** Connection rows store the provider id; catalog rows carry
 *   the display alias. Comparing only one spelling called a provider unknown and reported every
 *   model on it as ready — including on a provider with no working connection at all.
 * - **A lock is machine- or model-wide.** `modelLock_*` holds an ISO expiry; an empty suffix
 *   means "every model on this connection is cooling down". Reading `__all` as a model named
 *   `__all` reported the provider ready while every call would fail.
 * - **A combo is only as healthy as its worst member, and may nest.** A combo pointing at a
 *   combo recurses forever on a cycle, so the walk needs a seen-set as well as a depth bound.
 * - **A combo's context window is the smallest of its members.** Routing can land on any
 *   member, so the smallest is the limit the caller must plan against — not the largest.
 */

/** How healthy a catalog row is, worst first. */
export const MODEL_STATUSES = ["unavailable", "cooldown", "limited", "ready"] as const
export type ModelStatus = (typeof MODEL_STATUSES)[number]

const STATUS_RANK: Record<ModelStatus, number> = {
	unavailable: 0,
	cooldown: 1,
	limited: 2,
	ready: 3,
}

/** A combo may nest this deep before the walk gives up and reports the row ready. */
export const COMBO_WALK_DEPTH = 4

export function normalizeModelStatus(status: unknown): ModelStatus {
	const value = String(status ?? "")
		.trim()
		.toLowerCase()
	return Object.hasOwn(STATUS_RANK, value) ? (value as ModelStatus) : "ready"
}

/**
 * Folds a model id to the shape a `modelLock_*` column suffix uses.
 *
 * The column name holds the model id with `.`, `-` and `:` replaced by `_`, so `gpt-4o` is
 * stored as `modelLock_gpt_4o`. Comparing the raw id against the suffix never matched, and the
 * model that was actually cooling down was reported `limited` — a wrong answer that looks like
 * a working connection.
 */
export function lockKey(model: unknown): string {
	return String(model ?? "")
		.trim()
		.toLowerCase()
		.replace(/[.:-]/g, "_")
}

/**
 * The least healthy of a set.
 *
 * An unrecognised string normalises to `ready` rather than `unavailable`: an unknown status is
 * a provider naming something new, and hiding the model because of it would be worse than
 * showing it.
 */
export function worstModelStatus(statuses: readonly unknown[] | null | undefined): ModelStatus {
	let worst: ModelStatus = "ready"
	for (const status of statuses ?? []) {
		const normalised = normalizeModelStatus(status)
		if (STATUS_RANK[normalised] < STATUS_RANK[worst]) worst = normalised
	}
	return worst
}

/** Per-provider connection health, as counted from the live connection rows. */
export interface ProviderHealth {
	readonly active: number
	readonly unavailable: number
}

/**
 * The model ids a connection has locked, in `lockKey` form.
 *
 * `__all` means "every model this connection serves" and stays a marker rather than becoming a
 * model name — compared against a real model id it would never match. Expired locks are
 * dropped: the column holds an expiry, and a lock in the past is not a lock.
 */
export function activeModelLocks(
	connection: Record<string, unknown> | null | undefined,
	now: number,
): string[] {
	const locks: string[] = []
	for (const [key, value] of Object.entries(connection ?? {})) {
		if (!key.startsWith("modelLock_") || !value) continue
		const expiry = new Date(String(value)).getTime()
		if (!Number.isFinite(expiry) || expiry <= now) continue
		locks.push(key.slice("modelLock_".length).toLowerCase() || "__all")
	}
	return locks
}

/** Provider health and locks accumulated from the connection rows. */
export interface ProviderIndex {
	readonly health: ReadonlyMap<string, ProviderHealth>
	readonly locks: ReadonlyMap<string, readonly string[]>
}

/**
 * Folds connection rows into per-provider health and locks.
 *
 * Inactive connections are skipped entirely: a disabled connection is not a source of traffic,
 * and counting it as available would mark a provider ready that cannot serve.
 */
export function indexProviders(
	connections:
		| readonly {
				readonly provider?: unknown
				readonly isActive?: unknown
				readonly testStatus?: unknown
				readonly [key: string]: unknown
		  }[]
		| null,
	now: number,
): ProviderIndex {
	const health = new Map<string, { active: number; unavailable: number }>()
	const locks = new Map<string, string[]>()
	for (const connection of connections ?? []) {
		if (!connection?.provider) continue
		if (connection.isActive === false) continue
		const key = String(connection.provider).toLowerCase()
		const record = health.get(key) ?? { active: 0, unavailable: 0 }
		if (connection.testStatus === "unavailable") {
			record.unavailable += 1
		} else {
			record.active += 1
		}
		health.set(key, record)
		for (const lock of activeModelLocks(connection, now)) {
			const list = locks.get(key) ?? []
			list.push(lock)
			locks.set(key, list)
		}
	}
	return { health, locks }
}

/** The three spellings a provider may be addressed by, supplied by the caller's registry. */
export interface ProviderSpellings {
	readonly aliasOf: (provider: string) => string | null | undefined
	readonly idOf: (provider: string) => string | null | undefined
}

/**
 * The keys under which one provider may appear in the index.
 *
 * A catalog row carries the alias, a connection row carries the id, both lowercase. Comparing
 * only one spelling is what reported a provider with no working connection as ready.
 */
export function providerKeysOf(provider: string, spellings: ProviderSpellings): string[] {
	const keys = new Set<string>()
	for (const candidate of [provider, spellings.aliasOf(provider), spellings.idOf(provider)]) {
		const key = String(candidate ?? "")
			.trim()
			.toLowerCase()
		if (key) keys.add(key)
	}
	return [...keys]
}

/**
 * Whether a provider can serve right now.
 *
 * No connection row at all reports `ready`, not `unavailable`: credential-free providers serve
 * without one, and reporting them unavailable would hide every free model from the card. A
 * provider that *has* rows and none of them active reports `unavailable` — that distinction is
 * the whole point.
 */
export function providerStatus(
	provider: string,
	index: ProviderIndex,
	spellings: ProviderSpellings,
): ModelStatus {
	let found = false
	let active = 0
	for (const key of providerKeysOf(provider, spellings)) {
		const record = index.health.get(key)
		if (!record) continue
		found = true
		active += record.active
	}
	if (!found) return "ready"
	return active > 0 ? "ready" : "unavailable"
}

/**
 * Whether one model on a provider is locked.
 *
 * Three answers, and the middle one is the one that gets lost: a provider with *no* locks is
 * `ready`; locked for every model is `cooldown`; locked for some other model is `limited` —
 * that model still works, this one does not.
 */
export function modelLockStatus(
	provider: string,
	bareModel: unknown,
	index: ProviderIndex,
	spellings: ProviderSpellings,
): ModelStatus {
	const locks: string[] = []
	for (const key of providerKeysOf(provider, spellings)) {
		locks.push(...(index.locks.get(key) ?? []))
	}
	if (locks.length === 0) return "ready"
	if (locks.includes("__all")) return "cooldown"
	const bare = lockKey(bareModel)
	if (bare && locks.includes(bare)) return "cooldown"
	return "limited"
}

export interface ComboStatusDeps {
	readonly membersOf: (name: string) => readonly string[]
	readonly isCombo: (name: string) => boolean
	readonly providerStatusOf: (provider: string) => ModelStatus
	readonly modelLockStatusOf: (provider: string, bareModel: string) => ModelStatus
}

/**
 * The health of one combo member, which may itself be a combo.
 *
 * `seen` carries the combos currently being walked, not every combo ever visited: removing a
 * name on the way out lets one combo appear under two branches while a cycle still terminates.
 * A member with no `/` is a bare id in the provider's namespace or a combo name; when it is
 * neither there is nothing to resolve, so it reports ready rather than inventing a failure.
 */
export function memberStatus(
	member: unknown,
	seen: Set<string>,
	deps: ComboStatusDeps,
	depth = 0,
): ModelStatus {
	if (depth > COMBO_WALK_DEPTH) return "ready"
	const value = String(member ?? "").trim()
	if (!value) return "ready"

	if (deps.isCombo(value)) {
		if (seen.has(value)) return "ready" // a cycle: stop rather than recurse
		seen.add(value)
		const nested = deps.membersOf(value).map((id) => memberStatus(id, seen, deps, depth + 1))
		seen.delete(value)
		return nested.length > 0 ? worstModelStatus(nested) : "ready"
	}

	const slash = value.indexOf("/")
	if (slash > 0) {
		const provider = value.slice(0, slash)
		const bare = value.slice(slash + 1)
		return worstModelStatus([deps.providerStatusOf(provider), deps.modelLockStatusOf(provider, bare)])
	}
	return "ready"
}

/** The health of a whole combo: the worst of its members, nested ones included. */
export function comboStatus(name: string, deps: ComboStatusDeps): ModelStatus {
	const members = deps.membersOf(name)
	if (members.length === 0) return "ready"
	const seen = new Set<string>([name])
	return worstModelStatus(members.map((member) => memberStatus(member, seen, deps)))
}

/** Resolves a model id to its context window, or null when the table does not know it. */
export type ContextWindowLookup = (provider: string, bareModel: string) => number | null

/**
 * The smallest context window among a combo's members.
 *
 * Routing can land on any member, so the smallest is the limit the caller must plan against.
 * Nested combos are walked, and the depth bound mirrors `memberStatus`. A member whose window is
 * unknown contributes nothing: treating an absent window as zero would report 0 for every combo
 * containing one unknown model.
 */
export function comboContextWindow(
	name: string,
	membersOf: (name: string) => readonly string[],
	isCombo: (name: string) => boolean,
	lookup: ContextWindowLookup,
	depth = 0,
): number | null {
	if (depth > COMBO_WALK_DEPTH) return null
	const windows: number[] = []
	for (const raw of membersOf(name)) {
		const value = String(raw ?? "").trim()
		if (!value) continue

		if (isCombo(value)) {
			const nested = comboContextWindow(value, membersOf, isCombo, lookup, depth + 1)
			if (nested !== null) windows.push(nested)
			continue
		}

		const slash = value.indexOf("/")
		// A bare member id still resolves: the capability lookup matches with or without a
		// provider prefix.
		const window =
			slash > 0 ? lookup(value.slice(0, slash), value.slice(slash + 1)) : lookup("", value)
		if (window !== null) windows.push(window)
	}
	return windows.length > 0 ? Math.min(...windows) : null
}

/** A context window the capability table returned, normalised to a positive number or null. */
export function readContextWindow(capabilities: unknown): number | null {
	const window = Number((capabilities as { contextWindow?: unknown } | null)?.contextWindow)
	return Number.isFinite(window) && window > 0 ? window : null
}

/** Ids a plugin resolver may match a row against, so a combo inherits its members' marks. */
export function pluginMarkIds(
	entry: {
		readonly origin?: unknown
		readonly model?: unknown
		readonly provider?: unknown
		readonly fullModel?: unknown
		readonly routedModel?: unknown
	},
	memberIds: readonly string[],
): string[] {
	if (entry.origin === "combo") {
		return [String(entry.model ?? ""), `combo/${String(entry.model ?? "")}`, ...memberIds]
	}
	return [
		`${String(entry.provider ?? "")}/${String(entry.model ?? "")}`,
		String(entry.fullModel ?? ""),
		String(entry.routedModel ?? ""),
		String(entry.model ?? ""),
	]
}

/** The enabled plugin keys, each with the model ids it covers. */
export interface PluginSource {
	readonly key: string
	readonly models: ReadonlySet<string>
}

/**
 * Builds the plugin sources from stored settings.
 *
 * Only enabled plugins become sources: a disabled plugin still lists its models, and returning
 * marks for it would claim capability the operator turned off.
 */
export function enabledPluginSources(
	plugins:
		| Readonly<Record<string, { readonly enabled?: unknown; readonly models?: unknown }>>
		| null
		| undefined,
	knownKeys: readonly string[],
): PluginSource[] {
	const sources: PluginSource[] = []
	for (const key of knownKeys) {
		const config = plugins?.[key]
		if (config?.enabled !== true) continue
		sources.push({
			key,
			models: new Set(Array.isArray(config.models) ? (config.models as string[]) : []),
		})
	}
	return sources
}

/**
 * The plugin marks for one row.
 *
 * Every spelling of the row is offered, because a plugin's model set may be written against any
 * of them — the full id, the routed id, the bare id, or a combo name. Matching on one spelling
 * is why the Usage view showed no plugin mark for a model that clearly had one on `/api/models`.
 */
export function resolvePluginMarks(
	ids: readonly unknown[],
	sources: readonly PluginSource[],
): string[] {
	const candidates = ids.filter(Boolean).map(String)
	if (candidates.length === 0) return []
	return sources
		.filter((source) => candidates.some((id) => source.models.has(id)))
		.map((source) => source.key)
}

/** The key a display row is de-duplicated by: provider and model, case-folded. */
export function callPathKey(entry: {
	readonly provider?: unknown
	readonly model?: unknown
	readonly name?: unknown
}): string {
	const provider = String(entry.provider ?? "")
		.trim()
		.toLowerCase()
	const model = String(entry.model ?? entry.name ?? "")
		.trim()
		.toLowerCase()
	return `${provider}\u0000${model}`
}

/**
 * Keeps one row per call path.
 *
 * Two rows sharing a bare model id behind *different* providers are different call paths and
 * both stay — the card disambiguates the label. Two rows under the *same* provider and model
 * are one path listed twice (a marketing variant with the same id), which the operator reads as
 * "one model shown twice".
 */
export function distinctCallPaths<
	T extends { readonly provider?: unknown; readonly model?: unknown; readonly name?: unknown },
>(entries: readonly T[]): T[] {
	const seen = new Set<string>()
	const distinct: T[] = []
	for (const entry of entries) {
		const key = callPathKey(entry)
		if (seen.has(key)) continue
		seen.add(key)
		distinct.push(entry)
	}
	return distinct
}

/**
 * Whether the model is disabled in the operator's settings.
 *
 * The disabled list may be filed under the provider id or its alias, and a build that read only
 * one kept offering a model the operator had switched off.
 */
export function isModelDisabled(
	disabled: Readonly<Record<string, unknown>> | null,
	provider: string,
	model: string,
	aliasOf: (provider: string) => string | null | undefined,
): boolean {
	if (!disabled) return false
	const alias = aliasOf(provider) || provider
	const list = disabled[alias] ?? disabled[provider]
	return Array.isArray(list) && list.includes(model)
}
