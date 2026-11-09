import fs from "node:fs"
import path from "node:path"
import { resolveModelDisplayName } from "../../utils/modelDisplayName.js"
import { home, isStr, readJson, rewriteFile, toml, v1, writeFile, writeJson } from "./shared.js"

// ── OpenCode ────────────────────────────────────────────────────────────────
const opencodePath = () => path.join(home(), ".config", "opencode", "opencode.json")

const opencode = {
	id: "opencode",
	name: "OpenCode",
	paths: () => [opencodePath()],
	route: "opencode-settings",
	serverModel(data) {
		const m = data?.config?.model
		return isStr(m) && m.startsWith("9router/") ? m.slice("9router/".length) : null
	},
	async apply({ baseUrl, apiKey, model }) {
		const file = opencodePath()
		const cfg = readJson(file) || {}
		cfg.provider = cfg.provider || {}
		const p = cfg.provider["9router"] || { npm: "@ai-sdk/openai-compatible", options: {}, models: {} }
		p.options = { ...p.options, baseURL: v1(baseUrl), apiKey }
		p.models = p.models || {}
		p.models[model] = {
			name: resolveModelDisplayName(model),
			modalities: { input: ["text", "image"], output: ["text"] },
		}
		cfg.provider["9router"] = p
		cfg.model = `9router/${model}`
		cfg.agent = cfg.agent || {}
		cfg.agent.explorer = {
			description: "Fast explorer subagent for codebase exploration",
			mode: "subagent",
			model: `9router/${model}`,
		}
		writeJson(file, cfg)
		return [file]
	},
	async show() {
		const cfg = readJson(opencodePath()) || {}
		const p = cfg.provider?.["9router"]
		const models = {}
		if (isStr(cfg.model)) models.main = cfg.model
		if (isStr(cfg.agent?.explorer?.model)) models.explorer = cfg.agent.explorer.model
		const listed = Object.keys(p?.models || {})
		if (listed.length) models.available = listed.join(", ")
		return {
			baseUrl: p?.options?.baseURL,
			apiKey: p?.options?.apiKey,
			models,
			active: !!cfg.model?.startsWith("9router/"),
		}
	},
	async reset() {
		const file = opencodePath()
		const cfg = readJson(file)
		if (!cfg) return []
		if (cfg.provider) delete cfg.provider["9router"]
		if (cfg.model?.startsWith("9router/")) delete cfg.model
		if (cfg.agent?.explorer?.model?.startsWith("9router/")) {
			delete cfg.agent.explorer
			if (Object.keys(cfg.agent).length === 0) delete cfg.agent
		}
		rewriteFile(file, JSON.stringify(cfg, null, 2))
		return [file]
	},
}

// ── Factory Droid ───────────────────────────────────────────────────────────
const droidPath = () => path.join(home(), ".factory", "settings.json")
const isDroid9r = (m) => m.id?.startsWith("custom:9Router")

const droid = {
	id: "droid",
	name: "Factory Droid",
	paths: () => [droidPath()],
	route: "droid-settings",
	serverModel(data) {
		const m = (data?.settings?.customModels || []).find(isDroid9r)?.model
		return isStr(m) ? m : null
	},
	async apply({ baseUrl, apiKey, model }) {
		const file = droidPath()
		const cfg = readJson(file) || {}
		const others = (cfg.customModels || []).filter((m) => !isDroid9r(m))
		cfg.customModels = [
			{
				model,
				id: "custom:9Router-0",
				index: 0,
				baseUrl: v1(baseUrl),
				apiKey,
				displayName: resolveModelDisplayName(model),
				maxOutputTokens: 131072,
				noImageSupport: false,
				provider: "openai",
			},
			...others,
		]
		cfg.customModels.forEach((m, i) => {
			m.index = i
		})
		writeJson(file, cfg)
		return [file]
	},
	async show() {
		const ours = (readJson(droidPath())?.customModels || []).filter(isDroid9r)
		return {
			baseUrl: ours[0]?.baseUrl,
			apiKey: ours[0]?.apiKey,
			models: ours.length
				? {
						main: ours[0].model,
						...(ours.length > 1 ? { available: ours.map((m) => m.model).join(", ") } : {}),
					}
				: {},
		}
	},
	async reset() {
		const file = droidPath()
		const cfg = readJson(file)
		if (!cfg) return []
		if (cfg.customModels) {
			cfg.customModels = cfg.customModels.filter((m) => !isDroid9r(m))
			if (cfg.customModels.length === 0) delete cfg.customModels
		}
		rewriteFile(file, JSON.stringify(cfg, null, 2))
		return [file]
	},
}

// ── Crush ───────────────────────────────────────────────────────────────────
const crushPath = () =>
	path.join(process.env.XDG_CONFIG_HOME || path.join(home(), ".config"), "crush", "crush.json")

const crush = {
	id: "crush",
	name: "Crush",
	paths: () => [crushPath()],
	route: "crush-settings",
	serverModel(data) {
		const m = data?.config?.providers?.["9router"]?.models?.[0]?.id
		return isStr(m) ? m : null
	},
	async apply({ baseUrl, apiKey, model }) {
		const file = crushPath()
		const cfg = readJson(file) || {}
		cfg.providers = cfg.providers || {}
		cfg.providers["9router"] = {
			type: "openai-compat",
			base_url: v1(baseUrl),
			api_key: apiKey,
			models: [{ id: model, name: resolveModelDisplayName(model), context_window: 128000 }],
		}
		writeJson(file, cfg)
		return [file]
	},
	async show() {
		const p = readJson(crushPath())?.providers?.["9router"]
		const ids = (p?.models || []).map((m) => m.id).filter(isStr)
		return { baseUrl: p?.base_url, apiKey: p?.api_key, models: ids.length ? { main: ids[0] } : {} }
	},
	async reset() {
		const file = crushPath()
		const cfg = readJson(file)
		if (!cfg?.providers?.["9router"]) return []
		delete cfg.providers["9router"]
		if (Object.keys(cfg.providers).length === 0) delete cfg.providers
		rewriteFile(file, JSON.stringify(cfg, null, 2))
		return [file]
	},
}

export { crush, droid, opencode }
