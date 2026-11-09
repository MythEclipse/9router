/** Combo smart routing. */

import { detectRequiredCapabilities, reorderByCapabilities } from "./combo-capabilities.ts"
import { getRotatedModels } from "./combo-rotation.ts"
import { getStickyComboModel, orderModelsByChoice, setStickyComboModel } from "./systemoneRouter.ts"

export async function resolveSmartRotation(models, opts) {
	const {
		comboStrategy,
		comboStickyLimit,
		smartPolicy,
		sessionSticky,
		confidenceThreshold,
		sessionId,
		comboName,
		resolveSmartChoice,
		log,
		autoSwitch,
		body,
	} = opts
	let rotatedModels = models
	let activeStickyModel = null
	if (comboStrategy === "smart") {
		const policy = (typeof smartPolicy === "string" ? smartPolicy : "smart").toLowerCase()
		const isPerTurn = policy === "per-turn" || sessionSticky === false
		const isStrict = policy === "strict"

		let switchThreshold = 0.8
		if (policy === "custom") {
			const custom = Number(confidenceThreshold)
			if (Number.isFinite(custom) && custom > 0) switchThreshold = custom
		} else if (policy === "smart-switch-70") switchThreshold = 0.7
		else if (policy === "smart-switch-90") switchThreshold = 0.9
		else if (policy.startsWith("smart-switch") || policy === "smart") {
			const custom = Number(confidenceThreshold)
			if (Number.isFinite(custom) && custom > 0) switchThreshold = custom
		}

		if (!isPerTurn && sessionId) {
			activeStickyModel = getStickyComboModel(comboName, sessionId, models)
		}

		if (activeStickyModel) {
			if (isStrict) {
				// Strict Lock: re-use sticky model without invoking System One (0ms, 0 extra tokens)
				rotatedModels = [activeStickyModel, ...models.filter((m) => m !== activeStickyModel)]
				log.info("COMBO", `smart-router [strict] locked session "${sessionId}" → ${activeStickyModel}`)
			} else if (typeof resolveSmartChoice === "function") {
				// Smart Switch (Adaptive): check if the user's task drastically shifted
				try {
					const smartResult = await resolveSmartChoice(body, models)
					const newChoice = smartResult?.choice
					const conf = typeof smartResult?.confidence === "number" ? smartResult.confidence : null

					if (
						newChoice &&
						newChoice !== activeStickyModel &&
						models.includes(newChoice) &&
						conf !== null &&
						conf >= switchThreshold
					) {
						// Task changed with high confidence: switch model and update session
						rotatedModels = orderModelsByChoice(models, smartResult)
						log.info(
							"COMBO",
							`smart-router [smart-switch] task changed → switched from ${activeStickyModel} to ${newChoice} (confidence: ${conf} >= ${switchThreshold})`,
						)
						if (sessionId) {
							setStickyComboModel(comboName, sessionId, newChoice)
							activeStickyModel = newChoice
						}
					} else {
						// Stay on current model to preserve warm prompt cache
						rotatedModels = [activeStickyModel, ...models.filter((m) => m !== activeStickyModel)]
						log.info(
							"COMBO",
							`smart-router [smart-switch] retained prompt cache model "${activeStickyModel}"`,
						)
					}
				} catch (err) {
					// Fail open to active sticky model
					rotatedModels = [activeStickyModel, ...models.filter((m) => m !== activeStickyModel)]
					log.warn("COMBO", `smart-router error, retained model "${activeStickyModel}"`, {
						error: err?.message || String(err),
					})
				}
			} else {
				rotatedModels = [activeStickyModel, ...models.filter((m) => m !== activeStickyModel)]
			}
		} else if (typeof resolveSmartChoice === "function") {
			// Turn 1 or per-turn: evaluate System One to select initial model
			try {
				const smartResult = await resolveSmartChoice(body, models)
				const conf = typeof smartResult?.confidence === "number" ? smartResult.confidence : null

				if (smartResult?.choice && models.includes(smartResult.choice)) {
					if (switchThreshold > 0 && conf !== null && conf < switchThreshold) {
						log.info(
							"COMBO",
							`smart-router confidence (${conf}) below threshold (${switchThreshold}), fallback to order: [${models.join(", ")}]`,
						)
					} else {
						rotatedModels = orderModelsByChoice(models, smartResult)
						log.info(
							"COMBO",
							`smart-router selected ${smartResult.choice} (confidence: ${conf ?? "N/A"})`,
						)
						if (!isPerTurn && sessionId) {
							setStickyComboModel(comboName, sessionId, smartResult.choice)
							activeStickyModel = smartResult.choice
						}
					}
				} else {
					log.info("COMBO", `smart-router no decision, fallback to order: [${models.join(", ")}]`)
				}
			} catch (err) {
				log.warn("COMBO", `smart-router error, fallback to order: [${models.join(", ")}]`, {
					error: err?.message || String(err),
				})
			}
		}
	} else {
		// Apply rotation strategy if enabled
		rotatedModels = getRotatedModels(models, comboName, comboStrategy, comboStickyLimit)
	}

	// Auto-switch: float models that satisfy the request's required capabilities to the front.
	if (autoSwitch) {
		const required = detectRequiredCapabilities(body)
		if (required.size > 0) {
			const reordered = reorderByCapabilities(rotatedModels, required)
			if (reordered[0] !== rotatedModels[0]) {
				log.info("COMBO", `auto-switch for [${[...required].join(",")}] → ${reordered[0]}`)
			}
			rotatedModels = reordered
		}
	}
	return { rotatedModels, activeStickyModel }
}
