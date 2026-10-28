import { NextResponse } from "next/server"
import { createCombo, getComboById, getCombos, getSettings, updateSettings } from "@/lib/localDb"
import { nextCopyName } from "@/shared/utils/comboCopyName"

export const dynamic = "force-dynamic"

// POST /api/combos/[id]/duplicate - copy a combo's contents into a new combo
// named "<name>-1", "<name>-2", ... (first free suffix), the way copying a file
// leaves the original untouched and puts a copy beside it.
export async function POST(_request, { params }) {
	try {
		const { id } = await params
		const source = await getComboById(id)
		if (!source) {
			return NextResponse.json({ error: "Combo not found" }, { status: 404 })
		}

		const combos = await getCombos()
		const name = nextCopyName(
			source.name,
			combos.map((c) => c.name),
		)

		const combo = await createCombo({
			name,
			models: source.models || [],
			kind: source.kind || null,
			contextWindow: source.contextWindow,
		})

		// The per-combo routing strategy lives in settings keyed by combo name, so
		// the copy has to carry it over or it would silently run on the defaults.
		const settings = await getSettings()
		const strategies = settings.comboStrategies || {}
		const sourceStrategy = strategies[source.name]
		if (sourceStrategy) {
			await updateSettings({
				comboStrategies: {
					...strategies,
					[name]: JSON.parse(JSON.stringify(sourceStrategy)),
				},
			})
		}

		return NextResponse.json(combo, { status: 201 })
	} catch (error) {
		console.log("Error duplicating combo:", error)
		return NextResponse.json({ error: "Failed to duplicate combo" }, { status: 500 })
	}
}
