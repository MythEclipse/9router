/**
 * Composition of every use-case over one `Dependencies` graph.
 *
 * The single place that knows which use-case exists. Routers receive this
 * object, never the database, so wiring stays centralised and a test can build
 * the same shape from fakes.
 */

import { makeCreateApiKey } from "./api-keys/create-api-key.ts"
import { makeListApiKeys, makeRevokeApiKey } from "./api-keys/manage-api-keys.ts"
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
import { readLoginGate } from "./settings/login-gate.ts"

export interface UseCases {
	readonly createApiKey: ReturnType<typeof makeCreateApiKey>
	readonly listApiKeys: ReturnType<typeof makeListApiKeys>
	readonly revokeApiKey: ReturnType<typeof makeRevokeApiKey>
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
	}
}
