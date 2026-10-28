/**
 * Preset adapter.
 *
 * The preset catalogs read `open-sse` config and the CLI-tool constants, both of
 * which live in `apps/web`. Rather than move them into `apps/api` — which would
 * drag the whole SSE engine along — this adapter implements the port the
 * use-case declared, so the rule "a preset is created through createCombo"
 * stays in one place while the catalog stays where it belongs.
 */
import type { ComboPresetPort } from "9router-api/application/dependencies"
import { resolveCursorModels } from "open-sse/services/cursorModels"
import { buildPresetItems, PRESET_SOURCES } from "@/lib/comboPresets"
import { getProviderConnections } from "@/lib/localDb"

type PresetSource = "cursor" | "claude"

/**
 * The live Cursor catalog, when a Cursor connection is active. Absent is normal
 * — the static preset list is used and the user still gets the combos.
 */
async function fetchCursorLiveModels() {
	try {
		const connections = await getProviderConnections()
		const conn = (connections || []).find((c) => c.provider === "cursor" && c.isActive !== false)
		if (!conn) return null
		const result = await resolveCursorModels(
			{
				accessToken: typeof conn.accessToken === "string" ? conn.accessToken : "",
				providerSpecificData:
					(conn.providerSpecificData as Record<string, unknown> | null | undefined) || {},
			},
			{ log: console },
		)
		return result?.models?.length ? result.models : null
	} catch (error) {
		console.log("combo presets: cursor live catalog failed", (error as Error)?.message || error)
		return null
	}
}

export function createComboPresetPort(): ComboPresetPort {
	return {
		isSource(value: unknown) {
			return typeof value === "string" && PRESET_SOURCES.has(value)
		},
		async list(source, existingNames) {
			const liveModels = source === "cursor" ? await fetchCursorLiveModels() : null
			return buildPresetItems(source as PresetSource, {
				liveModels: liveModels || undefined,
				existingNames,
			})
		},
	}
}
