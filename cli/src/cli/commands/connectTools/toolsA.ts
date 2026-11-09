import fs from "node:fs"
import path from "node:path"
import { resolveModelDisplayName } from "../../utils/modelDisplayName.js"
import { home, isStr, readJson, rewriteFile, toml, v1, writeFile, writeJson } from "./shared.js"

// ── Claude Code ─────────────────────────────────────────────────────────────
const CLAUDE_MODELS = [
	{ flag: "fable", envKey: "ANTHROPIC_DEFAULT_FABLE_MODEL" },
	{ flag: "opus", envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL" },
	{ flag: "sonnet", envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL" },
	{ flag: "haiku", envKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL" },
]
const CLAUDE_RESET_KEYS = [
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_AUTH_TOKEN",
	...CLAUDE_MODELS.map((m) => m.envKey),
]
const claudePath = () => path.join(home(), ".claude", "settings.json")

const claude = {
	id: "claude",
	name: "Claude Code",
	paths: () => [claudePath()],
	async apply({ baseUrl, apiKey, claudeModels }) {
		const file = claudePath()
		const cur = readJson(file) || {}
		cur.hasCompletedOnboarding = true
		cur.env = { ...(cur.env || {}), ANTHROPIC_BASE_URL: v1(baseUrl), ANTHROPIC_AUTH_TOKEN: apiKey }
		// A tier with no model (null) is removed so Claude Code uses its own default
		// instead of a stale value from an earlier run.
		for (const m of CLAUDE_MODELS) {
			if (claudeModels[m.envKey]) cur.env[m.envKey] = claudeModels[m.envKey]
			else delete cur.env[m.envKey]
		}
		writeJson(file, cur)
		return [file]
	},
	async show() {
		const env = readJson(claudePath())?.env || {}
		const models = {}
		if (isStr(env.ANTHROPIC_MODEL)) models.main = env.ANTHROPIC_MODEL
		for (const m of CLAUDE_MODELS) if (isStr(env[m.envKey])) models[m.flag] = env[m.envKey]
		return { baseUrl: env.ANTHROPIC_BASE_URL, apiKey: env.ANTHROPIC_AUTH_TOKEN, models }
	},
	async reset() {
		const file = claudePath()
		const cur = readJson(file)
		if (!cur) return []
		if (cur.env) {
			CLAUDE_RESET_KEYS.forEach((k) => delete cur.env[k])
			if (Object.keys(cur.env).length === 0) delete cur.env
		}
		rewriteFile(file, JSON.stringify(cur, null, 2))
		return [file]
	},
}

// ── OpenAI Codex CLI ────────────────────────────────────────────────────────
const codexPath = () => path.join(home(), ".codex", "config.toml")

const codex = {
	id: "codex",
	name: "OpenAI Codex CLI",
	paths: () => [codexPath()],
	route: "codex-settings",
	// GET returns raw TOML text; only trust `model` when the provider is 9router.
	async serverModel(data) {
		if (!isStr(data?.config)) return null
		const { parseTOML } = await toml()
		const cfg = parseTOML(data.config) || {}
		return cfg.model_provider === "9router" && isStr(cfg.model) ? cfg.model : null
	},
	async apply({ baseUrl, apiKey, model }) {
		const { parseTOML, stringifyTOML } = await toml()
		const file = codexPath()
		let cfg = {}
		try {
			cfg = parseTOML(fs.readFileSync(file, "utf8")) || {}
		} catch (err) {
			if (err.code !== "ENOENT") throw err
		}
		cfg.model = model
		cfg.model_provider = "9router"
		cfg.model_providers = cfg.model_providers || {}
		// Custom providers ignore auth.json - key must travel as a static header.
		cfg.model_providers["9router"] = {
			name: "9Router",
			base_url: v1(baseUrl),
			wire_api: "responses",
			http_headers: { Authorization: `Bearer ${apiKey}` },
		}
		cfg.agents = cfg.agents || {}
		delete cfg.agents.subagent
		cfg.agents.default_subagent_model = model
		writeFile(file, stringifyTOML(cfg))
		return [file]
	},
	async show() {
		let cfg
		try {
			const { parseTOML } = await toml()
			cfg = parseTOML(fs.readFileSync(codexPath(), "utf8")) || {}
		} catch (err) {
			if (err.code === "ENOENT") return {}
			throw new Error(`Cannot parse ${codexPath()}: ${err.message}`)
		}
		const p = cfg.model_providers?.["9router"]
		const auth = p?.http_headers?.Authorization
		return {
			baseUrl: p?.base_url,
			apiKey: isStr(auth) ? auth.replace(/^Bearer\s+/i, "") : undefined,
			models: {
				...(isStr(cfg.model) ? { main: cfg.model } : {}),
				...(isStr(cfg.agents?.default_subagent_model)
					? { subagent: cfg.agents.default_subagent_model }
					: {}),
			},
			// Codex only routes through 9router when this provider is the active one.
			active: cfg.model_provider === "9router",
		}
	},
	async reset() {
		const { parseTOML, stringifyTOML } = await toml()
		const file = codexPath()
		let cfg
		try {
			cfg = parseTOML(fs.readFileSync(file, "utf8")) || {}
		} catch (err) {
			if (err.code === "ENOENT") return []
			throw err
		}
		if (cfg.model_provider === "9router") {
			delete cfg.model
			delete cfg.model_provider
		}
		if (cfg.model_providers) delete cfg.model_providers["9router"]
		if (cfg.agents) {
			delete cfg.agents.default_subagent_model
			delete cfg.agents.subagent
		}
		for (const k of ["model_providers", "agents"]) {
			if (cfg[k] && Object.keys(cfg[k]).length === 0) delete cfg[k]
		}
		rewriteFile(file, stringifyTOML(cfg))
		return [file]
	},
}

export { CLAUDE_MODELS, claude, codex }
