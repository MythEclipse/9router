/** Shared combo handling with fallback support. */

import { getCapabilitiesForModel } from "../providers/capabilities.ts"
import { extractTextContent } from "../translator/formats/gemini.ts"
import { unavailableResponse } from "../utils/error.ts"
import { checkFallbackError, formatRetryAfter } from "./accountFallback.ts"
import { detectRequiredCapabilities, reorderByCapabilities } from "./combo-capabilities.ts"
import { handleFusionChat } from "./combo-fusion.ts"
import {
	deepCopyBody,
	isLockedStreamError,
	isZeroContentResponse,
	peekComboResponse,
	reportEmptyResponse,
	sleepAbortable,
} from "./combo-response.ts"
import { getRotatedModels, resetComboRotation } from "./combo-rotation.ts"
import { resolveSmartRotation } from "./combo-smart.ts"
import { isNoRetryFinish, peekStreamForContent, reconstructStream } from "./emptyFailover.ts"
import { parseModel } from "./model.ts"
import {
	clearStickyComboSession,
	getStickyComboModel,
	orderModelsByChoice,
	setStickyComboModel,
} from "./systemoneRouter.ts"

export { detectRequiredCapabilities, reorderByCapabilities } from "./combo-capabilities.ts"
export { handleFusionChat } from "./combo-fusion.ts"
export { isZeroContentResponse } from "./combo-response.ts"
export { getComboModelsFromData, getRotatedModels, resetComboRotation } from "./combo-rotation.ts"

/** Handle combo chat with fallback. */
export async function handleComboChat({
	body,
	models,
	handleSingleModel,
	log,
	comboName,
	comboStrategy,
	comboStickyLimit = 1,
	sourceFormat = null,
	autoSwitch = true,
	sessionId = null,
	smartPolicy = "smart",
	sessionSticky = true,
	confidenceThreshold = 0.8,
	resolveSmartChoice = null,
	onEmptyResponse = null,
	signal = null,
}) {
	if (signal?.aborted) {
		return new Response(JSON.stringify({ error: { message: "Request aborted" } }), {
			status: 499,
			headers: { "Content-Type": "application/json" },
		})
	}
	const { rotatedModels, activeStickyModel } = await resolveSmartRotation(models, {
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
	})

	let lastError = null
	let earliestRetryAfter = null
	let lastStatus = null
	let requestScopedResult = null

	// Read and discard a response body so the underlying stream is fully released
	// before we move on to the next combo member. Prevents "ReadableStream is
	// locked" when a later member reuses the same buffer or the caller retries.
	async function drainResponse(result) {
		try {
			if (result && result.body && !result.body.locked) {
				const reader = result.body.getReader()
				while (true) {
					const { done } = await reader.read()
					if (done) break
				}
				reader.releaseLock()
			}
		} catch {
			// fail open: an undrained body is harmless for fallback
		}
	}

	for (let i = 0; i < rotatedModels.length; i++) {
		if (signal?.aborted) {
			log.warn("COMBO", "Client disconnected before next combo member; stopping fallback")
			return new Response(JSON.stringify({ error: { message: "Request aborted" } }), {
				status: 499,
				headers: { "Content-Type": "application/json" },
			})
		}

		const modelStr = rotatedModels[i]
		log.info("COMBO", `Trying model ${i + 1}/${rotatedModels.length}: ${modelStr}`)

		try {
			const result = await handleSingleModel(deepCopyBody(body), modelStr)

			// Success (2xx) - return response unless empty/zero-content on a non-final seat
			if (result.ok) {
				const isLastModel = i === rotatedModels.length - 1
				if (!isLastModel) {
					const contentType = result.headers?.get?.("content-type") || ""
					if (contentType.toLowerCase().includes("text/event-stream")) {
						const peeked = await peekComboResponse(result, log, sourceFormat)
						if (peeked?.outcome === "empty" && !isNoRetryFinish(peeked.finishReason)) {
							lastError = "Zero usable content"
							lastStatus = 200
							await reportEmptyResponse(onEmptyResponse, modelStr, "Zero usable content")
							await drainResponse(peeked.response)
							continue
						}
						log.info("COMBO", `Model ${modelStr} succeeded`)
						return peeked?.response || result
					}
					if (contentType.includes("application/json")) {
						let peekBody = null
						try {
							peekBody = await result.clone().json()
						} catch {
							// Ignore JSON parse errors (incl. a locked/disturbed body)
						}
						if (peekBody && isZeroContentResponse(peekBody)) {
							log.warn(
								"COMBO",
								`Model ${modelStr} returned HTTP 200 with zero usable content, falling back to next model`,
							)
							lastError = "Zero usable content"
							lastStatus = 200
							await reportEmptyResponse(onEmptyResponse, modelStr, "Zero usable content (JSON)")
							await drainResponse(result)
							continue
						}
					}
				}

				log.info("COMBO", `Model ${modelStr} succeeded`)
				return result
			}

			// Extract error info from response
			let errorText = result.statusText || ""
			let retryAfter = null
			try {
				const errorBody = await result.clone().json()
				errorText = errorBody?.error?.message || errorBody?.error || errorBody?.message || errorText
				retryAfter = errorBody?.retryAfter || null
			} catch {
				// Ignore JSON parse errors (incl. a locked/disturbed body)
			}

			// Track earliest retryAfter across all combo models
			if (retryAfter && (!earliestRetryAfter || new Date(retryAfter) < new Date(earliestRetryAfter))) {
				earliestRetryAfter = retryAfter
			}

			// Normalize error text to string (Worker-safe)
			if (typeof errorText !== "string") {
				try {
					errorText = JSON.stringify(errorText)
				} catch {
					errorText = String(errorText)
				}
			}

			// Check if should fallback to next model
			const { provider } = parseModel(modelStr)
			const { shouldFallback, cooldownMs, requestScoped } = checkFallbackError(
				result.status,
				errorText,
				0,
				provider,
			)

			if (!shouldFallback && !requestScoped) {
				log.warn("COMBO", `Model ${modelStr} failed (no fallback)`, { status: result.status })
				return result
			}

			// A request-scoped 4xx (validation failure, unsupported parameter, context
			// overflow) says this member cannot serve THIS request — not that the
			// credential is unhealthy. Members run on different providers with
			// different validation, so the next member may well serve it. Advance
			// without a cooldown, and without waiting: there is nothing to recover.
			// checkFallbackError() reports no account fallback here on purpose (a
			// request-scoped fault must not evict a healthy account from rotation).
			// Clear sticky lock when the active sticky model fails and we fall back
			if (comboStrategy === "smart" && sessionId && modelStr === activeStickyModel) {
				clearStickyComboSession(comboName, sessionId)
			}
			if (requestScoped) {
				log.warn("COMBO", `Model ${modelStr} rejected the request (${result.status}), trying next`, {
					status: result.status,
				})
				lastError = errorText || String(result.status)
				if (!lastStatus) lastStatus = result.status
				if (!requestScopedResult) requestScopedResult = result.clone()
				await drainResponse(result)
				continue
			}

			// For transient errors (503/502/504), wait for cooldown before falling through
			// so a briefly-overloaded provider gets a chance to recover rather than being
			// skipped immediately (fixes: combo falls through on transient 503).
			// The wait is abortable: a client that hangs up mid-cooldown should not keep
			// this loop parked for the full delay.
			const isTransient =
				cooldownMs > 0 &&
				cooldownMs <= 5000 &&
				(result.status === 503 || result.status === 502 || result.status === 504)

			// Fallback to next model: release the failed member's stream before moving on.
			// Exactly one drain — the cooldown wait below reuses this call instead of
			// repeating it, so the body is never read twice.
			lastError = errorText || String(result.status)
			if (!lastStatus) lastStatus = result.status
			log.warn("COMBO", `Model ${modelStr} failed, trying next`, { status: result.status })
			await drainResponse(result)

			if (isTransient) {
				log.info(
					"COMBO",
					`Model ${modelStr} transient ${result.status}, waiting ${cooldownMs}ms before next`,
				)
				if (signal?.aborted) {
					log.warn("COMBO", "Client disconnected during cooldown; stopping fallback")
					return new Response(JSON.stringify({ error: { message: "Request aborted" } }), {
						status: 499,
						headers: { "Content-Type": "application/json" },
					})
				}
				await sleepAbortable(cooldownMs, signal)
			}
		} catch (error) {
			// Catch unexpected exceptions to ensure fallback continues. Stream-lock
			// races are retryable: the candidate already consumed/locked its body and
			// the next model is allowed to try. Do not treat this as a terminal model error.
			const locked = isLockedStreamError(error)
			if (comboStrategy === "smart" && sessionId && modelStr === activeStickyModel) {
				clearStickyComboSession(comboName, sessionId)
			}
			lastError = error?.message || String(error)
			if (!lastStatus) lastStatus = 500
			log.warn("COMBO", `Model ${modelStr} threw error during combo attempt`, {
				phase: "handleSingleModel",
				model: modelStr,
				lockedStream: locked,
				error: lastError,
				name: error?.name || "Error",
				stack: error?.stack ? String(error.stack).split("\n").slice(0, 4).join(" | ") : null,
			})
			if (locked) {
				log.warn("COMBO", `Model ${modelStr} stream was already locked, trying next`, {
					model: modelStr,
					error: lastError,
					lockedStream: true,
				})
				continue
			}
			log.warn("COMBO", `Model ${modelStr} threw error, trying next`, { error: lastError })
		}
	}

	// At least one member rejected the request itself. Hand back that member's own
	// response — status and body — rather than the synthesized envelope below: the
	// synthesized one reaches the client as a 200 carrying an error object, which
	// reads as an empty success, and it buries the member that named the real cause.
	// This is also what the caller saw before combos advanced on these errors.
	if (requestScopedResult) {
		log.warn(
			"COMBO",
			`No model served the request; returning the first request-scoped failure (${requestScopedResult.status})`,
		)
		return requestScopedResult
	}

	// All models failed
	// Use 503 (Service Unavailable) rather than 406 (Not Acceptable) - 406 implies
	// the request itself is invalid, but here the providers are simply unavailable
	// or have no active credentials. 503 is more accurate and retryable by clients.
	const allDisabled = lastError && lastError.toLowerCase().includes("no credentials")
	const status = allDisabled ? 503 : lastStatus || 503
	const msg = lastError || "All combo models unavailable"

	if (earliestRetryAfter) {
		const retryHuman = formatRetryAfter(earliestRetryAfter)
		log.warn("COMBO", `All models failed | ${msg} (${retryHuman})`)
		return unavailableResponse(status, msg, earliestRetryAfter, retryHuman)
	}

	log.warn("COMBO", `All models failed | ${msg}`)
	return new Response(JSON.stringify({ error: { message: msg } }), {
		status,
		headers: { "Content-Type": "application/json" },
	})
}
