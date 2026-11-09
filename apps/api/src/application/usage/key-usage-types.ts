/** Per-key usage report: shared types. */
import type { MergedModelRow } from "../../domain/key-usage-report.ts"

/** The subset of a stored key the report reads; the host's record carries more. */
export interface KeyRecord {
	readonly id: string
	readonly name: string
	readonly key: string
	readonly createdBy?: unknown
	readonly isActive: boolean
	readonly createdAt?: string | null
	readonly expiresAt?: string | null
	readonly tokenLimit?: number
	readonly usedTokens?: number
	readonly resetInterval?: string | null
	readonly lastResetAt?: number | null
	readonly rpmLimit?: number
	readonly tpmLimit?: number
	readonly dailyCostLimit?: number | string | null
	readonly requestLimit?: number | string | null
	readonly usedRequests?: number | string | null
}

export interface KeyTotalRow {
	readonly requests: number
	readonly promptTokens: number
	readonly completionTokens: number
	readonly cost: number
	readonly lastUsed: string | null
}

export interface ModelTotalRow {
	readonly model: string
	readonly requests: number
	readonly tokens: number
	readonly cost: number
	readonly lastUsed: string | null
}

/** The aggregates for every key, as the port returns them. */
export interface KeyAggregates {
	readonly totals: Readonly<Record<string, KeyTotalRow>>
	readonly modelsByKey: Readonly<Record<string, readonly ModelTotalRow[]>>
	readonly errorsByKey: Readonly<Record<string, { readonly ok: number; readonly errors: number }>>
	/** Tokens per raw key inside its own quota window. */
	readonly tokensInWindow: Readonly<Record<string, number>>
}

export interface KeyUsageDeps {
	/** Every stored key, unfiltered: the visibility rule needs the whole list. */
	readonly listKeys: () => Promise<readonly KeyRecord[]>
	/** Narrows the list to what this session may see. */
	readonly visibleKeys: (keys: readonly KeyRecord[], session: unknown) => readonly KeyRecord[]
	/** Who created a key, resolved from the same full list. */
	readonly creatorNameOf: (createdBy: unknown, keys: readonly KeyRecord[]) => string | undefined
	/**
	 * The aggregate queries. Supplied by the infrastructure factory, not the host: they read the
	 * shared database, which the host does not own. Optional here so the host's object states
	 * only what the host knows; the factory fills the rest.
	 */
	readonly aggregatesOf?: (input: {
		readonly ownKey: string | null
		readonly keys: readonly KeyRecord[]
		readonly now: number
	}) => Promise<KeyAggregates>
	/** The budget kind and cap a key enforces, and how much of it is spent. */
	readonly budgetOf: (
		key: KeyRecord,
		context: { readonly tokenCap: number; readonly tokenUsed: number; readonly today: string },
	) => { readonly kind: string; readonly cap: number; readonly used: number }
	readonly spentTodayOf: (key: KeyRecord, today: string) => number
	readonly todayKey: () => string
	/** Masks a raw key for display. */
	readonly maskKey: (key: string) => string
	readonly now: () => number
}

/** One row of the report: quota state plus aggregates. */
export interface KeyUsageRow {
	readonly id: string
	readonly name: string
	readonly createdByName?: string
	readonly keyMasked: string
	readonly isActive: boolean
	readonly createdAt: string | null
	readonly expiresAt: string | null
	readonly expired: boolean
	readonly tokenLimit: number
	readonly usedTokens: number
	readonly usagePercent: number | null
	readonly resetInterval: string
	readonly nextResetAt: string | null
	readonly rpmLimit: number
	readonly tpmLimit: number
	readonly requests: number
	readonly promptTokens: number
	readonly completionTokens: number
	readonly totalTokens: number
	readonly cost: number
	readonly dailyCostLimit?: number
	readonly costSpentToday?: number
	readonly costPercent?: number | null
	readonly limitKind?: string
	readonly requestLimit?: number
	readonly usedRequests?: number
	readonly limitCap?: number
	readonly limitUsed?: number
	readonly limitPercent?: number | null
	readonly lastUsed: string | null
	readonly okRequests: number
	readonly errorRequests: number
	readonly errorRate: number
	readonly models: readonly (ModelTotalRow | MergedModelRow)[]
}

export interface KeyUsageReport {
	readonly keys: readonly KeyUsageRow[]
	readonly generatedAt: string
}
