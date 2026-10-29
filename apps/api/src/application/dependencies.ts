/**
 * Use-case dependency container.
 *
 * Every side effect a use-case needs arrives here. Use-cases never import a
 * database, a cache, or a framework — which is what makes them testable with
 * plain fakes and keeps the composition root the single wiring point.
 */
import type { IApiKeyRepository } from "../domain/api-key.ts"
import type { PricingResetTarget, PricingUpdate } from "../domain/pricing.ts"
import type { BulkEditPort } from "./api-keys/bulk-edit-api-keys.ts"
import type { ApiKeyManagementPort } from "./api-keys/manage-api-keys-dashboard.ts"
import type { SingleKeyAuditPort, SingleKeyPort } from "./api-keys/manage-single-key.ts"
import type { ChangelogSource } from "./changelog.ts"
import type { SettingsPort } from "./settings/login-gate.ts"
import type { UsageReportPort } from "./usage/report-usage.ts"

export interface IActivityRepository {
	record(entry: {
		action: string
		subject: string
		payload?: Record<string, unknown>
		at: Date
	}): Promise<void>
}

/** A combo as the dashboard sees it — the row, with `models` parsed. */
export interface ComboView {
	readonly id: string
	readonly name: string
	readonly models: string[]
	readonly kind: string | null
	/** 0 means auto: the window follows the largest member. */
	readonly contextWindow: number
	readonly createdAt: string
	readonly updatedAt: string
}

export interface ComboInput {
	readonly name: string
	readonly models: string[]
	readonly kind?: string | null
	readonly contextWindow?: number
	readonly [key: string]: unknown
}

export interface ComboPort {
	list(): Promise<ComboView[]>
	findById(id: string): Promise<ComboView | null>
	findByName(name: string): Promise<ComboView | null>
	create(input: ComboInput): Promise<ComboView>
	update(id: string, input: Partial<ComboInput>): Promise<ComboView | null>
	remove(id: string): Promise<boolean>
}

/**
 * Per-combo routing strategies, stored in settings keyed by combo name. A combo
 * rename or copy has to move the entry, or the copy silently runs on defaults.
 */
export interface ComboStrategyPort {
	read(comboName: string): Promise<unknown | null>
	write(comboName: string, strategy: unknown): Promise<void>
}

/** One combo a preset source proposes, and whether it already exists. */
export interface ComboPresetItem {
	readonly name: string
	readonly models: string[]
	readonly exists: boolean
}

/**
 * A source of combo presets — Cursor's live catalog, Claude's CLI aliases. The
 * catalogs live in `apps/web` beside the constants they read, so the use-case
 * asks for items instead of importing them.
 */
export interface ComboPresetPort {
	/** `existingNames` lets the adapter mark items already present. */
	list(source: string, existingNames: readonly string[]): Promise<ComboPresetItem[]>
	isSource(value: unknown): boolean
}

/** A studio (custom) model and the single model it targets. */
export interface StudioTarget {
	readonly callName: string
	readonly targetModel: string
}

export interface StudioTargetPort {
	list(): Promise<StudioTarget[]>
}

/**
 * Combo rotation state lives in the gateway's runtime, not the database. The
 * use-case only needs to invalidate it; how is not its concern.
 */
export interface ComboRotationPort {
	reset(comboName: string): void
}

/** One stored diagnostic entry, as the dashboard renders it. */
export interface ErrorLogEntry {
	readonly id: number
	readonly [key: string]: unknown
}

export interface ErrorLogPort {
	/** Newest first, capped by the caller. */
	list(limit: number): Promise<ErrorLogEntry[]>
	/**
	 * Returns false when the delete did not happen. The handler used to report
	 * success regardless, so a failed clear looked like a successful one.
	 */
	clear(): Promise<boolean>
}

/** provider → model → field → rate, as the repo returns it. */
export type PricingMap = Record<string, Record<string, Record<string, number>>>

export interface PricingPort {
	/** The catalog merged with the operator's overrides. */
	read(): Promise<PricingMap>
	/** Applies a validated update and returns the merged result. */
	update(update: PricingUpdate): Promise<PricingMap>
	/** Resets one model, one provider, or everything, per the target. */
	reset(target: PricingResetTarget): Promise<PricingMap>
}

/**
 * The dashboard's key-management ports. Separate from `apiKeys` because the two
 * answer different questions: `apiKeys` is about authenticating a request with a
 * key, this is about the table an operator edits.
 */
export interface Dependencies {
	readonly apiKeys: IApiKeyRepository
	readonly dashboardApiKeys: ApiKeyManagementPort
	readonly bulkApiKeys: BulkEditPort
	readonly usageReports: UsageReportPort
	readonly singleApiKeys: SingleKeyPort
	readonly singleKeyAudit: SingleKeyAuditPort
	readonly apiKeyAudit: {
		recordKeyCreated(event: {
			readonly actor: string
			readonly keyName: string
			readonly permissions: unknown
		}): Promise<void>
		recordBulkUpdate(event: {
			readonly updatedCount: number
			readonly fields: readonly string[]
		}): Promise<void>
	}
	/** The pattern language, injected so the domain never re-implements it. */
	readonly matchesAllowedModels: (patterns: readonly string[], model: string) => boolean
	/** The endpoint kinds this deployment serves, from `packages/db`. */
	readonly endpointKinds: readonly string[]
	readonly activity: IActivityRepository
	readonly changelog: ChangelogSource
	readonly settings: SettingsPort
	readonly combos: ComboPort
	readonly errorLogs: ErrorLogPort
	readonly pricing: PricingPort
	readonly studios: StudioTargetPort
	readonly comboRotation: ComboRotationPort
	readonly comboPresets: ComboPresetPort
	readonly comboStrategies: ComboStrategyPort
	readonly now: () => Date
	/** Injected so tests can pin key material instead of hoping. */
	readonly randomId: () => string
}
