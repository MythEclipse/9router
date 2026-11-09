import fs from "node:fs"
import path from "node:path"
import { resolveModelDisplayName } from "../../utils/modelDisplayName.js"
import { home, isStr, readJson, rewriteFile, toml, v1, writeFile, writeJson } from "./shared.js"

// ── Kilo Code (CLI auth only; VS Code settings left to the dashboard) ───────
const kiloPath = () => path.join(home(), ".local", "share", "kilo", "auth.json")

const kilo = {
	id: "kilo",
	name: "Kilo Code CLI",
	paths: () => [kiloPath()],
	// No route: the dashboard GET exposes only auth key names, not the model,
	// so kilo falls back to the shared model.
	async apply({ baseUrl, apiKey, model }) {
		const file = kiloPath()
		const auth = readJson(file) || {}
		auth["openai-compatible"] = { type: "api-key", apiKey, baseUrl: v1(baseUrl), model }
		writeJson(file, auth)
		return [file]
	},
	async show() {
		const a = readJson(kiloPath())?.["openai-compatible"]
		return {
			baseUrl: a?.baseUrl,
			apiKey: a?.apiKey,
			models: isStr(a?.model) ? { main: a.model } : {},
		}
	},
	async reset() {
		const file = kiloPath()
		const auth = readJson(file)
		if (!auth) return []
		delete auth["openai-compatible"]
		delete auth["9router"]
		rewriteFile(file, JSON.stringify(auth, null, 2))
		return [file]
	},
}

// ── Cline CLI ───────────────────────────────────────────────────────────────
const clineDir = () => path.join(home(), ".cline", "data")
const clineState = () => path.join(clineDir(), "globalState.json")
const clineSecrets = () => path.join(clineDir(), "secrets.json")

const cline = {
	id: "cline",
	name: "Cline CLI",
	paths: () => [clineState(), clineSecrets()],
	route: "cline-settings",
	serverModel(data) {
		const st = data?.settings
		return st?.actModeApiProvider === "openai" && isStr(st.openAiModelId) ? st.openAiModelId : null
	},
	async apply({ baseUrl, apiKey, model }) {
		const state = readJson(clineState()) || {}
		state.actModeApiProvider = "openai"
		state.planModeApiProvider = "openai"
		state.openAiBaseUrl = baseUrl // Cline expects base WITHOUT /v1
		state.openAiModelId = model
		state.planModeOpenAiModelId = model
		writeJson(clineState(), state)
		const secrets = readJson(clineSecrets()) || {}
		secrets.openAiApiKey = apiKey
		writeJson(clineSecrets(), secrets)
		return [clineState(), clineSecrets()]
	},
	async show() {
		const st = readJson(clineState()) || {}
		const models = {}
		if (isStr(st.openAiModelId)) models.act = st.openAiModelId
		if (isStr(st.planModeOpenAiModelId)) models.plan = st.planModeOpenAiModelId
		return {
			baseUrl: st.openAiBaseUrl,
			apiKey: readJson(clineSecrets())?.openAiApiKey,
			models,
			active: st.actModeApiProvider === "openai",
		}
	},
	async reset() {
		const state = readJson(clineState())
		if (!state) return []
		if (state.actModeApiProvider === "openai") {
			delete state.openAiBaseUrl
			delete state.openAiModelId
			delete state.planModeOpenAiModelId
			state.actModeApiProvider = "cline"
			state.planModeApiProvider = "cline"
		}
		rewriteFile(clineState(), JSON.stringify(state, null, 2))
		const touched = [clineState()]
		const secrets = readJson(clineSecrets())
		if (secrets) {
			delete secrets.openAiApiKey
			rewriteFile(clineSecrets(), JSON.stringify(secrets, null, 2))
			touched.push(clineSecrets())
		}
		return touched
	},
}

// ── Pi (pi-coding-agent) ────────────────────────────────────────────────────
// Prefers ~/.pi/agent/models.json; an existing legacy ~/.pi/models.json is used instead.
const piPath = () => {
	const agent = path.join(home(), ".pi", "agent", "models.json")
	const root = path.join(home(), ".pi", "models.json")
	return !fs.existsSync(agent) && fs.existsSync(root) ? root : agent
}

const pi = {
	id: "pi",
	name: "Pi",
	paths: () => [piPath()],
	route: "pi-settings",
	serverModel(data) {
		const m = data?.config?.providers?.["9router"]?.models?.[0]
		const id = typeof m === "string" ? m : m?.id
		return isStr(id) ? id : null
	},
	async apply({ baseUrl, apiKey, model }) {
		const file = piPath()
		const cfg = readJson(file) || {}
		cfg.providers = cfg.providers || {}
		cfg.providers["9router"] = {
			...(cfg.providers["9router"] || {}),
			baseUrl: v1(baseUrl),
			apiKey,
			api: "openai-completions",
			models: [
				{ id: model, name: resolveModelDisplayName(model), contextWindow: 128000, maxTokens: 16384 },
			],
		}
		writeJson(file, cfg)
		return [file]
	},
	async show() {
		const p = readJson(piPath())?.providers?.["9router"]
		const ids = (p?.models || []).map((m) => (typeof m === "string" ? m : m?.id)).filter(isStr)
		return {
			baseUrl: p?.baseUrl,
			apiKey: p?.apiKey,
			models: ids.length
				? { main: ids[0], ...(ids.length > 1 ? { available: ids.join(", ") } : {}) }
				: {},
		}
	},
	async reset() {
		const file = piPath()
		const cfg = readJson(file)
		if (!cfg?.providers?.["9router"]) return []
		delete cfg.providers["9router"]
		if (Object.keys(cfg.providers).length === 0) delete cfg.providers
		rewriteFile(file, JSON.stringify(cfg, null, 2))
		return [file]
	},
}

// ── Oh My Pi ────────────────────────────────────────────────────────────────
// Proxy discovery lists every server model under /model, so no model is written.
// The dashboard also mirrors the key into agent.db; models.yml is the primary
// source, so that best-effort sqlite write is skipped here.
const ompPath = () => path.join(home(), ".omp", "agent", "models.yml")

async function readYaml(file) {
	let text
	try {
		text = fs.readFileSync(file, "utf8")
	} catch (err) {
		if (err.code === "ENOENT") return null
		throw err
	}
	try {
		const { parseYAML } = await toml()
		return parseYAML(text) || {}
	} catch (err) {
		throw new Error(`Cannot parse ${file}: ${err.message}`)
	}
}

const omp = {
	id: "omp",
	name: "Oh My Pi",
	paths: () => [ompPath()],
	needsModel: false,
	async apply({ baseUrl, apiKey }) {
		const { stringifyYAML } = await toml()
		const file = ompPath()
		const cfg = (await readYaml(file)) || {}
		cfg.providers = cfg.providers || {}
		cfg.providers["9router"] = {
			baseUrl: v1(baseUrl),
			apiKey,
			api: "openai-completions",
			authHeader: true,
			disableStrictTools: true,
			discovery: { type: "proxy" },
		}
		writeFile(file, stringifyYAML(cfg))
		return [file]
	},
	async show() {
		const p = (await readYaml(ompPath()))?.providers?.["9router"]
		return {
			baseUrl: p?.baseUrl,
			apiKey: p?.apiKey,
			models: p?.discovery?.type === "proxy" ? { main: "(all server models, via discovery)" } : {},
		}
	},
	async reset() {
		const { stringifyYAML } = await toml()
		const file = ompPath()
		const cfg = await readYaml(file)
		if (!cfg?.providers?.["9router"]) return []
		delete cfg.providers["9router"]
		if (Object.keys(cfg.providers).length === 0) delete cfg.providers
		rewriteFile(file, Object.keys(cfg).length ? stringifyYAML(cfg) : "")
		return [file]
	},
}

export { cline, kilo, omp, pi, readYaml }
