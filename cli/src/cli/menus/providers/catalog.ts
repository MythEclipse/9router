import * as api from "../../api/client.js"
import { copyToClipboard } from "../../utils/clipboard.js"
import { clearScreen, showHeader, showStatus } from "../../utils/display.js"
import { confirm, pause, prompt } from "../../utils/input.js"
import { showListMenu, showMenuWithBack } from "../../utils/menuHelper.js"

// ANSI colors for styling
const COLORS = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	cyan: "\x1b[36m",
	dim: "\x1b[2m",
}

// Provider models - static config (synced from open-sse/config/providerModels.js)
const PROVIDER_MODELS = {
	cc: [
		{ id: "claude-opus-4-5-20251101" },
		{ id: "claude-sonnet-4-5-20250929" },
		{ id: "claude-haiku-4-5-20251001" },
	],
	cx: [
		{ id: "gpt-5.2-codex" },
		{ id: "gpt-5.2" },
		{ id: "gpt-5.1-codex-max" },
		{ id: "gpt-5.1-codex" },
		{ id: "gpt-5.1-codex-mini" },
		{ id: "gpt-5.1" },
		{ id: "gpt-5-codex" },
		{ id: "gpt-5-codex-mini" },
	],
	gc: [
		{ id: "gemini-3-flash-preview" },
		{ id: "gemini-3-pro-preview" },
		{ id: "gemini-2.5-pro" },
		{ id: "gemini-2.5-flash" },
		{ id: "gemini-2.5-flash-lite" },
	],
	qw: [{ id: "qwen3-coder-plus" }, { id: "qwen3-coder-flash" }, { id: "vision-model" }],
	if: [
		{ id: "qwen3-coder-plus" },
		{ id: "kimi-k2" },
		{ id: "kimi-k2-thinking" },
		{ id: "deepseek-r1" },
		{ id: "deepseek-v3.2-chat" },
		{ id: "deepseek-v3.2-reasoner" },
		{ id: "minimax-m2" },
		{ id: "glm-4.7" },
	],
	ag: [
		{ id: "gemini-4-argon-high" },
		{ id: "gemini-4-argon-medium" },
		{ id: "gemini-4-argon-low" },
		{ id: "gemini-4-argon" },
		{ id: "gemini-3.8-flash-high" },
		{ id: "gemini-3.8-flash-medium" },
		{ id: "gemini-3.8-flash-low" },
		{ id: "gemini-3.7-flash-high" },
		{ id: "gemini-3.7-flash-medium" },
		{ id: "gemini-3.7-flash-low" },
		{ id: "gemini-3.6-flash-high" },
		{ id: "gemini-3.6-flash-medium" },
		{ id: "gemini-3.6-flash-low" },
		{ id: "gemini-3-flash-agent" },
		{ id: "gemini-3.5-flash-low" },
		{ id: "gemini-3.5-flash-extra-low" },
		{ id: "gemini-pro-agent" },
		{ id: "gemini-3.1-pro-low" },
		{ id: "claude-sonnet-5-5" },
		{ id: "claude-sonnet-5-5-low" },
		{ id: "claude-sonnet-5-5-medium" },
		{ id: "claude-sonnet-5-5-high" },
		{ id: "claude-opus-5-5" },
		{ id: "claude-opus-5-5-low" },
		{ id: "claude-opus-5-5-medium" },
		{ id: "claude-opus-5-5-high" },
		{ id: "claude-sonnet-4-6" },
		{ id: "claude-opus-4-6-thinking" },
		{ id: "gpt-oss-120b-medium" },
		{ id: "gemini-3-flash" },
	],
	gh: [
		{ id: "gpt-5" },
		{ id: "gpt-5-mini" },
		{ id: "gpt-5.1-codex" },
		{ id: "gpt-5.1-codex-max" },
		{ id: "gpt-4.1" },
		{ id: "claude-4.5-sonnet" },
		{ id: "claude-4.5-opus" },
		{ id: "claude-4.5-haiku" },
		{ id: "gemini-3-pro" },
		{ id: "gemini-3-flash" },
		{ id: "gemini-2.5-pro" },
		{ id: "grok-code-fast-1" },
	],
	kr: [{ id: "claude-sonnet-5" }, { id: "claude-sonnet-4.5" }, { id: "claude-haiku-4.5" }],
	openai: [
		{ id: "gpt-4o" },
		{ id: "gpt-4o-mini" },
		{ id: "gpt-4-turbo" },
		{ id: "o1" },
		{ id: "o1-mini" },
	],
	anthropic: [
		{ id: "claude-sonnet-4-20250514" },
		{ id: "claude-opus-4-20250514" },
		{ id: "claude-3-5-sonnet-20241022" },
	],
	gemini: [
		{ id: "gemini-3.8-flash" },
		{ id: "gemini-3.7-flash" },
		{ id: "gemini-3.6-flash" },
		{ id: "gemini-3.5-flash-lite" },
		{ id: "gemini-3-pro-preview" },
		{ id: "gemini-2.5-pro" },
		{ id: "gemini-2.5-flash" },
		{ id: "gemini-2.5-flash-lite" },
	],
	openrouter: [{ id: "auto" }],
	glm: [{ id: "glm-4.7" }, { id: "glm-4.6v" }],
	kimi: [{ id: "kimi-latest" }],
	minimax: [{ id: "MiniMax-M2.1" }],
}

// Provider definitions
const OAUTH_PROVIDERS = {
	claude: { id: "claude", alias: "cc", name: "Claude Code" },
	codex: { id: "codex", alias: "cx", name: "OpenAI Codex" },
	"gemini-cli": { id: "gemini-cli", alias: "gc", name: "Gemini CLI" },
	github: { id: "github", alias: "gh", name: "GitHub Copilot" },
	antigravity: { id: "antigravity", alias: "ag", name: "Antigravity" },
	iflow: { id: "iflow", alias: "if", name: "iFlow AI" },
	qwen: { id: "qwen", alias: "qw", name: "Qwen Code" },
	kiro: { id: "kiro", alias: "kr", name: "Kiro AI" },
	glm: { id: "glm", alias: "glm", name: "Zai GLM Coding" },
}

const APIKEY_PROVIDERS = {
	openrouter: { id: "openrouter", name: "OpenRouter" },
	glm: { id: "glm", name: "Zai GLM Coding" },
	minimax: { id: "minimax", name: "Minimax Coding" },
	kimi: { id: "kimi", name: "Kimi" },
	openai: { id: "openai", name: "OpenAI" },
	anthropic: { id: "anthropic", name: "Anthropic" },
	gemini: { id: "gemini", name: "Gemini" },
}

const ALL_PROVIDERS = { ...OAUTH_PROVIDERS, ...APIKEY_PROVIDERS }

/**
 * Get auth type for provider
 * @param {string} providerId - Provider ID
 * @returns {string} "oauth" or "apikey"
 */
function _getAuthType(providerId) {
	return OAUTH_PROVIDERS[providerId] ? "oauth" : "apikey"
}

/**
 * Count connections by provider
 * @param {Array} connections - Array of connection objects
 * @returns {Object} Map of providerId -> count
 */
function countConnectionsByProvider(connections) {
	const counts = {}
	connections.forEach((conn) => {
		const providerId = conn.provider || conn.providerId
		counts[providerId] = (counts[providerId] || 0) + 1
	})
	return counts
}

export {
	_getAuthType,
	ALL_PROVIDERS,
	APIKEY_PROVIDERS,
	COLORS,
	countConnectionsByProvider,
	OAUTH_PROVIDERS,
	PROVIDER_MODELS,
}
