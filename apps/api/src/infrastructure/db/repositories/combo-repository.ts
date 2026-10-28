/**
 * Combo adapters.
 *
 * Each adapter narrows a concrete source to the port the use-cases declared.
 * The repo returns more than a combo view carries (`createdAt`, `updatedAt`),
 * which is fine — the port describes what callers need, not what storage keeps.
 */
import {
	createCombo,
	deleteCombo,
	getComboById,
	getComboByName,
	getCombos,
	type ComboInput as RepoComboInput,
	updateCombo,
} from "@9router/db/repos/combosRepo"
import { getStudioModels } from "@9router/db/repos/modelEditorRepo"
import type {
	ComboInput,
	ComboPort,
	ComboView,
	StudioTarget,
	StudioTargetPort,
} from "../../../application/dependencies.ts"

/**
 * The repo already returns the shape the port describes, so this only guards
 * absence — re-mapping fields here would silently drop any the repo adds later.
 */
function toView(row: unknown): ComboView | null {
	return (row as ComboView | null) ?? null
}

function toRepoInput(input: ComboInput | Partial<ComboInput>): RepoComboInput {
	const out: RepoComboInput = {}
	if (input.name !== undefined) out.name = input.name
	if (input.models !== undefined) out.models = input.models
	if (input.kind !== undefined) out.kind = input.kind
	if (input.contextWindow !== undefined) out.contextWindow = input.contextWindow
	return out
}

export function createComboRepository(): ComboPort {
	return {
		async list() {
			const rows = await getCombos()
			return rows.map((row) => toView(row)).filter((view): view is ComboView => view !== null)
		},
		async findById(id) {
			return toView(await getComboById(id))
		},
		async findByName(name) {
			return toView(await getComboByName(name))
		},
		async create(input) {
			const created = await createCombo(toRepoInput(input))
			const view = toView(created)
			if (!view) throw new Error("createCombo returned no row")
			return view
		},
		async update(id, input) {
			return toView(await updateCombo(id, toRepoInput(input)))
		},
		async remove(id) {
			return deleteCombo(id)
		},
	}
}

/** Studio models are read-only here: the editor owns their writes. */
export function createStudioTargetRepository(): StudioTargetPort {
	return {
		async list(): Promise<StudioTarget[]> {
			const rows = await getStudioModels()
			return (rows ?? [])
				.filter((row) => row && String(row.callName ?? "").trim() !== "")
				.map((row) => ({
					callName: String(row.callName ?? "").trim(),
					targetModel: String(row.targetModel ?? "").trim(),
				}))
		},
	}
}
