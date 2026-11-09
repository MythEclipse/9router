import * as api from "../../api/client.js"
import { comboModelId } from "../../utils/comboModelId.js"
import { clearScreen, showStatus } from "../../utils/display.js"
import { formatDate } from "../../utils/format.js"
import { confirm, pause, prompt } from "../../utils/input.js"
import { showListMenu, showMenuWithBack } from "../../utils/menuHelper.js"
import { selectModelFromList } from "../../utils/modelSelector.js"
import { handleCreateCombo } from "./create.js"

/**
 * Format model to string (handle both string and object)
 */
function formatModel(model) {
	if (typeof model === "string") return model
	if (model && typeof model === "object") {
		return model.id || model.name || `${model.provider}/${model.model}` || JSON.stringify(model)
	}
	return String(model)
}

/**
 * Show actions for a specific combo
 * @param {Object} combo - Combo object
 * @param {Array<string>} breadcrumb - Breadcrumb path
 */
async function showComboActions(combo, breadcrumb = []) {
	const modelsChain = Array.isArray(combo.models) ? combo.models.map(formatModel).join(" → ") : ""

	await showMenuWithBack({
		title: `🔀 ${combo.name}`,
		breadcrumb: [...breadcrumb, combo.name],
		headerContent: `Name: ${combo.name}\nModels: ${modelsChain}`,
		items: [
			{
				label: "Edit Combo",
				action: async () => {
					await handleEditSingleCombo(combo)
					return true
				},
			},
			{
				label: "Delete Combo",
				action: async () => {
					await handleDeleteSingleCombo(combo)
					return false // Exit after delete
				},
			},
		],
	})
}

/**
 * Handle editing a single combo
 * @param {Object} combo - Combo to edit
 */
async function handleEditSingleCombo(combo) {
	clearScreen()
	console.log(`\n✏️  Edit Combo: ${combo.name}\n`)

	const newName = await prompt(`New name (Enter to keep "${combo.name}"): `)
	const name = newName || combo.name

	console.log(
		"\nCurrent models: " +
			(Array.isArray(combo.models) ? combo.models.map(formatModel).join(" → ") : ""),
	)
	console.log("\nSelect models for this combo (add one by one):")

	const models = []
	let addMore = true

	while (addMore) {
		const currentChain = models.length > 0 ? models.join(" → ") : "None"
		const model = await selectModelFromList(
			`Add Model #${models.length + 1}`,
			`Chain: ${currentChain}`,
		)

		if (model) {
			models.push(model)
			console.log(`\n✓ Added: ${model}`)
			console.log(`Current chain: ${models.join(" → ")}\n`)

			const continueAdding = await confirm("Add another model?")
			addMore = continueAdding
		} else {
			addMore = false
		}
	}

	// Use new models if any were added, otherwise keep current
	const finalModels = models.length > 0 ? models : combo.models

	const result = await api.updateCombo(combo.id, { name, models: finalModels })

	if (result.success) {
		showStatus("Combo updated!", "success")
	} else {
		showStatus(`Update failed: ${result.error}`, "error")
	}
	await pause()
}

/**
 * Handle deleting a single combo
 * @param {Object} combo - Combo to delete
 */
async function handleDeleteSingleCombo(combo) {
	const confirmed = await confirm(`Delete combo "${combo.name}"?`)
	if (confirmed) {
		const result = await api.deleteCombo(combo.id)
		if (result.success) {
			showStatus("Combo deleted!", "success")
		} else {
			showStatus(`Delete failed: ${result.error}`, "error")
		}
		await pause()
	}
}

/**
 * Main combos menu - list all combos and actions
 * @param {Array<string>} breadcrumb - Breadcrumb path
 */
async function showCombosMenu(breadcrumb = []) {
	await showListMenu({
		title: "🔀 Combos Management",
		breadcrumb,
		fetchItems: async () => {
			const result = await api.getCombos()
			if (!result.success) {
				clearScreen()
				showStatus(`Failed to load combos: ${result.error}`, "error")
				await pause()
				return null
			}
			return { items: result.data.combos || [] }
		},
		formatItem: (combo) => {
			const modelsChain = Array.isArray(combo.models) ? combo.models.map(formatModel).join(" → ") : ""
			const maxLen = 35
			const displayModels =
				modelsChain.length > maxLen ? modelsChain.substring(0, maxLen - 3) + "..." : modelsChain
			return `${combo.name}: ${displayModels}`
		},
		onSelect: async (combo) => {
			await showComboActions(combo, breadcrumb)
		},
		createAction: {
			label: "Create New Combo",
			action: async () => {
				await handleCreateCombo()
			},
		},
	})
}

export {
	formatModel,
	handleDeleteSingleCombo,
	handleEditSingleCombo,
	showComboActions,
	showCombosMenu,
}
