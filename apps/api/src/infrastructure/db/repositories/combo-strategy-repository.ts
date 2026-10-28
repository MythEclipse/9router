/**
 * Combo strategy adapter.
 *
 * Strategies live in the settings row under `comboStrategies`, keyed by combo
 * name. Reads and writes go through the settings repo rather than a new table:
 * the shape already exists and the dashboard edits it there.
 */
import { getSettings, updateSettings } from "@9router/db/repos/settingsRepo"
import type { ComboStrategyPort } from "../../../application/dependencies.ts"

type StrategyMap = Record<string, unknown>

function readStrategies(settings: unknown): StrategyMap {
	const map = (settings as { comboStrategies?: unknown } | null)?.comboStrategies
	return map && typeof map === "object" ? (map as StrategyMap) : {}
}

export function createComboStrategyRepository(): ComboStrategyPort {
	return {
		async read(comboName: string) {
			const strategies = readStrategies(await getSettings())
			return strategies[comboName] ?? null
		},
		async write(comboName: string, strategy: unknown) {
			const settings = await getSettings()
			const strategies = readStrategies(settings)
			await updateSettings({
				comboStrategies: {
					...strategies,
					// Deep copy so a later edit of the source strategy cannot mutate
					// the copy through a shared reference.
					[comboName]: JSON.parse(JSON.stringify(strategy)),
				},
			})
		},
	}
}
