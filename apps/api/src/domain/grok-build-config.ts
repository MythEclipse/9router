export const GROK_MAIN_MODEL_SLOT = "9router"
export const GROK_BUILTIN_DEFAULT = "grok-build"
export const GROK_SUBAGENT_TYPES = ["general-purpose", "explore", "plan"]

const UNSET_SENTINEL = "__9router_unset__"
const MODELS_SECTION = "models"
const SUBAGENT_MODELS_SECTION = "subagents.models"

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const tomlString = (value: unknown): string => JSON.stringify(String(value))

const sectionRegExp = (section: string): RegExp =>
	new RegExp(`^\\[${escapeRegExp(section)}\\][ \\t]*\\r?\\n((?:(?!\\[)[^\\r\\n]*\\r?\\n?)*)`, "m")

const modelSlot = (type: string): string => `${GROK_MAIN_MODEL_SLOT}-${type}`

const previousDefaultRegExp = /^# 9router-prev-default = "([^"]*)"[ \t]*\r?\n?/m
const previousSubagentRegExp = (type: string): RegExp =>
	new RegExp(`^# 9router-prev-subagent-${escapeRegExp(type)} = "([^"]*)"[ \\t]*\\r?\\n?`, "m")

function getSectionField(toml: string, section: string, key: string): string | null {
	const match = toml.match(sectionRegExp(section))
	if (!match) return null
	const field = match[1].match(
		new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=[ \\t]*"([^"]*)"`, "m"),
	)
	return field ? field[1] : null
}

function getSectionNumber(toml: string, section: string, key: string): number | null {
	const match = toml.match(sectionRegExp(section))
	if (!match) return null
	const field = match[1].match(
		new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=[ \\t]*([0-9]+(?:\\.[0-9]+)?)`, "m"),
	)
	if (!field) return null
	const value = Number(field[1])
	return Number.isFinite(value) ? value : null
}

function setSectionField(toml: string, section: string, key: string, value: unknown): string {
	const match = toml.match(sectionRegExp(section))
	const line = `${key} = ${tomlString(value)}`
	if (!match) {
		const prefix = toml.length > 0 && !toml.endsWith("\n") ? `${toml}\n` : toml
		return `${prefix}\n[${section}]\n${line}\n`
	}

	const body = match[1] || ""
	const fieldRegExp = new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=[ \\t]*"[^"]*"`, "m")
	const nextBody = fieldRegExp.test(body) ? body.replace(fieldRegExp, line) : `${line}\n${body}`
	return toml.replace(match[0], `[${section}]\n${nextBody}`)
}

function deleteSectionField(toml: string, section: string, key: string): string {
	const match = toml.match(sectionRegExp(section))
	if (!match) return toml
	const fieldRegExp = new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=[^\\r\\n]*\\r?\\n?`, "m")
	const nextBody = (match[1] || "").replace(fieldRegExp, "")
	if (!nextBody.trim()) return toml.replace(match[0], "").replace(/\n{3,}/g, "\n\n")
	return toml.replace(match[0], `[${section}]\n${nextBody}`)
}

function parseModelSection(toml: string, slot: string) {
	const match = toml.match(sectionRegExp(`model.${slot}`))
	if (!match) return null
	const body = match[1] || ""
	const contextWindow = getSectionNumber(toml, `model.${slot}`, "context_window")
	return {
		model: getSectionField(toml, `model.${slot}`, "model"),
		base_url: getSectionField(toml, `model.${slot}`, "base_url"),
		name: getSectionField(toml, `model.${slot}`, "name"),
		api_key: getSectionField(toml, `model.${slot}`, "api_key"),
		api_backend: getSectionField(toml, `model.${slot}`, "api_backend"),
		context_window:
			typeof contextWindow === "number" && contextWindow > 0 ? contextWindow : (null as number | null),
		raw: body,
	}
}

interface ModelSectionInput {
	slot: string
	model: string
	baseUrl: string
	apiKey: string | undefined
	contextWindow: number | null | undefined
	name: string
}

function buildModelSection({
	slot,
	model,
	baseUrl,
	apiKey,
	contextWindow,
	name,
}: ModelSectionInput): string {
	const lines = [
		`[model.${slot}]`,
		`model = ${tomlString(model)}`,
		`base_url = ${tomlString(baseUrl)}`,
		`name = ${tomlString(name)}`,
		`description = ${tomlString("Routed via 9Router gateway")}`,
		`api_backend = "chat_completions"`,
	]
	if (apiKey) lines.push(`api_key = ${tomlString(apiKey)}`)
	if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
		lines.push(`context_window = ${Math.floor(contextWindow)}`)
	}
	return `${lines.join("\n")}\n`
}

function upsertModelSection(toml: string, config: ModelSectionInput): string {
	const regexp = sectionRegExp(`model.${config.slot}`)
	const section = buildModelSection(config)
	if (regexp.test(toml)) return toml.replace(regexp, section)
	const prefix = toml.length > 0 && !toml.endsWith("\n") ? `${toml}\n` : toml
	return `${prefix}\n${section}`
}

function removeModelSection(toml: string, slot: string): string {
	return toml.replace(sectionRegExp(`model.${slot}`), "").replace(/\n{3,}/g, "\n\n")
}

function insertMarker(toml: string, marker: string): string {
	const mainSection = sectionRegExp(`model.${GROK_MAIN_MODEL_SLOT}`)
	if (mainSection.test(toml)) {
		return toml.replace(mainSection, (section) => `${marker}${section}`)
	}
	const prefix = toml.length > 0 && !toml.endsWith("\n") ? `${toml}\n` : toml
	return `${prefix}${marker}`
}

function rememberPreviousDefault(toml: string): string {
	if (previousDefaultRegExp.test(toml)) return toml
	const current = getSectionField(toml, MODELS_SECTION, "default")
	if (!current || current === GROK_MAIN_MODEL_SLOT) return toml
	return insertMarker(toml, `# 9router-prev-default = ${tomlString(current)}\n`)
}

function restorePreviousDefault(toml: string): string {
	const previous = toml.match(previousDefaultRegExp)?.[1] || GROK_BUILTIN_DEFAULT
	let next = toml.replace(previousDefaultRegExp, "")
	if (getSectionField(next, MODELS_SECTION, "default") === GROK_MAIN_MODEL_SLOT) {
		next = setSectionField(next, MODELS_SECTION, "default", previous)
	}
	return next
}

function rememberPreviousSubagent(toml: string, type: string): string {
	const regexp = previousSubagentRegExp(type)
	if (regexp.test(toml)) return toml
	const current = getSectionField(toml, SUBAGENT_MODELS_SECTION, type)
	const previous = current == null ? UNSET_SENTINEL : current
	return insertMarker(toml, `# 9router-prev-subagent-${type} = ${tomlString(previous)}\n`)
}

function restorePreviousSubagent(toml: string, type: string): string {
	const regexp = previousSubagentRegExp(type)
	const previous = toml.match(regexp)?.[1] || UNSET_SENTINEL
	const next = toml.replace(regexp, "")
	if (getSectionField(next, SUBAGENT_MODELS_SECTION, type) !== modelSlot(type)) {
		return next
	}
	if (previous === UNSET_SENTINEL) {
		return deleteSectionField(next, SUBAGENT_MODELS_SECTION, type)
	}
	return setSectionField(next, SUBAGENT_MODELS_SECTION, type, previous)
}

export function parseGrokBuildConfig(toml: string) {
	const subagentModels: Record<string, ReturnType<typeof parseModelSection>> = {}
	const subagentMappings: Record<string, string | null> = {}
	for (const type of GROK_SUBAGENT_TYPES) {
		const mapping = getSectionField(toml, SUBAGENT_MODELS_SECTION, type)
		subagentMappings[type] = mapping
		subagentModels[type] = mapping === modelSlot(type) ? parseModelSection(toml, mapping) : null
	}

	return {
		model: parseModelSection(toml, GROK_MAIN_MODEL_SLOT),
		default: getSectionField(toml, MODELS_SECTION, "default"),
		subagentModels,
		subagentMappings,
	}
}

/**
 * Apply main model and optional per-type subagent overrides while preserving all unrelated TOML.
 * `subagentModels === undefined` leaves existing subagent config untouched for API compatibility.
 */
export interface GrokBuildApplyInput {
	baseUrl: string
	apiKey: string
	model: string
	contextWindow?: number
	subagentModels?: Record<string, { model?: string; contextWindow?: number } | null | undefined>
}

export function applyGrokBuildConfig(
	toml: string,
	{ baseUrl, apiKey, model, contextWindow, subagentModels }: GrokBuildApplyInput,
): string {
	let next = rememberPreviousDefault(toml)
	next = upsertModelSection(next, {
		slot: GROK_MAIN_MODEL_SLOT,
		model,
		baseUrl,
		apiKey,
		contextWindow,
		name: "9Router",
	})
	next = setSectionField(next, MODELS_SECTION, "default", GROK_MAIN_MODEL_SLOT)

	if (subagentModels && typeof subagentModels === "object") {
		for (const type of GROK_SUBAGENT_TYPES) {
			const selected = subagentModels[type]
			const slot = modelSlot(type)
			if (selected?.model) {
				next = rememberPreviousSubagent(next, type)
				next = upsertModelSection(next, {
					slot,
					model: selected.model,
					baseUrl,
					apiKey,
					contextWindow: selected.contextWindow,
					name: `9Router ${type}`,
				})
				next = setSectionField(next, SUBAGENT_MODELS_SECTION, type, slot)
			} else {
				next = restorePreviousSubagent(next, type)
				next = removeModelSection(next, slot)
			}
		}
	}

	return next
}

export function resetGrokBuildConfig(toml: string): string {
	let next = toml
	for (const type of GROK_SUBAGENT_TYPES) {
		next = restorePreviousSubagent(next, type)
		next = removeModelSection(next, modelSlot(type))
	}
	next = removeModelSection(next, GROK_MAIN_MODEL_SLOT)
	next = restorePreviousDefault(next)
	return next.replace(/\n{3,}/g, "\n\n")
}

export function getGrokSubagentSlot(type: string): string | null {
	return GROK_SUBAGENT_TYPES.includes(type) ? modelSlot(type) : null
}
