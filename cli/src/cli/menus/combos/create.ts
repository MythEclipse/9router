import * as api from "../../api/client.js"
import { comboModelId } from "../../utils/comboModelId.js"
import { clearScreen, showStatus } from "../../utils/display.js"
import { formatDate } from "../../utils/format.js"
import { confirm, pause, prompt } from "../../utils/input.js"
import { showListMenu, showMenuWithBack } from "../../utils/menuHelper.js"
import { selectModelFromList } from "../../utils/modelSelector.js"
import { formatModel } from "./menu.js"

/**
 * Show combo detail with stats
 */
async function _showComboDetail(comboId) {
	clearScreen()

	const result = await api.getComboById(comboId)

	if (!result.success) {
		showStatus(`Failed to load combo: ${result.error}`, "error")
		await pause()
		return
	}

	const combo = result.data

	console.log("┌─────────────────────────────────────────────────────────┐")
	console.log(`│  🔀 Combo: ${combo.name.padEnd(46)} │`)
	console.log("├─────────────────────────────────────────────────────────┤")
	console.log("│                                                          │")
	console.log(`│  ID: ${combo.id.padEnd(51)} │`)
	console.log(`│  Created: ${formatDate(combo.createdAt).padEnd(46)} │`)
	console.log(`│  Updated: ${formatDate(combo.updatedAt).padEnd(46)} │`)
	console.log("│                                                          │")
	console.log("│  Model Chain:                                           │")

	// Models is array of strings like ["ag/claude-sonnet-4-5", "kr/claude-sonnet-4.5"]
	const models = Array.isArray(combo.models) ? combo.models : []
	models.forEach((modelStr, index) => {
		const arrow = index < models.length - 1 ? " →" : "  "
		const displayText = `${index + 1}. ${modelStr}${arrow}`
		const padding = Math.max(0, 54 - displayText.length)
		console.log(`│    ${displayText}${" ".repeat(padding)} │`)
	})

	console.log("│                                                          │")
	console.log("└─────────────────────────────────────────────────────────┘")

	await pause()
}

/**
 * Format combo for menu display
 */
function formatComboLabel(combo) {
	const modelsChain = Array.isArray(combo.models) ? combo.models.map(formatModel).join(" → ") : ""
	const maxLen = 40
	const displayModels =
		modelsChain.length > maxLen ? modelsChain.substring(0, maxLen - 3) + "..." : modelsChain
	return `${combo.name}: ${displayModels}`
}

/**
 * Create new combo
 */
async function handleCreateCombo() {
	clearScreen()

	showStatus("Create New Combo", "info")
	console.log()

	// Get combo name
	const name = await prompt("Combo name: ")
	if (!name) {
		showStatus("Combo name is required", "error")
		await pause()
		return
	}

	// Fetch available models
	showStatus("Loading available models...", "info")
	const modelsResult = await api.getModels()

	if (!modelsResult.success) {
		showStatus(`Failed to load models: ${modelsResult.error}`, "error")
		await pause()
		return
	}

	const availableModels = modelsResult.data.models || []

	if (availableModels.length === 0) {
		showStatus("No models available. Please add providers first.", "warning")
		await pause()
		return
	}

	// Select models for chain
	const selectedModels = []

	console.log()
	showStatus("Select models for the chain (minimum 2)", "info")

	while (true) {
		clearScreen()
		console.log(`Creating combo: ${name}`)
		console.log(`Selected models (${selectedModels.length}):`)

		if (selectedModels.length > 0) {
			selectedModels.forEach((m, i) => {
				console.log(`  ${i + 1}. ${m}`)
			})
		} else {
			console.log("  (none)")
		}

		console.log()
		console.log("Available models:")
		availableModels.forEach((m, i) => {
			console.log(`  ${i + 1}. ${m.provider}/${m.model}`)
		})

		console.log()
		console.log("Actions:")
		console.log("  - Enter number to add model")
		console.log("  - Type 'done' to finish (min 2 models)")
		console.log("  - Type 'cancel' to abort")

		const input = await prompt("\nAction: ")

		if (input.toLowerCase() === "cancel") {
			showStatus("Cancelled", "warning")
			await pause()
			return
		}

		if (input.toLowerCase() === "done") {
			if (selectedModels.length < 2) {
				showStatus("Please select at least 2 models", "error")
				await pause()
				continue
			}
			break
		}

		const num = parseInt(input, 10)
		if (Number.isNaN(num) || num < 1 || num > availableModels.length) {
			showStatus("Invalid model number", "error")
			await pause()
			continue
		}

		const modelId = comboModelId(availableModels[num - 1])
		if (!modelId) {
			showStatus("Selected model has no valid identifier", "error")
			await pause()
			continue
		}
		selectedModels.push(modelId)
	}

	// Create combo
	showStatus("Creating combo...", "info")

	const createResult = await api.createCombo({
		name,
		models: selectedModels,
	})

	if (!createResult.success) {
		showStatus(`Failed to create combo: ${createResult.error}`, "error")
		await pause()
		return
	}

	showStatus(`Combo "${name}" created successfully!`, "success")
	await pause()
}

export { _showComboDetail, formatComboLabel, handleCreateCombo }
