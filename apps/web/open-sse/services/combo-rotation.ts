/** Combo rotation. */
import { clearStickyComboSession } from "./systemoneRouter.ts"

/**
 * Track rotation state per combo (for round-robin strategy)
 * @type {Map<string, { index: number, consecutiveUseCount: number }>}
 */
const comboRotationState = new Map()

// Trailing run of items after the last assistant/model turn = the current user
// turn. It may span several messages (e.g. text + image split across blocks),
// so we return all of them. History media (older turns) must not pin the combo
function normalizeStickyLimit(stickyLimit) {
	const parsed = Number.parseInt(stickyLimit, 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

function rotateModelsFromIndex(models, currentIndex) {
	const rotatedModels = [...models]
	for (let i = 0; i < currentIndex; i++) {
		const moved = rotatedModels.shift()
		rotatedModels.push(moved)
	}
	return rotatedModels
}

/**
 * Get rotated model list based on strategy
 * @param {string[]} models - Array of model strings
 * @param {string} comboName - Name of the combo
 * @param {string} strategy - "fallback" or "round-robin"
 * @param {number|string} [stickyLimit=1] - Requests per combo model before switching
 * @returns {string[]} Rotated models array
 */
export function getRotatedModels(models, comboName, strategy, stickyLimit = 1) {
	if (!models || models.length <= 1) {
		return models
	}

	if (strategy !== "round-robin") {
		return models
	}

	const rotationKey = comboName || "__default__"
	const normalizedStickyLimit = normalizeStickyLimit(stickyLimit)
	const existingState = comboRotationState.get(rotationKey)
	const state =
		typeof existingState === "number"
			? { index: existingState, consecutiveUseCount: 0 }
			: existingState || { index: 0, consecutiveUseCount: 0 }

	const currentIndex = state.index % models.length
	const rotatedModels = rotateModelsFromIndex(models, currentIndex)
	const nextUseCount = state.consecutiveUseCount + 1

	if (nextUseCount >= normalizedStickyLimit) {
		comboRotationState.set(rotationKey, {
			index: (currentIndex + 1) % models.length,
			consecutiveUseCount: 0,
		})
	} else {
		comboRotationState.set(rotationKey, {
			index: currentIndex,
			consecutiveUseCount: nextUseCount,
		})
	}

	return rotatedModels
}

/**
 * Reset in-memory rotation state when combo/settings change
 * @param {string} [comboName] - Combo name to reset; omit to clear all
 */
export function resetComboRotation(comboName) {
	if (comboName) {
		comboRotationState.delete(comboName)
		clearStickyComboSession(comboName)
	} else {
		comboRotationState.clear()
		clearStickyComboSession()
	}
}

/**
 * Get combo models from combos data
 * @param {string} modelStr - Model string to check
 * @param {Array|Object} combosData - Array of combos or object with combos
 * @returns {string[]|null} Array of models or null if not a combo
 */
export function getComboModelsFromData(modelStr, combosData) {
	// Don't check if it's in provider/model format
	if (modelStr.includes("/")) return null

	// Handle both array and object formats
	const combos = Array.isArray(combosData) ? combosData : combosData?.combos || []

	const combo = combos.find((c) => c.name === modelStr)
	if (combo && combo.models && combo.models.length > 0) {
		return combo.models
	}
	return null
}
