import * as api from "../../api/client.js"
import { clearScreen } from "../display.js"
import { prompt } from "../input.js"

// Provider alias order: OAuth first, then Free, then API Key
const PROVIDER_ALIAS_ORDER = [
	"cc",
	"ag",
	"cx",
	"if",
	"qw",
	"gc",
	"gh",
	"kr",
	"oc",
	"openrouter",
	"glm",
	"kimi",
	"minimax",
	"openai",
	"anthropic",
	"gemini",
]

// Alias to display name mapping
const PROVIDER_ALIAS_NAMES = {
	cc: "Claude Code",
	ag: "Antigravity",
	cx: "OpenAI Codex",
	if: "iFlow AI",
	qw: "Qwen Code",
	gc: "Gemini CLI",
	gh: "GitHub Copilot",
	kr: "Kiro AI",
	oc: "OpenCode Free",
	opencode: "OpenCode Free",
	openrouter: "OpenRouter",
	glm: "Zai GLM Coding",
	kimi: "Kimi Coding",
	minimax: "Minimax Coding",
	openai: "OpenAI",
	anthropic: "Anthropic",
	gemini: "Gemini",
}

const PROVIDER_ID_TO_ALIAS = {
	claude: "cc",
	codex: "cx",
	"gemini-cli": "gc",
	github: "gh",
	antigravity: "ag",
	iflow: "if",
	qwen: "qw",
	kiro: "kr",
	cursor: "cu",
	cline: "cline",
	clinepass: "clinepass",
	qoder: "qd",
	"qoder-cn": "qd",
	gitlab: "gitlab",
	"codebuddy-cn": "cb",
	"codebuddy-intl": "cbai",
	kimchi: "kimchi",
	"grok-cli": "grok-cli",
	trae: "trae",
	windsurf: "windsurf",
	zed: "zed",
	opencode: "oc",
	"opencode-go": "ocg",
	"opencode-zen": "ocz",
}

// Providers usable without stored credentials
const NO_AUTH_PROVIDERS = new Set(["opencode", "oc"])

/**
 * Get all available models grouped by provider + combos (filtered by active connections)
 * @returns {Promise<{combos: Array, groups: Object}>}
 */
async function getAvailableModelsGrouped() {
	const [modelsResult, providersResult] = await Promise.all([
		api.getAvailableModels(),
		api.getProviders(),
	])

	if (!modelsResult.success) return { combos: [], groups: {} }

	const connections = providersResult.success ? providersResult.data?.connections || [] : []
	const activeAliases = new Set(NO_AUTH_PROVIDERS)

	connections.forEach((conn) => {
		if (conn.isActive === false) return
		const p = conn.provider
		if (!p) return
		activeAliases.add(p)
		const alias = conn.providerSpecificData?.prefix || PROVIDER_ID_TO_ALIAS[p] || p
		activeAliases.add(alias)
	})

	const models = modelsResult.data?.data || []
	const combos = []
	const groups = {}

	models.forEach((m) => {
		if (m.owned_by === "combo") {
			combos.push(m.id)
		} else {
			const provider = m.owned_by
			// Only keep connected providers or noAuth providers
			if (!activeAliases.has(provider)) return
			if (!groups[provider]) {
				groups[provider] = []
			}
			groups[provider].push(m.id)
		}
	})

	return { combos, groups }
}

export {
	getAvailableModelsGrouped,
	NO_AUTH_PROVIDERS,
	PROVIDER_ALIAS_NAMES,
	PROVIDER_ALIAS_ORDER,
	PROVIDER_ID_TO_ALIAS,
}
