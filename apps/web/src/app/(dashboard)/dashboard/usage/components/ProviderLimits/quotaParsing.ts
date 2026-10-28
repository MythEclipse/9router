/**
 * Normalizing a provider's quota payload into the rows the usage UI renders.
 *
 * Every provider reports the same idea — a named bucket with used/total and a reset
 * time — in its own shape, so this is one switch keyed by provider. A case that
 * recognizes nothing returns no rows rather than guessing, because an invented row
 * shows a limit that does not exist.
 */
import { getModelsByProviderId } from "open-sse/config/providerModels"
import { calculatePercentage } from "./quotaPercentage.ts"

/** One quota bucket as returned by a provider quota endpoint. */
export interface RawQuotaEntry {
	used?: number
	total?: number
	resetAt?: string | null
	displayName?: string
	remainingPercentage?: number
	remaining?: number
	unit?: string
	neverExpires?: boolean
	detailUrl?: string
	recurring?: boolean
	isCreditBalance?: boolean
	currency?: string
	// Providers attach extra per-quota metadata; normalized rows pass it through.
	[key: string]: unknown
}

/** The raw per-provider quota payload this module normalizes. */
export interface RawQuotaPayload {
	quotas?: Record<string, RawQuotaEntry>
	[key: string]: unknown
}

/** A normalized quota row consumed by the usage UI. */
export interface NormalizedQuota {
	name: string
	used: number
	total: number
	resetAt: string | null
	modelKey?: string
	remainingPercentage?: number
	quotaType?: string
	unit?: string
	message?: string
	remaining?: number
	neverExpires?: boolean
	recurring?: boolean
	isCreditBalance?: boolean
	// Pass-through of provider-specific quota metadata.
	[key: string]: unknown
}

export function parseQuotaData(
	provider: string,
	data: RawQuotaPayload | null | undefined,
): NormalizedQuota[] {
	if (!data || typeof data !== "object") return []

	const normalizedQuotas: NormalizedQuota[] = []

	try {
		switch (provider.toLowerCase()) {
			case "github":
				if (data.quotas) {
					Object.entries(data.quotas).forEach(([name, quota]) => {
						normalizedQuotas.push({
							name,
							used: quota.used || 0,
							total: quota.total || 0,
							resetAt: quota.resetAt || null,
						})
					})
				}
				break

			case "antigravity":
				if (data.quotas) {
					const entries = Object.entries(data.quotas)
					const weeklyKeys = new Set(["gemini_weekly", "claude_gpt_weekly", "argon_weekly"])
					const sessionKeys = new Set(["gemini_session", "claude_gpt_session", "argon_session"])
					const summaryKeys = new Set([...weeklyKeys, ...sessionKeys])
					const geminiModels = entries.filter(
						([k]) => k.startsWith("gemini-") && !k.includes("image") && !k.includes("argon"),
					)
					const argonModels = entries.filter(([k]) => k.includes("argon"))
					const claudeModels = entries.filter(([k]) => k.startsWith("claude-"))
					const imageModels = entries.filter(([k]) => k.includes("image"))
					const summaryModels = entries.filter(([k]) => summaryKeys.has(k))
					const otherModels = entries.filter(
						([k]) =>
							!k.startsWith("gemini-") &&
							!k.startsWith("claude-") &&
							!k.includes("image") &&
							!summaryKeys.has(k),
					)

					// Summary keys from retrieveUserQuotaSummary
					const hasGeminiWeekly = Boolean(data.quotas.gemini_weekly)
					const hasGeminiSession = Boolean(data.quotas.gemini_session)
					const hasArgonWeekly = Boolean(data.quotas.argon_weekly)
					const hasArgonSession = Boolean(data.quotas.argon_session)
					const hasClaudeWeekly = Boolean(data.quotas.claude_gpt_weekly)
					const hasClaudeSession = Boolean(data.quotas.claude_gpt_session)

					// 1. Gemini Family:
					if (hasGeminiSession) {
						summaryModels
							.filter(([k]) => k === "gemini_session")
							.forEach(([modelKey, quota]) => {
								normalizedQuotas.push({
									name: quota.displayName || modelKey,
									modelKey,
									used: quota.used || 0,
									total: quota.total || 0,
									resetAt: quota.resetAt || null,
									remainingPercentage: quota.remainingPercentage,
								})
							})
					} else if (geminiModels.length > 0) {
						const rep = geminiModels.reduce((min, cur) =>
							(cur[1].remainingPercentage ?? 100) < (min[1].remainingPercentage ?? 100) ? cur : min,
						)[1]
						// Only show synthesized Gemini row if its resetAt differs from weekly (i.e. it represents a separate 5h window)
						const weeklyResetAt = data.quotas.gemini_weekly?.resetAt
						const isDuplicateOfWeekly =
							hasGeminiWeekly && rep.resetAt === weeklyResetAt && (rep.remainingPercentage ?? 0) === 0

						if (!isDuplicateOfWeekly) {
							normalizedQuotas.push({
								name: "Gemini (Flash / Pro)",
								modelKey: "gemini",
								used: rep.used || 0,
								total: rep.total || 0,
								resetAt: rep.resetAt || null,
								remainingPercentage: rep.remainingPercentage,
							})
						}
					}

					// Show Gemini weekly row if present
					if (hasGeminiWeekly) {
						summaryModels
							.filter(([k]) => k === "gemini_weekly")
							.forEach(([modelKey, quota]) => {
								normalizedQuotas.push({
									name: quota.displayName || modelKey,
									modelKey,
									used: quota.used || 0,
									total: quota.total || 0,
									resetAt: quota.resetAt || null,
									remainingPercentage: quota.remainingPercentage,
								})
							})
					}

					// 2. Gemini 4 Argon Family:
					if (hasArgonSession) {
						summaryModels
							.filter(([k]) => k === "argon_session")
							.forEach(([modelKey, quota]) => {
								normalizedQuotas.push({
									name: quota.displayName || modelKey,
									modelKey,
									used: quota.used || 0,
									total: quota.total || 0,
									resetAt: quota.resetAt || null,
									remainingPercentage: quota.remainingPercentage,
								})
							})
					} else if (argonModels.length > 0) {
						const rep = argonModels.reduce((min, cur) =>
							(cur[1].remainingPercentage ?? 100) < (min[1].remainingPercentage ?? 100) ? cur : min,
						)[1]
						const weeklyResetAt = data.quotas.argon_weekly?.resetAt
						const isDuplicateOfWeekly =
							hasArgonWeekly && rep.resetAt === weeklyResetAt && (rep.remainingPercentage ?? 0) === 0

						if (!isDuplicateOfWeekly) {
							normalizedQuotas.push({
								name: "Gemini 4 Argon",
								modelKey: "gemini-4-argon",
								used: rep.used || 0,
								total: rep.total || 0,
								resetAt: rep.resetAt || null,
								remainingPercentage: rep.remainingPercentage,
							})
						}
					}

					// Show Argon weekly row if present
					if (hasArgonWeekly) {
						summaryModels
							.filter(([k]) => k === "argon_weekly")
							.forEach(([modelKey, quota]) => {
								normalizedQuotas.push({
									name: quota.displayName || modelKey,
									modelKey,
									used: quota.used || 0,
									total: quota.total || 0,
									resetAt: quota.resetAt || null,
									remainingPercentage: quota.remainingPercentage,
								})
							})
					}

					// 3. Claude & GPT Family:
					if (hasClaudeSession) {
						summaryModels
							.filter(([k]) => k === "claude_gpt_session")
							.forEach(([modelKey, quota]) => {
								normalizedQuotas.push({
									name: quota.displayName || modelKey,
									modelKey,
									used: quota.used || 0,
									total: quota.total || 0,
									resetAt: quota.resetAt || null,
									remainingPercentage: quota.remainingPercentage,
								})
							})
					} else if (claudeModels.length > 0) {
						const rep = claudeModels.reduce((min, cur) =>
							(cur[1].remainingPercentage ?? 100) < (min[1].remainingPercentage ?? 100) ? cur : min,
						)[1]
						const weeklyResetAt = data.quotas.claude_gpt_weekly?.resetAt
						const isDuplicateOfWeekly =
							hasClaudeWeekly && rep.resetAt === weeklyResetAt && (rep.remainingPercentage ?? 0) === 0

						if (!isDuplicateOfWeekly) {
							normalizedQuotas.push({
								name: "Claude (Sonnet / Opus)",
								modelKey: "claude",
								used: rep.used || 0,
								total: rep.total || 0,
								resetAt: rep.resetAt || null,
								remainingPercentage: rep.remainingPercentage,
							})
						}
					}

					// Show Claude & GPT weekly row if present
					if (hasClaudeWeekly) {
						summaryModels
							.filter(([k]) => k === "claude_gpt_weekly")
							.forEach(([modelKey, quota]) => {
								normalizedQuotas.push({
									name: quota.displayName || modelKey,
									modelKey,
									used: quota.used || 0,
									total: quota.total || 0,
									resetAt: quota.resetAt || null,
									remainingPercentage: quota.remainingPercentage,
								})
							})
					}

					// 3. Standalone Image Generation Models (unique usage)
					imageModels.forEach(([modelKey, quota]) => {
						normalizedQuotas.push({
							name: quota.displayName || modelKey,
							modelKey,
							used: quota.used || 0,
							total: quota.total || 0,
							resetAt: quota.resetAt || null,
							remainingPercentage: quota.remainingPercentage,
						})
					})

					// 4. Other models:
					// In Antigravity, GPT-OSS is explicitly documented by Google as part of the "Claude and GPT models" group:
					// ("Models within this group: Claude Opus, Claude Sonnet, GPT-OSS").
					// When summary quotas (claude_gpt_session / claude_gpt_weekly) are present, GPT-OSS is already represented
					// by the "Claude & GPT" family rows. We only include otherModels if no summary exists for that pool.
					if (!hasClaudeWeekly && !hasClaudeSession) {
						otherModels.forEach(([modelKey, quota]) => {
							normalizedQuotas.push({
								name: quota.displayName || modelKey,
								modelKey,
								used: quota.used || 0,
								total: quota.total || 0,
								resetAt: quota.resetAt || null,
								remainingPercentage: quota.remainingPercentage,
							})
						})
					}
				}
				break

			case "codex":
				if (data.quotas) {
					Object.entries(data.quotas).forEach(([quotaType, quota]) => {
						let displayName = quotaType
						if (quotaType === "spark_session") displayName = "Spark (5h)"
						else if (quotaType === "spark_weekly") displayName = "Spark (Weekly)"
						else if (quotaType === "session") displayName = "5h"
						else if (quotaType === "weekly") displayName = "Weekly"
						else if (quotaType === "review_session") displayName = "Review (5h)"
						else if (quotaType === "review_weekly") displayName = "Review (Weekly)"

						normalizedQuotas.push({
							name: displayName,
							quotaType,
							used: quota.used || 0,
							total: quota.total || 0,
							remaining: quota.remaining,
							resetAt: quota.resetAt || null,
						})
					})
				}
				break

			case "kiro":
				if (data.quotas) {
					Object.entries(data.quotas).forEach(([quotaType, quota]) => {
						normalizedQuotas.push({
							name: quotaType,
							used: quota.used || 0,
							total: quota.total || 0,
							resetAt: quota.resetAt || null,
						})
					})
				}
				break

			case "qoder":
			case "qoder-cn":
				// Qoder ships a `user` quota, an optional `organization` quota and —
				// when the account has redeemed a free-credit promo — an `addOn`
				// bucket. All share the shape {total, used, remaining, unit, resetAt}.
				// Skip any bucket whose total is 0: `personal_standard` accounts
				// report `user` as 0/0 (their grant lives in `addOn`) and most
				// accounts never have an organization bucket, so rendering "0/0"
				// rows is noise. Buckets holding an actual grant always have
				// total > 0 and are kept.
				// Don't forward Qoder's `remaining` field: it's an absolute credit
				// count, but getRemainingPercentage / QuotaTable interpret
				// `remaining` as a 0-100 percentage and would render 348 credits
				// as "348%". The percentage is computed from used/total instead.
				if (data.quotas) {
					Object.entries(data.quotas).forEach(([quotaType, quota]) => {
						if (!quota || (Number(quota.total) || 0) === 0) {
							return
						}
						normalizedQuotas.push({
							name:
								quotaType === "user"
									? "Personal"
									: quotaType === "organization"
										? "Organization"
										: quotaType === "addOn"
											? "Add-on"
											: quotaType,
							used: quota.used || 0,
							total: quota.total || 0,
							unit: quota.unit,
							resetAt: quota.resetAt || null,
							// Qoder reports open-ended plans as a 9999 sentinel; the service
							// turns that into neverExpires so the row can read
							// "Never expires" instead of "N/A" or a year-9999 date.
							neverExpires: quota.neverExpires === true,
							// Present on add-on credits: links to Qoder's own usage page.
							detailUrl: quota.detailUrl || null,
						})
					})
				}
				break

			case "claude":
				if (data.message) {
					// Handle error message case
					normalizedQuotas.push({
						name: "error",
						used: 0,
						total: 0,
						resetAt: null,
						message: typeof data.message === "string" ? data.message : "",
					})
				} else if (data.quotas) {
					Object.entries(data.quotas).forEach(([name, quota]) => {
						normalizedQuotas.push({
							name,
							used: quota.used || 0,
							total: quota.total || 0,
							remaining:
								quota.remaining !== undefined
									? quota.remaining
									: Math.max(0, (quota.total || 100) - (quota.used || 0)),
							remainingPercentage:
								quota.remainingPercentage !== undefined
									? quota.remainingPercentage
									: calculatePercentage(quota.used, quota.total),
							resetAt: quota.resetAt || null,
						})
					})
				}
				break

			case "vercel-ai-gateway":
				// Vercel returns currency credit balance, not request quotas.
				// The 'Remaining (USD)' row needs explicit remainingPercentage because
				// its used/total values would otherwise compute the wrong direction
				// (e.g. used=95.5 / total=100 → 4% instead of 96%).
				if (data.quotas) {
					Object.entries(data.quotas).forEach(([name, quota]) => {
						normalizedQuotas.push({
							name,
							used: quota.used || 0,
							total: quota.total || 0,
							resetAt: quota.resetAt || null,
							remainingPercentage: quota.remainingPercentage,
						})
					})
				}
				break

			case "codebuddy-cn":
			case "codebuddy-intl":
				// CodeBuddy CN/Intl mix recurring refill packs ("Monthly"/"Weekly"/...)
				// with one-shot bonus packs ("Bonus Pack N"). Forward `recurring`
				// so the UI can show "Expires in" for bonus packs (whose resetAt is
				// a hard expiry, not a refresh) instead of "Reset in".
				if (data.quotas) {
					Object.entries(data.quotas).forEach(([name, quota]) => {
						normalizedQuotas.push({
							name,
							used: quota.used || 0,
							total: quota.total || 0,
							resetAt: quota.resetAt || null,
							recurring: quota.recurring !== false,
						})
					})
				}
				break

			case "grok-cli":
				// Grok Build credits (on-demand window + prepaid balance).
				// Do NOT forward absolute `remaining` — getRemainingPercentage treats
				// it as a 0–100 percentage (same as Qoder). Use remainingPercentage.
				if (data.quotas) {
					Object.entries(data.quotas).forEach(([name, quota]) => {
						normalizedQuotas.push({
							name,
							used: quota.used || 0,
							total: quota.total || 0,
							resetAt: quota.resetAt || null,
							remainingPercentage: quota.remainingPercentage,
						})
					})
				}
				break

			case "kimi":
				// Weekly / Ratelimit from /v1/usages. Prefer remainingPercentage only.
				if (data.quotas) {
					Object.entries(data.quotas).forEach(([name, quota]) => {
						normalizedQuotas.push({
							name,
							used: quota.used || 0,
							total: quota.total || 0,
							resetAt: quota.resetAt || null,
							remainingPercentage: quota.remainingPercentage,
						})
					})
				}
				break

			case "deepseek":
				// Credit balance — remainingPercentage only (no absolute remaining).
				if (data.quotas) {
					Object.entries(data.quotas).forEach(([name, quota]) => {
						normalizedQuotas.push({
							name,
							used: quota.used || 0,
							total: quota.total || 0,
							resetAt: quota.resetAt || null,
							remainingPercentage: quota.remainingPercentage,
							isCreditBalance: quota.isCreditBalance ?? true,
							currency:
								quota.currency ||
								(name.includes("(") ? name.slice(name.indexOf("(") + 1, name.indexOf(")")) : "USD"),
						})
					})
				}
				break

			case "cursor":
				// Plan spend is USD (cents from GetCurrentPeriodUsage). Forward
				// remainingPercentage only — do not pass absolute remaining (UI treats it as %).
				if (data.quotas) {
					Object.entries(data.quotas).forEach(([name, quota]) => {
						normalizedQuotas.push({
							name,
							used: quota.used || 0,
							total: quota.total || 0,
							resetAt: quota.resetAt || null,
							remainingPercentage: quota.remainingPercentage,
						})
					})
				}
				break

			case "groq":
				// Requests/Tokens rate-limit windows from response headers — absolute
				// used/total (calculatePercentage derives the bar), like Codex/Kiro.
				if (data.quotas) {
					Object.entries(data.quotas).forEach(([name, quota]) => {
						normalizedQuotas.push({
							name,
							used: quota.used || 0,
							total: quota.total || 0,
							resetAt: quota.resetAt || null,
						})
					})
				}
				break

			case "ollama":
				// Session (5h) / Weekly (7d) / Monthly usage % from ollama.com/api/balance (or /api/usage).
				// remainingPercentage only — no absolute remaining (UI treats remaining as %).
				if (data.quotas) {
					Object.entries(data.quotas).forEach(([name, quota]) => {
						normalizedQuotas.push({
							name,
							used: quota.used || 0,
							total: quota.total || 0,
							resetAt: quota.resetAt || null,
							remainingPercentage: quota.remainingPercentage,
							isCreditBalance: quota.isCreditBalance,
							currency: quota.currency,
							unit: quota.unit,
							unlimited: quota.unlimited,
						})
					})
				}
				break

			case "zed":
				// Edit predictions + optional hosted model_requests; unlimited uses remainingPercentage.
				if (data.quotas) {
					Object.entries(data.quotas).forEach(([name, quota]) => {
						normalizedQuotas.push({
							name,
							used: quota.used || 0,
							total: quota.total || 0,
							resetAt: quota.resetAt || null,
							remainingPercentage: quota.remainingPercentage,
							unlimited: quota.unlimited,
						})
					})
				}
				break

			case "minimax-code":
			case "minimax-code-global":
				// Service already returns dashboard-shaped rows: a credits balance
				// (isCreditBalance → 💰 with the amount as total) plus M Plan rate
				// windows as 0-100 percent rows. Pass through, preserving extras.
				if (data.quotas) {
					Object.entries(data.quotas).forEach(([name, quota]) => {
						normalizedQuotas.push({
							name,
							used: quota.used || 0,
							total: quota.total || 0,
							remaining: quota.remaining,
							remainingPercentage: quota.remainingPercentage,
							resetAt: quota.resetAt || null,
							message: typeof quota.message === "string" ? quota.message : "",
							isCreditBalance: quota.isCreditBalance,
							currency: quota.currency,
						})
					})
				}
				break

			default:
				// Generic fallback for unknown providers, including compatible nodes
				// that opt in to the standard /credits endpoint.
				if (data.quotas) {
					Object.entries(data.quotas).forEach(([name, quota]) => {
						normalizedQuotas.push({
							name,
							used: quota.used || 0,
							total: quota.total || 0,
							remainingPercentage: quota.remainingPercentage,
							resetAt: quota.resetAt || null,
							unlimited: quota.unlimited,
							isCreditBalance: quota.isCreditBalance,
							currency: quota.currency,
						})
					})
				}
		}
	} catch (error) {
		console.error(`Error parsing quota data for ${provider}:`, error)
		return []
	}

	if (provider?.toLowerCase() === "claude") {
		const CLAUDE_QUOTA_ORDER = {
			"session (5h)": 0,
			"weekly (7d)": 1,
			"weekly fable (7d)": 2,
			"weekly opus (7d)": 3,
			"weekly sonnet (7d)": 4,
		}
		normalizedQuotas.sort(
			(a, b) => (CLAUDE_QUOTA_ORDER[a.name] ?? 99) - (CLAUDE_QUOTA_ORDER[b.name] ?? 99),
		)
		return normalizedQuotas
	}

	// Sort quotas according to PROVIDER_MODELS order
	const modelOrder = getModelsByProviderId(provider)
	if (modelOrder.length > 0) {
		const orderMap = new Map(modelOrder.map((m, i) => [m.id, i]))

		normalizedQuotas.sort((a, b) => {
			// Use modelKey for antigravity (mapped to family anchor), otherwise use name
			let keyA = a.modelKey || a.name
			let keyB = b.modelKey || b.name
			if (keyA === "gemini" || keyA === "gemini_session") keyA = "gemini-3.8-flash-high"
			if (keyA === "claude" || keyA === "claude_gpt_session") keyA = "claude-sonnet-4-6"
			if (keyB === "gemini" || keyB === "gemini_session") keyB = "gemini-3.8-flash-high"
			if (keyB === "claude" || keyB === "claude_gpt_session") keyB = "claude-sonnet-4-6"
			const orderA = orderMap.get(keyA) ?? 999
			const orderB = orderMap.get(keyB) ?? 999
			return orderA - orderB
		})
	}

	return normalizedQuotas
}
