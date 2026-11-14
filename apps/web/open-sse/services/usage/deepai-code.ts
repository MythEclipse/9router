/**
 * DeepAI Code usage - GET https://api.deepai.org/deepai_code/theos
 * Auth: Api-Key + lane/device headers (same contract as the chat lane).
 *
 * The response carries the daily Theos allowance:
 *   { enabled, balance, granted, refresh_at, lane_version }
 * `balance` and `granted` are STRINGS with five decimals, not numbers.
 */
import { buildDeepAiCodeHeaders } from "../../shared/deepaiCode.ts"
import { proxyAwareFetch } from "../../utils/proxyFetch.ts"
import { parseResetTime, toFiniteNumber, U } from "./shared.ts"

const THEOS_URL = U("deepai-code").url || "https://api.deepai.org/deepai_code/theos"

export async function getDeepAiCodeUsage(apiKey = null, proxyOptions = null) {
	if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
		return { message: "DeepAI Code API key not available. Add a key to view usage." }
	}

	try {
		const response = await proxyAwareFetch(
			THEOS_URL,
			{
				method: "GET",
				headers: {
					...buildDeepAiCodeHeaders(apiKey.trim()),
					Accept: "application/json",
				},
			},
			proxyOptions,
		)

		if (response.status === 401) {
			return {
				plan: "DeepAI Code",
				message: "DeepAI Code authentication failed. Check the API key.",
			}
		}
		if (response.status === 403) {
			// A valid key also gets 403 here: upstream answers "Free daily Theos are
			// not available right now. Restart DeepAI Code to..." transiently, so this
			// must not read as a bad key or the operator rotates a working credential.
			const errText = await response.text().catch(() => "")
			return {
				plan: "DeepAI Code",
				message: `DeepAI Code has no Theos allowance available right now${errText ? ` (${errText.slice(0, 120)})` : ""}.`,
			}
		}
		if (response.status === 426) {
			return {
				plan: "DeepAI Code",
				message: "DeepAI Code rejected the lane version. Update 9router.",
			}
		}
		if (!response.ok) {
			const errText = await response.text().catch(() => "")
			return {
				plan: "DeepAI Code",
				message: `DeepAI Code usage API error (${response.status})${errText ? `: ${errText.slice(0, 120)}` : ""}`,
			}
		}

		const data = await response.json().catch(() => null)
		if (!data || typeof data !== "object") {
			return { message: "DeepAI Code usage response was not JSON." }
		}

		// granted 0 is the normal state for a fresh account: it reports the balance
		// but has no allowance window to draw yet, so a quota row would read 0/0.
		const granted = toFiniteNumber(data.granted, 0)
		const balance = toFiniteNumber(data.balance, 0)
		const enabled = data.enabled !== false

		if (!enabled) {
			return { plan: "DeepAI Code", message: "DeepAI Code is not enabled on this account." }
		}
		if (granted <= 0) {
			return {
				plan: "DeepAI Code",
				message: `DeepAI Code connected. Balance ${balance.toFixed(5)} Theos, no daily allowance allocated yet.`,
			}
		}

		const used = Math.max(0, granted - balance)
		return {
			plan: "DeepAI Code",
			quotas: {
				"Daily Theos": {
					used,
					total: granted,
					remainingPercentage: granted > 0 ? Math.round((balance / granted) * 100) : 0,
					remaining: balance,
					resetAt: parseResetTime(data.refresh_at),
					unlimited: false,
					unit: "Theos",
				},
			},
		}
	} catch (error) {
		return { message: `DeepAI Code error: ${(error as Error).message}` }
	}
}
