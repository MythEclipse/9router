/**
 * Composition of every use-case over one `Dependencies` graph.
 *
 * The single place that knows which use-case exists. Routers receive this
 * object, never the database, so wiring stays centralised and a test can build
 * the same shape from fakes.
 */

import { makeBulkEditApiKeys } from "./api-keys/bulk-edit-api-keys.ts"
import { makeCreateApiKey } from "./api-keys/create-api-key.ts"
import { makeListApiKeys, makeRevokeApiKey } from "./api-keys/manage-api-keys.ts"
import { makeManageApiKeys } from "./api-keys/manage-api-keys-dashboard.ts"
import { makeManageSingleKey } from "./api-keys/manage-single-key.ts"
import { loadChangelog } from "./changelog.ts"
import {
	makeCheckComboCycle,
	makeCreateCombo,
	makeCreateComboPresets,
	makeDeleteCombo,
	makeDuplicateCombo,
	makeGetCombo,
	makeListCombos,
	makePreviewComboPresets,
	makeUpdateCombo,
} from "./combos/manage-combos.ts"
import type { Dependencies } from "./dependencies.ts"
import { makeClearErrorLogs, makeListErrorLogs } from "./error-logs/read-error-logs.ts"
import { makeReadPlugins, makeWritePlugins } from "./plugins/manage-plugins.ts"
import { makeGetPricing, makeResetPricing, makeUpdatePricing } from "./pricing/manage-pricing.ts"
import { assertSupportedLocale } from "./settings/locale.ts"
import { readLoginGate } from "./settings/login-gate.ts"
import { makeGetTheme, makeSetTheme } from "./settings/theme.ts"
import { makeCacheStats } from "./system/cache-stats.ts"
import { makeDashboardJobs } from "./system/dashboard-jobs.ts"
import { makeShutdownFromDashboard, makeShutdownFromHook } from "./system/shutdown.ts"
import { makeUsageReports } from "./usage/report-usage.ts"

export interface UseCases {
	readonly createApiKey: ReturnType<typeof makeCreateApiKey>
	readonly listApiKeys: ReturnType<typeof makeListApiKeys>
	readonly revokeApiKey: ReturnType<typeof makeRevokeApiKey>
	/** The dashboard's key table: list, create with scoping, bulk edit. */
	readonly dashboardKeys: ReturnType<typeof makeManageApiKeys>
	readonly bulkEditKeys: ReturnType<typeof makeBulkEditApiKeys>
	readonly singleKey: ReturnType<typeof makeManageSingleKey>
	/** The read-only usage endpoints: stats, chart, sparks, logs, history. */
	readonly usageReports: ReturnType<typeof makeUsageReports>
	readonly getChangelog: () => ReturnType<typeof loadChangelog>
	readonly getLoginGate: () => ReturnType<typeof readLoginGate>
	readonly listCombos: ReturnType<typeof makeListCombos>
	readonly createCombo: ReturnType<typeof makeCreateCombo>
	readonly getCombo: ReturnType<typeof makeGetCombo>
	readonly updateCombo: ReturnType<typeof makeUpdateCombo>
	readonly deleteCombo: ReturnType<typeof makeDeleteCombo>
	readonly duplicateCombo: ReturnType<typeof makeDuplicateCombo>
	readonly checkComboCycle: ReturnType<typeof makeCheckComboCycle>
	readonly previewComboPresets: ReturnType<typeof makePreviewComboPresets>
	readonly createComboPresets: ReturnType<typeof makeCreateComboPresets>
	readonly listErrorLogs: ReturnType<typeof makeListErrorLogs>
	readonly clearErrorLogs: ReturnType<typeof makeClearErrorLogs>
	readonly getTheme: ReturnType<typeof makeGetTheme>
	readonly setTheme: ReturnType<typeof makeSetTheme>
	/**
	 * Rejects an unsupported locale with VALIDATION. The supported list comes
	 * from the caller because the dashboard owns the translations.
	 */
	readonly assertLocale: (requested: unknown, supported: readonly string[]) => string
	readonly getPricing: ReturnType<typeof makeGetPricing>
	readonly updatePricing: ReturnType<typeof makeUpdatePricing>
	readonly resetPricing: ReturnType<typeof makeResetPricing>
	/** The custom-plugin settings, as one shape for both read and write. */
	readonly readPlugins: ReturnType<typeof makeReadPlugins>
	readonly writePlugins: ReturnType<typeof makeWritePlugins>
	/** Response-cache counters; `reset` answers with the zeroed snapshot. */
	readonly cacheStats: ReturnType<typeof makeCacheStats>
	/** Server-side dashboard operations: start, poll, live, cancel. */
	readonly dashboardJobs: ReturnType<typeof makeDashboardJobs>
	/** Two identities, one shutdown sequence. */
	readonly shutdownFromDashboard: ReturnType<typeof makeShutdownFromDashboard>
	readonly shutdownFromHook: ReturnType<typeof makeShutdownFromHook>
}

/** The combo use-cases share one dependency slice, so it is built once. */
function comboDeps(deps: Dependencies) {
	return {
		combos: deps.combos,
		studios: deps.studios,
		rotation: deps.comboRotation,
		presets: deps.comboPresets,
		strategies: deps.comboStrategies,
	}
}

export function buildUseCases(deps: Dependencies): UseCases {
	const combos = comboDeps(deps)
	return {
		createApiKey: makeCreateApiKey(deps),
		listApiKeys: makeListApiKeys(deps),
		revokeApiKey: makeRevokeApiKey(deps),
		dashboardKeys: makeManageApiKeys({
			keys: deps.dashboardApiKeys,
			audit: deps.apiKeyAudit,
			matchesAllowedModels: deps.matchesAllowedModels,
			endpointKinds: deps.endpointKinds,
		}),
		bulkEditKeys: makeBulkEditApiKeys({
			keys: deps.bulkApiKeys,
			audit: deps.apiKeyAudit,
		}),
		usageReports: makeUsageReports({ usage: deps.usageReports }),
		singleKey: makeManageSingleKey({
			keys: deps.singleApiKeys,
			audit: deps.singleKeyAudit,
			endpointKinds: deps.endpointKinds,
			matchesAllowedModels: deps.matchesAllowedModels,
			defaultPermissions: { viewUsage: true, manageApiKeys: false },
		}),
		getChangelog: () => loadChangelog(deps.changelog),
		getLoginGate: () => readLoginGate(deps.settings),
		listCombos: makeListCombos(combos),
		createCombo: makeCreateCombo(combos),
		getCombo: makeGetCombo(combos),
		updateCombo: makeUpdateCombo(combos),
		deleteCombo: makeDeleteCombo(combos),
		duplicateCombo: makeDuplicateCombo(combos),
		checkComboCycle: makeCheckComboCycle(combos),
		previewComboPresets: makePreviewComboPresets(combos),
		createComboPresets: makeCreateComboPresets(combos),
		listErrorLogs: makeListErrorLogs(deps.errorLogs),
		clearErrorLogs: makeClearErrorLogs(deps.errorLogs),
		getTheme: makeGetTheme(deps.settings),
		setTheme: makeSetTheme(deps.settings),
		assertLocale: assertSupportedLocale,
		getPricing: makeGetPricing(deps.pricing),
		updatePricing: makeUpdatePricing(deps.pricing),
		resetPricing: makeResetPricing(deps.pricing),
		readPlugins: makeReadPlugins(deps.plugins, deps.pluginCatalogue),
		writePlugins: makeWritePlugins(deps.plugins, deps.pluginCatalogue, deps.pluginCache),
		cacheStats: makeCacheStats(deps.semanticCache),
		dashboardJobs: makeDashboardJobs(deps.dashboardJobRegistry, deps.dashboardJobEnv),
		shutdownFromDashboard: makeShutdownFromDashboard(deps.shutdown),
		shutdownFromHook: makeShutdownFromHook(deps.shutdown, deps.shutdownEnv),
	}
}
