/**
 * Usage Fetcher - Get usage data from provider APIs
 */

import { consumeClaudeResetGrant, getClaudeUsage } from "./usage/claude.ts"
import {
	consumeCodexRateLimitResetCredit,
	getCodexRateLimitResetCredits,
	getCodexUsage,
} from "./usage/codex.ts"
import { getGitHubUsage } from "./usage/github.ts"
import { getAntigravityUsage, getGeminiUsage } from "./usage/google.ts"

export { consumeClaudeResetGrant, consumeCodexRateLimitResetCredit, getCodexRateLimitResetCredits }

import type { Credentials, ProxyOptions } from "../types.ts"
import { getMiniMaxCodeUsage } from "./minimaxCodeUsage.ts"
import { resolveQoderCredentials } from "./qoderModels.ts"
import { getCodeBuddyCnUsage, getCodeBuddyIntlUsage } from "./usage/codebuddy-cn.ts"
import { getCommandCodeUsage } from "./usage/commandcode.ts"
import { getCursorUsage } from "./usage/cursor.ts"
import { getCustomCreditsUsage, isCustomQuotaProvider } from "./usage/customCredits.ts"
import { getDeepseekUsage } from "./usage/deepseek.ts"
import { getGlmUsage } from "./usage/glm.ts"
import { getGrokCliUsage } from "./usage/grok-cli.ts"
import { getGroqUsage } from "./usage/groq.ts"
import { getKimiUsage } from "./usage/kimi.ts"
import { getKiroUsage } from "./usage/kiro.ts"
import { getMiniMaxUsage } from "./usage/minimax.ts"
import {
	getIflowUsage,
	getOllamaUsage,
	getQoderUsage,
	getVercelAiGatewayUsage,
} from "./usage/misc.ts"
import { getOpenCodeGoUsage } from "./usage/opencode-go.ts"
import { getOpenCodeZenUsage } from "./usage/opencode-zen.ts"
import type { UsageProviderData, UsageQuotaMap } from "./usage/shared.ts"
import { getXiaomiMimoUsage } from "./usage/xiaomi-mimo.ts"
import { getZedUsage } from "./usage/zed.ts"

/**
 * Get usage data for a provider connection
 * @param {Object} connection - Provider connection with accessToken
 * @returns {Object} Usage data with quotas
 */
// provider → usage handler (ctx carries every arg each handler needs)
/**
 * The context handed to a usage handler: the stored connection (a
 * `Credentials` superset, since handlers read `accessToken` / `apiKey` /
 * `providerSpecificData`) plus the extras the dispatcher computes.
 */
type UsageHandlerContext = Credentials & {
	provider: string
	/** `providerSpecificData` with the resolved project id merged in. */
	providerDataWithProjectId?: UsageProviderData
	proxyOptions?: ProxyOptions | null
	force?: boolean
}

/** Everything a usage handler may return: quotas, a plan, or a UI message. */
export type ProviderUsageResult = {
	quotas?: UsageQuotaMap
	plan?: string | null
	message?: string
	[key: string]: unknown
}

const USAGE_HANDLERS: Record<string, (c: UsageHandlerContext) => Promise<ProviderUsageResult>> = {
	github: (c) => getGitHubUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
	"gemini-cli": (c) => getGeminiUsage(c.accessToken, c.providerDataWithProjectId, c.proxyOptions),
	antigravity: (c) => getAntigravityUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
	claude: (c) => getClaudeUsage(c.accessToken, c.proxyOptions, { force: c.force }),
	codex: (c) => getCodexUsage(c.accessToken, c.proxyOptions),
	kiro: (c) => getKiroUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
	qoder: (c) => getQoderUsageFor(c),
	"qoder-cn": (c) => getQoderUsageFor(c),
	iflow: (c) => getIflowUsage(c.accessToken),
	ollama: (c) => getOllamaUsage(c.apiKey, c.providerSpecificData, c.proxyOptions),
	// OAuth connections store the coding-plan key on accessToken (no apiKey)
	glm: (c) => getGlmUsage(c.apiKey || c.accessToken, c.provider, c.proxyOptions),
	"glm-cn": (c) => getGlmUsage(c.apiKey || c.accessToken, c.provider, c.proxyOptions),
	minimax: (c) => getMiniMaxUsage(c.apiKey, c.provider, c.proxyOptions),
	"minimax-cn": (c) => getMiniMaxUsage(c.apiKey, c.provider, c.proxyOptions),
	// MiniMax Code (mcode) credits lane — signed account API + plan windows
	"minimax-code": (c) => getMiniMaxCodeUsage(c),
	"minimax-code-global": (c) => getMiniMaxCodeUsage(c),
	"vercel-ai-gateway": (c) => getVercelAiGatewayUsage(c.apiKey, c.proxyOptions),
	"codebuddy-cn": (c) =>
		getCodeBuddyCnUsage(c.accessToken, c.apiKey, c.providerSpecificData, c.proxyOptions),
	"codebuddy-intl": (c) =>
		getCodeBuddyIntlUsage(c.accessToken, c.apiKey, c.providerSpecificData, c.proxyOptions),
	"grok-cli": (c) => getGrokCliUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
	kimi: (c) => getKimiUsage(c.accessToken, c.apiKey, c.proxyOptions, c.providerSpecificData),
	"opencode-go": (c) => getOpenCodeGoUsage(c.apiKey, c.proxyOptions),
	"opencode-zen": (c) => getOpenCodeZenUsage(c.apiKey, c.proxyOptions),
	deepseek: (c) => getDeepseekUsage(c.apiKey, c.proxyOptions),
	groq: (c) => getGroqUsage(c.apiKey, c.proxyOptions),
	zed: (c) => getZedUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
	"xiaomi-mimo": (c) => getXiaomiMimoUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
	commandcode: (c) => getCommandCodeUsage(c.apiKey, c.proxyOptions),
	cursor: (c) => getCursorUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
}

// Qoder intl/CN share one usage path: PATs must be exchanged to a job token
// before the quota endpoint accepts them, and the quota URL comes from the
// provider's own registry usage block (region-correct via c.provider).
async function getQoderUsageFor(c: UsageHandlerContext): Promise<ProviderUsageResult> {
	const resolved = await resolveQoderCredentials(c, c.proxyOptions).catch(() => null)
	return getQoderUsage(resolved?.accessToken || c.accessToken, c.proxyOptions, c.provider || "qoder")
}

export async function getUsageForProvider(
	connection: UsageHandlerContext & { projectId?: string },
	proxyOptions: ProxyOptions | null = null,
	options: { force?: boolean } = {},
): Promise<ProviderUsageResult> {
	const { provider, accessToken, apiKey, providerSpecificData, projectId } = connection
	const providerDataWithProjectId = {
		...(providerSpecificData || {}),
		...(projectId ? { projectId } : {}),
	}

	// Compatible providers use the standard /credits endpoint configured on the node.
	if (isCustomQuotaProvider(provider)) {
		return await getCustomCreditsUsage({
			provider,
			apiKey,
			providerSpecificData,
			proxyOptions,
			force: options.force === true,
		})
	}

	const handler = USAGE_HANDLERS[provider]
	if (!handler) return { message: `Usage API not implemented for ${provider}` }
	return await handler({
		provider,
		accessToken,
		apiKey,
		providerSpecificData,
		providerDataWithProjectId,
		proxyOptions,
		force: options.force === true,
	})
}
