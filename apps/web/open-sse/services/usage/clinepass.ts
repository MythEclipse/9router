/**
 * ClinePass usage — GET /api/v1/users/me/plan/usage-limits
 *
 * Auth:
 * - API key: `Authorization: Bearer <key>`
 * - OAuth:   buildClineHeaders(accessToken) → `Bearer workos:<JWT>`
 *
 * Response shape (verified against app.cline.bot dashboard):
 *   { success: true, data: { limits: [{ type, percentUsed, resetsAt }] } }
 *   type ∈ five_hour | weekly | monthly
 */

import { buildClineHeaders } from "../../shared/clineAuth.ts"
import type { ProxyOptions } from "../../types.ts"
import { proxyAwareFetch } from "../../utils/proxyFetch.ts"
import { parseResetTime, toFiniteNumber, U, type UsageQuotaMap } from "./shared.ts"

const WINDOW_LABELS: Record<string, string> = {
	five_hour: "Session (5h)",
	weekly: "Weekly (7d)",
	monthly: "Monthly",
}

const WINDOW_ORDER = ["five_hour", "weekly", "monthly"]

function percentQuota(percentUsed: unknown, resetsAt: unknown) {
	const used = Math.max(0, Math.min(100, toFiniteNumber(percentUsed, 0)))
	return {
		used,
		total: 100,
		remainingPercentage: Math.max(0, 100 - used),
		resetAt: parseResetTime(resetsAt),
	}
}

function buildAuthHeaders(accessToken?: string | null, apiKey?: string | null) {
	const useApiKey = typeof apiKey === "string" && apiKey.trim().length > 0
	if (useApiKey) {
		return {
			Accept: "application/json",
			Authorization: `Bearer ${apiKey.trim()}`,
		}
	}
	if (typeof accessToken === "string" && accessToken.trim().length > 0) {
		return buildClineHeaders(accessToken.trim(), { Accept: "application/json" })
	}
	return null
}

export async function getClinepassUsage(
	accessToken: string | null = null,
	apiKey: string | null = null,
	proxyOptions: ProxyOptions | null = null,
) {
	const headers = buildAuthHeaders(accessToken, apiKey)
	if (!headers) {
		return { message: "ClinePass access token or API key not available." }
	}

	const usageUrl = U("clinepass").url
	if (!usageUrl) {
		return { message: "ClinePass usage endpoint is not configured." }
	}

	try {
		const response = await proxyAwareFetch(usageUrl, { method: "GET", headers }, proxyOptions)

		if (response.status === 401 || response.status === 403) {
			return {
				plan: "ClinePass",
				message: "ClinePass authentication expired. Please re-authorize.",
			}
		}

		if (!response.ok) {
			const errText = await response.text().catch(() => "")
			return {
				plan: "ClinePass",
				message: `ClinePass usage API error (${response.status})${errText ? `: ${errText.slice(0, 120)}` : ""}`,
			}
		}

		const body = await response.json().catch(() => null)
		if (!body || typeof body !== "object") {
			return { message: "ClinePass usage response was not JSON." }
		}

		const limits = Array.isArray((body as any)?.data?.limits) ? (body as any).data.limits : []
		const byType = new Map<string, any>()
		for (const item of limits) {
			if (!item || typeof item !== "object") continue
			const type = typeof item.type === "string" ? item.type : ""
			if (!WINDOW_LABELS[type]) continue
			byType.set(type, item)
		}

		const quotas: UsageQuotaMap = {}
		for (const type of WINDOW_ORDER) {
			const item = byType.get(type)
			if (!item) continue
			quotas[WINDOW_LABELS[type]] = percentQuota(item.percentUsed, item.resetsAt)
		}

		if (Object.keys(quotas).length === 0) {
			return {
				plan: "ClinePass",
				message: "ClinePass connected. No usage limits reported for this plan.",
				quotas: {},
			}
		}

		return { plan: "ClinePass", quotas }
	} catch (error: any) {
		return { message: `ClinePass usage error: ${error.message}` }
	}
}
