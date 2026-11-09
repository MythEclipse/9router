import * as api from "../../api/client.js"
import { comboModelId } from "../../utils/comboModelId.js"
import { clearScreen, showStatus } from "../../utils/display.js"
import { formatDate } from "../../utils/format.js"
import { confirm, pause, prompt } from "../../utils/input.js"
import { showListMenu, showMenuWithBack } from "../../utils/menuHelper.js"
import { selectModelFromList } from "../../utils/modelSelector.js"
import { formatComboLabel } from "./create.js"
import { formatModel } from "./menu.js"

/**
 * Edit combo - select which combo to edit
 */
async function _handleEditCombo(combos) {
	if (combos.length === 0) {
		showStatus("No combos available", "warning")
		await pause()
		return
	}

	let selectedCombo = null

	await showMenuWithBack({
		title: "✏️  Select Combo to Edit",
		items: combos.map((combo) => ({
			label: formatComboLabel(combo),
			action: async () => {
				selectedCombo = combo
				return false
			},
		})),
	})

	if (!selectedCombo) return
	await editSingleCombo(selectedCombo)
}

/**
 * Edit a single combo
 */
async function editSingleCombo(combo) {
	clearScreen()
	showStatus(`Editing combo: ${combo.name}`, "info")
	console.log()

	const newName = await prompt(`New name (current: ${combo.name}, press Enter to keep): `)
	const editModels = await confirm("Edit model chain?")

	let newModels = combo.models

	if (editModels) {
		newModels = []

		while (true) {
			clearScreen()
			console.log(`Editing combo: ${combo.name}`)
			console.log(`Selected models (${newModels.length}):`)

			if (newModels.length > 0) {
				newModels.forEach((m, i) => console.log(`  ${i + 1}. ${m}`))
			} else {
				console.log("  (none)")
			}

			console.log("\nType 'done' to finish (min 2 models) or 'cancel' to abort\n")

			const model = await selectModelFromList("Add Model", "")

			if (model === null) {
				showStatus("Cancelled", "warning")
				await pause()
				return
			}

			if (model === "done") {
				if (newModels.length < 2) {
					showStatus("Please select at least 2 models", "error")
					await pause()
					continue
				}
				break
			}

			newModels.push(model)
			showStatus(`Added: ${model}`, "success")
			await pause()
		}
	}

	const updateData = {}
	if (newName) updateData.name = newName
	if (editModels) updateData.models = newModels

	if (Object.keys(updateData).length === 0) {
		showStatus("No changes made", "warning")
		await pause()
		return
	}

	showStatus("Updating combo...", "info")

	const updateResult = await api.updateCombo(combo.id, updateData)

	if (!updateResult.success) {
		showStatus(`Failed to update combo: ${updateResult.error}`, "error")
		await pause()
		return
	}

	showStatus("Combo updated successfully!", "success")
	await pause()
}

/**
 * Delete combo - select which combo to delete
 */
async function _handleDeleteCombo(combos) {
	if (combos.length === 0) {
		showStatus("No combos available", "warning")
		await pause()
		return
	}

	let selectedCombo = null

	await showMenuWithBack({
		title: "🗑️  Select Combo to Delete",
		items: combos.map((combo) => ({
			label: formatComboLabel(combo),
			action: async () => {
				selectedCombo = combo
				return false
			},
		})),
	})

	if (!selectedCombo) return

	clearScreen()
	showStatus(`Combo: ${selectedCombo.name}`, "warning")
	const modelsDisplay = Array.isArray(selectedCombo.models)
		? selectedCombo.models.map(formatModel).join(" → ")
		: ""
	console.log(`Models: ${modelsDisplay}`)
	console.log()

	const confirmed = await confirm("Are you sure you want to delete this combo?")

	if (!confirmed) {
		showStatus("Cancelled", "info")
		await pause()
		return
	}

	showStatus("Deleting combo...", "info")

	const deleteResult = await api.deleteCombo(selectedCombo.id)

	if (!deleteResult.success) {
		showStatus(`Failed to delete combo: ${deleteResult.error}`, "error")
		await pause()
		return
	}

	showStatus("Combo deleted successfully!", "success")
	await pause()
}

export { _handleDeleteCombo, _handleEditCombo, editSingleCombo }
