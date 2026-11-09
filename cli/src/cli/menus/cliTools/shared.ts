import * as api from "../../api/client.js"
import { showStatus } from "../../utils/display.js"
import { getEndpoint } from "../../utils/endpoint.js"
import { confirm, pause, select } from "../../utils/input.js"
import { showMenuWithBack } from "../../utils/menuHelper.js"
import { selectModelFromList } from "../../utils/modelSelector.js"

const COLORS = {
	reset: "\x1b[0m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	dim: "\x1b[2m",
	cyan: "\x1b[36m",
}

// Claude model types with defaults (matching Web UI)
const CLAUDE_MODEL_TYPES = [
	{
		id: "sonnet",
		name: "Sonnet",
		envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL",
		defaultValue: "cc/claude-sonnet-4-5-20250929",
	},
	{
		id: "opus",
		name: "Opus",
		envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL",
		defaultValue: "cc/claude-opus-4-5-20251101",
	},
	{
		id: "haiku",
		name: "Haiku",
		envKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
		defaultValue: "cc/claude-haiku-4-5-20251001",
	},
]

// ─── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Get first available API key from server
 * @returns {Promise<string|null>}
 */
async function getFirstApiKey() {
	const result = await api.getApiKeys()
	const keys = result.success ? result.data.keys || [] : []
	return keys.length > 0 ? keys[0].key : null
}

export { CLAUDE_MODEL_TYPES, COLORS, getFirstApiKey }
