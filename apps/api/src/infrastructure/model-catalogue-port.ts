/**
 * Adapters for the model catalogue, the daily sync and the single-model probe.
 *
 * Every function here is *supplied by the host*, not imported.
 *
 * The capability tables, the free-provider registry, the sync timer and the
 * probe all live in `apps/web` beside the gateway they describe. Importing them
 * from `apps/api` would drag `apps/web` into the API's TypeScript project, which
 * has neither the `@/` alias nor the `open-sse` path — a build error, not a
 * style preference. The host already owns those modules, so it passes them in,
 * exactly as it does for the pxpipe engine and the semantic cache.
 *
 * At construction nothing is read: `GET /api/models` is dynamic because plugin
 * badges change while the process runs.
 */
import type {
	CatalogueSyncPort,
	ModelCataloguePort,
	ModelProbePort,
} from "../application/models/ports.ts"

/** The catalogue file's summary. */
export type CatalogFileSummary = {
	syncedAt: string
	models: number
	providers: number
	bytes: number
} | null

/**
 * What the host supplies. Each entry mirrors one module the gateway already
 * uses, so there is no second implementation of any of them.
 */
export interface CatalogueHost {
	curatedModels(): Array<{ provider: string; model: string; name?: string }>
	fetchLiveFree(): Promise<
		Array<{ alias: string; model: string; name?: string; contextLength?: number }>
	>
	capabilities(
		provider: string,
		model: string,
	): {
		vision: boolean
		search: boolean
		reasoning: boolean
		contextWindow: number
		maxOutput: number
	}
	providerIdOf(alias: string): string
	aggregateCombo(
		members: string[],
		byName: Record<string, string[]>,
		contextWindow: number,
	): Record<string, unknown> | null
	displayName(model: string, fallback?: string): string
	generateId(): string
	normalizeLogo(value: unknown): string | null | undefined
	/** Returns the refusal message, or null when the URL may be used. */
	rejectUrl(raw: string, local: boolean): Promise<string | null>
	capabilityKeys(): readonly string[]
	/** The STT markers the dashboard may offer. */
	sttTransports(): readonly string[]
	readCatalogFile(): Promise<CatalogFileSummary>
	syncState(): Record<string, unknown>
	runSync(): Promise<unknown | null>
	ping(model: string, kind: string): Promise<Record<string, unknown>>
}

/** Refuses the call rather than answering from a catalogue that does not exist. */
export function unavailableCatalogue(host: string): never {
	throw new Error(`The model catalogue is not available in this process (${host})`)
}

export function createModelCataloguePort(host: CatalogueHost): ModelCataloguePort {
	return {
		async curated() {
			return host.curatedModels()
		},
		async liveFree() {
			return host.fetchLiveFree()
		},
		capabilities: (provider, model) => host.capabilities(provider, model),
		providerIdOf: (alias) => host.providerIdOf(alias),
		aggregateCombo: (members, byName, contextWindow) =>
			host.aggregateCombo(members, byName, contextWindow),
		displayName: (model, fallback) => host.displayName(model, fallback),
		generateId: () => host.generateId(),
		normalizeLogo: (value) => host.normalizeLogo(value),
		rejectUrl: (raw, local) => host.rejectUrl(raw, local),
		capabilityKeys: () => host.capabilityKeys(),
		sttTransports: () => host.sttTransports(),
	}
}

export function createCatalogueSyncPort(host: CatalogueHost): CatalogueSyncPort {
	return {
		state() {
			const state = host.syncState()
			return {
				lastSync: (state.lastSync as string | null) ?? null,
				lastError: (state.lastError as string | null) ?? null,
				lastResult: state.lastResult ?? null,
				intervalMs: Number(state.intervalMs ?? 0),
				file: String(state.file ?? ""),
				url: String(state.url ?? ""),
			}
		},
		fileSummary: () => host.readCatalogFile(),
		run: () => host.runSync(),
	}
}

export function createModelProbePort(host: CatalogueHost): ModelProbePort {
	return {
		ping: (model, kind) => host.ping(model, kind),
	}
}
