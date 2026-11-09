/**
 * Database backup/export types.
 *
 * Extracted verbatim from index.ts.
 */

/** Raw providerConnections row. */
export interface ProviderConnectionRow {
	id: string
	provider: string
	authType?: string
	name?: string | null
	email?: string | null
	priority?: number | null
	isActive?: number | null
	data?: string | null
	createdAt?: string
	updatedAt?: string
}

/** Raw providerNodes row. */
export interface ProviderNodeRow {
	id: string
	type?: string | null
	name?: string | null
	data?: string | null
	createdAt?: string
	updatedAt?: string
}

/** Raw proxyPools row. */
export interface ProxyPoolRow {
	id: string
	isActive?: number | null
	testStatus?: string | null
	data?: string | null
	createdAt?: string
	updatedAt?: string
}

/** Which sections a backup includes: null = all, array = only those, object = opt-out flags. */
export type ExportScope = string[] | Record<string, boolean> | null

/** A full database backup. Sections are optional because a scoped export omits them. */
export interface DbExportPayload {
	settings?: unknown
	providerConnections?: ProviderConnectionBackup[]
	providerNodes?: ProviderNodeBackup[]
	proxyPools?: ProxyPoolBackup[]
	apiKeys?: ApiKeyBackupRow[]
	combos?: ComboBackup[]
	usageHistory?: UsageHistoryBackupRow[]
	usageDaily?: UsageDailyBackupRow[]
	modelAliases?: Record<string, unknown>
	customModels?: CustomModelBackup[]
	mitmAlias?: Record<string, unknown>
	modelOverrides?: Record<string, unknown>
	pricing?: Record<string, unknown>
	disabledModels?: Record<string, unknown>
	autoBackup?: Record<string, unknown>
	[key: string]: unknown
}

/**
 * A providerConnections entry inside a backup file.
 *
 * The JSON payload of the row is spread back at the top level on export, so a
 * backup row carries the fixed columns *plus* arbitrary provider-specific keys.
 * `isActive` is a boolean here (the export normalises the 0/1 column), which is
 * why the backup shape is declared separately from the raw row.
 */
export interface ProviderConnectionBackup extends Record<string, unknown> {
	id: string
	provider?: string
	authType?: string
	name?: string | null
	email?: string | null
	priority?: number | null
	isActive?: boolean
	createdAt?: string
	updatedAt?: string
}

/** A providerNodes entry inside a backup file. */
export interface ProviderNodeBackup extends Record<string, unknown> {
	id: string
	type?: string | null
	name?: string | null
	createdAt?: string
	updatedAt?: string
}

/** A proxyPools entry inside a backup file. */
export interface ProxyPoolBackup extends Record<string, unknown> {
	id: string
	isActive?: boolean
	testStatus?: string | null
	createdAt?: string
	updatedAt?: string
}

/** A combos entry inside a backup file. */
export interface ComboBackup {
	id: string
	name?: string
	kind?: string
	models?: unknown[]
	createdAt?: string
	updatedAt?: string
	[key: string]: unknown
}

/** A custom model entry inside a backup file. */
export interface CustomModelBackup extends Record<string, unknown> {
	providerAlias: string
	id: string
	type?: string
}

/** A usageHistory entry inside a backup file. */
export interface UsageHistoryBackupRow extends Record<string, unknown> {
	timestamp?: string
	provider?: string | null
	model?: string | null
	connectionId?: string | null
	apiKey?: string | null
	endpoint?: string | null
	promptTokens?: number
	completionTokens?: number
	cost?: number
	status?: string | null
	tokens?: unknown
	meta?: unknown
}

/** A usageDaily entry inside a backup file. */
export interface UsageDailyBackupRow extends Record<string, unknown> {
	dateKey: string
	data?: unknown
}

/** A raw apiKeys table row (columns, not the API view). */
export interface ApiKeyRow {
	id: string
	key?: string
	name?: string
	machineId?: string
	isActive?: number
	createdAt?: string
	tokenLimit?: number
	usedTokens?: number
	limitKind?: string
	requestLimit?: number
	usedRequests?: number
	resetInterval?: string
	lastResetAt?: string | null
	allowedModels?: string
	allowedEndpoints?: string
	rpmLimit?: number
	tpmLimit?: number
	dailyCostLimit?: number
	costSpent?: number
	costDay?: string
	expiresAt?: string | null
	systemPrompt?: string
	permissions?: string
	createdBy?: string
	accessRestricted?: number
	accessAllow?: string
	[column: string]: unknown
}

/**
 * An apiKeys entry inside a backup file.
 *
 * Every field is optional: a backup written by an older version omits the
 * columns that did not exist yet, which is exactly why the import falls back to
 * the live row for anything absent.
 */
export interface ApiKeyBackupRow extends Record<string, unknown> {
	id: string
	key?: string
	name?: string | null
	machineId?: string | null
	isActive?: boolean
	createdAt?: string
	tokenLimit?: number
	usedTokens?: number
	limitKind?: string
	requestLimit?: number
	usedRequests?: number
	resetInterval?: string
	lastResetAt?: string | null
	allowedModels?: string
	allowedEndpoints?: string[]
	rpmLimit?: number
	tpmLimit?: number
	dailyCostLimit?: number
	costSpent?: number
	costDay?: string
	expiresAt?: string | null
	systemPrompt?: string
	permissions?: string
	createdBy?: string
	access?: unknown
}

/** Progress callback for the progressive import. */
export interface ImportProgress {
	done: number
	total: number
	percent: number
	currentSection: string | null
}
