import { exec } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { NextResponse } from "next/server"
import { resolveModelDisplayName } from "@/shared/utils/modelDisplayName"

export const dynamic = "force-dynamic"

const execAsync = promisify(exec)

// OpenClaw 2026.5.x writes agents[].model as either a plain string
// (legacy) or as an object `{ primary, fallbacks }`. Normalize to the
// string id so downstream consumers can call `.startsWith()` safely.
type AgentModelValue = string | { primary?: string; fallbacks?: string[] } | null

const resolveAgentModel = (m: AgentModelValue): string => {
	if (typeof m === "string") return m
	if (m && typeof m === "object") return m.primary ?? ""
	return ""
}

interface OpenClawAgent {
	id?: string
	agentDir?: string
	model?: AgentModelValue
	[key: string]: unknown
}

interface OpenClawProviderEntry {
	baseUrl?: string
	apiKey?: string
	api?: string
	models?: Array<{ id: string; name: string }>
}

interface OpenClawSettings {
	models?: {
		providers?: Record<string, OpenClawProviderEntry>
	}
	agents?: {
		defaults?: {
			model?: { primary?: string }
			models?: Record<string, unknown>
		}
		list?: OpenClawAgent[]
	}
}

interface AgentModelsJson {
	providers?: Record<string, OpenClawProviderEntry>
}

const getOpenClawDir = () => path.join(os.homedir(), ".openclaw")
const getOpenClawSettingsPath = () => path.join(getOpenClawDir(), "openclaw.json")

// Check if openclaw CLI is installed (via which/where or config file exists)
const checkOpenClawInstalled = async () => {
	try {
		const isWindows = os.platform() === "win32"
		const command = isWindows ? "where openclaw" : "which openclaw"
		// On Windows, inject %APPDATA%\npm into PATH so npm global packages are found
		const env = isWindows
			? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
			: process.env
		await execAsync(command, { windowsHide: true, env })
		return true
	} catch {
		try {
			await fs.access(getOpenClawSettingsPath())
			return true
		} catch {
			return false
		}
	}
}

// Read current settings.json
const readSettings = async () => {
	try {
		const settingsPath = getOpenClawSettingsPath()
		const content = await fs.readFile(settingsPath, "utf-8")
		// Tolerate JSONC (trailing commas) and treat unparseable files as "no config"
		// rather than throwing a 500 that the UI misreads as "tool not installed".
		const stripped = content.replace(/,(\s*[}\]])/g, "$1")
		return JSON.parse(stripped) as OpenClawSettings
	} catch (_error) {
		return null
	}
}

// Check if settings has 9Router config
const has9RouterConfig = (settings: OpenClawSettings | null) => {
	if (!settings || !settings.models || !settings.models.providers) return false
	return !!settings.models.providers["9router"]
}

// Read per-agent models.json and return current model id (without "9router/" prefix)
const readAgentModel = async (agentDir: string) => {
	try {
		const modelsPath = path.join(agentDir, "models.json")
		const content = await fs.readFile(modelsPath, "utf-8")
		const data = JSON.parse(content)
		const models = data?.providers?.["9router"]?.models
		return models?.[0]?.id || null
	} catch {
		return null
	}
}

// GET - Check openclaw CLI and read current settings
export async function GET() {
	try {
		const isInstalled = await checkOpenClawInstalled()

		if (!isInstalled) {
			return NextResponse.json({
				installed: false,
				settings: null,
				message: "Open Claw CLI is not installed",
			})
		}

		const settings = await readSettings()

		// Enrich agents list with current per-agent model from models.json.
		// Coerce agent.model to its string id when OpenClaw stores it as
		// `{ primary, fallbacks }` so downstream `.startsWith()` calls work.
		const agentList = settings?.agents?.list || []
		const enrichedAgents = await Promise.all(
			agentList.map(async (agent: OpenClawAgent) => {
				const agentModel = agent.agentDir ? await readAgentModel(agent.agentDir) : null
				return { ...agent, model: resolveAgentModel(agent.model), currentModel: agentModel }
			}),
		)

		return NextResponse.json({
			installed: true,
			settings,
			agents: enrichedAgents,
			has9Router: has9RouterConfig(settings),
			settingsPath: getOpenClawSettingsPath(),
		})
	} catch (error) {
		console.log("Error checking openclaw settings:", error)
		return NextResponse.json({ error: "Failed to check openclaw settings" }, { status: 500 })
	}
}

// Write per-agent models.json
const writeAgentModels = async (
	agentDir: string,
	model: string,
	baseUrl: string,
	apiKey: string | undefined,
) => {
	await fs.mkdir(agentDir, { recursive: true })
	const modelsPath = path.join(agentDir, "models.json")
	let existing: AgentModelsJson = {}
	try {
		const content = await fs.readFile(modelsPath, "utf-8")
		existing = JSON.parse(content)
	} catch {
		/* No existing */
	}

	if (!existing.providers) existing.providers = {}
	existing.providers["9router"] = {
		baseUrl,
		apiKey: apiKey || "your_api_key",
		api: "openai-completions",
		models: [{ id: model, name: resolveModelDisplayName(model, undefined) }],
	}
	await fs.writeFile(modelsPath, JSON.stringify(existing, null, 2))
}

// POST - Update 9Router settings (merge with existing settings)
export async function POST(request: Request) {
	try {
		// agentModels: { [agentId]: modelId } for per-agent override
		const {
			baseUrl,
			apiKey,
			model,
			agentModels = {},
		}: {
			baseUrl?: string
			apiKey?: string
			model?: string
			agentModels?: Record<string, string | undefined>
		} = await request.json()

		if (!baseUrl || !model) {
			return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 })
		}

		const openclawDir = getOpenClawDir()
		const settingsPath = getOpenClawSettingsPath()

		await fs.mkdir(openclawDir, { recursive: true })

		let settings: OpenClawSettings = {}
		try {
			const existingSettings = await fs.readFile(settingsPath, "utf-8")
			settings = JSON.parse(existingSettings)
		} catch {
			/* No existing settings */
		}

		if (!settings.agents) settings.agents = {}
		if (!settings.agents.defaults) settings.agents.defaults = {}
		if (!settings.agents.defaults.model) settings.agents.defaults.model = {}
		if (!settings.agents.defaults.models) settings.agents.defaults.models = {}
		if (!settings.models) settings.models = {}
		if (!settings.models.providers) settings.models.providers = {}

		// The defaults above guarantee these buckets exist.
		const agentDefaults = settings.agents.defaults
		const providerModels = settings.models.providers

		const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`
		const fullModelId = `9router/${model}`

		// Remove all old 9router/* entries from agents.defaults.models
		Object.keys(agentDefaults.models)
			.filter((k) => k.startsWith("9router/"))
			.forEach((k) => {
				delete agentDefaults.models[k]
			})

		// Update default model
		agentDefaults.model.primary = fullModelId

		// Collect all unique models (default + per-agent)
		const allModelIds = new Set([model])
		Object.values(agentModels).forEach((m) => {
			if (m) allModelIds.add(m)
		})

		// Add fresh 9router models to allowlist
		allModelIds.forEach((m) => {
			agentDefaults.models[`9router/${m}`] = {}
		})

		// Remove old 9router model from each agent in agents.list. The
		// model field may be a plain string or `{ primary, fallbacks }`.
		if (settings.agents.list) {
			settings.agents.list = settings.agents.list.map((agent: OpenClawAgent) => {
				if (resolveAgentModel(agent.model).startsWith("9router/")) {
					const { model: _model, ...rest } = agent
					return rest
				}
				return agent
			})
		}

		// Update models.providers.9router with all models
		providerModels["9router"] = {
			baseUrl: normalizedBaseUrl,
			apiKey: apiKey || "your_api_key",
			api: "openai-completions",
			models: [...allModelIds].map((m) => ({ id: m, name: resolveModelDisplayName(m, undefined) })),
		}

		// Set per-agent model in agents.list and write models.json
		if (settings.agents.list) {
			settings.agents.list = settings.agents.list.map((agent: OpenClawAgent) => {
				const agentModel = agent.id ? agentModels[agent.id] : undefined
				if (agentModel) return { ...agent, model: `9router/${agentModel}` }
				return agent
			})

			// Write per-agent models.json for agents with agentDir
			await Promise.all(
				settings.agents.list.map(async (agent: OpenClawAgent) => {
					if (!agent.agentDir) return
					const agentModel = agent.id ? agentModels[agent.id] : undefined
					const modelToWrite = agentModel || model // fallback to default
					await writeAgentModels(agent.agentDir, modelToWrite, normalizedBaseUrl, apiKey)
				}),
			)
		}

		await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2))

		return NextResponse.json({
			success: true,
			message: "Open Claw settings applied successfully!",
			settingsPath,
		})
	} catch (error) {
		console.log("Error updating openclaw settings:", error)
		return NextResponse.json({ error: "Failed to update openclaw settings" }, { status: 500 })
	}
}

// DELETE - Remove 9Router settings only (keep other settings)
export async function DELETE() {
	try {
		const settingsPath = getOpenClawSettingsPath()

		// Read existing settings
		let settings: OpenClawSettings = {}
		try {
			const existingSettings = await fs.readFile(settingsPath, "utf-8")
			settings = JSON.parse(existingSettings)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return NextResponse.json({
					success: true,
					message: "No settings file to reset",
				})
			}
			throw error
		}

		// Remove 9Router from models.providers
		if (settings.models && settings.models.providers) {
			delete settings.models.providers["9router"]

			// Remove providers object if empty
			if (Object.keys(settings.models.providers).length === 0) {
				delete settings.models.providers
			}
		}

		// Remove 9router models from agents.defaults.models allowlist
		if (settings.agents?.defaults?.models) {
			const keysToRemove = Object.keys(settings.agents.defaults.models).filter((k) =>
				k.startsWith("9router/"),
			)
			for (const key of keysToRemove) {
				delete settings.agents.defaults.models[key]
			}
			if (Object.keys(settings.agents.defaults.models).length === 0) {
				delete settings.agents.defaults.models
			}
		}

		// Reset agents.defaults.model.primary if it uses 9router
		if (settings.agents?.defaults?.model?.primary?.startsWith("9router/")) {
			delete settings.agents.defaults.model.primary
		}

		// Write updated settings
		await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2))

		return NextResponse.json({
			success: true,
			message: "9Router settings removed successfully",
		})
	} catch (error) {
		console.log("Error resetting openclaw settings:", error)
		return NextResponse.json({ error: "Failed to reset openclaw settings" }, { status: 500 })
	}
}
