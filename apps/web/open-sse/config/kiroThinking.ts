// Extracted from kiroConstants.ts — thinking budget + effort-level resolution. Re-exported from kiroConstants.ts; do not import directly.
import { effortToBudget } from "../translator/concerns/thinking.ts"
import { extractThinking } from "../translator/concerns/thinkingUnified.ts"

export const KIRO_THINKING_BUDGET_DEFAULT = 16000

/**
 * Resolve the Kiro thinking budget requested by a client.
 *
 * Reuses the shared thinkingUnified parser (extractThinking) so every client
 * shape (Claude output_config.effort / thinking.budget_tokens, OpenAI
 * reasoning_effort / reasoning.effort, Gemini, Qwen) maps consistently. Explicit
 * `none`/`off`/disabled wins and returns null (no prefix injected).
 * buildThinkingSystemPrefix performs Kiro's final 1..32000 clamp.
 *
 * @param {object} body OpenAI/Claude-shaped request body
 * @param {object} [headers] Original inbound HTTP headers (case-insensitive)
 * @param {string} [model] Model id the caller asked for
 * @returns {number|null} budget to inject, or null when thinking is disabled
 */
export function resolveKiroThinkingBudget(body, headers, model) {
	const cfg = extractThinking(body)
	if (cfg) {
		if (cfg.mode === "none") return null
		if (cfg.mode === "level" && cfg.level === "disabled") return null
		if (cfg.mode === "budget") return cfg.budget
		if (cfg.mode === "level") return effortToBudget(cfg.level) ?? KIRO_THINKING_BUDGET_DEFAULT
		return KIRO_THINKING_BUDGET_DEFAULT
	}

	if (headers) {
		const beta = pickHeader(headers, "anthropic-beta")
		if (typeof beta === "string" && beta.toLowerCase().includes("interleaved-thinking")) {
			return KIRO_THINKING_BUDGET_DEFAULT
		}
	}

	if (containsThinkingModeTag(body)) return KIRO_THINKING_BUDGET_DEFAULT

	if (typeof model === "string" && model) {
		const m = model.toLowerCase()
		if (m.includes("thinking") || m.includes("-reason")) return KIRO_THINKING_BUDGET_DEFAULT
	}

	return null
}

function parseClaudeVersion(model) {
	if (typeof model !== "string") return null
	const normalized = model.toLowerCase().replace(/-/g, ".")
	const match = normalized.match(/(?:^|[/.])claude(?:[/.][a-z]+)*[/.](\d+)(?:[/.](\d+))?(?:[/.]|$)/)
	if (!match) return null
	return { major: Number(match[1]), minor: match[2] === undefined ? null : Number(match[2]) }
}

// Kiro effort tiers per model (kiro.dev docs + live additionalModelRequestFieldsSchema):
// 4.6 Claude models cap at low|medium|high|max; 4.7+ add xhigh. Unknown models stay conservative.
function kiroModelLacksXhigh(model) {
	const v = parseClaudeVersion(model)
	return !v || (v.major === 4 && v.minor !== null && v.minor <= 6)
}

export function extractKiroEffortLevel(body, model) {
	const effort =
		body?.output_config?.effort ??
		body?.reasoning_effort ??
		(typeof body?.reasoning === "object" ? body.reasoning?.effort : null)
	if (typeof effort !== "string") return null
	const normalized = effort.toLowerCase()
	if (normalized === "none" || normalized === "off" || normalized === "disabled") return null
	if (normalized === "xhigh") return kiroModelLacksXhigh(model) ? "high" : "xhigh"
	if (normalized === "max") return "max"
	if (["low", "medium", "high"].includes(normalized)) return normalized
	return null
}

function extractKiroGptEffortLevel(body) {
	const effort =
		body?.output_config?.effort ??
		body?.reasoning_effort ??
		(typeof body?.reasoning === "object" ? body.reasoning?.effort : null)
	if (typeof effort !== "string") return null
	const normalized = effort.toLowerCase()
	if (normalized === "max") return "xhigh"
	// Kiro CLI does not advertise an explicit GPT "none" wire value; omit it.
	if (["low", "medium", "high", "xhigh"].includes(normalized)) {
		return normalized
	}
	return null
}

export function buildKiroAdditionalModelRequestFields(body, effortPath = "output_config", model) {
	const effort =
		effortPath === "reasoning" ? extractKiroGptEffortLevel(body) : extractKiroEffortLevel(body, model)
	if (!effort) return undefined
	if (effortPath === "reasoning") {
		// Mirrors Kiro CLI/KAS buildEffortRequestFields("reasoning") for GPT.
		return { reasoning: { effort } }
	}
	// Mirrors Kiro CLI/KAS buildEffortRequestFields("output_config").
	return {
		thinking: { type: "adaptive", display: "summarized" },
		output_config: { effort },
	}
}

export function resolveKiroEffortPath(model) {
	if (typeof model !== "string") return null
	const normalized = model.toLowerCase().replace(/-/g, ".")
	if (/(?:^|[/.])gpt[/.]5[/.]6(?:[/.]|$)/.test(normalized)) {
		return "reasoning"
	}
	if (!normalized.includes("claude")) return null
	const v = parseClaudeVersion(model)
	if (!v) return null
	const { major, minor } = v
	const dateSuffixMinor = minor !== null && minor >= 1000
	// Kiro rejected additionalModelRequestFields on legacy 4.5 models in live smoke.
	// Default future Claude/Kiro models to supported so new model releases do not
	// need a code allowlist update.
	return major < 4 || (major === 4 && (minor === null || minor <= 5 || dateSuffixMinor))
		? null
		: "output_config"
}

export function supportsKiroAdditionalModelRequestFields(model) {
	return resolveKiroEffortPath(model) !== null
}

export function usesKiroNativeGptEffort(body, model) {
	return resolveKiroEffortPath(model) === "reasoning" && extractKiroGptEffortLevel(body) !== null
}

export function buildKiroAdditionalModelRequestFieldsForModel(body, model) {
	const effortPath = resolveKiroEffortPath(model)
	if (!effortPath) return undefined
	return buildKiroAdditionalModelRequestFields(body, effortPath, model)
}
function pickHeader(headers, name) {
	if (!headers) return undefined
	if (typeof headers.get === "function") {
		return headers.get(name)
	}
	const lower = name.toLowerCase()
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === lower) {
			return headers[key]
		}
	}
	return undefined
}

function containsThinkingModeTag(body) {
	const messages = Array.isArray(body?.messages) ? body.messages : []
	for (const msg of messages) {
		if (!msg) continue
		if (msg.role !== "system" && msg.role !== "user") continue
		const content = msg.content
		if (typeof content === "string") {
			if (containsTagInText(content)) return true
		} else if (Array.isArray(content)) {
			for (const part of content) {
				const text = part?.text
				if (typeof text === "string" && containsTagInText(text)) return true
			}
		}
	}
	if (typeof body?.system === "string" && containsTagInText(body.system)) return true
	return false
}

function containsTagInText(text) {
	if (!text) return false
	if (!text.includes("<thinking_mode>")) return false
	return (
		text.includes("<thinking_mode>enabled</thinking_mode>") ||
		text.includes("<thinking_mode>interleaved</thinking_mode>")
	)
}
