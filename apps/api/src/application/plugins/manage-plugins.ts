/**
 * Reading and writing the custom-plugin settings.
 *
 * Both verbs go through `domain/custom-plugins.ts`, so what the reader returns
 * and what the writer stores are the same shape by construction. The
 * `clearPluginCache` hook is injected rather than imported: it reaches into the
 * running router's plugin registry, which is an infrastructure concern, and the
 * use-case only needs to say "the stored value changed, tell whoever caches it".
 */

import {
	type CustomPluginEntry,
	type CustomPlugins,
	isPluginPayload,
	normaliseCustomPlugins,
} from "../../domain/custom-plugins.ts"
import { invalid } from "../../domain/errors.ts"
import type { SettingsPort } from "../settings/login-gate.ts"

export interface PluginCatalogue {
	/** The closed list of plugin keys, owned by the database package. */
	readonly keys: readonly string[]
}

export interface PluginCache {
	/** Drop the runtime's cached plugin configuration. */
	clear(): void
}

/** Settings, plus the one field these use-cases own. */
export type PluginSettingsPort = Omit<SettingsPort, "read"> & {
	/** The base port declares no `customPlugins`, so it is read as unknown here. */
	read(): Promise<{ readonly customPlugins?: unknown }>
}

export function makeReadPlugins(settings: PluginSettingsPort, catalogue: PluginCatalogue) {
	return async (): Promise<{ customPlugins: CustomPlugins }> => {
		const stored = await settings.read()
		const { customPlugins } = normaliseCustomPlugins(stored.customPlugins, catalogue.keys)
		return { customPlugins }
	}
}

export function makeWritePlugins(
	settings: PluginSettingsPort,
	catalogue: PluginCatalogue,
	cache: PluginCache,
) {
	return async (body: unknown): Promise<{ ok: true; customPlugins: CustomPlugins }> => {
		if (!isPluginPayload(body)) {
			throw invalid("Invalid customPlugins payload")
		}

		const { customPlugins, unknownKeys } = normaliseCustomPlugins(body.customPlugins, catalogue.keys)
		// Reported instead of silently dropped: a caller writing `{ adaptiveThinkin: … }`
		// has a typo, and a 200 would leave them believing the plugin was configured.
		if (unknownKeys.length > 0) {
			throw invalid("Invalid customPlugins payload", `unknown keys: ${unknownKeys.join(", ")}`)
		}

		await settings.update({ customPlugins: toStored(customPlugins) })
		cache.clear()
		return { ok: true, customPlugins }
	}
}

/** The port stores arrays, not readonly arrays; the copy keeps the domain immutable. */
function toStored(plugins: CustomPlugins): Record<string, CustomPluginEntry> {
	const stored: Record<string, CustomPluginEntry> = {}
	for (const [key, entry] of Object.entries(plugins)) {
		stored[key] = { enabled: entry.enabled, models: [...entry.models] }
	}
	return stored
}
