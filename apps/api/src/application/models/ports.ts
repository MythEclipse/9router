/**
 * Model-registry ports.
 *
 * Twelve handlers read and wrote four different stores (aliases, disabled
 * models, custom models, studio models) plus the provider-node table, and each
 * one called those stores directly. The ports below name the operations the
 * use-cases need so the routes stop being the place where storage conventions
 * live.
 *
 * `AllowedModelReconciler` is a port rather than an import because it rewrites
 * API-key `allowedModels` arrays, and losing that call silently leaves keys
 * pointing at a model the operator just deleted. Making it explicit means a
 * use-case that forgets it fails a test instead of failing in production.
 */

export interface ModelAliasPort {
	/** alias → model, as stored. */
	list(): Promise<Record<string, string>>
	set(alias: string, model: string): Promise<void>
	remove(alias: string): Promise<void>
}

export interface DisabledModelPort {
	/** provider alias → disabled model ids. */
	list(): Promise<Record<string, string[]>>
	disable(providerAlias: string, ids: string[]): Promise<void>
	/** An empty `ids` re-enables everything for that provider. */
	enable(providerAlias: string, ids: string[]): Promise<void>
}

export interface CustomModelPort {
	list(): Promise<Array<Record<string, unknown>>>
	add(fields: Record<string, unknown>): Promise<unknown>
	remove(fields: { providerAlias: string; id: string; type: string }): Promise<void>
}

export interface StudioModelPort {
	list(): Promise<Array<Record<string, unknown>>>
	find(callName: string): Promise<Record<string, unknown> | null>
	save(fields: Record<string, unknown>): Promise<unknown>
	remove(callName: string): Promise<void>
}

/**
 * Rewrites stored API-key `allowedModels` lists after a model moves or goes
 * away. Returns the keys that were left with no models at all, which the
 * dashboard surfaces for review.
 */
export interface AllowedModelReconciler {
	reconcile(change: {
		removed?: string[]
		renamed?: Record<string, string>
	}): Promise<{ emptied: string[] }>
}

/** A provider connection, as availability cares about it. */
export interface ProviderConnectionRow {
	readonly id: string
	readonly provider: string
	readonly [key: string]: unknown
}

export interface ProviderConnectionPort {
	list(filter?: { provider?: string }): Promise<ProviderConnectionRow[]>
	update(id: string, patch: Record<string, unknown>): Promise<unknown>
}

/** A provider node, as stored. */
export interface ProviderNodeRow {
	readonly id: string
	readonly type?: string
	readonly name?: string
	readonly prefix?: string
	readonly baseUrl?: string
	readonly [key: string]: unknown
}

export interface ProviderNodePort {
	list(): Promise<ProviderNodeRow[]>
	find(id: string): Promise<ProviderNodeRow | null>
	create(fields: Record<string, unknown>): Promise<ProviderNodeRow>
	update(id: string, patch: Record<string, unknown>): Promise<ProviderNodeRow | null>
	remove(id: string): Promise<boolean>
	/** Drops the connections a node owns, so a deleted node leaves nothing behind. */
	removeConnections(providerId: string): Promise<void>
}

/** Model capabilities, as the dashboard row reports them. */
export interface Capabilities {
	readonly vision: boolean
	readonly search: boolean
	readonly reasoning: boolean
	readonly contextWindow: number
	readonly maxOutput: number
}

/** One model the dashboard lists, before plugin marks are applied. */
export interface CatalogueEntry {
	provider: string
	model: string
	name?: string
	contextLength?: number
}

/**
 * A live catalogue entry. Distinct from `CatalogueEntry` because a free
 * provider's models are keyed by the alias they route under, which is not the
 * same string as the registry's provider id.
 */
export interface LiveCatalogueEntry {
	alias: string
	model: string
	name?: string
	contextLength?: number
}

/** The catalogue the dashboard lists: curated rows plus the live free catalogue. */
export interface ModelCataloguePort {
	/** Models from the build-time registry, with the provider alias each routes under. */
	curated(): Promise<CatalogueEntry[]>
	/** Models a free provider currently publishes, fetched live. */
	liveFree(): Promise<LiveCatalogueEntry[]>
	capabilities(provider: string, model: string): Capabilities
	/** Resolves an alias to the provider id the capability tables are keyed by. */
	providerIdOf(alias: string): string
	/** What a combo's members add up to, or null when no member is known. */
	aggregateCombo(
		members: string[],
		byName: Record<string, string[]>,
		contextWindow: number,
	): Record<string, unknown> | null
	displayName(model: string, fallback?: string): string
	/** Free-text id for node ids (an adjective-noun pair, not a uuid). */
	generateId(): string
	/** `undefined` for an unusable logo, `null` for "none given". */
	normalizeLogo(value: unknown): string | null | undefined
	/**
	 * Guard against a base URL the server must not dial (loopback, link-local),
	 * for callers that are not local. Returns the refusal, or null when allowed.
	 */
	rejectUrl(raw: string, local: boolean): Promise<string | null>
	/** The STT transport markers the dashboard may select. */
	sttTransports(): readonly string[]
	/** The capability keys a custom model may store. */
	capabilityKeys(): readonly string[]
}

export interface CatalogueSyncPort {
	state(): {
		lastSync: string | null
		lastError: string | null
		lastResult: unknown
		intervalMs: number
		file: string
		url: string
	}
	/** Summary of the file on disk, or null when there is none. */
	fileSummary(): Promise<{
		syncedAt: string
		models: number
		providers: number
		bytes: number
	} | null>
	/** Returns null while a sync is already running. */
	run(): Promise<unknown | null>
}

/** Sends one probe request to a model and reports what happened. */
export interface ModelProbePort {
	ping(model: string, kind: string): Promise<Record<string, unknown>>
}

/** Combo rows, for the model list and the studio cycle guard. */
export interface ComboReaderPort {
	list(): Promise<Array<{ name: string; models?: string[]; contextWindow?: number }>>
}

/** Provider-node prefixes, so a picked `prefix/model` resolves to a node id. */
export interface NodePrefixPort {
	list(): Promise<Array<{ id: string; prefix?: string }>>
}
